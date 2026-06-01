#!/usr/bin/env node
// arcanada-publisher — unified CLI entry (Phase 6).
//
//   arcanada-publisher publish  --platform <p> --text-file <f> [--image <p> ...] [--dry-run] [--policy-config <f>]
//   arcanada-publisher comment  --platform <p> --text-file <f> --parent-url <url>
//   arcanada-publisher delete   --platform <p> --target-url <url> --expected-content <text>
//   arcanada-publisher login    --platform <p> [--profile <name>]

import { run } from "./run.js";

export { run } from "./run.js";
export { parseArgs, CliParseError } from "./parse-args.js";
export type { ParsedArgs, Command } from "./parse-args.js";
export { makeAdapter } from "./adapters.js";

async function main(): Promise<void> {
  const result = await run(process.argv.slice(2));
  if (result.code === 0) {
    // eslint-disable-next-line no-console
    console.log(result.message);
  } else {
    console.error(result.message);
  }
  process.exit(result.code);
}

// Only auto-run when executed as a binary, not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  void main();
}
