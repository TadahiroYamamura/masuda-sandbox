import { spawn } from "node:child_process";
import readline from "node:readline";

export class ProcessError extends Error {}

// Runs a child process and yields its stdout and stderr lines as they arrive,
// interleaved in arrival order. Completes when the process exits with 0 and
// throws ProcessError otherwise. Everything is event-driven: the service runs
// SSH forwarders and HTTP mediation in this same process, so blocking on a
// child (execFileSync and friends) would stall every live sandbox.
// Abandoning the iteration (e.g. the RPC was cancelled) kills the child.
export async function* runLines(cmd: string, args: string[], opts: { cwd?: string; signal?: AbortSignal } = {}): AsyncGenerator<string, void> {
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
  const pending: string[] = [];
  let finished: { code: number | null; signal: NodeJS.Signals | null } | { error: Error } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream, crlfDelay: Infinity }).on("line", (l) => {
      pending.push(l);
      notify();
    });
  }
  child.once("error", (error) => {
    finished ??= { error };
    notify();
  });
  child.once("close", (code, signal) => {
    finished ??= { code, signal };
    notify();
  });

  try {
    for (;;) {
      while (pending.length) yield pending.shift()!;
      if (finished) break;
      await new Promise<void>((r) => (wake = r));
    }
  } finally {
    if (!finished) child.kill("SIGTERM");
  }
  if ("error" in finished) throw new ProcessError(`${cmd}: ${finished.error.message}`);
  if (finished.code !== 0) {
    throw new ProcessError(`${cmd} exited with ${finished.code !== null ? `code ${finished.code}` : `signal ${finished.signal}`}`);
  }
}
