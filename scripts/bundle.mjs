#!/usr/bin/env node
import { build } from "esbuild";
import { rmSync } from "node:fs";

// tsc used to emit one file per module into dist/; start clean so none of
// those can end up in the tarball or shadow the bundle.
rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  sourcemap: true,
  // Gondolin pulls in native-leaning optional dependencies (the krun runners,
  // ssh2's cpu-features), which have to be resolved per platform by the
  // installer; bundling would freeze whatever this host happened to have.
  external: ["@earendil-works/gondolin"],
  // Bundled CommonJS code that calls require() for Node built-ins fails in an
  // ESM output without a real require in scope.
  banner: { js: 'import { createRequire as __masudaCreateRequire } from "node:module"; const require = __masudaCreateRequire(import.meta.url);' },
  logLevel: "warning",
});
