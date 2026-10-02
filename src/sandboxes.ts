import { create } from "@bufbuild/protobuf";
import { timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import path from "node:path";

import { dataDir, readJsonFile, writeJsonFile } from "./datafile.js";
import { Egress, validatePolicy } from "./egress.js";
import { EventQueue } from "./events.js";
import { PolicySchema, SandboxSchema, SandboxState, type Sandbox, type SandboxEvent, type SecretDecl } from "./gen/masuda/sandbox/v1/sandbox_pb.js";
import { ExecSlots } from "./exec.js";
import { log } from "./log.js";
import { GuestSsh, type SshInfo } from "./ssh.js";
import { bootVm, type GuestVm } from "./vm.js";

export interface PolicyRecord {
  allowedHosts: string[];
  enabledSecrets: string[];
}

export interface TcpMapRecord {
  host: string;
  port: number;
  upstream: string;
}

export interface SshEgressRecord {
  allowedHosts: string[];
  agentSocket: string;
  knownHostsFile: string;
  pushAllowedRefs: string[];
}

// What sandboxes.json holds. Secret values are deliberately absent: only their
// names are written, so the file never becomes a second copy of credentials.
export interface SandboxRecord {
  id: string;
  buildId: string;
  createdAt: string; // ISO 8601
  defaultUser: string;
  memoryMib: number;
  cpus: number;
  env: Record<string, string>;
  policy: PolicyRecord;
  secretNames: string[];
  tcpMaps: TcpMapRecord[];
  sshEgress?: SshEgressRecord;
}

interface SandboxesFile {
  sandboxes: SandboxRecord[];
}

interface Entry {
  record: SandboxRecord;
  state: SandboxState;
  failure: string;
  // Absent for sandboxes restored as STOPPED: secret values are not persisted.
  egress?: Egress;
  events: EventQueue;
  execSlots: ExecSlots;
  vm?: GuestVm;
  ssh?: GuestSsh;
  monitor?: NodeJS.Timeout;
  // Settles when boot finished either way; destroy waits on it so that a VM
  // still booting is not left running behind a removed entry.
  ready: Promise<void>;
  destroyed: boolean;
}

export interface RunningSandbox {
  record: SandboxRecord;
  vm: GuestVm;
  execSlots: ExecSlots;
  // record.env plus the secret placeholders; what every Exec starts from.
  env: Record<string, string>;
}

export function defaultSandboxesPath(): string {
  return path.join(dataDir(), "sandboxes.json");
}

export class SandboxRegistry {
  private readonly entries = new Map<string, Entry>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string = defaultSandboxesPath()) {}

  // Every recorded sandbox is STOPPED after a restart: its VM belonged to the
  // previous process and died with it (or was collected by gcSessions).
  async load(): Promise<void> {
    const parsed = await readJsonFile<Partial<SandboxesFile>>(this.file);
    for (const record of Array.isArray(parsed?.sandboxes) ? parsed.sandboxes : []) {
      const events = new EventQueue();
      events.close();
      this.entries.set(record.id, { record, state: SandboxState.STOPPED, failure: "", events, execSlots: new ExecSlots(), ready: Promise.resolve(), destroyed: false });
    }
  }

  list(): Sandbox[] {
    return [...this.entries.values()].map(snapshot);
  }

  get(id: string): Sandbox | undefined {
    const e = this.entries.get(id);
    return e && snapshot(e);
  }

  metrics(): { total: number; vms: { id: string; pid: number | null; execs: number }[] } {
    const all = [...this.entries.values()];
    const vms = all.filter((e) => e.state === SandboxState.RUNNING && e.vm).map((e) => ({ id: e.record.id, pid: e.vm!.getHostPid(), execs: e.execSlots.inUse }));
    return { total: all.length, vms };
  }

  watchEvents(id: string, afterSeq: bigint, signal: AbortSignal): AsyncGenerator<SandboxEvent> {
    const e = this.entries.get(id);
    if (!e) throw new ConnectError(`sandbox ${JSON.stringify(id)} not found`, Code.NotFound);
    return e.events.watch(afterSeq, signal);
  }

  running(id: string): RunningSandbox {
    const e = this.runningEntry(id);
    return { record: e.record, vm: e.vm!, execSlots: e.execSlots, env: guestEnv(e) };
  }

  private runningEntry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new ConnectError(`sandbox ${JSON.stringify(id)} not found`, Code.NotFound);
    if (e.state !== SandboxState.RUNNING || !e.vm) throw new ConnectError(`sandbox ${JSON.stringify(id)} is not running`, Code.FailedPrecondition);
    return e;
  }

  // A STOPPED or FAILED record with the same id is replaced: the contract only
  // requires uniqueness among live sandboxes, and masuda reuses workspace ids.
  async create(record: SandboxRecord, secrets: SecretDecl[], imageDir: string): Promise<Sandbox> {
    const prev = this.entries.get(record.id);
    if (prev && (prev.state === SandboxState.STARTING || prev.state === SandboxState.RUNNING)) {
      throw new ConnectError(`sandbox ${JSON.stringify(record.id)} already exists`, Code.AlreadyExists);
    }
    for (const s of secrets) {
      if (s.name in record.env) throw new ConnectError(`secret ${JSON.stringify(s.name)} collides with an env variable of the same name`, Code.InvalidArgument);
    }
    const events = new EventQueue();
    const egress = new Egress(secrets, record.policy, events);
    record.policy = egress.currentPolicy;
    let settle!: () => void;
    const entry: Entry = { record, state: SandboxState.STARTING, failure: "", egress, events, execSlots: new ExecSlots(), ready: new Promise((r) => (settle = r)), destroyed: false };
    this.entries.set(record.id, entry);
    setState(entry, SandboxState.STARTING, "");
    try {
      await this.persist();
      entry.vm = await bootVm(record, imageDir, guestEnv(entry), egress);
      entry.ssh = new GuestSsh(entry.vm);
      if (entry.destroyed) throw new ConnectError(`sandbox ${JSON.stringify(record.id)} was destroyed while starting`, Code.Aborted);
      setState(entry, SandboxState.RUNNING, "");
      this.monitor(entry);
      log.info("sandbox running", { id: record.id, buildId: record.buildId, pid: entry.vm.getHostPid() });
      return snapshot(entry);
    } catch (e) {
      if (!entry.destroyed && this.entries.get(record.id) === entry) {
        this.entries.delete(record.id);
        await this.persist().catch((pe) => log.error("persist failed", { error: pe }));
      }
      await entry.vm?.close().catch(() => {});
      entry.events.close();
      throw e;
    } finally {
      settle();
    }
  }

  // Takes effect from the next request: the hooks read the policy per request.
  async setPolicy(id: string, policy: PolicyRecord): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new ConnectError(`sandbox ${JSON.stringify(id)} not found`, Code.NotFound);
    if (e.egress) {
      e.egress.setPolicy(policy);
      e.record.policy = e.egress.currentPolicy;
    } else {
      e.record.policy = validatePolicy(policy, e.record.secretNames);
    }
    await this.persist();
  }

  enableSsh(id: string, user: string): Promise<SshInfo> {
    const e = this.runningEntry(id);
    return e.ssh!.enable(user || e.record.defaultUser);
  }

  async disableSsh(id: string, user: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new ConnectError(`sandbox ${JSON.stringify(id)} not found`, Code.NotFound);
    await e.ssh?.disable(user || e.record.defaultUser);
  }

  async destroy(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    e.destroyed = true;
    this.entries.delete(id);
    await this.persist();
    await e.ready;
    await closeVm(e);
    if (e.state === SandboxState.RUNNING) setState(e, SandboxState.STOPPED, "destroyed");
    e.events.close();
    log.info("sandbox destroyed", { id });
  }

  // Shutdown closes VMs but keeps the records, so that after a restart the
  // sandboxes show up as STOPPED instead of vanishing.
  async shutdown(): Promise<{ id: string; error: unknown }[]> {
    const entries = [...this.entries.values()];
    const results = await Promise.allSettled(
      entries.map(async (e) => {
        await e.ready;
        await closeVm(e);
        if (e.state === SandboxState.RUNNING) setState(e, SandboxState.STOPPED, "service shutdown");
        else e.state = SandboxState.STOPPED;
        e.events.close();
      }),
    );
    return results.flatMap((r, i) => (r.status === "rejected" ? [{ id: entries[i]!.record.id, error: r.reason }] : []));
  }

  // Gondolin exposes no event for its QEMU process dying (the controller's
  // "exit" stays internal), so the runner PID is polled. The poll is cheap and
  // a few seconds of delay in noticing a crash is acceptable to callers.
  private monitor(e: Entry): void {
    e.monitor = setInterval(() => {
      if (e.state !== SandboxState.RUNNING || !e.vm) return;
      const pid = e.vm.getHostPid();
      if (pid !== null && processAlive(pid)) return;
      clearInterval(e.monitor);
      e.monitor = undefined;
      const detail = pid === null ? "qemu process exited" : `qemu process ${pid} exited`;
      e.failure = detail;
      setState(e, SandboxState.FAILED, detail);
      log.error("sandbox failed", { id: e.record.id, detail });
      void closeVm(e)
        .catch((err) => log.error("closing failed sandbox failed", { id: e.record.id, error: err }))
        .finally(() => e.events.close());
    }, MONITOR_INTERVAL_MS);
    e.monitor.unref();
  }

  // Writes are chained so that concurrent create/destroy calls cannot lose
  // each other's change through interleaved read-modify-write.
  private persist(): Promise<void> {
    const op = this.queue.then(() => writeJsonFile(this.file, { sandboxes: [...this.entries.values()].map((e) => e.record) } satisfies SandboxesFile));
    this.queue = op.catch(() => {});
    return op;
  }
}

// vm.close() also closes Gondolin's current ssh access, but an EnableSsh still
// in flight would open its host-side forwarder afterwards; closing GuestSsh
// first makes that late access close itself.
async function closeVm(e: Entry): Promise<void> {
  clearInterval(e.monitor);
  e.monitor = undefined;
  await e.ssh?.close().catch((err) => log.error("closing ssh access failed", { id: e.record.id, error: err }));
  if (e.vm) await e.vm.close();
}

const MONITOR_INTERVAL_MS = 5_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function setState(e: Entry, state: SandboxState, detail: string): void {
  e.state = state;
  e.events.push({ case: "stateChanged", value: { state, detail } });
}

function guestEnv(e: Entry): Record<string, string> {
  return { ...e.record.env, ...e.egress?.placeholders };
}

function snapshot(e: Entry): Sandbox {
  return create(SandboxSchema, {
    id: e.record.id,
    state: e.state,
    buildId: e.record.buildId,
    createdAt: timestampFromDate(new Date(e.record.createdAt)),
    placeholders: { ...e.egress?.placeholders },
    policy: create(PolicySchema, e.record.policy),
    failure: e.failure,
    ...activity(e),
  });
}

function activity(e: Entry): { lastHttpActivity?: Timestamp; inflightHttpRequests: number } {
  const a = e.egress?.activity();
  if (!a) return { inflightHttpRequests: 0 };
  // Nothing is in flight once the VM is gone, whatever the bookkeeping says.
  const inflight = e.state === SandboxState.RUNNING ? a.inflight : 0;
  return { lastHttpActivity: a.last && timestampFromDate(a.last), inflightHttpRequests: inflight };
}
