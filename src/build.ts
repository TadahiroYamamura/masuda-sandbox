import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runLines } from "./proc.js";

export type Arch = "x86_64" | "aarch64";

export interface BuildRequest {
  contextDir: string;
  dockerfile: string;
  name: string;
  arch: Arch;
  signal?: AbortSignal;
  // Returns the build id of existing Gondolin assets made from this OCI
  // digest, if any; the Gondolin step (~400MB of new assets) is then skipped.
  reusable?: (ociDigest: string) => Promise<string | undefined>;
}

export type BuildEvent =
  | { log: string }
  | { built: { buildId: string; ociDigest: string } }
  | { reused: { buildId: string; ociDigest: string } };

export function hostArch(): Arch {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

export function parseArch(s: string): Arch | undefined {
  if (s === "") return hostArch();
  return s === "x86_64" || s === "aarch64" ? s : undefined;
}

const dockerPlatform: Record<Arch, string> = { x86_64: "linux/amd64", aarch64: "linux/arm64" };

// The CLI is run as a child instead of calling buildAssets() and
// importImageFromDirectory() in-process: both use execFileSync and synchronous
// fs copies of the multi-GB rootfs, which would freeze the event loop shared
// with running sandboxes.
function gondolinBin(): string {
  const index = fileURLToPath(import.meta.resolve("@earendil-works/gondolin"));
  return path.resolve(path.dirname(index), "..", "bin", "gondolin.js");
}

export async function* buildImage(req: BuildRequest): AsyncGenerator<BuildEvent, void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "masuda-sandbox-build-"));
  try {
    const iidFile = path.join(tmp, "iid");
    yield { log: `==> docker build ${req.contextDir} (${dockerPlatform[req.arch]})` };
    // With the containerd image store, the default provenance attestation
    // gives a fully cached rebuild a new image id every time; without it the
    // id (recorded as oci_digest) is stable for unchanged input.
    for await (const l of runLines(
      "docker",
      ["build", "--progress=plain", "--provenance=false", "--platform", dockerPlatform[req.arch], "--iidfile", iidFile, "-f", path.resolve(req.contextDir, req.dockerfile), req.contextDir],
      { signal: req.signal },
    )) {
      yield { log: l };
    }
    const ociDigest = (await fs.readFile(iidFile, "utf8")).trim();

    const existing = await req.reusable?.(ociDigest);
    if (existing) {
      yield { log: `==> reusing existing gondolin assets ${existing} for ${ociDigest} (gondolin build skipped)` };
      yield { reused: { buildId: existing, ociDigest } };
      return;
    }

    // Gondolin's OCI importer takes an image reference rather than a bare
    // image id, so the result gets a tag derived from its digest. Identical
    // builds map to the same tag, so tags do not pile up on rebuilds.
    const tag = `masuda-sandbox/image:${req.arch}-${ociDigest.replace(/^sha256:/, "").slice(0, 16)}`;
    yield { log: `==> docker tag ${ociDigest} ${tag}` };
    for await (const l of runLines("docker", ["tag", ociDigest, tag], { signal: req.signal })) yield { log: l };

    const config = {
      arch: req.arch,
      distro: "alpine",
      oci: { image: tag, runtime: "docker", pullPolicy: "never" },
      rootfs: { label: "gondolin-root" },
      runtimeDefaults: { rootfsMode: "cow" },
    };
    const configPath = path.join(tmp, "build-config.json");
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    yield { log: `==> gondolin build (${tag})` };
    let buildId: string | undefined;
    for await (const l of runLines(process.execPath, [gondolinBin(), "build", "--config", configPath], { signal: req.signal })) {
      const m = /^\s*Build ID:\s*(\S+)\s*$/.exec(l);
      if (m) buildId = m[1];
      yield { log: l };
    }
    if (!buildId) throw new Error("gondolin build succeeded but printed no build id");
    yield { built: { buildId, ociDigest } };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
