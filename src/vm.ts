import { VM } from "@earendil-works/gondolin";

import type { SandboxRecord } from "./sandboxes.js";

// The rest of the service sees only this much of a Gondolin VM, which keeps
// Gondolin's types from spreading beyond this file and exec.ts.
export type GuestVm = Pick<VM, "exec" | "close" | "getHostPid">;

export async function bootVm(rec: SandboxRecord, imageDir: string): Promise<GuestVm> {
  const vm = await VM.create({
    sandbox: { imagePath: imageDir },
    memory: `${rec.memoryMib}M`,
    cpus: rec.cpus,
    env: rec.env,
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
