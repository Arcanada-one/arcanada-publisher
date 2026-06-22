// ffmpeg / ffprobe locator and spawn wrapper.
//
// Security contract (Appendix A):
//   - Binaries are resolved from PATH; never constructed from user input.
//   - All spawn calls use execFileSync (arg-array, shell: false by default).
//   - No user string is ever concatenated into an argument array.
//   - ffprobe is used only for duration probing on a validated path.

import { execFileSync } from "node:child_process";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

// Cache the resolved paths for the lifetime of the process.
let _ffmpegPath: string | undefined;
let _ffprobePath: string | undefined;

function whichSync(bin: string): string | undefined {
  try {
    const out = execFileSync("which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate ffmpeg and ffprobe in PATH.
 * Throws AdapterError(MISSING_INPUT) with a clear install hint when absent.
 */
export function requireFfmpeg(): { ffmpeg: string; ffprobe: string } {
  if (_ffmpegPath === undefined) {
    _ffmpegPath = whichSync("ffmpeg");
  }
  if (_ffprobePath === undefined) {
    _ffprobePath = whichSync("ffprobe");
  }

  if (_ffmpegPath === undefined) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "ffmpeg not found in PATH — install it: brew install ffmpeg (macOS) or apt install ffmpeg (Debian/Ubuntu)",
    );
  }
  if (_ffprobePath === undefined) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "ffprobe not found in PATH — install it alongside ffmpeg: brew install ffmpeg",
    );
  }

  return { ffmpeg: _ffmpegPath, ffprobe: _ffprobePath };
}

/**
 * Run ffmpeg with an argument array.
 * Throws on non-zero exit (execFileSync behaviour).
 * Never uses shell: true.
 */
export function runFfmpeg(args: string[]): void {
  const { ffmpeg } = requireFfmpeg();
  try {
    execFileSync(ffmpeg, args, { stdio: ["ignore", "inherit", "inherit"] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterError(ErrorCode.INTERNAL_PANIC, `ffmpeg failed: ${message}`);
  }
}

/**
 * Probe the duration of a media file using ffprobe.
 * Returns duration in seconds as a float.
 * Throws when the file cannot be probed.
 */
export function probeDuration(filePath: string): number {
  const { ffprobe } = requireFfmpeg();
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ];
  try {
    const out = execFileSync(ffprobe, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const dur = parseFloat(out.trim());
    if (!Number.isFinite(dur) || dur <= 0) {
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        `ffprobe: could not read valid duration from '${filePath}' (got '${out.trim()}')`,
      );
    }
    return dur;
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `ffprobe: failed to probe '${filePath}': ${message}`,
    );
  }
}

/**
 * Probe whether a file has a video stream and an audio stream.
 * Returns { hasVideo, hasAudio, durationSec }.
 */
export function probeStreams(
  filePath: string,
): { hasVideo: boolean; hasAudio: boolean; durationSec: number } {
  const { ffprobe } = requireFfmpeg();
  const args = [
    "-v", "error",
    "-show_entries", "stream=codec_type:format=duration",
    "-of", "flat",
    filePath,
  ];
  try {
    const out = execFileSync(ffprobe, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // ffprobe -of flat quotes values: codec_type="video"
    const hasVideo = out.includes('codec_type="video"');
    const hasAudio = out.includes('codec_type="audio"');
    const match = /format\.duration="?([0-9.]+)"?/.exec(out);
    const durationSec = match ? parseFloat(match[1] as string) : 0;
    return { hasVideo, hasAudio, durationSec };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `ffprobe: failed to probe streams of '${filePath}': ${message}`,
    );
  }
}

/** Visible for testing: reset cached binary paths (needed in tests that mock PATH). */
export function _resetFfmpegCache(): void {
  _ffmpegPath = undefined;
  _ffprobePath = undefined;
}
