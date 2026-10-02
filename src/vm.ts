import { Code, ConnectError } from "@connectrpc/connect";
import { VM, type DebugLogFn, type HttpHooks } from "@earendil-works/gondolin";

import type { GuestConnections } from "./egress.js";
import { watchConnections } from "./netwatch.js";
import type { SandboxRecord } from "./sandboxes.js";
import { toTcpHosts } from "./tcpmaps.js";

// The rest of the service sees only this much of a Gondolin VM, which keeps
// Gondolin's types from spreading beyond this file, exec.ts, files.ts, ssh.ts
// and netwatch.ts.
export type GuestVm = Pick<VM, "exec" | "fs" | "enableSsh" | "close" | "getHostPid">;

export interface VmNetwork {
  httpHooks: HttpHooks;
  onDebug: DebugLogFn;
  connections: GuestConnections;
  useResponseHook(): void;
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
    // tcp.hosts requires per-host synthetic DNS. It is set even without
    // tcp_maps so that the guest's view of DNS does not depend on them.
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    tcp: rec.tcpMaps.length > 0 ? { hosts: toTcpHosts(rec.tcpMaps) } : undefined,
    sessionLabel: rec.id,
    // Gondolin grows the qcow2 overlay before boot and runs resize2fs in the
    // guest during start(); the base image is never touched.
    rootfs: rec.diskMib ? { size: `${rec.diskMib}M` } : undefined,
  });
  if (!watchConnections(vm, net.connections)) net.useResponseHook();
  try {
    await vm.start();
  } catch (e) {
    await vm.close().catch(() => {});
    // Whether the image has resize2fs is only known once the guest runs, so
    // this is where the missing tool surfaces (Gondolin exits 127 for it).
    if (rec.diskMib && /requires resize2fs/.test((e as Error).message)) {
      throw new ConnectError(`disk_mib needs resize2fs in the image (install e2fsprogs): ${(e as Error).message}`, Code.FailedPrecondition);
    }
    throw e;
  }
  return vm;
}
