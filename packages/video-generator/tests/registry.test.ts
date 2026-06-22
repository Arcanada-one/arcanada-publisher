// T2: Registry tests — resolve known preset; unknown → throws; names() lists ≥3;
// exactly ≥1 timelineChanging:true.

import { describe, it, expect } from "vitest";
import { resolve, names, describe as describePresets, PRESET_REGISTRY } from "../src/presets/index.js";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

describe("PRESET_REGISTRY", () => {
  it("has at least 3 presets", () => {
    expect(PRESET_REGISTRY.size).toBeGreaterThanOrEqual(3);
  });

  it("contains 'zoompan', 'cqt', 'cycle'", () => {
    expect(PRESET_REGISTRY.has("zoompan")).toBe(true);
    expect(PRESET_REGISTRY.has("cqt")).toBe(true);
    expect(PRESET_REGISTRY.has("cycle")).toBe(true);
  });

  it("has at least one timelineChanging preset", () => {
    const changing = [...PRESET_REGISTRY.values()].filter((p) => p.timelineChanging);
    expect(changing.length).toBeGreaterThanOrEqual(1);
  });

  it("'cycle' is the timelineChanging preset", () => {
    expect(PRESET_REGISTRY.get("cycle")?.timelineChanging).toBe(true);
  });

  it("'zoompan' is not timelineChanging", () => {
    expect(PRESET_REGISTRY.get("zoompan")?.timelineChanging).toBe(false);
  });

  it("'cqt' is not timelineChanging", () => {
    expect(PRESET_REGISTRY.get("cqt")?.timelineChanging).toBe(false);
  });
});

describe("resolve()", () => {
  it("resolves 'cycle' successfully", () => {
    const preset = resolve("cycle");
    expect(preset.name).toBe("cycle");
  });

  it("resolves 'zoompan' successfully", () => {
    const preset = resolve("zoompan");
    expect(preset.name).toBe("zoompan");
  });

  it("resolves 'cqt' successfully", () => {
    const preset = resolve("cqt");
    expect(preset.name).toBe("cqt");
  });

  it("throws AdapterError(INVALID_ARGS) for unknown preset", () => {
    expect(() => resolve("nope")).toThrow(AdapterError);
    try {
      resolve("nope");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
      expect((err as AdapterError).message).toContain("nope");
      expect((err as AdapterError).message).toContain("valid presets");
    }
  });

  it("throws for empty string", () => {
    expect(() => resolve("")).toThrow(AdapterError);
  });
});

describe("names()", () => {
  it("returns an array of at least 3 names", () => {
    expect(names().length).toBeGreaterThanOrEqual(3);
  });

  it("includes 'zoompan', 'cqt', 'cycle'", () => {
    const ns = names();
    expect(ns).toContain("zoompan");
    expect(ns).toContain("cqt");
    expect(ns).toContain("cycle");
  });
});

describe("describePresets()", () => {
  it("returns metadata for each preset", () => {
    const meta = describePresets();
    expect(meta.length).toBeGreaterThanOrEqual(3);
    for (const m of meta) {
      expect(typeof m.name).toBe("string");
      expect(typeof m.description).toBe("string");
      expect(typeof m.timelineChanging).toBe("boolean");
    }
  });

  it("cycle metadata has timelineChanging: true", () => {
    const cycle = describePresets().find((m) => m.name === "cycle");
    expect(cycle?.timelineChanging).toBe(true);
  });
});
