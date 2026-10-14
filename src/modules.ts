import { log } from "./log.js";
import type { GuestVm } from "./vm.js";

// UNPACK_MODULES_FN unpacks the kernel's modules in the guest. Gondolin copies
// them into the rootfs as .ko.gz, which neither the kernel nor a
// distribution's kmod built without zlib can load (gondolin#161), so modprobe
// fails for every module. Unpacking at build time would mean depending on
// Gondolin internals (there is no hook between copying the modules and making
// the ext4 image, and a wrapped mke2fs would silently stop working if Gondolin
// changed how it calls it), so it is done in each VM right after boot instead,
// at about 1.5s and ~100MB of disk per VM. Once Gondolin ships uncompressed
// modules there is nothing left to unpack and this does nothing.
//
// Images without depmod cannot use modules anyway and are left alone.
// Unpacked, the modules grow from ~30MB to well over 100MB, more than the
// default root disk has free, so the space is checked first: running out
// halfway would leave the disk full.
export const UNPACK_MODULES_FN = `masuda_unpack_modules() {
  dir=$1
  command -v depmod >/dev/null 2>&1 || return 0
  [ -d "$dir" ] || return 0
  need=$(find "$dir" -name '*.ko.gz' -exec gzip -lq {} + 2>/dev/null | awk '{s += $2} END {print int(s / 1024)}')
  [ "\${need:-0}" -gt 0 ] || return 0
  avail=$(df -Pk "$dir" | awk 'NR == 2 {print $4}')
  if [ "\${avail:-0}" -lt $((need + 65536)) ]; then
    echo "kernel modules left compressed: \${need}KiB needed, \${avail}KiB free" >&2
    return 0
  fi
  find "$dir" -name '*.ko.gz' -exec gunzip -f {} + && depmod -a "$(basename "$dir")"
}
`;

export const UNPACK_MODULES = `${UNPACK_MODULES_FN}masuda_unpack_modules "/lib/modules/$(uname -r)"\n`;

// unpackKernelModules runs UNPACK_MODULES as root. It must follow vm.start(),
// which is where Gondolin grows the root disk to disk_mib. A failure only
// leaves modules unusable, so it is logged rather than failing the boot.
export async function unpackKernelModules(vm: GuestVm, id: string): Promise<void> {
  try {
    const r = await vm.exec(["/bin/sh", "-c", UNPACK_MODULES]);
    const stderr = r.stderr.trim();
    if (r.exitCode !== 0) log.error("unpacking kernel modules failed", { id, exitCode: r.exitCode, stderr });
    else if (stderr) log.info("kernel modules", { id, detail: stderr });
  } catch (e) {
    log.error("unpacking kernel modules failed", { id, error: e });
  }
}
