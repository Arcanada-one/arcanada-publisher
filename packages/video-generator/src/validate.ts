// Input validation for the video generator.
// Mirrors the adapter pattern (validateImagePath in adapter-x-twitter/src/image.ts)
// with extension allowlists appropriate for cover images and audio files.

import { existsSync, statSync } from "node:fs";
import { extname, resolve as resolvePath, dirname } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

// Allowlist for cover images (same as platform adapters, minus video exts).
const COVER_EXT_ALLOWLIST = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// Allowlist for audio files.
const AUDIO_EXT_ALLOWLIST = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg"]);

/** Validate a cover image path and return the resolved absolute path. */
export function validateCoverPath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "video: cover path contains NUL byte");
  }
  const abs = resolvePath(rawPath);
  if (!existsSync(abs)) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, `video: cover image not found: ${abs}`, {
      path: abs,
    });
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `video: cover path is not a regular file: ${abs}`,
    );
  }
  const ext = extname(abs).toLowerCase();
  if (!COVER_EXT_ALLOWLIST.has(ext)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `video: unsupported cover extension '${ext}'`,
      { path: abs, allowed: [...COVER_EXT_ALLOWLIST] },
    );
  }
  return abs;
}

/** Validate an audio file path and return the resolved absolute path. */
export function validateAudioPath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "video: audio path contains NUL byte");
  }
  const abs = resolvePath(rawPath);
  if (!existsSync(abs)) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, `video: audio file not found: ${abs}`, {
      path: abs,
    });
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `video: audio path is not a regular file: ${abs}`,
    );
  }
  const ext = extname(abs).toLowerCase();
  if (!AUDIO_EXT_ALLOWLIST.has(ext)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `video: unsupported audio extension '${ext}'`,
      { path: abs, allowed: [...AUDIO_EXT_ALLOWLIST] },
    );
  }
  return abs;
}

/** Validate an output path: must not contain NUL bytes; parent directory must exist. */
export function validateOutputPath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "video: output path contains NUL byte");
  }
  const abs = resolvePath(rawPath);
  const parent = dirname(abs);
  if (!existsSync(parent)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `video: output directory does not exist: ${parent}`,
      { path: abs },
    );
  }
  return abs;
}
