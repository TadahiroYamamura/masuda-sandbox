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

// env is the image's Config.Env ("K=V" entries), which Exec starts from.
export type BuildEvent =
  | { log: string }
  | { built: { buildId: string; ociDigest: string; env: string[] } }
  | { reused: { buildId: string; ociDigest: string; env: string[] } };

export function hostArch(): Arch {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

export function parseArch(s: string): Arch | undefined {
  if (s === "") return hostArch();
  return s === "x86_64" || s === "aarch64" ? s : undefined;
}

const dockerPlatform: Record<Arch, string> = { x86_64: "linux/amd64", aarch64: "linux/arm64" };

// The build runs in a child instead of calling buildAssets() and
// importImageFromDirectory() in-process: both use execFileSync and synchronous
// fs copies of the multi-GB rootfs, which would freeze the event loop shared
// with running sandboxes. Why the child is our own script rather than the
// gondolin CLI is in gondolin-build.ts.
const buildChild = fileURLToPath(new URL("./gondolin-build.js", import.meta.url));

async function imageEnv(ociDigest: string, signal?: AbortSignal): Promise<string[]> {
  let out = "";
  for await (const l of runLines("docker", ["image", "inspect", "--format", "{{json .Config.Env}}", ociDigest], { signal })) out += l;
  const parsed: unknown = JSON.parse(out);
  return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
}

// The extracted rootfs may hold directories without the owner's write bit,
// which a plain recursive rm cannot empty.
async function removeTree(dir: string): Promise<void> {
  try {
    for await (const _ of runLines("chmod", ["-R", "u+w", dir])) void _;
  } catch {
    // Best effort: the rm below reports what is still in the way.
  }
  await fs.rm(dir, { recursive: true, force: true });
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
    const env = await imageEnv(ociDigest, req.signal);

    const existing = await req.reusable?.(ociDigest);
    if (existing) {
      yield { log: `==> reusing existing gondolin assets ${existing} for ${ociDigest} (gondolin build skipped)` };
      yield { reused: { buildId: existing, ociDigest, env } };
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
    // TMPDIR keeps any other temporary files Gondolin makes inside tmp too.
    const childEnv = { ...process.env, TMPDIR: tmp };
    const args = [buildChild, configPath, path.join(tmp, "work"), path.join(tmp, "out")];
    for await (const l of runLines(process.execPath, args, { signal: req.signal, env: childEnv })) {
      const m = /^\s*Build ID:\s*(\S+)\s*$/.exec(l);
      if (m) buildId = m[1];
      yield { log: l };
    }
    if (!buildId) throw new Error("gondolin build succeeded but printed no build id");
    yield { built: { buildId, ociDigest, env } };
  } finally {
    await removeTree(tmp);
  }
}
