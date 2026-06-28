// Preset: cycle — house-style timeline-changing video (ported from make-cycle-video.sh).
//
// Algorithm (matching the bash engine):
//   1. Intro segment: clean cover held for intro_sec.
//   2. Each subsequent segment applies one effect from a Fisher-Yates-shuffled
//      pool, lasting seg_sec.
//   3. Segments are crossfaded with xfade=fade in batches of BATCH.
//   4. Audio is muxed last with -shortest; cover-only runs produce ~30 s cycle.
//
// All paths are passed as argument-array elements to execFileSync — never
// interpolated into a shell string. Filtergraph strings come only from the
// fixed EFFECT_POOL (no user input enters filter_complex).

import { join as pathJoin, dirname } from "node:path";
import { EFFECT_POOL, buildEffectSequence, substituteEffectParams } from "./cycle-effects.js";
import type { PresetDef, BuildContext, FfmpegPass, PresetPlan } from "./types.js";
import { boundedVideoArgs } from "./encode-settings.js";
import { buildWaveformFilter } from "./waveform.js";

const INTRO_SEC = 2;
const SEG_SEC = 3;
const XF = 0.6; // crossfade duration between segments (seconds)
const BATCH = 12; // segments fused per xfade pass
/** Safety cap: refuse to render more than MAX_AUDIO_MINUTES of audio-driven segments. */
const MAX_AUDIO_MINUTES = 60;

function buildIntroPass(ctx: BuildContext, workdir: string, introLen: number): FfmpegPass {
  const { cover, width, height, fps } = ctx;
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");
  return {
    label: "cycle: intro segment",
    args: [
      "-y",
      "-v",
      "error",
      "-loop",
      "1",
      "-t",
      String(introLen),
      "-i",
      cover,
      "-vf",
      vf,
      "-r",
      String(fps),
      "-t",
      String(introLen),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      pathJoin(workdir, "seg-000.mp4"),
    ],
  };
}

function buildEffectPass(
  ctx: BuildContext,
  workdir: string,
  index: number,
  effectStr: string,
  segLen: number,
): FfmpegPass {
  const { cover, width, height, fps } = ctx;
  const numStr = String(index).padStart(3, "0");
  const filterComplex = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,${effectStr},format=yuv420p[v]`;
  return {
    label: `cycle: segment ${index}`,
    args: [
      "-y",
      "-v",
      "error",
      "-loop",
      "1",
      "-t",
      String(segLen),
      "-i",
      cover,
      "-filter_complex",
      filterComplex,
      "-map",
      "[v]",
      "-r",
      String(fps),
      "-t",
      String(segLen),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      pathJoin(workdir, `seg-${numStr}.mp4`),
    ],
  };
}

/**
 * Build a single xfade-chain pass that joins `inputPaths` into `outputPath`.
 * When only one input, it is remuxed directly.
 */
function buildXfadePass(
  inputPaths: string[],
  outputPath: string,
  fps: number,
  xfDur: number,
  segDurations: number[],
): FfmpegPass {
  if (inputPaths.length === 1) {
    return {
      label: `xfade: pass-through → ${outputPath}`,
      args: ["-y", "-v", "error", "-i", inputPaths[0] as string, "-c", "copy", outputPath],
    };
  }

  const inputArgs: string[] = [];
  for (const p of inputPaths) {
    inputArgs.push("-i", p);
  }

  const n = inputPaths.length;
  const fcParts: string[] = [];
  let prev = "0:v";
  let acc = segDurations[0] ?? 0;
  for (let m = 1; m < n; m++) {
    const offset = Math.max(0, acc - xfDur);
    const label = `x${m}`;
    fcParts.push(
      `[${prev}][${m}:v]xfade=transition=fade:duration=${xfDur.toFixed(3)}:offset=${offset.toFixed(3)}[${label}]`,
    );
    prev = label;
    acc += (segDurations[m] ?? 0) - xfDur;
  }

  return {
    label: `xfade: chain ${inputPaths.length} → ${outputPath}`,
    args: [
      "-y",
      "-v",
      "error",
      ...inputArgs,
      "-filter_complex",
      fcParts.join(";"),
      "-map",
      `[x${n - 1}]`,
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      outputPath,
    ],
  };
}

/**
 * Final assembly pass: bounded H.264 re-encode (replaces the prior -c:v copy).
 * The VBV ceiling (maxrate/bufsize) is enforced once here on the assembled stream,
 * giving a deterministic file-size guarantee independent of per-segment CRF.
 * faststart and yuv420p come from boundedVideoArgs (single source of truth).
 *
 * When audio is present AND ctx.waveform is enabled, the bottom audio-amplitude
 * strip (gradient showwaves) is overlaid in this same pass via filter_complex —
 * no extra pass, no extra temp file. The strip is drawn ON TOP of the assembled
 * cycle animation, so the cover stays the hero (this is not a bare-waveform
 * video, which the publishing policy forbids as the whole post).
 */
function buildMuxPass(
  ctx: BuildContext,
  silentVideo: string,
  audio: string | undefined,
  out: string,
): FfmpegPass {
  const v = boundedVideoArgs(ctx);
  if (audio === undefined) {
    // Cover-only run: no audio → no amplitude strip possible.
    return {
      label: "cycle: final bounded encode (no audio)",
      args: ["-y", "-v", "error", "-i", silentVideo, ...v, out],
    };
  }

  const wantWaveform = ctx.waveform?.enabled === true;
  if (wantWaveform) {
    const filterComplex = buildWaveformFilter(
      ctx.waveform as NonNullable<BuildContext["waveform"]>,
      ctx.width,
      ctx.height,
      ctx.fps,
    );
    return {
      label: "cycle: final bounded encode + mux audio + amplitude strip",
      args: [
        "-y",
        "-v",
        "error",
        "-i",
        silentVideo,
        "-i",
        audio,
        "-filter_complex",
        filterComplex,
        "-map",
        "[vout]",
        "-map",
        "1:a",
        ...v,
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        out,
      ],
    };
  }

  return {
    label: "cycle: final bounded encode + mux audio",
    args: [
      "-y",
      "-v",
      "error",
      "-i",
      silentVideo,
      "-i",
      audio,
      "-map",
      "0:v",
      "-map",
      "1:a",
      ...v,
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-shortest",
      out,
    ],
  };
}

function buildCyclePlan(ctx: BuildContext): PresetPlan {
  const { out, fps, durationSec, seed } = ctx;
  const workdir = pathJoin(dirname(out), `_cycleWork-${Date.now()}`);

  if (durationSec > MAX_AUDIO_MINUTES * 60) {
    throw new Error(
      `cycle: audio duration ${durationSec}s exceeds the ${MAX_AUDIO_MINUTES}-minute safety cap`,
    );
  }

  const introLen = INTRO_SEC + XF; // intro segment length (with xfade tail)
  const segLen = SEG_SEC + XF; // per-effect segment length (with xfade tail)
  const nseg = Math.max(1, Math.ceil((durationSec - INTRO_SEC) / SEG_SEC));
  const effectSeq = buildEffectSequence(nseg, seed);
  const dt = fps * SEG_SEC;

  const passes: FfmpegPass[] = [];

  // 1. Intro segment (clean cover)
  passes.push(buildIntroPass(ctx, workdir, introLen));

  // 2. Per-effect segments
  for (let i = 0; i < nseg; i++) {
    const efxIdx = effectSeq[i];
    if (efxIdx === undefined) continue;
    const rawEffect = EFFECT_POOL[efxIdx] ?? (EFFECT_POOL[0] as string);
    const effectStr = substituteEffectParams(rawEffect, dt);
    passes.push(buildEffectPass(ctx, workdir, i + 1, effectStr, segLen));
  }

  // 3. Crossfade passes (batched)
  const allSegPaths: string[] = [pathJoin(workdir, "seg-000.mp4")];
  for (let i = 1; i <= nseg; i++) {
    allSegPaths.push(pathJoin(workdir, `seg-${String(i).padStart(3, "0")}.mp4`));
  }

  // Durations: intro has introLen, all effect segments have segLen
  const allSegDurations: number[] = [introLen, ...Array.from({ length: nseg }, () => segLen)];

  // Pass 1: batch fuse
  const chunkPaths: string[] = [];
  let ci = 0;
  for (let s = 0; s < allSegPaths.length; s += BATCH) {
    const batchPaths = allSegPaths.slice(s, s + BATCH);
    const batchDurs = allSegDurations.slice(s, s + BATCH);
    const chunkPath = pathJoin(workdir, `chunk-${String(ci).padStart(3, "0")}.mp4`);
    passes.push(buildXfadePass(batchPaths, chunkPath, fps, XF, batchDurs));
    chunkPaths.push(chunkPath);
    ci++;
  }

  // Pass 2: fuse chunks → silent video (or pass-through if only one chunk)
  const silentPath = pathJoin(workdir, "video-silent.mp4");
  // Approximate chunk durations for xfade offset math:
  const chunkDur = BATCH * SEG_SEC; // rough; xfade handles the precise overlap
  const chunkDurations = Array.from({ length: chunkPaths.length }, () => chunkDur);
  passes.push(buildXfadePass(chunkPaths, silentPath, fps, XF, chunkDurations));

  // Pass 3: final bounded encode + mux audio (or video-only bounded encode)
  passes.push(buildMuxPass(ctx, silentPath, ctx.audio, out));

  return { passes, workdir };
}

export const cyclePreset: PresetDef = {
  name: "cycle",
  description:
    "House-style timeline-changing video: clean cover intro (~2s), then a new visual effect every 3s from a shuffled pool of 44 effects with smooth crossfades. Ported from dev-tools/video/make-cycle-video.sh.",
  timelineChanging: true,
  buildPlan(ctx: BuildContext): PresetPlan {
    return buildCyclePlan(ctx);
  },
};
