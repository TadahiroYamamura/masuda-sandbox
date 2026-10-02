// Child process for one `gondolin build`, run by build.ts in place of the
// gondolin CLI. The CLI cannot be given a work directory: it creates
// /tmp/gondolin-build-XXXX itself and removes it with fs.rmSync, which fails
// with EACCES when the extracted OCI rootfs contains directories without the
// owner's write bit (a non-root `go mod download` leaves its module cache
// 0555). The build itself had succeeded by then, but the CLI exits before
// importing the assets. Here the work directory is the caller's, which makes
// it writable again before removing it.
//
// Usage: node gondolin-build.js <build-config.json> <work dir> <output dir>
// Prints "Build ID: <id>" on success, like the CLI.
import { buildAssets, importImageFromDirectory, parseBuildConfig } from "@earendil-works/gondolin";
import fs from "node:fs/promises";
import path from "node:path";

const [configPath, workDir, outputDir] = process.argv.slice(2);
if (!configPath || !workDir || !outputDir) {
  console.error("usage: gondolin-build.js <build-config.json> <work dir> <output dir>");
  process.exit(2);
}

try {
  const config = parseBuildConfig(await fs.readFile(configPath, "utf8"));
  await fs.mkdir(workDir, { recursive: true });
  const result = await buildAssets(config, { outputDir, configDir: path.dirname(configPath), workDir, verbose: true });
  const imported = importImageFromDirectory(result.outputDir);
  console.log(`Build ID: ${imported.buildId}`);
} catch (e) {
  console.error(`Build failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
