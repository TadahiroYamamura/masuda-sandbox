import { describe, expect, it } from "vitest";

import { guestArgv, type ExecSpec } from "../../src/exec.js";

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
