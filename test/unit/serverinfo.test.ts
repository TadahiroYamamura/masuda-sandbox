import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { gondolinVersion, platformString, serverInfo } from "../../src/serverinfo.js";

describe("platformString", () => {
  it("uses Go's architecture names", () => {
    expect(platformString("linux", "x64")).toBe("linux/amd64");
    expect(platformString("darwin", "arm64")).toBe("darwin/arm64");
  });

  it("passes unknown architectures through", () => {
    expect(platformString("linux", "riscv64")).toBe("linux/riscv64");
  });
});

describe("serverInfo", () => {
  const info = serverInfo();

  it("names the contract package", () => {
    expect(info.contract).toBe("masuda.sandbox.v1");
  });

  it("carries the SHA-256 of the contract text in this checkout", () => {
    const proto = readFileSync(new URL("../../proto/masuda/sandbox/v1/sandbox.proto", import.meta.url));
    expect(info.contractSha256).toBe(createHash("sha256").update(proto).digest("hex"));
  });

  it("reports the installed Gondolin version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../node_modules/@earendil-works/gondolin/package.json", import.meta.url), "utf8")) as { version: string };
    expect(gondolinVersion()).toBe(pkg.version);
    expect(info.gondolinVersion).toBe(pkg.version);
  });

  it("reports the host platform and a version", () => {
    expect(info.platform).toBe(platformString(process.platform, process.arch));
    expect(info.platform).toMatch(/^[a-z0-9]+\/[a-z0-9]+$/);
    expect(info.version).toMatch(/^(dev|\d+\.\d+\.\d+.*)$/);
  });
});
