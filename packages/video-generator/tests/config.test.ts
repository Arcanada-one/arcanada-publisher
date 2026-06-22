// T3: Config-level tests for the two-path contract.
// Cover-only → no audio map, duration ≈ 30s.
// Audio-present → audio map + -shortest + duration = probed audio length.
// These are pure builder tests — no real ffmpeg spawn.

import { describe, it, expect } from "vitest";
import type { BuildContext } from "../src/presets/types.js";
import { zoompanPreset } from "../src/presets/cover-zoompan.js";
import { cyclePreset } from "../src/presets/cycle.js";
import { cqtPreset } from "../src/presets/audio-cqt.js";

const COVER = "/test/cover.jpg";
const AUDIO = "/test/audio.mp3";
const OUT = "/test/out.mp4";

const withAudio: BuildContext = {
  cover: COVER,
  audio: AUDIO,
  out: OUT,
  durationSec: 8, // simulates ~8s audio
  width: 1280,
  height: 720,
  fps: 30,
  seed: 0,
  coverOnlySeconds: 30,
};

const coverOnly: BuildContext = {
  ...withAudio,
  audio: undefined,
  durationSec: 30, // coverOnlySeconds
};

function hasAudioMap(args: string[]): boolean {
  const mapIndices = args.reduce<number[]>((acc, v, i) => (v === "-map" ? [...acc, i] : acc), []);
  return mapIndices.some((i) => args[i + 1] === "1:a");
}

function hasShortest(args: string[]): boolean {
  return args.includes("-shortest");
}

function getDuration(args: string[]): number {
  const idx = args.lastIndexOf("-t");
  return idx !== -1 ? parseFloat(args[idx + 1] ?? "0") : 0;
}

// ---- zoompan preset ----

describe("zoompan: cover-only path", () => {
  it("does not map audio (no 1:a in -map)", () => {
    const plan = zoompanPreset.buildPlan(coverOnly);
    const args = plan.passes.flatMap((p) => p.args);
    expect(hasAudioMap(args)).toBe(false);
  });

  it("does not include -shortest", () => {
    const plan = zoompanPreset.buildPlan(coverOnly);
    const args = plan.passes.flatMap((p) => p.args);
    expect(hasShortest(args)).toBe(false);
  });

  it("duration arg is coverOnlySeconds (30s)", () => {
    const plan = zoompanPreset.buildPlan(coverOnly);
    const args = plan.passes.flatMap((p) => p.args);
    const dur = getDuration(args);
    // Allow ±1s for any internal overhead
    expect(dur).toBeGreaterThanOrEqual(29);
    expect(dur).toBeLessThanOrEqual(31);
  });
});

describe("zoompan: audio-present path", () => {
  it("includes -map 1:a", () => {
    const plan = zoompanPreset.buildPlan(withAudio);
    const args = plan.passes.flatMap((p) => p.args);
    expect(hasAudioMap(args)).toBe(true);
  });

  it("includes -shortest", () => {
    const plan = zoompanPreset.buildPlan(withAudio);
    const args = plan.passes.flatMap((p) => p.args);
    expect(hasShortest(args)).toBe(true);
  });

  it("duration arg matches audio duration (8s)", () => {
    const plan = zoompanPreset.buildPlan(withAudio);
    const args = plan.passes.flatMap((p) => p.args);
    const dur = getDuration(args);
    expect(dur).toBeGreaterThanOrEqual(7);
    expect(dur).toBeLessThanOrEqual(9);
  });
});

// ---- cqt preset ----

describe("cqt: cover-only path falls back to zoompan", () => {
  it("does not map audio", () => {
    const plan = cqtPreset.buildPlan(coverOnly);
    const args = plan.passes.flatMap((p) => p.args);
    expect(hasAudioMap(args)).toBe(false);
  });

  it("duration is coverOnlySeconds", () => {
    const plan = cqtPreset.buildPlan(coverOnly);
    const args = plan.passes.flatMap((p) => p.args);
    const dur = getDuration(args);
    expect(dur).toBeGreaterThanOrEqual(29);
    expect(dur).toBeLessThanOrEqual(31);
  });
});

describe("cqt: audio-present path", () => {
  it("includes -map 1:a", () => {
    const plan = cqtPreset.buildPlan(withAudio);
    const args = plan.passes.flatMap((p) => p.args);
    expect(hasAudioMap(args)).toBe(true);
  });

  it("includes -shortest", () => {
    const plan = cqtPreset.buildPlan(withAudio);
    const args = plan.passes.flatMap((p) => p.args);
    expect(hasShortest(args)).toBe(true);
  });
});

// ---- cycle preset ----

describe("cycle: cover-only path", () => {
  it("mux pass does NOT include audio input", () => {
    const plan = cyclePreset.buildPlan(coverOnly);
    const muxPass = plan.passes[plan.passes.length - 1];
    const args = muxPass?.args ?? [];
    expect(hasAudioMap(args)).toBe(false);
    expect(hasShortest(args)).toBe(false);
  });
});

describe("cycle: audio-present path", () => {
  it("mux pass maps audio stream", () => {
    const plan = cyclePreset.buildPlan({ ...withAudio, durationSec: 9 });
    const muxPass = plan.passes[plan.passes.length - 1];
    const args = muxPass?.args ?? [];
    expect(hasAudioMap(args)).toBe(true);
  });

  it("mux pass includes -shortest", () => {
    const plan = cyclePreset.buildPlan({ ...withAudio, durationSec: 9 });
    const muxPass = plan.passes[plan.passes.length - 1];
    const args = muxPass?.args ?? [];
    expect(hasShortest(args)).toBe(true);
  });
});
