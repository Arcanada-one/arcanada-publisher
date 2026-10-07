// Input validation for the shotcraft render engine.
//
// Security contract (Appendix A / F8): every post-supplied path is validated for
// NUL bytes, existence and an extension allowlist BEFORE it reaches any Remotion
// bundle, headless-Chromium spawn or ffmpeg mux. Mirrors the proven
// video-generator/src/validate.ts shape (no shell-string interpolation anywhere
// downstream; all spawns are arg-arrays).

import { existsSync, statSync } from "node:fs";
import { extname, resolve as resolvePath, dirname } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

// Post text file: plain text or markdown.
const TEXT_EXT_ALLOWLIST = new Set([".txt", ".md", ".markdown"]);

// Product asset (screenshot / image) allowlist — same as the platform adapters.
const ASSET_EXT_ALLOWLIST = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** Validate the post text file path and return the resolved absolute path. */
export function validateTextFilePath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "shotcraft: text-file path contains NUL byte");
  }
  const abs = resolvePath(rawPath);
  if (!existsSync(abs)) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, `shotcraft: text file not found: ${abs}`, {
      path: abs,
    });
  }
  if (!statSync(abs).isFile()) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `shotcraft: text-file path is not a regular file: ${abs}`,
    );
  }
  const ext = extname(abs).toLowerCase();
  if (!TEXT_EXT_ALLOWLIST.has(ext)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `shotcraft: unsupported text extension '${ext}' — allowed: ${[...TEXT_EXT_ALLOWLIST].join(", ")}`,
      { path: abs },
    );
  }
  return abs;
}

/** Validate a single product-asset image path and return the resolved absolute path. */
export function validateAssetPath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "shotcraft: asset path contains NUL byte");
  }
  const abs = resolvePath(rawPath);
  if (!existsSync(abs)) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, `shotcraft: asset not found: ${abs}`, {
      path: abs,
    });
  }
  if (!statSync(abs).isFile()) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `shotcraft: asset path is not a regular file: ${abs}`,
    );
  }
  const ext = extname(abs).toLowerCase();
  if (!ASSET_EXT_ALLOWLIST.has(ext)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `shotcraft: unsupported asset extension '${ext}' — allowed: ${[...ASSET_EXT_ALLOWLIST].join(", ")}`,
      { path: abs },
    );
  }
  return abs;
}

/** Validate the output MP4 path: no NUL byte; parent directory must exist. */
export function validateOutputPath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "shotcraft: output path contains NUL byte");
  }
  const abs = resolvePath(rawPath);
  const parent = dirname(abs);
  if (!existsSync(parent)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `shotcraft: output directory does not exist: ${parent}`,
      { path: abs },
    );
  }
  return abs;
}

/** Validate an optional browser-executable override path (must exist, no NUL). */
export function validateBrowserExecutable(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "shotcraft: browser-executable path contains NUL byte",
    );
  }
  const abs = resolvePath(rawPath);
  if (!existsSync(abs)) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `shotcraft: browser executable not found: ${abs}`,
      { path: abs },
    );
  }
  if (!statSync(abs).isFile()) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `shotcraft: browser-executable path is not a regular file: ${abs}`,
    );
  }
  return abs;
}
