import { describe, it, expect } from "vitest";
import { parseArgs, CliParseError } from "../src/parse-args.js";

describe("cli parse-args (V-AC-11 flag contract)", () => {
  it("parses publish --platform x --text-file f --dry-run", () => {
    const a = parseArgs(["publish", "--platform", "x", "--text-file", "f.txt", "--dry-run"]);
    expect(a.command).toBe("publish");
    expect(a.platform).toBe("x");
    expect(a.textFile).toBe("f.txt");
    expect(a.dryRun).toBe(true);
  });

  it("--image is repeatable and accumulates into images[]", () => {
    const a = parseArgs([
      "publish",
      "--platform",
      "facebook",
      "--text-file",
      "f",
      "--image",
      "a.png",
      "--image",
      "b.png",
    ]);
    expect(a.images).toEqual(["a.png", "b.png"]);
  });

  it("parses --policy-config and --profile", () => {
    const a = parseArgs([
      "publish",
      "--platform",
      "x",
      "--text-file",
      "f",
      "--policy-config",
      "preset.json",
      "--profile",
      "pavel-personal",
    ]);
    expect(a.policyConfig).toBe("preset.json");
    expect(a.profile).toBe("pavel-personal");
  });

  it("rejects an unknown command", () => {
    expect(() => parseArgs(["frobnicate", "--platform", "x"])).toThrow(CliParseError);
  });

  it("rejects an unknown flag (typo is loud, not dropped)", () => {
    expect(() => parseArgs(["publish", "--platfrom", "x"])).toThrow(CliParseError);
  });

  it("rejects a value flag with no value", () => {
    expect(() => parseArgs(["publish", "--platform"])).toThrow(CliParseError);
  });
});
