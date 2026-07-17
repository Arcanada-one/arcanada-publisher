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
      if (err.details?.["unknown"] === true && err.details?.["reconcileRequired"] === true) {
        return { code: err.code, message: JSON.stringify(err.toJSON()) };
      }
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
    case "inspect":
      return runInspect(platform, profile, args);
    case "edit":
      return runEdit(platform, profile, args);
    case "comment":
      return runComment(platform, profile, args);
    case "replace-comment":
      return runReplaceComment(platform, profile, args);
    case "inspect-profile-post":
      return runInspectProfilePost(platform, profile, args);
    case "publish":
      return runPublish(platform, profile, args);
    case "bootstrap-playlists":
      return runBootstrapPlaylists(platform, profile);
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
  if (!args.targetUrl || (!args.expectedContent && !args.expectedContentFile)) {
    return {
      code: ErrorCode.MISSING_INPUT,
      message:
        "delete requires --target-url and exactly one of --expected-content or --expected-content-file",
    };
  }
  if (args.expectedContent && args.expectedContentFile) {
    return {
      code: ErrorCode.INVALID_ARGS,
      message: "delete accepts only one content oracle",
    };
  }
  const expectedContent = args.expectedContentFile
    ? readDeleteOracle(args.expectedContentFile)
    : args.expectedContent!;
  const res = await makeAdapter(platform, args).delete({
    targetUrl: args.targetUrl,
    kind: "post",
    expectedContent,
    profile,
  });
  return { code: ErrorCode.SUCCESS, message: `deleted ${res.targetUrl}` };
}

async function runEdit(platform: Platform, profile: string, args: ParsedArgs): Promise<RunResult> {
  if (
    !args.targetUrl ||
    (!args.textFile && args.title === undefined && args.privacy === undefined)
  ) {
    return {
      code: ErrorCode.MISSING_INPUT,
      message: "edit requires --target-url and at least one of --text-file, --title, or --privacy",
    };
  }
  if (
    platform === "facebook" &&
    (!args.expectedContentFile ||
      !args.expectedAuthorProfileUrl ||
      args.expectedMediaKind !== "image")
  ) {
    return {
      code: ErrorCode.MISSING_INPUT,
      message:
        "Facebook edit requires --expected-content-file, --expected-author-profile-url, and --expected-media-kind image",
    };
  }
  const res = await makeAdapter(platform, args).edit({
    postUrl: args.targetUrl,
    ...(args.textFile ? { text: readText(args) } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.privacy !== undefined
      ? { privacyStatus: args.privacy as "private" | "unlisted" | "public" }
      : {}),
    ...(args.images[0] ? { imagePath: args.images[0] } : {}),
    ...(args.expectedContent || args.expectedContentFile
      ? {
          expectedContent:
            args.expectedContent ??
            (platform === "facebook"
              ? readFacebookEditOracle(args.expectedContentFile!)
              : readFileSync(args.expectedContentFile!, "utf8").replace(/\r?\n$/, "")),
        }
      : {}),
    ...(args.expectedMediaKind ? { expectedMediaKind: args.expectedMediaKind } : {}),
    ...(args.parentUrl ? { expectedParentUrl: args.parentUrl } : {}),
    ...(args.expectedAuthorProfileUrl
      ? { expectedAuthorProfileUrl: args.expectedAuthorProfileUrl }
      : {}),
    ...(args.videoWidth ? { videoWidth: args.videoWidth } : {}),
    ...(args.videoHeight ? { videoHeight: args.videoHeight } : {}),
    ...(args.videoDuration ? { videoDuration: args.videoDuration } : {}),
    profile,
  });
  return { code: ErrorCode.SUCCESS, message: `edited ${res.postUrl}` };
}

async function runInspect(
  platform: Platform,
  profile: string,
  args: ParsedArgs,
): Promise<RunResult> {
  if (platform === "linkedin" && !args.targetUrl) {
    const adapter = makeAdapter(platform, args) as unknown as {
      inspectComposer(profile: string): Promise<unknown>;
    };
    const result = await adapter.inspectComposer(profile);
    return { code: ErrorCode.SUCCESS, message: JSON.stringify(result) };
  }
  if (platform !== "telegram" || !args.targetUrl)
    return {
      code: ErrorCode.INVALID_ARGS,
      message: "inspect requires Telegram --target-url or LinkedIn without --target-url",
    };
  const adapter = makeAdapter(platform, args) as unknown as {
    inspect(postUrl: string): Promise<unknown>;
  };
  const result = await adapter.inspect(args.targetUrl);
  return { code: ErrorCode.SUCCESS, message: JSON.stringify(result) };
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

async function runReplaceComment(
  platform: Platform,
  profile: string,
  args: ParsedArgs,
): Promise<RunResult> {
  if (platform !== "facebook" && platform !== "x" && platform !== "linkedin") {
    return {
      code: ErrorCode.INVALID_ARGS,
      message: "replace-comment is supported only for Facebook",
    };
  }
  if (
    !args.parentUrl ||
    !args.commentId ||
    !args.expectedAuthorProfileUrl ||
    !args.expectedContentFile ||
    !args.textFile
  ) {
    return {
      code: ErrorCode.MISSING_INPUT,
      message:
        "replace-comment requires --parent-url, --comment-id, --expected-author-profile-url, --expected-content-file, and --text-file",
    };
  }
  const adapter = makeAdapter(platform, args) as unknown as {
    replaceComment(input: {
      parentPostUrl: string;
      commentId: string;
      expectedAuthorProfileUrl: string;
      oldText: string;
      text: string;
      profile: string;
    }): Promise<{ commentId: string }>;
  };
  const res = await adapter.replaceComment({
    parentPostUrl: args.parentUrl,
    commentId: args.commentId,
    expectedAuthorProfileUrl: args.expectedAuthorProfileUrl,
    oldText: readExactMutationText(args.expectedContentFile),
    text: readExactMutationText(args.textFile),
    profile,
  });
  return { code: ErrorCode.SUCCESS, message: `comment replaced: ${res.commentId}` };
}

async function runInspectProfilePost(
  platform: Platform,
  profile: string,
  args: ParsedArgs,
): Promise<RunResult> {
  if (platform !== "facebook" && platform !== "linkedin" && platform !== "x") {
    return {
      code: ErrorCode.INVALID_ARGS,
      message: "inspect-profile-post is supported only for Facebook, LinkedIn, and X",
    };
  }
  if (
    !args.profileUrl ||
    !args.expectedAuthorProfileUrl ||
    !args.evidenceDir ||
    !args.maxScrolls ||
    (!args.expectedContentFile && !args.contentExcerpt)
  ) {
    return {
      code: ErrorCode.MISSING_INPUT,
      message: "inspect-profile-post is missing its required read-only oracle flags",
    };
  }
  const adapter = makeAdapter(platform, args) as unknown as {
    inspectProfilePost(input: {
      profileUrl: string;
      expectedAuthorProfileUrl: string;
      expectedBody?: string;
      contentExcerpt?: string;
      evidenceDir: string;
      maxScrolls: number;
      profile: string;
    }): Promise<unknown>;
  };
  const result = await adapter.inspectProfilePost({
    profileUrl: args.profileUrl,
    expectedAuthorProfileUrl: args.expectedAuthorProfileUrl,
    ...(args.expectedContentFile
      ? { expectedBody: readInspectionOracle(args.expectedContentFile) }
      : { contentExcerpt: args.contentExcerpt! }),
    evidenceDir: args.evidenceDir,
    maxScrolls: args.maxScrolls,
    profile,
  });
  return { code: ErrorCode.SUCCESS, message: JSON.stringify(result) };
}

async function runBootstrapPlaylists(platform: Platform, profile: string): Promise<RunResult> {
  if (platform !== "youtube") {
    return {
      code: ErrorCode.INVALID_ARGS,
      message: "bootstrap-playlists is a YouTube-only command",
    };
  }
  // Armed state + fail-closed audit are enforced INSIDE the adapter (D-REQ-12).
  const { YouTubeAdapter } = await import("@arcanada/publisher-youtube");
  const binding = await new YouTubeAdapter().bootstrapPlaylists(profile);
  return {
    code: ErrorCode.SUCCESS,
    message: `playlists bound: YOUTUBE_PLAYLIST_EN=${binding.en} YOUTUBE_PLAYLIST_RU=${binding.ru}`,
  };
}

async function runPublish(
  platform: Platform,
  profile: string,
  args: ParsedArgs,
): Promise<RunResult> {
  if (platform === "facebook" && !args.dryRun && !args.expectedAuthorProfileUrl) {
    return {
      code: ErrorCode.MISSING_INPUT,
      message: "Facebook publish requires --expected-author-profile-url",
    };
  }
  const body = applyPolicy(readText(args), platform, loadPolicy(args.policyConfig));
  // Platform-specific fields ride alongside the shared shape. `title` is used by
  // Reddit self-posts and by Telegram's explicit two-channel-post article bundle;
  // adapters that do not use a field ignore it.
  const res = await makeAdapter(platform, args).publish({
    text: body,
    imagePaths: args.images,
    profile,
    dryRun: args.dryRun,
    ...(args.premium ? { premium: true } : {}),
    ...(args.subreddit !== undefined ? { subreddit: args.subreddit } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.ownerId !== undefined ? { ownerId: args.ownerId } : {}),
    ...(args.chatId !== undefined ? { chatId: args.chatId } : {}),
    ...(args.videoPath !== undefined ? { videoPath: args.videoPath } : {}),
    ...(args.language !== undefined ? { language: args.language } : {}),
    ...(args.privacy !== undefined
      ? { privacyStatus: args.privacy as "private" | "unlisted" | "public" }
      : {}),
    ...(args.expectedAuthorProfileUrl !== undefined
      ? { expectedAuthorProfileUrl: args.expectedAuthorProfileUrl }
      : {}),
  } as Parameters<ReturnType<typeof makeAdapter>["publish"]>[0]);
  const publishedUrls = res.postUrls ?? [res.postUrl];
  const warningLines = res.warnings.length > 0 ? `\n${res.warnings.join("\n")}` : "";
  const outcome = args.dryRun ? "dry-run result" : "published";
  return {
    code: ErrorCode.SUCCESS,
    message: `${outcome}: ${publishedUrls.join(", ")}${warningLines}`,
  };
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
      .map(
        (p) => `  ${p.name}${p.timelineChanging ? " (timeline-changing)" : ""}: ${p.description}`,
      )
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

  // Assemble the optional waveform-strip override from CLI flags. Omitting the
  // key entirely keeps the generator's house-style default (enabled, 180px,
  // gold→crimson). Any flag present produces a partial override object.
  const waveform: Record<string, unknown> = {};
  if (args.noWaveform) waveform.enabled = false;
  if (args.waveformHeight !== undefined) waveform.heightPx = args.waveformHeight;
  if (args.waveformColors !== undefined) {
    const [left, right] = args.waveformColors.split(",");
    waveform.colorLeft = left;
    waveform.colorRight = right;
  }

  const result = await generateVideo({
    cover: args.cover,
    ...(args.audio !== undefined ? { audio: args.audio } : {}),
    out: args.videoOut,
    ...(args.preset !== undefined ? { preset: args.preset } : {}),
    ...(args.coverSeconds !== undefined ? { coverOnlySeconds: args.coverSeconds } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    ...(args.maxBitrateKbps !== undefined ? { maxBitrateKbps: args.maxBitrateKbps } : {}),
    ...(Object.keys(waveform).length > 0 ? { waveform } : {}),
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

function readExactMutationText(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
}

function readInspectionOracle(path: string): string {
  try {
    return readExactMutationText(path);
  } catch {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "inspect-profile-post: failed to read expected content file",
      {
        stage: "inspect-profile-post.read-expected-content",
        failure: "EXPECTED_CONTENT_READ_FAILED",
      },
    );
  }
}

function readDeleteOracle(path: string): string {
  try {
    return readExactMutationText(path);
  } catch {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "delete: failed to read expected content file",
      {
        stage: "delete.read-expected-content",
        failure: "EXPECTED_CONTENT_READ_FAILED",
      },
    );
  }
}

function readFacebookEditOracle(path: string): string {
  try {
    return readExactMutationText(path);
  } catch {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "Facebook edit: failed to read expected content file",
      { stage: "facebook-edit.read-expected-content" },
    );
  }
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
