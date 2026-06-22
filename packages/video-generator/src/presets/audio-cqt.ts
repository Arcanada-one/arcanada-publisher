// Preset: cqt — showcqt music visualizer overlaid on a blurred+darkened cover.
// Requires audio to produce meaningful output; falls back to zoompan (with a
// stderr note) when no audio is provided, since showcqt needs a signal.

import type { PresetDef, BuildContext, PresetPlan } from "./types.js";
import { zoompanPreset } from "./cover-zoompan.js";
import { boundedVideoArgs } from "./encode-settings.js";

function buildCqtArgs(ctx: BuildContext): string[] {
  const { cover, audio, out, width, height, fps, durationSec } = ctx;
  // audio is guaranteed to be defined here (fallback handled in buildPlan).
  const vizH = Math.round(height * 0.4); // bottom 40% height for visualizer
  const bgH = height - vizH;

  const filterComplex = [
    // Stream 0: cover → blurred/darkened background
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `setsar=1,gblur=sigma=8,eq=brightness=-0.15:saturation=0.7,format=yuv420p[bg]`,
    // Stream 1: audio → showcqt (limited to bottom vizH rows)
    `[1:a]showcqt=s=${width}x${vizH}:fps=${fps}:bar_g=2:axis=0:tc=0.33:tlength=0.4,` +
      `format=yuv420p[cqt]`,
    // Overlay: cqt at bottom, bg top covers bgH
    `[bg][cqt]overlay=0:${bgH}[out]`,
  ].join(";");

  return [
    "-y", "-v", "error",
    "-loop", "1", "-t", String(durationSec + 1), "-i", cover,
    "-i", audio as string,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-map", "1:a",
    "-t", String(durationSec),
    "-r", String(fps),
    // Bounded H.264 encode (shared helper — yuv420p, bt709, faststart, VBV cap).
    ...boundedVideoArgs(ctx),
    "-c:a", "aac", "-b:a", "160k",
    "-shortest",
    out,
  ];
}

export const cqtPreset: PresetDef = {
  name: "cqt",
  description:
    "Music visualizer (showcqt) overlaid on a blurred cover background. Requires audio; falls back to zoompan for cover-only.",
  timelineChanging: false,
  buildPlan(ctx: BuildContext): PresetPlan {
    if (ctx.audio === undefined) {
      // Fallback: cqt needs audio signal — silently use zoompan instead.
      process.stderr.write(
        "[publisher-video] cqt preset requires audio; falling back to zoompan for cover-only.\n",
      );
      return zoompanPreset.buildPlan(ctx);
    }
    return {
      passes: [{ args: buildCqtArgs(ctx), label: "cqt render" }],
    };
  },
};
