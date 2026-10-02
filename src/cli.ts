#!/usr/bin/env node
import { parseArgs } from "node:util";

import { log } from "./log.js";
import { serve } from "./server.js";

const usage = "usage: masuda-sandbox serve --socket <path>";

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
    default:
      process.stderr.write(`${usage}\n`);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e) => {
  log.error("fatal", { error: e });
  process.exit(1);
});
