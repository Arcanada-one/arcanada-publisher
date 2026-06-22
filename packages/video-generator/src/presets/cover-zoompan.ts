// Preset: zoompan — calm single zoom/pan effect over the cover image.
// Slow zoom-in: z starts at 1.0 and increases at 0.0005/frame up to 1.08.
// Works for both cover-only and cover+audio paths.

import type { PresetDef, BuildContext, PresetPlan } from "./types.js";
import { boundedVideoArgs } from "./encode-settings.js";

function buildZoompanArgs(ctx: BuildContext): string[] {
  const { cover, audio, out, width, height, fps, durationSec } = ctx;
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    `zoompan=z='min(zoom+0.0005,1.08)':d=${Math.ceil(durationSec * fps)}:s=${width}x${height}:fps=${fps}`,
    "format=yuv420p",
  ].join(",");

  const args: string[] = ["-y", "-v", "error"];
  // Input
  args.push("-loop", "1", "-t", String(durationSec + 1), "-i", cover);
  if (audio !== undefined) {
    args.push("-i", audio);
  }
  // Video filter
  args.push("-vf", vf);
  args.push("-t", String(durationSec));
  args.push("-r", String(fps));
  // Bounded H.264 encode (shared helper — yuv420p, bt709, faststart, VBV cap).
  // Replaces the per-preset -crf 20 + -movflags +faststart block for consistency.
  const encodeArgs = boundedVideoArgs(ctx);
  // Audio mux inserted before encode args so the stream mapping precedes codec flags
  if (audio !== undefined) {
    args.push("-map", "0:v", "-map", "1:a");
    args.push(...encodeArgs);
    args.push("-c:a", "aac", "-b:a", "160k");
    args.push("-shortest");
  } else {
    args.push(...encodeArgs);
  }
  args.push(out);
  return args;
}

export const zoompanPreset: PresetDef = {
  name: "zoompan",
  description: "Calm slow zoom-in on the cover image. Works with or without audio.",
  timelineChanging: false,
  buildPlan(ctx: BuildContext): PresetPlan {
    return {
      passes: [{ args: buildZoompanArgs(ctx), label: "zoompan render" }],
    };
  },
};
