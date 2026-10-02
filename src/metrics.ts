import fs from "node:fs/promises";

import { log } from "./log.js";
import type { SandboxRegistry } from "./sandboxes.js";

export const METRICS_INTERVAL_MS = 60_000;

// Resident set size of a host process in KiB, from /proc (Linux only).
// undefined when the process is gone or /proc is not available (macOS).
export async function rssKib(pid: number): Promise<number | undefined> {
  const status = await fs.readFile(`/proc/${pid}/status`, "utf8").catch(() => undefined);
  return status === undefined ? undefined : parseVmRss(status);
}

export function parseVmRss(status: string): number | undefined {
  const m = /^VmRSS:\s*(\d+)\s*kB\s*$/m.exec(status);
  return m ? Number(m[1]) : undefined;
}

// Kept out of ListSandboxes on purpose: these numbers are for whoever runs
// the service, not part of the API masuda programs against.
export function startMetricsLog(registry: SandboxRegistry, intervalMs: number = METRICS_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    void (async () => {
      const m = registry.metrics();
      const qemu = await Promise.all(m.vms.map(async (v) => ({ id: v.id, pid: v.pid, rssKib: v.pid === null ? undefined : await rssKib(v.pid), execs: v.execs })));
      log.info("metrics", { sandboxes: m.total, running: m.vms.length, qemu });
    })().catch((e) => log.error("metrics failed", { error: e }));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
