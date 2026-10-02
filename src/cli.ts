#!/usr/bin/env node
import { parseArgs } from "node:util";

import { ImageStore } from "./images.js";
import { log } from "./log.js";
import { applyPrune, formatBytes, planPrune } from "./prune.js";
import { serve } from "./server.js";

const usage = "usage: masuda-sandbox serve --socket <path>\n       masuda-sandbox images prune [--dry-run]";

async function imagesPrune(dryRun: boolean): Promise<void> {
  const images = new ImageStore();
  const plan = await planPrune(images);
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const verb = dryRun ? "would remove" : "removing";
  for (const r of plan.records) out(`${verb} record ${r.rec.buildId} (${r.rec.name}, ${r.rec.createdAt}): ${r.reason}`);
  for (const a of plan.assets) out(`${verb} assets ${a.dir} (${formatBytes(a.bytes)}): ${a.reason}`);
  for (const s of plan.skipped) out(`keeping assets ${s.buildId}: ${s.reason}`);
  const bytes = plan.assets.reduce((n, a) => n + a.bytes, 0);
  if (!dryRun) await applyPrune(images, plan);
  out(`${dryRun ? "dry run: " : ""}${plan.records.length} record(s), ${plan.assets.length} asset dir(s), ${formatBytes(bytes)}${dryRun ? " would be freed" : " freed"}`);
}

async function main(argv: string[]): Promise<void> {
  // `pnpm start -- serve ...` forwards the literal "--".
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  switch (command) {
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { socket: { type: "string" } }, strict: true });
      if (!values.socket) throw new Error(`--socket is required\n${usage}`);
      await serve({ socketPath: values.socket });
      return;
    }
    case "images": {
      const [sub, ...flags] = rest;
      if (sub !== "prune") break;
      const { values } = parseArgs({ args: flags, options: { "dry-run": { type: "boolean" } }, strict: true });
      await imagesPrune(values["dry-run"] ?? false);
      return;
    }
  }
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

main(process.argv.slice(2)).catch((e) => {
  log.error("fatal", { error: e });
  process.exit(1);
});
