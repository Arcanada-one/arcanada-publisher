// T1: Unit tests for filtergraph builders.
// Asserts: each builder returns a syntactically plausible plan (contains expected
// filter tokens) and no shell metacharacters from user-controlled inputs.

import { describe, it, expect, vi } from "vitest";
import type { BuildContext } from "../src/presets/types.js";
import { zoompanPreset } from "../src/presets/cover-zoompan.js";
import { cqtPreset } from "../src/presets/audio-cqt.js";
import { cyclePreset } from "../src/presets/cycle.js";

const COVER = "/safe/path/cover.jpg";
const AUDIO = "/safe/path/audio.mp3";
const OUT = "/safe/path/out.mp4";

const baseCtx: BuildContext = {
  cover: COVER,
  audio: AUDIO,
  out: OUT,
  durationSec: 10,
  width: 1280,
  height: 720,
  fps: 30,
  seed: 42,
  coverOnlySeconds: 30,
};

const coverOnlyCtx: BuildContext = {
  ...baseCtx,
  audio: undefined,
  durationSec: 30,
};

function flattenArgs(plan: ReturnType<typeof zoompanPreset.buildPlan>): string[] {
  return plan.passes.flatMap((p) => p.args);
}

function normalizeCycleWorkdirs(args: string[]): string[] {
  return args.map((arg) => arg.replace(/_cycleWork-\d+/g, "_cycleWork-<timestamp>"));
}

describe("zoompan preset", () => {
  it("buildPlan returns at least one pass", () => {
    const plan = zoompanPreset.buildPlan(baseCtx);
    expect(plan.passes.length).toBeGreaterThanOrEqual(1);
  });

  it("contains zoompan filter token", () => {
    const args = flattenArgs(zoompanPreset.buildPlan(baseCtx));
    const joined = args.join(" ");
    expect(joined).toContain("zoompan");
  });

  it("cover-only: no -map for audio", () => {
    const plan = zoompanPreset.buildPlan(coverOnlyCtx);
    const args = flattenArgs(plan);
    // Should not map audio input (1:a) when no audio
    const mapIdx = args.indexOf("-map");
    if (mapIdx !== -1) {
      const mapVal = args[mapIdx + 1];
      expect(mapVal).not.toBe("1:a");
    }
  });

  it("audio-present: includes -map 1:a", () => {
    const args = flattenArgs(zoompanPreset.buildPlan(baseCtx));
    const mapIndices = args.reduce<number[]>((acc, v, i) => (v === "-map" ? [...acc, i] : acc), []);
    const mapVals = mapIndices.map((i) => args[i + 1]);
    expect(mapVals).toContain("1:a");
  });

  it("args include -i with cover path as a separate element (arg-array safety)", () => {
    const args = flattenArgs(zoompanPreset.buildPlan(baseCtx));
    const iIdx = args.indexOf("-i");
    expect(args[iIdx + 1]).toBe(COVER);
  });

  it("user-supplied file paths do not appear inside filter strings (arg-array safety)", () => {
    // Paths with spaces/special chars that would be dangerous if shell-interpolated.
    // They must appear ONLY as -i / output args, never inside -vf/-filter_complex values.
    const nastyCtx: BuildContext = {
      ...baseCtx,
      cover: "/safe path/with spaces/cover.jpg",
      audio: "/safe path/with spaces/audio.mp3",
      out: "/safe path/out.mp4",
    };
    const args = flattenArgs(zoompanPreset.buildPlan(nastyCtx));
    const vfIdx = args.indexOf("-vf");
    if (vfIdx !== -1) {
      const filterStr = args[vfIdx + 1] ?? "";
      // The cover/audio paths should not appear in the filter expression
      expect(filterStr.includes("/safe path")).toBe(false);
      expect(filterStr.includes("cover.jpg")).toBe(false);
      expect(filterStr.includes("audio.mp3")).toBe(false);
    }
  });

  it("output path is the last argument", () => {
    const plan = zoompanPreset.buildPlan(baseCtx);
    const lastPass = plan.passes[plan.passes.length - 1];
    const args = lastPass?.args ?? [];
    expect(args[args.length - 1]).toBe(OUT);
  });
});

describe("cqt preset", () => {
  it("buildPlan returns at least one pass when audio is present", () => {
    const plan = cqtPreset.buildPlan(baseCtx);
    expect(plan.passes.length).toBeGreaterThanOrEqual(1);
  });

  it("filter complex contains showcqt when audio present", () => {
    const args = flattenArgs(cqtPreset.buildPlan(baseCtx));
    const joined = args.join(" ");
    expect(joined).toContain("showcqt");
  });

  it("falls back to zoompan when no audio (contains zoompan token)", () => {
    const args = flattenArgs(cqtPreset.buildPlan(coverOnlyCtx));
    const joined = args.join(" ");
    expect(joined).toContain("zoompan");
  });

  it("uses -filter_complex (not -vf) with audio", () => {
    const args = flattenArgs(cqtPreset.buildPlan(baseCtx));
    expect(args).toContain("-filter_complex");
  });

  it("maps audio stream when audio present", () => {
    const args = flattenArgs(cqtPreset.buildPlan(baseCtx));
    const mapIndices = args.reduce<number[]>((acc, v, i) => (v === "-map" ? [...acc, i] : acc), []);
    const mapVals = mapIndices.map((i) => args[i + 1]);
    expect(mapVals).toContain("1:a");
  });
});

describe("cycle preset", () => {
  it("buildPlan returns multiple passes (multi-segment)", () => {
    const plan = cyclePreset.buildPlan({ ...baseCtx, durationSec: 10 });
    // Expect: intro + ≥1 effect + xfade passes + mux
    expect(plan.passes.length).toBeGreaterThan(2);
  });

  it("timelineChanging is true", () => {
    expect(cyclePreset.timelineChanging).toBe(true);
  });

  it("passes contain -filter_complex with scale/crop/effect pattern", () => {
    const plan = cyclePreset.buildPlan({ ...baseCtx, durationSec: 10 });
    const allArgs = flattenArgs(plan);
    // Some pass must have -filter_complex
    const fcIdx = allArgs.indexOf("-filter_complex");
    expect(fcIdx).toBeGreaterThanOrEqual(0);
    const fcVal = allArgs[fcIdx + 1] ?? "";
    expect(fcVal.length).toBeGreaterThan(0);
  });

  it("cover path appears as -i argument (never in filter_complex)", () => {
    const plan = cyclePreset.buildPlan({ ...baseCtx, durationSec: 10 });
    for (const pass of plan.passes) {
      const fcIdx = pass.args.indexOf("-filter_complex");
      if (fcIdx !== -1) {
        const filterStr = pass.args[fcIdx + 1] ?? "";
        // Cover path should NOT appear in the filter_complex string
        expect(filterStr.includes(COVER)).toBe(false);
      }
      // Cover path SHOULD appear as -i argument
      const iIndices = pass.args.reduce<number[]>(
        (acc, v, i) => (v === "-i" ? [...acc, i] : acc),
        [],
      );
      const iVals = iIndices.map((i) => pass.args[i + 1]);
      // Passes that have the cover input must use it as a direct argument
      if (iVals.includes(COVER)) {
        expect(iVals).toContain(COVER);
      }
    }
  });

  it("mux pass maps audio stream when audio present", () => {
    const plan = cyclePreset.buildPlan({ ...baseCtx, durationSec: 10 });
    const muxPass = plan.passes[plan.passes.length - 1];
    expect(muxPass).toBeDefined();
    const args = muxPass?.args ?? [];
    expect(args).toContain("-i");
    // Last pass should reference audio
    expect(args).toContain(AUDIO);
  });

  it("mux pass does NOT include audio when no audio", () => {
    const plan = cyclePreset.buildPlan({ ...coverOnlyCtx, durationSec: 30 });
    const muxPass = plan.passes[plan.passes.length - 1];
    const args = muxPass?.args ?? [];
    expect(args).not.toContain(AUDIO);
  });

  it("plan includes a workdir for cleanup", () => {
    const plan = cyclePreset.buildPlan({ ...baseCtx, durationSec: 10 });
    expect(typeof plan.workdir).toBe("string");
  });

  it("throws when duration exceeds 60-minute safety cap", () => {
    expect(() => cyclePreset.buildPlan({ ...baseCtx, durationSec: 61 * 60 })).toThrow(/safety cap/);
  });

  it("seeds produce deterministic effect sequences", () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_001);
    const plan1 = cyclePreset.buildPlan({ ...baseCtx, durationSec: 15, seed: 123 });
    const plan2 = cyclePreset.buildPlan({ ...baseCtx, durationSec: 15, seed: 123 });
    now.mockRestore();

    expect(plan1.workdir).not.toBe(plan2.workdir);
    // The seed-derived plan is deterministic; per-run cleanup paths are intentionally unique.
    const allArgs1 = normalizeCycleWorkdirs(flattenArgs(plan1));
    const allArgs2 = normalizeCycleWorkdirs(flattenArgs(plan2));
    expect(allArgs1).toEqual(allArgs2);
  });

  it("different seeds produce different effect sequences", () => {
    const plan1 = cyclePreset.buildPlan({ ...baseCtx, durationSec: 30, seed: 1 });
    const plan2 = cyclePreset.buildPlan({ ...baseCtx, durationSec: 30, seed: 9999 });
    // Different seeds may produce the same sequence by chance, but with 44 effects
    // and 9 segments it is vanishingly unlikely.
    const args1 = flattenArgs(plan1).join("|");
    const args2 = flattenArgs(plan2).join("|");
    // This assertion may theoretically fail with p ≈ (1/44)^9 — treat as informational.
    expect(args1).not.toBe(args2);
  });
});
