#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";

import { dataDir } from "./datafile.js";

import { ImageStore } from "./images.js";
import { log, loggingToFile, logToFile } from "./log.js";
import { applyPrune, formatBytes, planPrune } from "./prune.js";
import { runCommand } from "./run.js";
import { serve } from "./server.js";
import { VERSION } from "./version.js";

const usage = "usage: masuda-sandbox serve --socket <path> [--log-file <path>|-]\n       masuda-sandbox run --socket <path> --build-id <id> [options] -- <shell command>\n       masuda-sandbox images prune [--dry-run]\n       masuda-sandbox --version";

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
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { socket: { type: "string" }, "log-file": { type: "string" } }, strict: true });
      if (!values.socket) throw new Error(`--socket is required\n${usage}`);
      // 端末には起動したことと、ログの置き場所だけを出す。-なら今までどおり端末に出す。
      const file = values["log-file"] ?? path.join(dataDir(), "logs", "masuda-sandbox-serve.log");
      const logged = file !== "-" && logToFile(file);
      await serve({ socketPath: values.socket });
      process.stderr.write(`masuda-sandbox: serving on ${path.resolve(values.socket)}\n`);
      if (logged) process.stderr.write(`masuda-sandbox: logs: ${file}\n`);
      return;
    }
    case "run": {
      // クライアントのHTTP/2のセッションが残っていても、ここで終わる。
      // 出力はrunCommandの中でdrainを待って書き終えている。
      process.exit(await runCommand(rest));
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
  // ログをファイルに書いていると、起動の失敗が端末に出ない。端末にも1行出す。
  if (loggingToFile()) process.stderr.write(`masuda-sandbox: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
