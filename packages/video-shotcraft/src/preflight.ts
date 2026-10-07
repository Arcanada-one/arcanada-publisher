// Preflight: verify the render runtime (ffmpeg + ffprobe + a headless Chromium)
// before any render begins (DESIGN §2.3 / D2.3, mirrors the proven
// video-generator/src/ffmpeg.ts requireFfmpeg UX). On absence it throws
// AdapterError(MISSING_INPUT) with a clear install hint — exactly the
// ffmpeg-absent experience the sibling engine already ships.
//
// Security contract: binaries are resolved from PATH via `which`; never
// constructed from user input. Any browser-executable override is a
// pre-validated absolute path (see validate.ts). No shell-string interpolation.

import { execFileSync } from "node:child_process";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { validateBrowserExecutable } from "./validate.js";

export const BROWSER_ENV = "PUBLISHER_SHOTCRAFT_BROWSER";

let _ffmpeg: string | undefined;
let _ffprobe: string | undefined;

function whichSync(bin: string): string | undefined {
  try {
    const out = execFileSync("which", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Locate ffmpeg + ffprobe in PATH; throw MISSING_INPUT + install hint when absent. */
export function requireFfmpeg(): { ffmpeg: string; ffprobe: string } {
  if (_ffmpeg === undefined) _ffmpeg = whichSync("ffmpeg");
  if (_ffprobe === undefined) _ffprobe = whichSync("ffprobe");

  if (_ffmpeg === undefined) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "shotcraft: ffmpeg not found in PATH — install it: brew install ffmpeg (macOS) or apt install ffmpeg (Debian/Ubuntu)",
    );
  }
  if (_ffprobe === undefined) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "shotcraft: ffprobe not found in PATH — install it alongside ffmpeg: brew install ffmpeg",
    );
  }
  return { ffmpeg: _ffmpeg, ffprobe: _ffprobe };
}

export interface PreflightResult {
  ffmpeg: string;
  ffprobe: string;
  /** Absolute path to a browser-executable override, or undefined when using Remotion's managed shell. */
  browserExecutable: string | undefined;
}

/**
 * Verify the synchronous parts of the render runtime and resolve the browser
 * override (if any). The Remotion-managed headless shell is provisioned
 * separately by ensureManagedBrowser() so that this function stays cheap and
 * deterministically unit-testable (the ffmpeg-absent path is dry-runnable).
 */
export function preflight(opts: { browserExecutable?: string | undefined } = {}): PreflightResult {
  const { ffmpeg, ffprobe } = requireFfmpeg();

  const override = opts.browserExecutable ?? process.env[BROWSER_ENV];
  const browserExecutable =
    override !== undefined && override.trim() !== ""
      ? validateBrowserExecutable(override)
      : undefined;

  return { ffmpeg, ffprobe, browserExecutable };
}

/**
 * Ensure the Remotion-managed Chrome-Headless-Shell is present (downloads it on
 * first use). Called only when no browser-executable override is supplied.
 * Failure is translated to MISSING_INPUT with the documented install hint,
 * mirroring the ffmpeg-absent UX.
 */
export async function ensureManagedBrowser(): Promise<void> {
  try {
    const { ensureBrowser } = await import("@remotion/renderer");
    await ensureBrowser();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `shotcraft: headless Chromium unavailable — run 'npx remotion browser ensure', or pass ` +
        `--browser-executable <path> / set ${BROWSER_ENV} to reuse an existing Chromium. (${message})`,
    );
  }
}

/** Visible for testing: reset the cached ffmpeg/ffprobe paths. */
export function _resetPreflightCache(): void {
  _ffmpeg = undefined;
  _ffprobe = undefined;
}
