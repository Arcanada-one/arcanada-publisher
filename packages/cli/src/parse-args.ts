// Minimal, dependency-free CLI argument parser for arcanada-publisher.
//
// Contract (V-AC-11):
//   arcanada-publisher <command> --platform <p> --text-file <f> \
//     [--image <path> ...] [--dry-run] [--policy-config <path>] [--profile <p>]
//
// `--image` is repeatable and accumulates into imagePaths[]. Unknown flags
// fail closed so a typo is loud, not silently dropped.
//
// PUB-0027: `video` subcommand added for animated cover video generation.

export type Command =
  | "publish"
  | "bootstrap-playlists"
  | "comment"
  | "replace-comment"
  | "inspect-profile-post"
  | "edit"
  | "delete"
  | "inspect"
  | "login"
  | "server"
  | "video";

const COMMANDS = new Set<Command>([
  "publish",
  "bootstrap-playlists",
  "comment",
  "replace-comment",
  "inspect-profile-post",
  "edit",
  "delete",
  "inspect",
  "login",
  "server",
  "video",
]);

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
  /** Facebook-specific exact existing comment mutation target. */
  commentId: string | undefined;
  /** Facebook-specific stable profile URL oracle for safe comment replacement. */
  expectedAuthorProfileUrl: string | undefined;
  expectedContent: string | undefined;
  expectedContentFile: string | undefined;
  /** Facebook read-only profile surface to scan. */
  profileUrl: string | undefined;
  /** Explicit fallback excerpt; mutually exclusive with expectedContentFile. */
  contentExcerpt: string | undefined;
  /** Private 0700 evidence directory for raw inspection read-back. */
  evidenceDir: string | undefined;
  /** Bounded Facebook profile pagination count. */
  maxScrolls: number | undefined;
  expectedMediaKind: "image" | "video" | "none" | undefined;
  /** `delete` target kind; defaults to "post" when omitted (PUB-0039). */
  kind: "post" | "comment" | undefined;
  videoWidth: number | undefined;
  videoHeight: number | undefined;
  videoDuration: number | undefined;
  bind: string | undefined;
  /** Loopback port for the `server` command (undefined → server default). */
  port: number | undefined;
  /** Reddit-specific: target subreddit (without the r/ prefix). */
  subreddit: string | undefined;
  /** Reddit-specific: self-post title. */
  title: string | undefined;
  /** VK-specific: wall owner id (negative for communities). */
  ownerId: number | undefined;
  /** Telegram-specific: target chat/channel id or @username. */
  chatId: string | undefined;
  /** Telegram-specific: clean one-message HTML article mode. */
  singleArticle: boolean;
  /** YouTube-specific: path to the video file to upload. */
  videoPath: string | undefined;
  /** YouTube-specific: content language ('en' | 'ru') driving playlist routing. */
  language: string | undefined;
  /** YouTube-specific: requested visibility. */
  privacy: string | undefined;
  /** X-specific (PUB-0033): opt-in Premium long-form mode (25 000-char limit). */
  premium: boolean;
  /**
   * PUB-0041: drop `inspect-profile-post`'s native-video requirement so a text
   * or image post can be read back. Default keeps the assertion on, so every
   * video caller retains its guarantee.
   */
  noExpectNativeVideo: boolean;
  /**
   * PUB-0033: run the browser headed (visible) instead of headless. Large video
   * uploads settle far more reliably in a headed context; default stays headless.
   */
  headed: boolean;
  /** PUB-0034: select the VK browser-mode adapter instead of the token API. */
  browser: boolean;
  // ---- video subcommand flags (PUB-0027) ----
  /** `video` subcommand: cover image path. */
  cover: string | undefined;
  /** `video` subcommand: optional audio file path. */
  audio: string | undefined;
  /** `video` subcommand: output MP4 path. */
  videoOut: string | undefined;
  /** `video` subcommand: preset name (default: cycle). */
  preset: string | undefined;
  /** `video` subcommand: cover-only clip duration in seconds (default: 30). */
  coverSeconds: number | undefined;
  /** `video` subcommand: optional seed for reproducible shuffle. */
  seed: number | undefined;
  /** `video` subcommand: when true, list presets and exit. */
  listPresets: boolean;
  /**
   * `video` subcommand: max output video bitrate ceiling in kbit/s.
   * Validated as a positive integer at parse time. Default: undefined → 600 kbps
   * compact target inside the encoder. Mirrors GenerateOptions.maxBitrateKbps.
   */
  maxBitrateKbps: number | undefined;
  /**
   * `video` subcommand: output canvas in pixels. Default 1280x720 (16:9); pass
   * 720x1280 for a 9:16 social vertical. Mirrors GenerateOptions.width/height.
   *
   * Deliberately NOT named --video-width/--video-height: those already exist on
   * this CLI and mean something else (the dimensions a PUBLISHED post's media is
   * verified against). Reusing them would have made a render flag and a
   * verification flag share a name.
   */
  canvasWidth: number | undefined;
  canvasHeight: number | undefined;
  /**
   * `video` subcommand: disable the bottom audio-amplitude strip (cycle preset).
   * Default false → the strip is drawn (house style). `--no-waveform` flips it.
   */
  noWaveform: boolean;
  /** `video` subcommand: amplitude-strip height in px. Default undefined → 180. */
  waveformHeight: number | undefined;
  /**
   * `video` subcommand: amplitude-strip gradient colours as "LEFT,RIGHT" hex
   * (e.g. "0xFFD24C,0xE03B5A"). Default undefined → gold→crimson house style.
   */
  waveformColors: string | undefined;
  // ---- shotcraft engine flags (ARCA-0191) ----
  /** `video` subcommand: render engine — "cycle" (ffmpeg, default) | "shotcraft" (Remotion). */
  engine: "cycle" | "shotcraft";
  /** `video --engine shotcraft`: product screenshot path(s); repeatable → assets[]. */
  assets: string[];
  /** `video --engine shotcraft`: template id (default + only validated: "ink-press"). */
  template: string | undefined;
  /** `video --engine shotcraft`: explicit shot-card designation(s); repeatable → shots[]. */
  shots: string[];
  /** `video --engine shotcraft`: optional Chromium executable override. */
  browserExecutable: string | undefined;
  /** `video --engine shotcraft`: output format id (default + only validated: "landscape"). */
  format: string | undefined;
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
  "--comment-id",
  "--expected-author-profile-url",
  "--expected-content",
  "--expected-content-file",
  "--profile-url",
  "--content-excerpt",
  "--evidence-dir",
  "--max-scrolls",
  "--expected-media-kind",
  "--kind",
  "--video-width",
  "--video-height",
  "--video-duration",
  "--bind",
  "--port",
  "--subreddit",
  "--title",
  "--owner-id",
  "--chat-id",
  "--video",
  "--language",
  "--privacy",
  // video subcommand flags
  "--cover",
  "--audio",
  "--out",
  "--preset",
  "--cover-seconds",
  "--seed",
  "--max-bitrate",
  "--canvas-width",
  "--canvas-height",
  "--waveform-height",
  "--waveform-colors",
  // shotcraft engine flags (ARCA-0191)
  "--engine",
  "--asset",
  "--template",
  "--shot",
  "--browser-executable",
  "--format",
]);

const BOOL_FLAGS = new Set([
  "--dry-run",
  "--list-presets",
  "--premium",
  "--no-expect-native-video",
  "--headed",
  "--browser",
  "--single-article",
  "--no-waveform",
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
    commentId: undefined,
    expectedAuthorProfileUrl: undefined,
    expectedContent: undefined,
    expectedContentFile: undefined,
    profileUrl: undefined,
    contentExcerpt: undefined,
    evidenceDir: undefined,
    maxScrolls: undefined,
    expectedMediaKind: undefined,
    kind: undefined,
    videoWidth: undefined,
    videoHeight: undefined,
    videoDuration: undefined,
    bind: undefined,
    port: undefined,
    subreddit: undefined,
    title: undefined,
    ownerId: undefined,
    chatId: undefined,
    singleArticle: false,
    videoPath: undefined,
    language: undefined,
    privacy: undefined,
    premium: false,
    noExpectNativeVideo: false,
    headed: false,
    browser: false,
    cover: undefined,
    audio: undefined,
    videoOut: undefined,
    preset: undefined,
    coverSeconds: undefined,
    seed: undefined,
    listPresets: false,
    maxBitrateKbps: undefined,
    canvasWidth: undefined,
    canvasHeight: undefined,
    noWaveform: false,
    waveformHeight: undefined,
    waveformColors: undefined,
    engine: "cycle",
    assets: [],
    template: undefined,
    shots: [],
    browserExecutable: undefined,
    format: undefined,
  };

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (flag === "--list-presets") {
      out.listPresets = true;
      continue;
    }
    if (flag === "--premium") {
      out.premium = true;
      continue;
    }
    if (flag === "--no-expect-native-video") {
      out.noExpectNativeVideo = true;
      continue;
    }
    if (flag === "--headed") {
      out.headed = true;
      continue;
    }
    if (flag === "--browser") {
      out.browser = true;
      continue;
    }
    if (flag === "--single-article") {
      out.singleArticle = true;
      continue;
    }
    if (flag === "--no-waveform") {
      out.noWaveform = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag) && !BOOL_FLAGS.has(flag)) {
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
      case "--comment-id":
        out.commentId = value;
        break;
      case "--expected-author-profile-url":
        out.expectedAuthorProfileUrl = value;
        break;
      case "--expected-content":
        out.expectedContent = value;
        break;
      case "--expected-content-file":
        out.expectedContentFile = value;
        break;
      case "--profile-url":
        out.profileUrl = value;
        break;
      case "--content-excerpt":
        out.contentExcerpt = value;
        break;
      case "--evidence-dir":
        out.evidenceDir = value;
        break;
      case "--max-scrolls": {
        if (!/^\d+$/.test(value))
          throw new CliParseError(`--max-scrolls must be an integer from 1 to 50, got '${value}'`);
        const parsed = Number.parseInt(value, 10);
        if (parsed < 1 || parsed > 50)
          throw new CliParseError(`--max-scrolls must be an integer from 1 to 50, got '${value}'`);
        out.maxScrolls = parsed;
        break;
      }
      case "--expected-media-kind":
        if (value !== "image" && value !== "video" && value !== "none")
          throw new CliParseError(
            `--expected-media-kind must be image, video, or none, got '${value}'`,
          );
        out.expectedMediaKind = value;
        break;
      case "--kind":
        if (value !== "post" && value !== "comment")
          throw new CliParseError(`--kind must be post or comment, got '${value}'`);
        out.kind = value;
        break;
      case "--video-width":
      case "--video-height":
      case "--video-duration": {
        if (!/^\d+$/.test(value))
          throw new CliParseError(`${flag} must be a positive integer, got '${value}'`);
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed <= 0)
          throw new CliParseError(`${flag} must be a positive integer, got '${value}'`);
        if (flag === "--video-width") out.videoWidth = parsed;
        else if (flag === "--video-height") out.videoHeight = parsed;
        else out.videoDuration = parsed;
        break;
      }
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
      case "--chat-id":
        out.chatId = value;
        break;
      case "--video":
        out.videoPath = value;
        break;
      case "--language":
        out.language = value;
        break;
      case "--privacy":
        if (value !== "private" && value !== "unlisted" && value !== "public") {
          throw new CliParseError(`--privacy must be private|unlisted|public, got '${value}'`);
        }
        out.privacy = value;
        break;
      // video subcommand flags
      case "--cover":
        out.cover = value;
        break;
      case "--audio":
        out.audio = value;
        break;
      case "--out":
        out.videoOut = value;
        break;
      case "--preset":
        out.preset = value;
        break;
      case "--cover-seconds": {
        const cs = Number.parseInt(value, 10);
        if (!Number.isInteger(cs) || cs <= 0) {
          throw new CliParseError(`--cover-seconds must be a positive integer, got '${value}'`);
        }
        out.coverSeconds = cs;
        break;
      }
      case "--seed": {
        const s = Number.parseInt(value, 10);
        if (!Number.isInteger(s)) {
          throw new CliParseError(`--seed must be an integer, got '${value}'`);
        }
        out.seed = s;
        break;
      }
      case "--canvas-width":
      case "--canvas-height": {
        if (!/^\d+$/.test(value))
          throw new CliParseError(`${flag} must be a positive integer (pixels), got '${value}'`);
        const px = Number.parseInt(value, 10);
        if (px <= 0 || px % 2 !== 0)
          throw new CliParseError(
            `${flag} must be a positive EVEN integer (h264 yuv420p), got '${value}'`,
          );
        if (flag === "--canvas-width") out.canvasWidth = px;
        else out.canvasHeight = px;
        break;
      }
      case "--max-bitrate": {
        if (!/^\d+$/.test(value)) {
          throw new CliParseError(
            `--max-bitrate must be a positive integer (kbit/s), got '${value}'`,
          );
        }
        const kbps = Number.parseInt(value, 10);
        if (kbps <= 0) {
          throw new CliParseError(
            `--max-bitrate must be a positive integer (kbit/s), got '${value}'`,
          );
        }
        out.maxBitrateKbps = kbps;
        break;
      }
      case "--waveform-height": {
        const h = Number.parseInt(value, 10);
        if (!Number.isInteger(h) || h <= 0) {
          throw new CliParseError(`--waveform-height must be a positive integer, got '${value}'`);
        }
        out.waveformHeight = h;
        break;
      }
      case "--waveform-colors": {
        if (!/^(0x|#)[0-9A-Fa-f]{6},(0x|#)[0-9A-Fa-f]{6}$/.test(value)) {
          throw new CliParseError(
            `--waveform-colors must be "LEFT,RIGHT" hex (e.g. 0xFFD24C,0xE03B5A), got '${value}'`,
          );
        }
        out.waveformColors = value;
        break;
      }
      // shotcraft engine flags (ARCA-0191)
      case "--engine":
        if (value !== "cycle" && value !== "shotcraft") {
          throw new CliParseError(`--engine must be 'cycle' or 'shotcraft', got '${value}'`);
        }
        out.engine = value;
        break;
      case "--asset":
        out.assets.push(value);
        break;
      case "--template":
        out.template = value;
        break;
      case "--shot":
        out.shots.push(value);
        break;
      case "--browser-executable":
        out.browserExecutable = value;
        break;
      case "--format":
        out.format = value;
        break;
    }
  }

  if (out.command === "inspect-profile-post") {
    const hasExact = Boolean(out.expectedContentFile);
    const hasExcerpt = Boolean(out.contentExcerpt);
    if (hasExact === hasExcerpt) {
      throw new CliParseError(
        "inspect-profile-post requires exactly one of --expected-content-file or --content-excerpt",
      );
    }
    if (!out.profileUrl || !out.expectedAuthorProfileUrl || !out.evidenceDir || !out.maxScrolls) {
      throw new CliParseError(
        "inspect-profile-post requires --profile-url, --expected-author-profile-url, --evidence-dir, and --max-scrolls",
      );
    }
  }

  return out;
}
