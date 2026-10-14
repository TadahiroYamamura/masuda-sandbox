import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UNPACK_MODULES, UNPACK_MODULES_FN } from "../../src/modules.js";

const run = promisify(execFile);

let tmp: string;
let bin: string;
let mods: string;

// fakeDf はdfの代わりに、空きをfreeKiBとして`df -Pk`の形で出す。
async function fakeDf(freeKiB: number): Promise<void> {
  await fs.writeFile(
    path.join(bin, "df"),
    `#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/vda 999999 1 ${freeKiB} 1% /"\n`,
    { mode: 0o755 },
  );
}

// fakeDepmod はdepmodの代わりに、受け取った引数をmodsの隣に書き残す。
async function fakeDepmod(): Promise<void> {
  await fs.writeFile(path.join(bin, "depmod"), `#!/bin/sh\necho "$@" > "${tmp}/depmod.args"\n`, { mode: 0o755 });
}

async function unpack(): Promise<{ stderr: string }> {
  const script = `${UNPACK_MODULES_FN}masuda_unpack_modules "${mods}"\n`;
  return run("/bin/sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin` } });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "masuda-unpack-test-"));
  bin = path.join(tmp, "bin");
  mods = path.join(tmp, "6.18.54-0-virt");
  await fs.mkdir(bin);
  await fs.mkdir(path.join(mods, "kernel", "fs"), { recursive: true });
  // 展開すると1MiB（1024KiB）になるモジュールが2つ
  for (const name of ["overlay.ko.gz", "bridge.ko.gz"]) {
    await fs.writeFile(path.join(mods, "kernel", "fs", name), gzipSync(Buffer.alloc(1024 * 1024, 7)));
  }
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("UNPACK_MODULES_FN", () => {
  it("depmodがあり空きが足りれば、.ko.gzを展開してその版でdepmodする", async () => {
    await fakeDepmod();
    // 要る量は2048KiBと余裕の65536KiB
    await fakeDf(2048 + 65536);
    await unpack();
    expect((await fs.readdir(path.join(mods, "kernel", "fs"))).sort()).toEqual(["bridge.ko", "overlay.ko"]);
    expect((await fs.stat(path.join(mods, "kernel", "fs", "overlay.ko"))).size).toBe(1024 * 1024);
    expect((await fs.readFile(path.join(tmp, "depmod.args"), "utf8")).trim()).toBe("-a 6.18.54-0-virt");
  });

  it("空きが展開後の大きさと余裕に1KiBでも足りなければ、展開せずに理由を出す", async () => {
    await fakeDepmod();
    await fakeDf(2048 + 65536 - 1);
    const { stderr } = await unpack();
    expect((await fs.readdir(path.join(mods, "kernel", "fs"))).sort()).toEqual(["bridge.ko.gz", "overlay.ko.gz"]);
    expect(stderr).toContain("kernel modules left compressed: 2048KiB needed, 67583KiB free");
    await expect(fs.access(path.join(tmp, "depmod.args"))).rejects.toThrow();
  });

  it("depmodの無いイメージでは何もしない", async () => {
    await fakeDf(1 << 30);
    await unpack();
    expect((await fs.readdir(path.join(mods, "kernel", "fs"))).sort()).toEqual(["bridge.ko.gz", "overlay.ko.gz"]);
  });

  it("展開済みで.ko.gzが無ければdepmodも流さない", async () => {
    await fakeDepmod();
    await fakeDf(1 << 30);
    await unpack();
    await fs.rm(path.join(tmp, "depmod.args"));
    await unpack();
    await expect(fs.access(path.join(tmp, "depmod.args"))).rejects.toThrow();
  });

  it("VMで流すスクリプトは、動いているカーネルの版のディレクトリで関数を呼ぶ", () => {
    expect(UNPACK_MODULES).toContain(UNPACK_MODULES_FN);
    expect(UNPACK_MODULES.trimEnd().endsWith('masuda_unpack_modules "/lib/modules/$(uname -r)"')).toBe(true);
  });
});
