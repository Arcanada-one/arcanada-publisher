// ARCA-0191: CLI engine routing for `video --engine shotcraft` + non-regression
// that the default (no --engine) and `--engine cycle` paths are unaffected.

import { describe, it, expect } from "vitest";
import { parseArgs, CliParseError } from "../src/parse-args.js";

describe("parseArgs: shotcraft engine flags", () => {
  it("defaults engine to 'cycle' when --engine is absent (non-regression)", () => {
    const args = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4"]);
    expect(args.engine).toBe("cycle");
  });

  it("parses --engine cycle explicitly", () => {
    const args = parseArgs(["video", "--engine", "cycle", "--cover", "c.jpg", "--out", "o.mp4"]);
    expect(args.engine).toBe("cycle");
  });

  it("parses --engine shotcraft with post/asset/shot flags", () => {
    const args = parseArgs([
      "video",
      "--engine",
      "shotcraft",
      "--text-file",
      "post.txt",
      "--asset",
      "a.png",
      "--asset",
      "b.png",
      "--shot",
      "brand-ink-open",
      "--out",
      "cinematic.mp4",
    ]);
    expect(args.engine).toBe("shotcraft");
    expect(args.assets).toEqual(["a.png", "b.png"]);
    expect(args.shots).toEqual(["brand-ink-open"]);
    expect(args.videoOut).toBe("cinematic.mp4");
  });

  it("rejects an unknown --engine value", () => {
    expect(() => parseArgs(["video", "--engine", "bogus", "--out", "o.mp4"])).toThrow(
      CliParseError,
    );
  });

  it("parses --template, --format, --browser-executable", () => {
    const args = parseArgs([
      "video",
      "--engine",
      "shotcraft",
      "--text-file",
      "p.txt",
      "--out",
      "o.mp4",
      "--template",
      "ink-press",
      "--format",
      "landscape",
      "--browser-executable",
      "/usr/bin/chromium",
    ]);
    expect(args.template).toBe("ink-press");
    expect(args.format).toBe("landscape");
    expect(args.browserExecutable).toBe("/usr/bin/chromium");
  });
});

describe("run: video --engine shotcraft input guards (no render)", () => {
  it("returns MISSING_INPUT when --text-file is absent (routes to shotcraft, not ffmpeg)", async () => {
    const { run } = await import("../src/run.js");
    const result = await run(["video", "--engine", "shotcraft", "--out", "/tmp/x.mp4"]);
    expect(result.code).not.toBe(0);
    expect(result.message).toContain("text-file");
  });
});
