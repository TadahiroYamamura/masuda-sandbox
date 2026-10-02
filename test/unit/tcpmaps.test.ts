import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { toTcpHosts, validateTcpMaps } from "../../src/tcpmaps.js";

function code(fn: () => unknown): Code | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ConnectError ? e.code : undefined;
  }
  return undefined;
}

describe("validateTcpMaps", () => {
  it("accepts loopback upstreams and normalizes host names", () => {
    const maps = validateTcpMaps([
      { host: "Masuda.Internal.", port: 0, upstream: "127.0.0.1:39301" },
      { host: "masuda.internal", port: 8080, upstream: "localhost:80" },
      { host: "other", port: 0, upstream: "[::1]:443" },
      { host: "x", port: 0, upstream: "127.9.9.9:1" },
    ]);
    expect(toTcpHosts(maps)).toEqual({
      "masuda.internal": "127.0.0.1:39301",
      "masuda.internal:8080": "localhost:80",
      other: "[::1]:443",
      x: "127.9.9.9:1",
    });
  });

  it.each([
    ["10.0.0.1:80"],
    ["192.168.127.1:80"],
    ["example.com:80"],
    ["[::2]:80"],
    ["0.0.0.0:80"],
    ["127.0.0.1"],
    ["127.0.0.1:0"],
    ["127.0.0.1:70000"],
    [""],
  ])("rejects upstream %s", (upstream) => {
    expect(code(() => validateTcpMaps([{ host: "a", port: 0, upstream }]))).toBe(Code.InvalidArgument);
  });

  it.each([[""], ["a:80"], ["*.x"], ["127.0.0.1"], ["[::1]"]])("rejects host %s", (host) => {
    expect(code(() => validateTcpMaps([{ host, port: 0, upstream: "127.0.0.1:1" }]))).toBe(Code.InvalidArgument);
  });

  it("rejects duplicates and out-of-range ports", () => {
    expect(code(() => validateTcpMaps([{ host: "a", port: 0, upstream: "127.0.0.1:1" }, { host: "A.", port: 0, upstream: "127.0.0.1:2" }]))).toBe(Code.InvalidArgument);
    expect(code(() => validateTcpMaps([{ host: "a", port: 65536, upstream: "127.0.0.1:1" }]))).toBe(Code.InvalidArgument);
  });
});
