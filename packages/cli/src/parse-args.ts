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

export type Command = "publish" | "comment" | "edit" | "delete" | "login" | "server" | "video";

const COMMANDS = new Set<Command>([
  "publish",
  "comment",
  "edit",
  "delete",
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
  /** Telegram-specific: target chat/channel id or @username. */
  chatId: string | undefined;
  /** X-specific (PUB-0033): opt-in Premium long-form mode (25 000-char limit). */
  premium: boolean;
  /**
   * PUB-0033: run the browser headed (visible) instead of headless. Large video
   * uploads settle far more reliably in a headed context; default stays headless.
   */
  headed: boolean;
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
  "--chat-id",
  // video subcommand flags
  "--cover",
  "--audio",
  "--out",
  "--preset",
  "--cover-seconds",
  "--seed",
  "--max-bitrate",
  "--waveform-height",
  "--waveform-colors",
]);

const BOOL_FLAGS = new Set([
  "--dry-run",
  "--list-presets",
  "--premium",
  "--headed",
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
    expectedContent: undefined,
    bind: undefined,
    port: undefined,
    subreddit: undefined,
    title: undefined,
    ownerId: undefined,
    chatId: undefined,
    premium: false,
    headed: false,
    cover: undefined,
    audio: undefined,
    videoOut: undefined,
    preset: undefined,
    coverSeconds: undefined,
    seed: undefined,
    listPresets: false,
    maxBitrateKbps: undefined,
    noWaveform: false,
    waveformHeight: undefined,
    waveformColors: undefined,
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
    if (flag === "--headed") {
      out.headed = true;
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
      case "--chat-id":
        out.chatId = value;
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
    }
  }

  return out;
}
