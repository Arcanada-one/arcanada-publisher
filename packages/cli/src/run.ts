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
  // Platform-agnostic commands first.
  if (args.command === "server") {
    return runServer(args);
  }
  if (args.command === "video") {
    return runVideo(args);
  }

  if (!args.platform || !isPlatform(args.platform)) {
    return { code: ErrorCode.INVALID_ARGS, message: `unknown platform '${args.platform ?? ""}'` };
  }
  const platform = args.platform;
  const profile = args.profile ?? "default";

  switch (args.command) {
    case "login":
      return runLogin(platform, profile, args);
    case "delete":
      return runDelete(platform, profile, args);
    case "edit":
      return runEdit(platform, profile, args);
    case "comment":
      return runComment(platform, profile, args);
    case "publish":
      return runPublish(platform, profile, args);
  }
}

async function runLogin(platform: Platform, profile: string, args: ParsedArgs): Promise<RunResult> {
  await makeAdapter(platform, args).login({ profile, headed: true });
  return { code: ErrorCode.SUCCESS, message: `login flow started for ${platform}` };
}

async function runDelete(
  platform: Platform,
  profile: string,
  args: ParsedArgs,
): Promise<RunResult> {
  if (!args.targetUrl || !args.expectedContent) {
    return {
      code: ErrorCode.MISSING_INPUT,
      message: "delete requires --target-url and --expected-content (read-before-delete)",
    };
  }
  const res = await makeAdapter(platform, args).delete({
    targetUrl: args.targetUrl,
    kind: "post",
    expectedContent: args.expectedContent,
    profile,
  });
  return { code: ErrorCode.SUCCESS, message: `deleted ${res.targetUrl}` };
}

async function runEdit(platform: Platform, profile: string, args: ParsedArgs): Promise<RunResult> {
  if (!args.targetUrl || !args.textFile) {
    return { code: ErrorCode.MISSING_INPUT, message: "edit requires --target-url and --text-file" };
  }
  const res = await makeAdapter(platform, args).edit({
    postUrl: args.targetUrl,
    text: readText(args),
    ...(args.images[0] ? { imagePath: args.images[0] } : {}),
    profile,
  });
  return { code: ErrorCode.SUCCESS, message: `edited ${res.postUrl}` };
}

async function runComment(
  platform: Platform,
  profile: string,
  args: ParsedArgs,
): Promise<RunResult> {
  if (!args.parentUrl) {
    return { code: ErrorCode.MISSING_INPUT, message: "comment requires --parent-url" };
  }
  const body = applyPolicy(readText(args), platform, loadPolicy(args.policyConfig));
  const res = await makeAdapter(platform, args).comment({
    parentPostUrl: args.parentUrl,
    text: body,
    profile,
  });
  return { code: ErrorCode.SUCCESS, message: `comment posted: ${res.commentId}` };
}

async function runPublish(
  platform: Platform,
  profile: string,
  args: ParsedArgs,
): Promise<RunResult> {
  const body = applyPolicy(readText(args), platform, loadPolicy(args.policyConfig));
  // Platform-specific fields (subreddit/title for reddit, ownerId for vk) ride
  // alongside the shared shape; adapters that don't use them ignore the extras.
  // They are required for the reddit/vk dry-run path to reach success.
  const res = await makeAdapter(platform, args).publish({
    text: body,
    imagePaths: args.images,
    profile,
    dryRun: args.dryRun,
    ...(args.subreddit !== undefined ? { subreddit: args.subreddit } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.ownerId !== undefined ? { ownerId: args.ownerId } : {}),
  } as Parameters<ReturnType<typeof makeAdapter>["publish"]>[0]);
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

/**
 * Run the `video` subcommand: generate an animated cover MP4 using
 * @arcanada/publisher-video. Platform-agnostic; no adapter or login needed.
 */
async function runVideo(args: ParsedArgs): Promise<RunResult> {
  const { generateVideo, listPresets } = await import("@arcanada/publisher-video");

  if (args.listPresets) {
    const presets = listPresets();
    const lines = presets
      .map((p) => `  ${p.name}${p.timelineChanging ? " (timeline-changing)" : ""}: ${p.description}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.log(`Available presets:\n${lines}`);
    return { code: ErrorCode.SUCCESS, message: `listed ${presets.length} presets` };
  }

  if (!args.cover) {
    return { code: ErrorCode.MISSING_INPUT, message: "video: --cover is required" };
  }
  if (!args.videoOut) {
    return { code: ErrorCode.MISSING_INPUT, message: "video: --out is required" };
  }

  const result = await generateVideo({
    cover: args.cover,
    ...(args.audio !== undefined ? { audio: args.audio } : {}),
    out: args.videoOut,
    ...(args.preset !== undefined ? { preset: args.preset } : {}),
    ...(args.coverSeconds !== undefined ? { coverOnlySeconds: args.coverSeconds } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
  });

  return {
    code: ErrorCode.SUCCESS,
    message: `video generated: ${result.out} (${result.durationSec.toFixed(1)}s, audio=${result.hasAudio})`,
  };
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
