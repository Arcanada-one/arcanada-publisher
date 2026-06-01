// CLI dispatcher: parse → load text + policy → run the requested command against
// the selected platform adapter. Returns a process exit code (0 = ok, non-zero
// = failure) so the binary and the unit tests share one entry point.

import { readFileSync } from "node:fs";
import {
  AdapterError,
  ErrorCode,
  enforce,
  PolicyConfigSchema,
  isPlatform,
  type PolicyConfig,
  type Platform,
} from "@arcanada/publisher-core";
import { listen } from "@arcanada/publisher-server";
import { parseArgs, CliParseError, type ParsedArgs } from "./parse-args.js";
import { makeAdapter } from "./adapters.js";

export interface RunResult {
  code: number;
  message: string;
}

export async function run(argv: string[]): Promise<RunResult> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliParseError) {
      return { code: ErrorCode.INVALID_ARGS, message: err.message };
    }
    throw err;
  }

  try {
    return await dispatch(args);
  } catch (err) {
    if (err instanceof AdapterError) {
      return { code: err.code, message: `${err.name}: ${err.message}` };
    }
    return {
      code: ErrorCode.INTERNAL_PANIC,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function dispatch(args: ParsedArgs): Promise<RunResult> {
  // `server` is platform-agnostic: it starts the loopback API and blocks.
  if (args.command === "server") {
    return runServer(args);
  }

  if (!args.platform || !isPlatform(args.platform)) {
    return { code: ErrorCode.INVALID_ARGS, message: `unknown platform '${args.platform ?? ""}'` };
  }
  const platform = args.platform;
  const profile = args.profile ?? "default";

  if (args.command === "login") {
    const adapter = makeAdapter(platform, args);
    await adapter.login({ profile, headed: true });
    return { code: ErrorCode.SUCCESS, message: `login flow started for ${platform}` };
  }

  if (args.command === "delete") {
    if (!args.targetUrl || !args.expectedContent) {
      return {
        code: ErrorCode.MISSING_INPUT,
        message: "delete requires --target-url and --expected-content (read-before-delete)",
      };
    }
    const adapter = makeAdapter(platform, args);
    const res = await adapter.delete({
      targetUrl: args.targetUrl,
      kind: "post",
      expectedContent: args.expectedContent,
      profile,
    });
    return { code: ErrorCode.SUCCESS, message: `deleted ${res.targetUrl}` };
  }

  if (args.command === "edit") {
    if (!args.targetUrl || !args.textFile) {
      return {
        code: ErrorCode.MISSING_INPUT,
        message: "edit requires --target-url and --text-file",
      };
    }
    const adapter = makeAdapter(platform, args);
    const res = await adapter.edit({
      postUrl: args.targetUrl,
      text: readText(args),
      ...(args.images[0] ? { imagePath: args.images[0] } : {}),
      profile,
    });
    return { code: ErrorCode.SUCCESS, message: `edited ${res.postUrl}` };
  }

  // publish / comment both need the body text.
  const rawText = readText(args);
  const policy = loadPolicy(args.policyConfig);
  const body = applyPolicy(rawText, platform, policy);

  const adapter = makeAdapter(platform, args);
  if (args.command === "comment") {
    if (!args.parentUrl) {
      return { code: ErrorCode.MISSING_INPUT, message: "comment requires --parent-url" };
    }
    const res = await adapter.comment({ parentPostUrl: args.parentUrl, text: body, profile });
    return { code: ErrorCode.SUCCESS, message: `comment posted: ${res.commentId}` };
  }

  // publish — platform-specific fields (subreddit/title for reddit, ownerId for
  // vk) ride alongside the shared shape; adapters that don't use them ignore the
  // extras. They are required for the reddit/vk dry-run path to reach success.
  const res = await adapter.publish({
    text: body,
    imagePaths: args.images,
    profile,
    dryRun: args.dryRun,
    ...(args.subreddit !== undefined ? { subreddit: args.subreddit } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.ownerId !== undefined ? { ownerId: args.ownerId } : {}),
  } as Parameters<typeof adapter.publish>[0]);
  return { code: ErrorCode.SUCCESS, message: `published: ${res.postUrl}` };
}

/**
 * Start the loopback API server and block until the process is signalled. The
 * promise only resolves on a startup error (bad bind / port in use); a healthy
 * server runs until SIGINT/SIGTERM, so `arcanada-publisher server` behaves like
 * a daemon foreground process.
 */
async function runServer(args: ParsedArgs): Promise<RunResult> {
  try {
    const { server, port } = await listen({
      ...(args.bind ? { bind: args.bind } : {}),
      ...(args.port !== undefined ? { port: args.port } : {}),
    });
    const bind = args.bind ?? "127.0.0.1";
    // eslint-disable-next-line no-console
    console.log(`arcanada-publisher loopback API listening on http://${bind}:${port}`);
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        server.close(() => resolve());
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return { code: ErrorCode.SUCCESS, message: "server stopped" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: ErrorCode.NETWORK_GUARD, message: `server failed to start: ${message}` };
  }
}

function readText(args: ParsedArgs): string {
  if (!args.textFile) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "publish/comment requires --text-file");
  }
  return readFileSync(args.textFile, "utf8");
}

function loadPolicy(path: string | undefined): PolicyConfig {
  if (!path) {
    return {};
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return PolicyConfigSchema.parse(raw);
}

/** Apply the content policy to a single-language body (CLI passes one variant). */
function applyPolicy(text: string, platform: Platform, policy: PolicyConfig): string {
  if (Object.keys(policy).length === 0) {
    return text;
  }
  const enforced = enforce({ platform, bodyByLang: { default: text }, links: [] }, policy);
  return enforced.body;
}
