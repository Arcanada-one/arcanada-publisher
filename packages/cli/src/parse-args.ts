// Minimal, dependency-free CLI argument parser for arcanada-publisher.
//
// Contract (V-AC-11):
//   arcanada-publisher <command> --platform <p> --text-file <f> \
//     [--image <path> ...] [--dry-run] [--policy-config <path>] [--profile <p>]
//
// `--image` is repeatable and accumulates into imagePaths[]. Unknown flags
// fail closed so a typo is loud, not silently dropped.

export type Command = "publish" | "comment" | "edit" | "delete" | "login" | "server";
const COMMANDS = new Set<Command>(["publish", "comment", "edit", "delete", "login", "server"]);

export interface ParsedArgs {
  command: Command;
  platform: string | undefined;
  textFile: string | undefined;
  images: string[];
  dryRun: boolean;
  policyConfig: string | undefined;
  profile: string | undefined;
  targetUrl: string | undefined;
  parentUrl: string | undefined;
  expectedContent: string | undefined;
  bind: string | undefined;
  /** Loopback port for the `server` command (undefined → server default). */
  port: number | undefined;
  /** Reddit-specific: target subreddit (without the r/ prefix). */
  subreddit: string | undefined;
  /** Reddit-specific: self-post title. */
  title: string | undefined;
  /** VK-specific: wall owner id (negative for communities). */
  ownerId: number | undefined;
}

/** Flags that take a value; everything else is a boolean switch. */
const VALUE_FLAGS = new Set([
  "--platform",
  "--text-file",
  "--image",
  "--policy-config",
  "--profile",
  "--target-url",
  "--parent-url",
  "--expected-content",
  "--bind",
  "--port",
  "--subreddit",
  "--title",
  "--owner-id",
]);

export class CliParseError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.has(command as Command)) {
    throw new CliParseError(
      `unknown or missing command '${command ?? ""}' — expected one of: ${[...COMMANDS].join(", ")}`,
    );
  }

  const out: ParsedArgs = {
    command: command as Command,
    platform: undefined,
    textFile: undefined,
    images: [],
    dryRun: false,
    policyConfig: undefined,
    profile: undefined,
    targetUrl: undefined,
    parentUrl: undefined,
    expectedContent: undefined,
    bind: undefined,
    port: undefined,
    subreddit: undefined,
    title: undefined,
    ownerId: undefined,
  };

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new CliParseError(`unknown flag '${flag}'`);
    }
    const value = rest[++i];
    if (value === undefined) {
      throw new CliParseError(`flag '${flag}' requires a value`);
    }
    switch (flag) {
      case "--platform":
        out.platform = value;
        break;
      case "--text-file":
        out.textFile = value;
        break;
      case "--image":
        out.images.push(value);
        break;
      case "--policy-config":
        out.policyConfig = value;
        break;
      case "--profile":
        out.profile = value;
        break;
      case "--target-url":
        out.targetUrl = value;
        break;
      case "--parent-url":
        out.parentUrl = value;
        break;
      case "--expected-content":
        out.expectedContent = value;
        break;
      case "--bind":
        out.bind = value;
        break;
      case "--port": {
        const port = Number.parseInt(value, 10);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new CliParseError(`--port must be an integer 0-65535, got '${value}'`);
        }
        out.port = port;
        break;
      }
      case "--subreddit":
        out.subreddit = value;
        break;
      case "--title":
        out.title = value;
        break;
      case "--owner-id": {
        const ownerId = Number.parseInt(value, 10);
        if (!Number.isInteger(ownerId)) {
          throw new CliParseError(`--owner-id must be an integer, got '${value}'`);
        }
        out.ownerId = ownerId;
        break;
      }
    }
  }

  return out;
}
