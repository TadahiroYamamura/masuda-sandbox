// Removes one image the contract tests built, from outside the service:
// `masuda-sandbox images prune` cannot run next to a live service, and would
// also touch images the tests do not own. Deletes the images.json record and
// the Gondolin asset directory through prune's applyPrune, then the Docker
// image BuildImage left behind (its tag and the image id).
//
// Also runnable by hand when a test run died before cleaning up:
//   npx tsx test/contract/cleanup-image.ts <build id>
import { getImageObjectDirectory } from "@earendil-works/gondolin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { dockerTag } from "../../src/build.js";
import { ImageStore } from "../../src/images.js";
import { applyPrune } from "../../src/prune.js";

export async function removeImage(buildId: string, store: ImageStore = new ImageStore()): Promise<void> {
  const rec = await store.get(buildId);
  await applyPrune(store, {
    records: rec ? [{ rec, reason: "contract test cleanup" }] : [],
    assets: [{ buildId, dir: getImageObjectDirectory(buildId), bytes: 0, reason: "contract test cleanup" }],
    skipped: [],
  });
  if (!rec) return;
  for (const ref of [dockerTag(rec.arch, rec.ociDigest), rec.ociDigest]) {
    await promisify(execFile)("docker", ["image", "rm", ref]).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: cleanup-image.ts <build id>");
    process.exit(2);
  }
  await removeImage(id);
}
