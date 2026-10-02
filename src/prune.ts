import { getImageStoreDirectory, listImageRefs } from "@earendil-works/gondolin";
import fs from "node:fs/promises";
import path from "node:path";

import { readJsonFile } from "./datafile.js";
import { assetsPresent, type ImageRecord, type ImageStore } from "./images.js";
import { defaultSandboxesPath, type SandboxRecord } from "./sandboxes.js";

// An unrecorded asset directory this young may belong to a BuildImage that is still
// running in the service: gondolin build has written it but images.json does
// not list it yet.
const RECENT_MS = 30 * 60_000;

export interface PrunePlan {
  // Records to drop from images.json, with the reason.
  records: { rec: ImageRecord; reason: string }[];
  // Asset directories to delete.
  assets: { buildId: string; dir: string; bytes: number; reason: string }[];
  // Asset directories left alone although nothing in images.json keeps them.
  skipped: { buildId: string; reason: string }[];
}

// Rules:
// - records whose assets are gone are dropped;
// - among records with the same (oci_digest, arch) only the newest survives;
// - asset directories no surviving record points at are deleted, except
//   those a Gondolin ref (e.g. alpine-base:latest) or a recorded sandbox
//   still uses, and those too recent to rule out an in-flight build.
export async function planPrune(images: ImageStore, sandboxesFile: string = defaultSandboxesPath(), now: number = Date.now()): Promise<PrunePlan> {
  const plan: PrunePlan = { records: [], assets: [], skipped: [] };
  const records = await images.list();
  const usedBySandbox = new Set(((await readJsonFile<{ sandboxes?: SandboxRecord[] }>(sandboxesFile))?.sandboxes ?? []).map((s) => s.buildId));

  const keep = new Set<string>();
  const newest = new Map<string, ImageRecord>();
  for (const rec of records) {
    if (!(await assetsPresent(rec.buildId))) {
      plan.records.push({ rec, reason: "assets missing" });
      continue;
    }
    if (usedBySandbox.has(rec.buildId)) keep.add(rec.buildId);
    const key = `${rec.arch}\0${rec.ociDigest}`;
    const cur = newest.get(key);
    if (!cur || rec.createdAt > cur.createdAt) newest.set(key, rec);
  }
  for (const rec of newest.values()) keep.add(rec.buildId);
  for (const rec of records) {
    if (keep.has(rec.buildId) || plan.records.some((r) => r.rec === rec)) continue;
    plan.records.push({ rec, reason: `superseded by ${newest.get(`${rec.arch}\0${rec.ociDigest}`)!.buildId} (same oci_digest)` });
  }

  const referenced = new Set(listImageRefs().flatMap((r) => Object.values(r.targets).filter((t): t is string => typeof t === "string")));
  const objectsDir = path.join(getImageStoreDirectory(), "objects");
  const dirents = await fs.readdir(objectsDir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const d of dirents) {
    if (!d.isDirectory() || keep.has(d.name)) continue;
    if (referenced.has(d.name)) {
      plan.skipped.push({ buildId: d.name, reason: "referenced by a gondolin image ref" });
      continue;
    }
    if (usedBySandbox.has(d.name)) {
      plan.skipped.push({ buildId: d.name, reason: "used by a recorded sandbox" });
      continue;
    }
    const dir = path.join(objectsDir, d.name);
    const inRecords = records.some((r) => r.buildId === d.name);
    if (!inRecords && now - (await fs.stat(dir)).mtimeMs < RECENT_MS) {
      plan.skipped.push({ buildId: d.name, reason: "not in images.json but modified in the last 30 minutes (possibly a build in progress)" });
      continue;
    }
    plan.assets.push({ buildId: d.name, dir, bytes: await diskUsage(dir), reason: inRecords ? "its record is pruned" : "not in images.json" });
  }
  return plan;
}

export async function applyPrune(images: ImageStore, plan: PrunePlan): Promise<void> {
  // Records go first: a record without assets is reported as FailedPrecondition
  // by CreateSandbox, whereas assets deleted under a live record would not be
  // noticed until boot.
  await images.remove(new Set(plan.records.map((r) => r.rec.buildId)));
  for (const a of plan.assets) await fs.rm(a.dir, { recursive: true, force: true });
}

// Allocated bytes (like du), so sparse rootfs images are not overcounted.
async function diskUsage(p: string): Promise<number> {
  const st = await fs.lstat(p);
  if (!st.isDirectory()) return st.blocks * 512;
  let total = st.blocks * 512;
  for (const name of await fs.readdir(p)) total += await diskUsage(path.join(p, name));
  return total;
}

export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
