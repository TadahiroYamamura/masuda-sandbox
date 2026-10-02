// Checks the output of `pnpm build`, so it needs dist/ to be built first (CI
// and release run build before test). It exists because the service starts
// dist/gondolin-build.js as a child only when a BuildImage misses the reuse
// path, which the contract tests normally do not reach: S13's bundling
// dropped that file and nothing noticed until a real build failed.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[]; bin: Record<string, string> };

describe("dist", () => {
  it("has every file the package publishes", () => {
    for (const f of [...pkg.files, ...Object.values(pkg.bin)]) {
      expect(existsSync(path.join(root, f)), `${f} missing; run pnpm build`).toBe(true);
    }
  });

  it("publishes the build child next to cli.js, where build.ts looks for it", () => {
    expect(pkg.files).toContain("dist/gondolin-build.js");
    expect(readFileSync(path.join(root, "dist/cli.js"), "utf8")).toContain('new URL("./gondolin-build.js", import.meta.url)');
  });

  it("runs the build child far enough to load Gondolin and check its arguments", async () => {
    const err = await promisify(execFile)(process.execPath, [path.join(root, "dist/gondolin-build.js")]).then(
      () => undefined,
      (e: { code?: number; stderr?: string }) => e,
    );
    expect(err?.stderr).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
    expect(err?.stderr).toMatch(/^usage: gondolin-build\.js/);
    expect(err?.code).toBe(2);
  });
});
