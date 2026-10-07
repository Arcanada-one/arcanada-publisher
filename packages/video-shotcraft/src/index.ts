// Public API for @arcanada/publisher-shotcraft — the cinematic Remotion render
// engine (DESIGN §1 §3, PRD D-REQ-01/03/04/05/06). renderCinematic wires:
//   license-gate → validate → preflight → vendor-assets → compose → Remotion
//   headless render → ffmpeg mux → ffprobe self-probe → shared result envelope.
//
// The result envelope { out, durationSec, hasAudio } matches
// @arcanada/publisher-video's GenerateResult so the CLI success message and the
// downstream `publish --image` handoff are engine-agnostic (D1).
//
// Security: every post-supplied path is validated before use; all subprocess
// spawns (Remotion's headless Chromium, ffmpeg mux, ffprobe) are arg-arrays with
// no shell-string interpolation; the vendored assets are read-only data.

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { validateTextFilePath, validateAssetPath, validateOutputPath } from "./validate.js";
import { assertLicenseAck } from "./license-gate.js";
import { preflight, ensureManagedBrowser } from "./preflight.js";
import { resolveShotCard, inkPressTemplateDir, type ShotCard } from "./vendor-assets.js";
import { DEFAULT_FORMAT, type RenderFormat } from "./formats.js";
import { probeVideo } from "./probe.js";
import { compositionEntry, publicDir } from "./paths.js";
import { totalFrames, type ShotSpec } from "./shot-plan.js";

export type { RenderFormat } from "./formats.js";
export { resolveFormat, listFormats, LANDSCAPE, DEFAULT_FORMAT } from "./formats.js";

/** Options for renderCinematic. */
export interface RenderCinematicOptions {
  /** Post text file (validated path; .txt/.md). */
  textFile: string;
  /** Product screenshot(s) (validated image paths). May be empty. */
  assets: string[];
  /** Output MP4 path (parent dir must exist). */
  out: string;
  /** Template id — default and only validated template for the baseline. */
  template?: "ink-press";
  /** Explicit shot-card designations; when omitted a default shot is selected. */
  shots?: string[];
  /** Render format; default = the landscape registry entry. */
  format?: RenderFormat;
  /** Optional Chromium executable override (else Remotion's managed shell). */
  browserExecutable?: string;
}

/** Result from a successful renderCinematic call (shared engine envelope). */
export interface RenderCinematicResult {
  out: string;
  durationSec: number;
  hasAudio: boolean;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Read an (already validated) image file and encode it as a data URI. */
function toDataUri(absPath: string): string {
  const mime = IMAGE_MIME[extname(absPath).toLowerCase()] ?? "application/octet-stream";
  const b64 = readFileSync(absPath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

/** Default shot selection when the caller does not name any (V-AC-2 path). */
const DEFAULT_SHOTS = ["brand-ink-open"];

/**
 * Render a cinematic promo MP4 from a social post (text + product asset[s]) using
 * the vendored Ink Press aesthetic and the selected shot cards.
 */
export async function renderCinematic(
  opts: RenderCinematicOptions,
): Promise<RenderCinematicResult> {
  // 1. License-ack gate (fail-closed — D-REQ-08).
  assertLicenseAck();

  // 2. Template guard (baseline: ink-press only).
  const template = opts.template ?? "ink-press";
  if (template !== "ink-press") {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `shotcraft: unknown --template '${template}' — only 'ink-press' is validated in the baseline`,
    );
  }
  // Reading the Ink Press template dir proves the pipeline consumes the vendored
  // template (throws MISSING_INPUT if the subtree is absent).
  inkPressTemplateDir();

  // 3. Validate every post-supplied path (fail-fast before any spawn).
  const textAbs = validateTextFilePath(opts.textFile);
  const assetAbs = opts.assets.map(validateAssetPath);
  const outAbs = validateOutputPath(opts.out);

  // 4. Resolve the render format (default landscape).
  const format: RenderFormat = opts.format ?? DEFAULT_FORMAT;

  // 5. Resolve shot cards (throws "card not found" on an unknown designation).
  const requested = opts.shots && opts.shots.length > 0 ? opts.shots : DEFAULT_SHOTS;
  const cards: ShotCard[] = requested.map(resolveShotCard);
  const shots: ShotSpec[] = cards.map((c) => ({
    name: c.name,
    durationFrames: c.durationFrames ?? 83,
  }));

  // 6. Preflight ffmpeg/ffprobe + resolve any browser override.
  const pre = preflight({ browserExecutable: opts.browserExecutable });

  // 7. When no override, ensure Remotion's managed headless shell is present.
  if (pre.browserExecutable === undefined) {
    await ensureManagedBrowser();
  }

  // 8. Assemble composition inputs.
  const postText = readFileSync(textAbs, "utf8");
  const assetDataUris = assetAbs.map(toDataUri);
  const pubDir = publicDir();
  const audioCandidate = join(pubDir, "audio", "riser-cine.mp3");
  const audioSrc = existsSync(audioCandidate) ? "audio/riser-cine.mp3" : null;
  const durationInFrames = totalFrames({ shots, assetCount: assetDataUris.length });

  const inputProps = {
    postText,
    assetDataUris,
    shots,
    audioSrc,
    width: format.width,
    height: format.height,
    fps: format.fps,
    durationInFrames,
  };

  // 9. Bundle + render (Remotion headless Chromium → frames → ffmpeg mux).
  const { bundle } = await import("@remotion/bundler");
  const { selectComposition, renderMedia } = await import("@remotion/renderer");

  const serveUrl = await bundle({
    entryPoint: compositionEntry(),
    publicDir: pubDir,
  });

  const composition = await selectComposition({
    serveUrl,
    id: "CinematicPromo",
    inputProps,
  });

  await renderMedia({
    serveUrl,
    composition,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: outAbs,
    inputProps,
    ...(pre.browserExecutable !== undefined ? { browserExecutable: pre.browserExecutable } : {}),
  });

  // 10. Self-probe: assert the output conforms to the RenderFormat (V-AC-4).
  const probed = probeVideo(pre.ffprobe, outAbs);
  if (probed.width !== format.width || probed.height !== format.height) {
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      `shotcraft: output dimensions ${probed.width}x${probed.height} != expected ${format.width}x${format.height}`,
    );
  }
  if (Math.abs(probed.fps - format.fps) > 1) {
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      `shotcraft: output fps ${probed.fps} != expected ~${format.fps}`,
    );
  }
  if (!probed.videoCodec.includes("264")) {
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      `shotcraft: output video codec '${probed.videoCodec}' is not H.264`,
    );
  }

  return {
    out: outAbs,
    durationSec: probed.durationSec,
    hasAudio: probed.hasAudio,
  };
}
