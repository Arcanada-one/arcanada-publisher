// Unit tests for the boundedVideoArgs helper (encode-settings.ts).
// Pure function tests — no ffmpeg spawn. Covers T1, T2, T3, T4, T5, T6.

import { describe, it, expect } from "vitest";
import { boundedVideoArgs, DEFAULT_MAX_KBPS, DEFAULT_CRF } from "../src/presets/encode-settings.js";
import type { BuildContext } from "../src/presets/types.js";
import { cyclePreset } from "../src/presets/cycle.js";
import { zoompanPreset } from "../src/presets/cover-zoompan.js";
import { cqtPreset } from "../src/presets/audio-cqt.js";

const COVER = "/test/cover.jpg";
const AUDIO = "/test/audio.mp3";
const OUT = "/test/out.mp4";

function makeCtx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    cover: COVER,
    audio: AUDIO,
    out: OUT,
    durationSec: 10,
    width: 1280,
    height: 720,
    fps: 30,
    seed: 0,
    coverOnlySeconds: 30,
    ...overrides,
  };
}

// ---- T1: default compact settings ----

describe("T1: boundedVideoArgs — compact defaults", () => {
  it("defaults are 600 kbps and CRF 28", () => {
    expect(DEFAULT_MAX_KBPS).toBe(600);
    expect(DEFAULT_CRF).toBe(28);
  });

  it("emits -maxrate 600k at default", () => {
    const args = boundedVideoArgs(makeCtx());
    const idx = args.indexOf("-maxrate");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("600k");
  });

  it("emits -bufsize 1200k at default (2× maxrate)", () => {
    const args = boundedVideoArgs(makeCtx());
    const idx = args.indexOf("-bufsize");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("1200k");
  });

  it("emits -crf 28 at default", () => {
    const args = boundedVideoArgs(makeCtx());
    const idx = args.indexOf("-crf");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("28");
  });

  it("emits -pix_fmt yuv420p", () => {
    const args = boundedVideoArgs(makeCtx());
    const idx = args.indexOf("-pix_fmt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("yuv420p");
  });

  it("emits -movflags +faststart", () => {
    const args = boundedVideoArgs(makeCtx());
    const idx = args.indexOf("-movflags");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("+faststart");
  });

  it("emits -c:v libx264 -preset veryfast", () => {
    const args = boundedVideoArgs(makeCtx());
    expect(args).toContain("libx264");
    expect(args).toContain("veryfast");
  });

  it("emits bt709 colorspace flags", () => {
    const args = boundedVideoArgs(makeCtx());
    expect(args).toContain("bt709");
  });
});

// ---- T2: configurable cap ----

describe("T2: boundedVideoArgs — honours maxBitrateKbps", () => {
  it("emits -maxrate 300k when maxBitrateKbps=300", () => {
    const args = boundedVideoArgs(makeCtx({ maxBitrateKbps: 300 }));
    const idx = args.indexOf("-maxrate");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("300k");
  });

  it("emits -bufsize 600k when maxBitrateKbps=300 (2× maxrate)", () => {
    const args = boundedVideoArgs(makeCtx({ maxBitrateKbps: 300 }));
    const idx = args.indexOf("-bufsize");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("600k");
  });

  it("emits -crf 24 when ctx.crf=24", () => {
    const args = boundedVideoArgs(makeCtx({ crf: 24 }));
    const idx = args.indexOf("-crf");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("24");
  });
});

// ---- T3: cycle final pass no longer -c:v copy ----

describe("T3: cycle final pass uses bounded encode, not copy", () => {
  it("last pass does not contain -c:v copy", () => {
    const plan = cyclePreset.buildPlan(makeCtx({ durationSec: 9 }));
    const muxPass = plan.passes[plan.passes.length - 1];
    const args = muxPass?.args ?? [];
    // Find -c:v and assert next token is not "copy"
    const cvIdx = args.indexOf("-c:v");
    if (cvIdx >= 0) {
      expect(args[cvIdx + 1]).not.toBe("copy");
    }
    // Must not contain the string "copy" as a standalone value in the video codec position
    expect(args.includes("copy")).toBe(false);
  });

  it("last pass contains -maxrate", () => {
    const plan = cyclePreset.buildPlan(makeCtx({ durationSec: 9 }));
    const muxPass = plan.passes[plan.passes.length - 1];
    const args = muxPass?.args ?? [];
    expect(args).toContain("-maxrate");
  });

  it("last pass contains -bufsize", () => {
    const plan = cyclePreset.buildPlan(makeCtx({ durationSec: 9 }));
    const muxPass = plan.passes[plan.passes.length - 1];
    const args = muxPass?.args ?? [];
    expect(args).toContain("-bufsize");
  });

  it("cover-only: last pass still no -c:v copy", () => {
    const ctx = makeCtx({ audio: undefined, durationSec: 30 });
    const plan = cyclePreset.buildPlan(ctx);
    const muxPass = plan.passes[plan.passes.length - 1];
    const args = muxPass?.args ?? [];
    expect(args.includes("copy")).toBe(false);
  });
});

// ---- T4: cycle audio path preserves 1:a, -shortest, AAC ----

describe("T4: cycle audio path keeps 1:a + -shortest + AAC", () => {
  function getMuxArgs(ctx: BuildContext): string[] {
    const plan = cyclePreset.buildPlan(ctx);
    const muxPass = plan.passes[plan.passes.length - 1];
    return muxPass?.args ?? [];
  }

  it("mux pass maps 1:a when audio present", () => {
    const args = getMuxArgs(makeCtx({ durationSec: 9 }));
    const mapIndices = args.reduce<number[]>((acc, v, i) => (v === "-map" ? [...acc, i] : acc), []);
    const mapVals = mapIndices.map((i) => args[i + 1]);
    expect(mapVals).toContain("1:a");
  });

  it("mux pass includes -shortest when audio present", () => {
    const args = getMuxArgs(makeCtx({ durationSec: 9 }));
    expect(args).toContain("-shortest");
  });

  it("mux pass includes -c:a aac", () => {
    const args = getMuxArgs(makeCtx({ durationSec: 9 }));
    const caIdx = args.indexOf("-c:a");
    expect(caIdx).toBeGreaterThanOrEqual(0);
    expect(args[caIdx + 1]).toBe("aac");
  });

  it("mux pass includes -b:a 160k", () => {
    const args = getMuxArgs(makeCtx({ durationSec: 9 }));
    const baIdx = args.indexOf("-b:a");
    expect(baIdx).toBeGreaterThanOrEqual(0);
    expect(args[baIdx + 1]).toBe("160k");
  });

  it("cover-only mux pass does NOT map audio", () => {
    const ctx = makeCtx({ audio: undefined, durationSec: 30 });
    const args = getMuxArgs(ctx);
    const mapIndices = args.reduce<number[]>((acc, v, i) => (v === "-map" ? [...acc, i] : acc), []);
    const mapVals = mapIndices.map((i) => args[i + 1]);
    expect(mapVals).not.toContain("1:a");
    expect(args).not.toContain("-shortest");
  });
});

// ---- T5: zoompan / cqt use helper → -maxrate + faststart + yuv420p ----

describe("T5: zoompan uses bounded encode helper", () => {
  it("contains -maxrate", () => {
    const plan = zoompanPreset.buildPlan(makeCtx());
    const args = plan.passes.flatMap((p) => p.args);
    expect(args).toContain("-maxrate");
  });

  it("contains +faststart", () => {
    const plan = zoompanPreset.buildPlan(makeCtx());
    const args = plan.passes.flatMap((p) => p.args);
    const idx = args.indexOf("-movflags");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("+faststart");
  });

  it("contains yuv420p", () => {
    const plan = zoompanPreset.buildPlan(makeCtx());
    const args = plan.passes.flatMap((p) => p.args);
    expect(args).toContain("yuv420p");
  });

  it("still maps 1:a when audio present", () => {
    const plan = zoompanPreset.buildPlan(makeCtx());
    const args = plan.passes.flatMap((p) => p.args);
    const mapIndices = args.reduce<number[]>((acc, v, i) => (v === "-map" ? [...acc, i] : acc), []);
    expect(mapIndices.map((i) => args[i + 1])).toContain("1:a");
  });

  it("still includes -shortest when audio present", () => {
    const plan = zoompanPreset.buildPlan(makeCtx());
    const args = plan.passes.flatMap((p) => p.args);
    expect(args).toContain("-shortest");
  });

  it("cover-only: no 1:a map, no -shortest", () => {
    const plan = zoompanPreset.buildPlan(makeCtx({ audio: undefined }));
    const args = plan.passes.flatMap((p) => p.args);
    const mapIndices = args.reduce<number[]>((acc, v, i) => (v === "-map" ? [...acc, i] : acc), []);
    expect(mapIndices.map((i) => args[i + 1])).not.toContain("1:a");
    expect(args).not.toContain("-shortest");
  });
});

describe("T5: cqt uses bounded encode helper", () => {
  it("contains -maxrate when audio present", () => {
    const plan = cqtPreset.buildPlan(makeCtx());
    const args = plan.passes.flatMap((p) => p.args);
    expect(args).toContain("-maxrate");
  });

  it("contains +faststart when audio present", () => {
    const plan = cqtPreset.buildPlan(makeCtx());
    const args = plan.passes.flatMap((p) => p.args);
    const idx = args.indexOf("-movflags");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("+faststart");
  });

  it("still maps 1:a when audio present", () => {
    const plan = cqtPreset.buildPlan(makeCtx());
    const args = plan.passes.flatMap((p) => p.args);
    const mapIndices = args.reduce<number[]>((acc, v, i) => (v === "-map" ? [...acc, i] : acc), []);
    expect(mapIndices.map((i) => args[i + 1])).toContain("1:a");
  });

  it("still includes -shortest when audio present", () => {
    const plan = cqtPreset.buildPlan(makeCtx());
    const args = plan.passes.flatMap((p) => p.args);
    expect(args).toContain("-shortest");
  });
});
