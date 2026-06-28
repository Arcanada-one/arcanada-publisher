// Pure builder tests for the bottom audio-amplitude strip.
//   - resolveWaveformConfig: defaults, merge, validation (height + hex colours).
//   - buildWaveformFilter: shape of the filter_complex graph.
//   - cyclePreset integration: the amplitude strip wires into the final mux pass
//     when (and only when) audio is present AND waveform.enabled.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_WAVEFORM,
  resolveWaveformConfig,
  buildWaveformFilter,
} from "../src/presets/waveform.js";
import { cyclePreset } from "../src/presets/cycle.js";
import type { BuildContext } from "../src/presets/types.js";

describe("resolveWaveformConfig", () => {
  it("returns the operator-approved house style by default", () => {
    const cfg = resolveWaveformConfig();
    expect(cfg).toEqual(DEFAULT_WAVEFORM);
    expect(cfg.enabled).toBe(true);
    expect(cfg.heightPx).toBe(180);
    expect(cfg.colorLeft).toBe("0xFFD24C"); // gold
    expect(cfg.colorRight).toBe("0xE03B5A"); // crimson
  });

  it("merges a partial override over the defaults", () => {
    const cfg = resolveWaveformConfig({ heightPx: 100, colorLeft: "0x35E0FF" });
    expect(cfg.heightPx).toBe(100);
    expect(cfg.colorLeft).toBe("0x35E0FF");
    expect(cfg.colorRight).toBe(DEFAULT_WAVEFORM.colorRight); // untouched
    expect(cfg.enabled).toBe(true);
  });

  it("honours an explicit disable", () => {
    expect(resolveWaveformConfig({ enabled: false }).enabled).toBe(false);
  });

  it("rejects a non-positive or non-integer height", () => {
    expect(() => resolveWaveformConfig({ heightPx: 0 })).toThrow(/positive integer/);
    expect(() => resolveWaveformConfig({ heightPx: -10 })).toThrow(/positive integer/);
    expect(() => resolveWaveformConfig({ heightPx: 12.5 })).toThrow(/positive integer/);
  });

  it("rejects a malformed colour (no raw strings reach filter_complex)", () => {
    expect(() => resolveWaveformConfig({ colorLeft: "red" })).toThrow(/hex colour/);
    expect(() => resolveWaveformConfig({ colorRight: "0xZZZ" })).toThrow(/hex colour/);
  });

  it("accepts both 0x and # hex forms, with or without alpha", () => {
    expect(() => resolveWaveformConfig({ colorLeft: "#FFD24C" })).not.toThrow();
    expect(() => resolveWaveformConfig({ colorRight: "0xE03B5AFF" })).not.toThrow();
  });
});

describe("buildWaveformFilter", () => {
  const cfg = DEFAULT_WAVEFORM;

  it("builds the showwaves → gradient → alphamerge → overlay graph", () => {
    const fc = buildWaveformFilter(cfg, 1280, 720, 30);
    expect(fc).toContain("showwaves=s=1280x180:mode=cline:colors=white");
    expect(fc).toContain("gradients=s=1280x180:c0=0xFFD24C:c1=0xE03B5A");
    expect(fc).toContain("alphamerge[wfwave]");
    // Strip pinned to the bottom edge: y = height - stripH = 720 - 180 = 540.
    expect(fc).toContain("[0:v][wfwave]overlay=0:540");
    expect(fc.endsWith("[vout]")).toBe(true);
  });

  it("clamps a strip taller than the frame to the canvas height", () => {
    const fc = buildWaveformFilter({ ...cfg, heightPx: 900 }, 1280, 720, 30);
    expect(fc).toContain("1280x720"); // clamped to 720, not 900
    expect(fc).toContain("overlay=0:0"); // y = 720 - 720 = 0
  });
});

const baseCtx: BuildContext = {
  cover: "/test/cover.jpg",
  audio: "/test/audio.mp3",
  out: "/test/out.mp4",
  durationSec: 8,
  width: 1280,
  height: 720,
  fps: 30,
  seed: 0,
  coverOnlySeconds: 30,
};

/** The final pass is the last entry in the cycle plan. */
function finalPassArgs(ctx: BuildContext): string[] {
  const plan = cyclePreset.buildPlan(ctx);
  const last = plan.passes[plan.passes.length - 1];
  return last?.args ?? [];
}

describe("cyclePreset — amplitude strip wiring", () => {
  it("overlays the strip in the final mux pass when audio present + enabled (default)", () => {
    const args = finalPassArgs({ ...baseCtx, waveform: resolveWaveformConfig() });
    expect(args).toContain("-filter_complex");
    const fc = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(fc).toContain("showwaves");
    expect(fc).toContain("[0:v][wfwave]overlay");
    // Video is taken from the overlay output, audio from input 1.
    expect(args).toContain("[vout]");
    expect(args.join(" ")).toContain("-map 1:a");
  });

  it("does NOT overlay when waveform is disabled", () => {
    const args = finalPassArgs({ ...baseCtx, waveform: resolveWaveformConfig({ enabled: false }) });
    expect(args).not.toContain("-filter_complex");
    expect(args.join(" ")).toContain("-map 0:v");
  });

  it("does NOT overlay on a cover-only run (no audio) even when enabled", () => {
    const args = finalPassArgs({
      ...baseCtx,
      audio: undefined,
      waveform: resolveWaveformConfig(),
    });
    expect(args).not.toContain("-filter_complex");
  });
});
