import { Code, ConnectError } from "@connectrpc/connect";
import os from "node:os";

import type { GuestVm } from "./vm.js";

export interface ExecSpec {
  argv: string[];
  shell: string;
  user: string;
  cwd: string;
  env: Record<string, string>;
  stdin: Uint8Array;
  pty: boolean;
  timeoutMs: number;
}

export type ExecOutput =
  | { case: "started"; value: Record<string, never> }
  | { case: "stdout"; value: Uint8Array }
  | { case: "stderr"; value: Uint8Array }
  | { case: "exited"; value: { exitCode: number; signal: string; timedOut: boolean } };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/;

// How long after the deadline the host stops waiting for the guest-side
// `timeout` to end the exec and reports it as timed out on its own.
const HOST_GRACE_MS = 10_000;

function invalid(msg: string): ConnectError {
  return new ConnectError(msg, Code.InvalidArgument);
}

// Builds the argv run in the guest. It is executed through `sh -c 'exec "$@"'`
// only to get a PATH lookup for timeout/runuser/env, whose location differs
// between distributions; the user's command itself is never re-parsed by a
// shell (argv) or parsed exactly once by `/bin/sh -lc` (shell).
//
// Layout: [timeout ...] [runuser -u <user> --] env K=V... <command>
// - The host has no way to kill a running exec (Gondolin only abandons it), so
//   the deadline is enforced inside the guest by coreutils `timeout`, which
//   signals its whole process group. KILL rather than TERM-then-KILL: with
//   `-k`, the follow-up KILL goes only to a direct child that is still alive,
//   so a grandchild ignoring TERM kept the output pipes open past the deadline
//   (seen with runuser, which exits on TERM). Commands get no chance to clean
//   up; a stuck exec was judged worse.
// - env is always passed explicitly: runuser does not carry the caller's
//   environment across reliably, and root goes through the same path so that
//   both users see exactly the same variables.
export function guestArgv(spec: ExecSpec, defaultUser: string, baseEnv: Record<string, string>): string[] {
  if (spec.argv.length > 0 && spec.shell) throw invalid("exactly one of argv and shell must be set");
  let cmd: string[];
  if (spec.argv.length > 0) {
    if (!spec.argv[0]!.startsWith("/")) throw invalid("argv[0] must be an absolute path");
    cmd = spec.argv;
  } else if (spec.shell) {
    cmd = ["/bin/sh", "-lc", spec.shell];
  } else {
    throw invalid("one of argv and shell is required");
  }

  const user = spec.user || defaultUser;
  if (!USER_NAME.test(user)) throw invalid(`invalid user ${JSON.stringify(user)}`);
  const env = { ...baseEnv, ...spec.env };
  for (const k of Object.keys(env)) if (!ENV_NAME.test(k)) throw invalid(`invalid env name ${JSON.stringify(k)}`);

  const out: string[] = [];
  if (spec.timeoutMs > 0) {
    // With a pty the command must stay in the terminal's foreground process
    // group or it is stopped on tty access; that costs killing its children.
    out.push("timeout", ...(spec.pty ? ["--foreground"] : []), "-s", "KILL", String(spec.timeoutMs / 1000));
  }
  if (user !== "root") out.push("runuser", "-u", user, "--");
  out.push("env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...cmd);
  return ["/bin/sh", "-c", 'exec "$@"', "masuda-exec", ...out];
}

const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// What an Exec gets before the image's ENV and the request's env. Without it
// the guest falls back to Gondolin's init environment (HOME=/root,
// XDG_*=/tmp/.cache etc. owned by root, PATH without /usr/local/bin), which a
// non-root user cannot write to. An unknown home (the user does not exist)
// leaves only PATH: runuser then reports the missing user itself.
export function serviceDefaultEnv(home: string | undefined): Record<string, string> {
  if (!home) return { PATH: SYSTEM_PATH };
  return {
    HOME: home,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    PATH: `${home}/.local/bin:${SYSTEM_PATH}`,
  };
}

// The image's ENV overrides the service defaults and is overridden by
// CreateSandbox.env; Exec.env is applied on top of the result in guestArgv.
// $HOME/.local/bin is then put first in whatever PATH resulted, because that
// is where the native Claude Code installs and images such as the official
// ubuntu set PATH in their ENV, which would otherwise hide it.
export function execBaseEnv(home: string | undefined, imageEnv: Record<string, string> | undefined, sandboxEnv: Record<string, string>): Record<string, string> {
  const env = { ...serviceDefaultEnv(home), ...imageEnv, ...sandboxEnv };
  if (!home) return env;
  const localBin = `${home}/.local/bin`;
  const path = env.PATH ?? "";
  // An empty entry would put the working directory on PATH.
  if (path === "") env.PATH = localBin;
  else if (path.split(":")[0] !== localBin) env.PATH = `${localBin}:${path}`;
  return env;
}

// Docker's Config.Env entries ("K=V"). Names env(1) cannot take are dropped
// rather than failing every Exec of the sandbox.
export function parseImageEnv(entries: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    const i = e.indexOf("=");
    if (i <= 0) continue;
    const k = e.slice(0, i);
    if (ENV_NAME.test(k)) out[k] = e.slice(i + 1);
  }
  return out;
}

// getent covers NSS sources other than /etc/passwd; the awk fallback is for
// images without getent.
const LOOKUP_HOME = `getent passwd "$1" 2>/dev/null | cut -d: -f6 || true
awk -F: -v u="$1" '$1 == u { print $6; exit }' /etc/passwd 2>/dev/null`;

export async function lookupHome(vm: GuestVm, user: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!USER_NAME.test(user)) return undefined;
  const r = await vm.exec(["/bin/sh", "-c", LOOKUP_HOME, "masuda-home", user], { signal });
  return r.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("/"));
}

export const MAX_CONCURRENT_EXECS = 8;

// Caps how many Execs one sandbox runs at once. Gondolin multiplexes them over
// one virtio channel to a single guest daemon, so an unbounded caller (a loop
// that never waits) would starve the sandbox's other users.
export class ExecSlots {
  private used = 0;

  constructor(private readonly max: number = MAX_CONCURRENT_EXECS) {}

  get inUse(): number {
    return this.used;
  }

  acquire(): () => void {
    if (this.used >= this.max) throw new ConnectError(`too many concurrent execs (limit ${this.max})`, Code.ResourceExhausted);
    this.used += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= 1;
    };
  }
}

const signalNames = new Map<number, string>(Object.entries(os.constants.signals).map(([name, num]) => [num, name]));

export async function* runExec(vm: GuestVm, spec: ExecSpec, defaultUser: string, baseEnv: Record<string, string>, signal: AbortSignal): AsyncGenerator<ExecOutput> {
  const argv = guestArgv(spec, defaultUser, baseEnv);
  const ac = new AbortController();
  const onCancel = () => ac.abort();
  signal.addEventListener("abort", onCancel, { once: true });
  let hostTimedOut = false;
  const hostTimer = spec.timeoutMs > 0
    ? setTimeout(() => {
        hostTimedOut = true;
        ac.abort();
      }, spec.timeoutMs + HOST_GRACE_MS)
    : undefined;
  const started = Date.now();
  try {
    const proc = vm.exec(argv, {
      cwd: spec.cwd || undefined,
      stdin: Buffer.from(spec.stdin),
      pty: spec.pty,
      stdout: "pipe",
      stderr: "pipe",
      signal: ac.signal,
    });
    const result = proc.result;
    result.catch(() => {});
    yield { case: "started", value: {} };
    for await (const chunk of proc.output()) {
      // A pty yields one merged stream; the contract puts it all on stdout.
      yield { case: spec.pty || chunk.stream === "stdout" ? "stdout" : "stderr", value: chunk.data };
    }
    let r;
    try {
      r = await result;
    } catch (e) {
      if (hostTimedOut) {
        yield { case: "exited", value: { exitCode: -1, signal: "", timedOut: true } };
        return;
      }
      if (signal.aborted) throw new ConnectError("exec cancelled", Code.Canceled);
      throw new ConnectError(`exec failed: ${(e as Error).message}`, Code.Internal);
    }
    const sig = r.signal !== undefined ? (signalNames.get(r.signal) ?? String(r.signal)) : "";
    // timeout(1) also kills itself with the group, so a timed-out exec ends
    // as 128+KILL; 124 is what it reports when --foreground spares it.
    const timedOut = spec.timeoutMs > 0 && Date.now() - started >= spec.timeoutMs && (r.exitCode === 137 || r.exitCode === 124 || sig === "SIGKILL");
    yield { case: "exited", value: { exitCode: r.exitCode, signal: sig, timedOut } };
  } finally {
    clearTimeout(hostTimer);
    signal.removeEventListener("abort", onCancel);
    ac.abort();
  }
}
