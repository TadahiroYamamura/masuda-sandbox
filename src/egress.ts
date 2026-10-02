import { Code, ConnectError } from "@connectrpc/connect";
import {
  BASE62_ALPHABET,
  HttpRequestBlockedError,
  createHttpHooks,
  makePlaceholderFunc,
  type DebugLogFn,
  type HttpHooks,
  type SecretManager,
} from "@earendil-works/gondolin";

import type { EventQueue } from "./events.js";
import { SubstituteIn, type SecretDecl } from "./gen/masuda/sandbox/v1/sandbox_pb.js";
import type { PolicyRecord } from "./sandboxes.js";

export type DenyReason = "host-not-allowed" | "secret-not-enabled" | "protocol";

interface Secret {
  name: string;
  value: string;
  hosts: string[];
  header: boolean;
  body: boolean;
  placeholder: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_PLACEHOLDER_PREFIX = "masuda_secret_";
const DEFAULT_PLACEHOLDER_LENGTH = 40;
// Started requests whose response never came (upstream error, redirect hops
// that only the last hop answers) are forgotten after this long.
const PENDING_TTL_MS = 10 * 60_000;
const PROTOCOL_DENY_DEDUPE_MS = 5_000;

function invalid(msg: string): ConnectError {
  return new ConnectError(msg, Code.InvalidArgument);
}

// Same semantics as Gondolin's own host patterns ("*" matches any substring),
// so that allowed_hosts and SecretDecl.hosts read the same way.
export function matchesHost(hostname: string, patterns: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (!pat) return false;
    if (pat === "*") return true;
    const re = new RegExp(`^${pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    return re.test(h);
  });
}

function normalizePolicy(p: PolicyRecord): PolicyRecord {
  return {
    allowedHosts: p.allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean),
    enabledSecrets: [...p.enabledSecrets],
  };
}

export function validatePolicy(p: PolicyRecord, secretNames: readonly string[]): PolicyRecord {
  for (const n of p.enabledSecrets) {
    if (!secretNames.includes(n)) throw invalid(`enabled_secrets names unknown secret ${JSON.stringify(n)}`);
  }
  return normalizePolicy(p);
}

function toSecrets(decls: SecretDecl[]): Secret[] {
  const out: Secret[] = [];
  for (const d of decls) {
    if (!ENV_NAME.test(d.name)) throw invalid(`invalid secret name ${JSON.stringify(d.name)}`);
    if (out.some((s) => s.name === d.name)) throw invalid(`duplicate secret ${JSON.stringify(d.name)}`);
    if (!d.value) throw invalid(`secret ${d.name} has no value`);
    const where = d.substituteIn.length > 0 ? d.substituteIn : [SubstituteIn.HEADER];
    const custom = d.placeholderPrefix !== "" || d.placeholderLength > 0;
    const placeholder = makePlaceholderFunc({
      prefix: custom ? d.placeholderPrefix : DEFAULT_PLACEHOLDER_PREFIX,
      length: d.placeholderLength || DEFAULT_PLACEHOLDER_LENGTH,
      alphabet: BASE62_ALPHABET,
    })();
    // A placeholder contained in another (or in a value) would be substituted
    // ambiguously; with a caller-chosen short length this is not impossible.
    for (const s of out) {
      if (s.placeholder.includes(placeholder) || placeholder.includes(s.placeholder)) throw invalid(`placeholders of ${s.name} and ${d.name} overlap; use a longer placeholder_length`);
    }
    if (placeholder.length < 8 || d.value.includes(placeholder)) {
      throw invalid(`placeholder for ${d.name} is too short or contained in its value; use a longer placeholder_length`);
    }
    out.push({
      name: d.name,
      value: d.value,
      hosts: [...d.hosts],
      header: where.includes(SubstituteIn.HEADER),
      body: where.includes(SubstituteIn.BODY),
      placeholder,
    });
  }
  return out;
}

function headerTexts(headers: Headers): string[] {
  const texts: string[] = [];
  headers.forEach((value, name) => {
    texts.push(value);
    // Gondolin also substitutes inside Basic credentials, so a placeholder
    // hidden in base64 must be seen here too.
    const m = /^(authorization|proxy-authorization)$/i.test(name) ? /^Basic\s+(\S+)\s*$/i.exec(value) : null;
    if (m) texts.push(Buffer.from(m[1]!, "base64").toString("utf8"));
  });
  return texts;
}

function denied(reason: DenyReason, host: string): HttpRequestBlockedError {
  return new HttpRequestBlockedError(`${reason}: ${host}`);
}

// Owns the HTTP side of one sandbox: the placeholders the guest sees, the
// mutable Policy that every request is checked against, and the hooks handed
// to Gondolin. Header substitution is Gondolin's (via createHttpHooks); body
// substitution and the enabled/disabled distinction are done here.
//
// Why secrets are checked in onRequest rather than isRequestAllowed: once a
// custom onRequest exists, Gondolin calls isRequestAllowed only after the
// hooks ran, i.e. after placeholders in headers were already replaced by real
// values. onRequest is the last point where the guest's placeholders are
// visible. Disabled secrets additionally get an empty host list in Gondolin's
// secret manager, so even a placeholder this code failed to spot is never
// replaced (Gondolin blocks the request instead).
export class Egress {
  readonly placeholders: Record<string, string>;
  readonly httpHooks: HttpHooks;
  private readonly secrets: Secret[];
  private readonly manager: SecretManager;
  private policy: PolicyRecord;
  private nextRequestId = 0n;
  private readonly pending = new Map<string, { id: bigint; startedAt: number }[]>();
  private readonly recentProtocolDenials = new Map<string, number>();
  private lastActivity: Date | undefined;

  constructor(decls: SecretDecl[], policy: PolicyRecord, private readonly events: EventQueue) {
    this.secrets = toSecrets(decls);
    this.policy = validatePolicy(policy, this.secrets.map((s) => s.name));
    this.placeholders = Object.fromEntries(this.secrets.map((s) => [s.name, s.placeholder]));
    const hooks = createHttpHooks({
      // Hosts are decided by isRequestAllowed against the mutable policy;
      // Gondolin's own list is fixed at creation and so left open.
      allowedHosts: undefined,
      secrets: Object.fromEntries(
        this.secrets.filter((s) => s.header).map((s) => [s.name, { hosts: this.enabled(s) ? s.hosts : [], value: s.value, placeholder: s.placeholder }]),
      ),
      isRequestAllowed: (req) => this.isRequestAllowed(req),
      onRequest: (req) => this.onRequest(req),
      onResponse: (res, req) => this.onResponse(res, req),
    });
    this.httpHooks = hooks.httpHooks;
    this.manager = hooks.secretManager;
  }

  get currentPolicy(): PolicyRecord {
    return { allowedHosts: [...this.policy.allowedHosts], enabledSecrets: [...this.policy.enabledSecrets] };
  }

  // inflight counts what started and has not finished, minus what the
  // PENDING_TTL_MS rule has given up on, so that a request whose response
  // never came does not keep the sandbox looking busy forever.
  activity(): { last: Date | undefined; inflight: number } {
    const now = Date.now();
    let inflight = 0;
    for (const list of this.pending.values()) for (const p of list) if (now - p.startedAt < PENDING_TTL_MS) inflight++;
    return { last: this.lastActivity, inflight };
  }

  setPolicy(p: PolicyRecord): void {
    this.policy = validatePolicy(p, this.secrets.map((s) => s.name));
    for (const s of this.secrets) if (s.header) this.manager.updateSecret(s.name, { hosts: this.enabled(s) ? s.hosts : [] });
  }

  // Gondolin reports non-HTTP flows it refuses only through its network debug
  // log, so that log is parsed for them.
  readonly onDebug: DebugLogFn = (component, message) => {
    if (component !== "net") return;
    const m = /^(?:tcp|udp) blocked \S+ -> (\S+)/.exec(message);
    if (!m) return;
    const dst = m[1]!;
    const now = Date.now();
    const last = this.recentProtocolDenials.get(dst);
    if (last !== undefined && now - last < PROTOCOL_DENY_DEDUPE_MS) return;
    this.recentProtocolDenials.set(dst, now);
    if (this.recentProtocolDenials.size > 1000) {
      for (const [k, t] of this.recentProtocolDenials) if (now - t >= PROTOCOL_DENY_DEDUPE_MS) this.recentProtocolDenials.delete(k);
    }
    this.recordDenied("protocol", dst);
  };

  private enabled(s: Secret): boolean {
    return this.policy.enabledSecrets.includes(s.name);
  }

  private hostAllowed(host: string): boolean {
    return matchesHost(host, this.policy.allowedHosts);
  }

  private recordDenied(reason: DenyReason, host: string): void {
    this.lastActivity = new Date();
    this.events.push({ case: "httpDenied", value: { host, reason } });
  }

  private deny(reason: DenyReason, host: string): never {
    this.recordDenied(reason, host);
    throw denied(reason, host);
  }

  private isRequestAllowed(req: Request): boolean {
    const host = new URL(req.url).hostname.toLowerCase();
    if (this.hostAllowed(host)) return true;
    this.recordDenied("host-not-allowed", host);
    return false;
  }

  private async onRequest(req: Request): Promise<Request | undefined> {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    if (!this.hostAllowed(host)) this.deny("host-not-allowed", host);

    const head = [...headerTexts(req.headers), req.url];
    for (const s of this.secrets) {
      if (!head.some((t) => t.includes(s.placeholder))) continue;
      if (!this.enabled(s) || (s.header && !matchesHost(host, s.hosts))) this.deny("secret-not-enabled", host);
    }

    let next: Request | undefined;
    const method = req.method.toUpperCase();
    if (this.secrets.length > 0 && req.body && method !== "GET" && method !== "HEAD") {
      // latin1 maps bytes 1:1, so non-UTF-8 bodies survive the round trip.
      const original = Buffer.from(await req.clone().arrayBuffer()).toString("latin1");
      let body = original;
      for (const s of this.secrets) {
        if (!body.includes(s.placeholder)) continue;
        if (!this.enabled(s)) this.deny("secret-not-enabled", host);
        if (!s.body) continue;
        if (!matchesHost(host, s.hosts)) this.deny("secret-not-enabled", host);
        body = body.split(s.placeholder).join(Buffer.from(s.value, "utf8").toString("latin1"));
      }
      if (body !== original) {
        const headers = new Headers(req.headers);
        headers.delete("content-length");
        next = new Request(req.url, { method: req.method, headers, body: Buffer.from(body, "latin1") });
      }
    }

    this.recordStarted(method, host, url.pathname, req.url);
    return next;
  }

  private recordStarted(method: string, host: string, path: string, url: string): void {
    const id = ++this.nextRequestId;
    const now = Date.now();
    const key = `${method} ${url}`;
    const list = this.pending.get(key) ?? [];
    list.push({ id, startedAt: now });
    this.pending.set(key, list);
    if (this.pending.size > 1000) this.prunePending(now);
    this.lastActivity = new Date(now);
    this.events.push({ case: "httpStarted", value: { requestId: id, method, host, path } });
  }

  private prunePending(now: number): void {
    for (const [k, list] of this.pending) {
      const live = list.filter((p) => now - p.startedAt < PENDING_TTL_MS);
      if (live.length === 0) this.pending.delete(k);
      else this.pending.set(k, live);
    }
  }

  private onResponse(res: Response, req: Request): undefined {
    const key = `${req.method.toUpperCase()} ${req.url}`;
    const list = this.pending.get(key);
    const p = list?.shift();
    if (list && list.length === 0) this.pending.delete(key);
    if (!p) return undefined;
    this.lastActivity = new Date();
    this.events.push({ case: "httpFinished", value: { requestId: p.id, status: res.status, durationMs: Date.now() - p.startedAt } });
    return undefined;
  }
}
