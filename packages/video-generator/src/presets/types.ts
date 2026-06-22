// Types shared across preset builders and the generator orchestrator.

/** Parameters the orchestrator resolves before calling a preset builder. */
export interface BuildContext {
  /** Absolute path to the cover image (already validated). */
  cover: string;
  /** Absolute path to the audio file, or undefined for cover-only. */
  audio: string | undefined;
  /** Target duration in seconds (audio duration or coverOnlySeconds). */
  durationSec: number;
  /** Output MP4 path. */
  out: string;
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /** Frames per second. */
  fps: number;
  /** Optional seed for reproducible shuffle (cycle preset). */
  seed: number | undefined;
  /** Duration for cover-only output (when audio is absent). Default 30. */
  coverOnlySeconds: number;
}

/**
 * A resolved ffmpeg invocation plan.
 * Multi-pass presets (like cycle) return multiple passes executed in sequence.
 */
export interface FfmpegPass {
  /** Argument array for execFileSync — no shell expansion, never shell:true. */
  args: string[];
  /** Human-readable label for progress logging. */
  label: string;
}

/** Return value from a preset's buildPlan function. */
export interface PresetPlan {
  passes: FfmpegPass[];
  /**
   * For multi-pass presets that use a temp workdir, provide the path so the
   * orchestrator can clean it up on success.
   */
  workdir?: string | undefined;
}

/** Preset definition registered in PRESET_REGISTRY. */
export interface PresetDef {
  name: string;
  description: string;
  /** True when the preset changes visual effects across the timeline. */
  timelineChanging: boolean;
  /**
   * Build the ffmpeg pass list for the given context.
   * Pure function — no side effects, no file I/O.
   */
  buildPlan(ctx: BuildContext): PresetPlan;
}
