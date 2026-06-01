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

  // publish
  const res = await adapter.publish({
    text: body,
    imagePaths: args.images,
    profile,
    dryRun: args.dryRun,
  });
  return { code: ErrorCode.SUCCESS, message: `published: ${res.postUrl}` };
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
