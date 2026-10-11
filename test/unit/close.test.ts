import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { closeGuest } from "../../src/sandboxes.js";
import { GuestSsh } from "../../src/ssh.js";
import type { GuestVm } from "../../src/vm.js";

const never = () => new Promise<void>(() => {});

function fakeVm(o: { close: () => Promise<void>; pid: number | null; exec?: (argv: string[]) => void }): GuestVm {
  return {
    close: o.close,
    getHostPid: () => o.pid,
    exec: ((argv: string[]) => {
      o.exec?.(argv);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }) as unknown as GuestVm["exec"],
    fs: undefined as unknown as GuestVm["fs"],
    enableSsh: undefined as unknown as GuestVm["enableSsh"],
  };
}

function sleeper() {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((r) => child.on("exit", (_code, signal) => r(signal)));
  return { pid: child.pid!, exited, kill: () => child.kill("SIGKILL") };
}

describe("closeGuest", () => {
  it("sshとVMが上限内に閉じればQEMUを止めずに終わる", async () => {
    const qemu = sleeper();
    try {
      const order: string[] = [];
      const vm = fakeVm({ close: async () => void order.push("vm"), pid: qemu.pid });
      await closeGuest("s", vm, { close: async () => void order.push("ssh") }, 200);
      expect(order).toEqual(["ssh", "vm"]);
      const killed = await Promise.race([qemu.exited, new Promise((r) => setTimeout(() => r("alive"), 300))]);
      expect(killed).toBe("alive");
    } finally {
      qemu.kill();
    }
  });

  it("sshもVMも閉じ終わらないとき、各段の上限で先へ進みQEMUにSIGKILLを送って終わる", async () => {
    const qemu = sleeper();
    try {
      const started = Date.now();
      await closeGuest("s", fakeVm({ close: never, pid: qemu.pid }), { close: never }, 200);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await qemu.exited).toBe("SIGKILL");
    } finally {
      qemu.kill();
    }
  });

  it("sshだけが閉じ終わらなくても、VMが閉じればQEMUは止めない", async () => {
    const qemu = sleeper();
    try {
      await closeGuest("s", fakeVm({ close: async () => {}, pid: qemu.pid }), { close: never }, 200);
      const killed = await Promise.race([qemu.exited, new Promise((r) => setTimeout(() => r("alive"), 300))]);
      expect(killed).toBe("alive");
    } finally {
      qemu.kill();
    }
  });

  it("VMを閉じるのが失敗したときはその誤りを返す", async () => {
    await expect(closeGuest("s", fakeVm({ close: () => Promise.reject(new Error("boom")), pid: null }), undefined, 200)).rejects.toThrow("boom");
  });
});

describe("GuestSsh.close", () => {
  function sshWithLog() {
    const order: string[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-test-"));
    const identityFile = path.join(dir, "id");
    fs.writeFileSync(identityFile, "key");
    const vm = fakeVm({ close: async () => {}, pid: null, exec: (argv) => order.push(argv[2]!.includes("sshd*") ? "kill-sshd" : "prepare") });
    vm.enableSsh = (async () => ({ host: "127.0.0.1", port: 1, user: "ubuntu", identityFile, command: "", close: async () => void order.push("access-close") })) as unknown as GuestVm["enableSsh"];
    return { order, ssh: new GuestSsh(vm), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it("アクセスを閉じる前に、ゲストのsshdをセッションも含めてすべて止める", async () => {
    const t = sshWithLog();
    try {
      await t.ssh.enable("ubuntu");
      await t.ssh.close();
      expect(t.order).toEqual(["prepare", "kill-sshd", "access-close"]);
    } finally {
      t.cleanup();
    }
  });

  it("無効にした後でも、確立済みのセッションが残りうるので閉じるときにsshdを止める", async () => {
    const t = sshWithLog();
    try {
      await t.ssh.enable("ubuntu");
      await t.ssh.disable("ubuntu");
      expect(t.order).toEqual(["prepare", "access-close"]);
      await t.ssh.close();
      expect(t.order).toEqual(["prepare", "access-close", "kill-sshd"]);
    } finally {
      t.cleanup();
    }
  });

  it("sshを一度も有効にしていなければゲストに何も実行しない", async () => {
    const order: string[] = [];
    await new GuestSsh(fakeVm({ close: async () => {}, pid: null, exec: () => order.push("exec") })).close();
    expect(order).toEqual([]);
  });
});
