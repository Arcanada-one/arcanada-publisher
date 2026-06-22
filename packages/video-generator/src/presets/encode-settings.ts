// Shared bounded H.264 encode settings — single source of truth for the
// compact social-video output format (PUB-0028).
//
// Security: the cap values (maxBitrateKbps, crf) arrive as TypeScript numbers;
// they are never user-supplied strings. Only their numeric template expansion
// (`${n}k`) reaches the ffmpeg arg-array. This satisfies the R1/R2 threat-model
// items in PUB-0028-plan.md Appendix A.

import type { BuildContext } from "./types.js";

/** Compact social-video default: ~600 kbit/s ceiling, H.264 High L4.0. */
export const DEFAULT_MAX_KBPS = 600;

/** Default CRF for the bounded final encode (operator-confirmed 2026-06-22). */
export const DEFAULT_CRF = 28;

/**
 * Returns the bounded H.264 encode arg fragment shared across all preset final
 * passes. Enforces:
 *   - VBV ceiling (-maxrate / -bufsize = 2× maxrate)
 *   - H.264 High profile, level 4.0 (web-/social-compatible)
 *   - yuv420p pixel format + bt709 tv-range colorspace
 *   - -movflags +faststart (moov atom before mdat for progressive playback)
 *
 * The returned array is spliced into the ffmpeg arg-array by each preset;
 * audio and I/O args are added by the caller.
 */
export function boundedVideoArgs(ctx: BuildContext): string[] {
  const kbps = ctx.maxBitrateKbps ?? DEFAULT_MAX_KBPS;
  const crf = ctx.crf ?? DEFAULT_CRF;
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-crf",
    String(crf),
    "-maxrate",
    `${kbps}k`,
    "-bufsize",
    `${kbps * 2}k`,
    "-pix_fmt",
    "yuv420p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-movflags",
    "+faststart",
  ];
}
