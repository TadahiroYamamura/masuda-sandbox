import { VM, type DebugLogFn, type HttpHooks } from "@earendil-works/gondolin";

import type { SandboxRecord } from "./sandboxes.js";

// The rest of the service sees only this much of a Gondolin VM, which keeps
// Gondolin's types from spreading beyond this file and exec.ts.
export type GuestVm = Pick<VM, "exec" | "close" | "getHostPid">;

export interface VmNetwork {
  httpHooks: HttpHooks;
  onDebug: DebugLogFn;
}

export async function bootVm(rec: SandboxRecord, imageDir: string, env: Record<string, string>, net: VmNetwork): Promise<GuestVm> {
  const vm = await VM.create({
    // "net" debug is on only because refused non-HTTP flows are reported
    // nowhere else (see Egress.onDebug). It costs a formatted message per
    // packet, which was judged acceptable against losing those denials.
    sandbox: { imagePath: imageDir, debug: ["net"] },
    debugLog: net.onDebug,
    memory: `${rec.memoryMib}M`,
    cpus: rec.cpus,
    env,
    httpHooks: net.httpHooks,
    // per-host synthetic DNS is what tcp.hosts (tcp_maps, S6) needs; set now so
    // that the guest's view of DNS does not change between work orders.
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    sessionLabel: rec.id,
  });
  try {
    await vm.start();
  } catch (e) {
    await vm.close().catch(() => {});
    throw e;
  }
  return vm;
}
