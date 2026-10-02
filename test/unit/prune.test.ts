import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ImageStore, type ImageRecord } from "../../src/images.js";
import { applyPrune, planPrune } from "../../src/prune.js";

const id = (n: number) => `00000000-0000-5000-8000-${String(n).padStart(12, "0")}`;
const rec = (n: number, createdAt: string, ociDigest = "sha256:aaa"): ImageRecord => ({ buildId: id(n), name: "t", arch: "x86_64", createdAt, ociDigest });

let tmp: string;
let store: ImageStore;
let sandboxesFile: string;
const old = Date.parse("2026-01-01T00:00:00Z");
const now = Date.parse("2026-01-02T00:00:00Z");

async function asset(n: number, mtime = old): Promise<void> {
  const dir = path.join(tmp, "store", "objects", id(n));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "rootfs.ext4"), "x".repeat(8192));
  await fs.utimes(dir, mtime / 1000, mtime / 1000);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "masuda-prune-test-"));
  process.env.GONDOLIN_IMAGE_STORE = path.join(tmp, "store");
  store = new ImageStore(path.join(tmp, "images.json"));
  sandboxesFile = path.join(tmp, "sandboxes.json");
});

afterEach(async () => {
  delete process.env.GONDOLIN_IMAGE_STORE;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("ImageStore.findReusable", () => {
  it("returns the newest record of the digest whose assets exist", async () => {
    await store.record(rec(1, "2026-01-01T00:00:01Z"));
    await store.record(rec(2, "2026-01-01T00:00:02Z"));
    await store.record(rec(3, "2026-01-01T00:00:03Z"));
    await asset(1);
    await asset(2);
    expect((await store.findReusable("sha256:aaa", "x86_64"))?.buildId).toBe(id(2));
    expect(await store.findReusable("sha256:aaa", "aarch64")).toBeUndefined();
    expect(await store.findReusable("sha256:bbb", "x86_64")).toBeUndefined();
  });
});

describe("planPrune", () => {
  it("keeps the newest record per digest and removes duplicates, dangling records and orphans", async () => {
    await store.record(rec(1, "2026-01-01T00:00:01Z"));
    await store.record(rec(2, "2026-01-01T00:00:02Z"));
    await store.record(rec(3, "2026-01-01T00:00:03Z", "sha256:bbb")); // assets missing
    await store.record(rec(4, "2026-01-01T00:00:04Z", "sha256:ccc"));
    for (const n of [1, 2, 4, 5]) await asset(n);
    await asset(6, now - 60_000); // too recent to touch
    await asset(7);
    await fs.writeFile(sandboxesFile, JSON.stringify({ sandboxes: [{ buildId: id(7) }] }));

    const plan = await planPrune(store, sandboxesFile, now);
    expect(plan.records.map((r) => [r.rec.buildId, r.reason]).sort()).toEqual([
      [id(1), `superseded by ${id(2)} (same oci_digest)`],
      [id(3), "assets missing"],
    ]);
    expect(plan.assets.map((a) => a.buildId).sort()).toEqual([id(1), id(5)]);
    expect(plan.assets.every((a) => a.bytes >= 8192)).toBe(true);
    expect(plan.skipped.map((s) => s.buildId).sort()).toEqual([id(6), id(7)]);

    await applyPrune(store, plan);
    expect((await store.list()).map((r) => r.buildId).sort()).toEqual([id(2), id(4)]);
    expect((await fs.readdir(path.join(tmp, "store", "objects"))).sort()).toEqual([id(2), id(4), id(6), id(7)]);
  });
});
