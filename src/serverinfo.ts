import { create } from "@bufbuild/protobuf";
import { createRequire } from "node:module";

import { ServerInfoSchema, file_masuda_sandbox_v1_sandbox, type ServerInfo } from "./gen/masuda/sandbox/v1/sandbox_pb.js";
import { CONTRACT_SHA256, VERSION } from "./version.js";

// Go's GOARCH spelling, because the clients (masuda) are Go and compare
// platforms in that vocabulary.
const ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "arm" };

export function platformString(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}/${ARCH[arch] ?? arch}`;
}

// Read at run time rather than embedded at build time: Gondolin is not bundled
// and the installer may resolve a different patch version than the one the
// tarball was built against.
export function gondolinVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("@earendil-works/gondolin/package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function serverInfo(): ServerInfo {
  return create(ServerInfoSchema, {
    version: VERSION,
    contract: file_masuda_sandbox_v1_sandbox.proto.package,
    contractSha256: CONTRACT_SHA256,
    gondolinVersion: gondolinVersion(),
    platform: platformString(),
  });
}
