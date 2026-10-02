import { describe, expect, it } from "vitest";

import { execBaseEnv, guestArgv, lookupHome, parseImageEnv, serviceDefaultEnv, type ExecSpec } from "../../src/exec.js";
import type { GuestVm } from "../../src/vm.js";

const spec = (s: Partial<ExecSpec>): ExecSpec => ({ argv: [], shell: "", user: "", cwd: "", env: {}, stdin: new Uint8Array(), pty: false, timeoutMs: 0, ...s });
const PREFIX = ["/bin/sh", "-c", 'exec "$@"', "masuda-exec"];

describe("guestArgv", () => {
  it("switches to the default user and passes env explicitly", () => {
    expect(guestArgv(spec({ shell: "echo hi", env: { B: "2" } }), "ubuntu", { A: "1" })).toEqual([
      ...PREFIX, "runuser", "-u", "ubuntu", "--", "env", "A=1", "B=2", "/bin/sh", "-lc", "echo hi",
    ]);
  });

  it("does not wrap root in runuser", () => {
    expect(guestArgv(spec({ argv: ["/bin/echo", "a b"], user: "root" }), "ubuntu", {})).toEqual([...PREFIX, "env", "/bin/echo", "a b"]);
  });

  it("request env overrides sandbox env", () => {
    expect(guestArgv(spec({ argv: ["/bin/true"], user: "root", env: { A: "x" } }), "ubuntu", { A: "1" })).toEqual([...PREFIX, "env", "A=x", "/bin/true"]);
  });

  it("enforces the timeout in the guest", () => {
    expect(guestArgv(spec({ argv: ["/bin/true"], user: "root", timeoutMs: 1500 }), "ubuntu", {})).toEqual([...PREFIX, "timeout", "-s", "KILL", "1.5", "env", "/bin/true"]);
    expect(guestArgv(spec({ argv: ["/bin/true"], user: "root", timeoutMs: 1500, pty: true }), "ubuntu", {}).slice(4, 6)).toEqual(["timeout", "--foreground"]);
  });

  it("rejects malformed requests", () => {
    expect(() => guestArgv(spec({}), "ubuntu", {})).toThrow(/required/);
    expect(() => guestArgv(spec({ argv: ["/bin/true"], shell: "true" }), "ubuntu", {})).toThrow(/exactly one/);
    expect(() => guestArgv(spec({ argv: ["true"] }), "ubuntu", {})).toThrow(/absolute/);
    expect(() => guestArgv(spec({ shell: "true", env: { "A=B": "x" } }), "ubuntu", {})).toThrow(/env name/);
    expect(() => guestArgv(spec({ shell: "true", user: "-x" }), "ubuntu", {})).toThrow(/user/);
  });
});

describe("default exec environment", () => {
  const SYSTEM = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

  it("derives HOME, XDG dirs and PATH from the user's home", () => {
    expect(serviceDefaultEnv("/home/ubuntu")).toEqual({
      HOME: "/home/ubuntu",
      XDG_CACHE_HOME: "/home/ubuntu/.cache",
      XDG_CONFIG_HOME: "/home/ubuntu/.config",
      XDG_DATA_HOME: "/home/ubuntu/.local/share",
      PATH: `/home/ubuntu/.local/bin:${SYSTEM}`,
    });
  });

  it("falls back to the system PATH alone when the home is unknown", () => {
    expect(serviceDefaultEnv(undefined)).toEqual({ PATH: SYSTEM });
  });

  it("layers service defaults < image ENV < sandbox env", () => {
    const env = execBaseEnv("/root", { PATH: "/opt/go/bin:/usr/bin", GOPATH: "/go", A: "image" }, { A: "sandbox" });
    expect(env.PATH).toBe("/opt/go/bin:/usr/bin");
    expect(env.GOPATH).toBe("/go");
    expect(env.A).toBe("sandbox");
    expect(env.HOME).toBe("/root");
    expect(env.XDG_CACHE_HOME).toBe("/root/.cache");
  });

  it("lets Exec.env override everything", () => {
    const base = execBaseEnv("/home/ubuntu", { PATH: "/img" }, { PATH: "/sb" });
    const argv = guestArgv(spec({ argv: ["/bin/true"], user: "root", env: { PATH: "/req" } }), "ubuntu", base);
    expect(argv).toContain("PATH=/req");
    expect(argv.filter((a) => a.startsWith("PATH="))).toHaveLength(1);
  });

  it("parses Docker Config.Env entries", () => {
    expect(parseImageEnv(["PATH=/a:/b", "EMPTY=", "EQ=x=y", "bad name=1", "=v", "NOEQ"])).toEqual({ PATH: "/a:/b", EMPTY: "", EQ: "x=y" });
  });

  it("reads the home directory from the guest", async () => {
    const calls: string[][] = [];
    const vm = {
      exec: async (argv: string[]) => {
        calls.push(argv);
        return { exitCode: 0, stdout: argv.at(-1) === "ubuntu" ? "/home/ubuntu\n/home/ubuntu\n" : "", stderr: "" };
      },
    } as unknown as GuestVm;
    expect(await lookupHome(vm, "ubuntu")).toBe("/home/ubuntu");
    expect(await lookupHome(vm, "nobody-here")).toBeUndefined();
    expect(await lookupHome(vm, "-x")).toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});
