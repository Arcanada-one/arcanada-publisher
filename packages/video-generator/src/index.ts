// Public API for @arcanada/publisher-video.
// Entry point wires validation → ffmpeg locate → duration → preset → spawn → self-probe.

import { mkdirSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { validateCoverPath, validateAudioPath, validateOutputPath } from "./validate.js";
import { requireFfmpeg, runFfmpeg, probeDuration, probeStreams } from "./ffmpeg.js";
import { resolve as resolvePreset, describe } from "./presets/index.js";
import type { BuildContext } from "./presets/types.js";
import { resolveWaveformConfig, type WaveformConfig } from "./presets/waveform.js";

/** Options for generateVideo. */
export interface GenerateOptions {
  /** Required cover image path (png/jpg/jpeg/webp/gif). */
  cover: string;
  /** Optional audio file (mp3/m4a/aac/wav/ogg). When absent, produces ~30s cover-only clip. */
  audio?: string | undefined;
  /** Output MP4 path. Parent directory must exist. */
  out: string;
  /** Preset name. Default: "cycle". */
  preset?: string | undefined;
  /** Cover-only clip duration in seconds. Default: 30. Ignored when audio is provided. */
  coverOnlySeconds?: number | undefined;
  /** Optional seed for reproducible effect shuffle (cycle preset). */
  seed?: number | undefined;
  /**
   * Max output video bitrate ceiling in kbit/s for the final bounded encode.
   * Default: 600 (compact social-video format). Validated as a positive integer
   * at the CLI boundary; programmatic callers supply a TypeScript number.
   */
  maxBitrateKbps?: number | undefined;
  /**
   * libx264 CRF for the final bounded encode. Default: 28.
   * Lower = better quality / larger file. Only applies to the final assembly pass.
   */
  crf?: number | undefined;
  /**
   * Bottom audio-amplitude strip (cycle preset only; ignored by other presets
   * and by cover-only runs that have no audio). A partial object is merged over
   * the operator-approved house style (enabled, 180px, gold→crimson gradient).
   * Pass `{ enabled: false }` to suppress the strip. Omit entirely → house style.
   */
  waveform?: Partial<WaveformConfig> | undefined;
}

/** Result from a successful generateVideo call. */
export interface GenerateResult {
  /** Absolute path to the generated MP4. */
  out: string;
  /** Duration of the output in seconds (as probed by ffprobe). */
  durationSec: number;
  /** Whether the output has an audio stream. */
  hasAudio: boolean;
}

/** List all available presets with their metadata. */
export function listPresets(): { name: string; description: string; timelineChanging: boolean }[] {
  return describe();
}

/**
 * Generate an animated MP4 from a cover image and optional audio.
 *
 * Two-path contract:
 *   - audio provided → duration = audio length, video + audio streams present.
 *   - no audio → duration ≈ coverOnlySeconds (default 30), video only (no audio stream).
 *
 * Security: ffmpeg is spawned with an argument array (never a shell string).
 * Filtergraph strings come only from the fixed preset registry.
 */
export async function generateVideo(opts: GenerateOptions): Promise<GenerateResult> {
  // 1. Validate inputs (fail-fast before any ffmpeg call).
  const coverAbs = validateCoverPath(opts.cover);
  const audioAbs = opts.audio !== undefined ? validateAudioPath(opts.audio) : undefined;
  const outAbs = validateOutputPath(opts.out);

  // 2. Ensure ffmpeg/ffprobe are available.
  requireFfmpeg();

  // 3. Resolve preset (throws INVALID_ARGS for unknown name).
  const presetName = opts.preset ?? "cycle";
  const preset = resolvePreset(presetName);

  // 4. Determine target duration.
  const coverOnlySeconds = opts.coverOnlySeconds ?? 30;
  const durationSec = audioAbs !== undefined ? probeDuration(audioAbs) : coverOnlySeconds;

  // 5. Build execution plan.
  // Resolve the waveform strip config (house-style default unless overridden).
  // Validation (height / hex colours) happens here, fail-fast before any ffmpeg call.
  const waveform = resolveWaveformConfig(opts.waveform);

  const ctx: BuildContext = {
    cover: coverAbs,
    audio: audioAbs,
    out: outAbs,
    durationSec,
    width: 1280,
    height: 720,
    fps: 30,
    seed: opts.seed,
    coverOnlySeconds,
    maxBitrateKbps: opts.maxBitrateKbps,
    crf: opts.crf,
    waveform,
  };

  const plan = preset.buildPlan(ctx);

  // 6. Create workdir if multi-pass (cycle).
  if (plan.workdir !== undefined) {
    mkdirSync(plan.workdir, { recursive: true });
  }

  // 7. Execute passes sequentially.
  try {
    for (const pass of plan.passes) {
      process.stderr.write(`[publisher-video] ${pass.label}\n`);
      runFfmpeg(pass.args);
    }
  } finally {
    // 8. Clean up workdir on success (leave on failure for debug).
    // We only clean on success (no-throw path below), so wrap with try/catch at call site.
  }

  // If we reach here all passes succeeded — clean workdir.
  if (plan.workdir !== undefined) {
    try {
      rmSync(plan.workdir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; do not fail the overall result.
    }
  }

  // 9. Self-probe result.
  const probed = probeStreams(resolvePath(outAbs));
  return {
    out: outAbs,
    durationSec: probed.durationSec,
    hasAudio: probed.hasAudio,
  };
}
