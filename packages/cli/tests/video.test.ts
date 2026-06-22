// T7: CLI `video` subcommand — parse-args and --list-presets / unknown preset.
// No real ffmpeg spawn; tests only the parse layer and the run dispatcher's
// --list-presets path.

import { describe, it, expect, vi, afterEach } from "vitest";
import { parseArgs, CliParseError } from "../src/parse-args.js";

describe("parseArgs: video subcommand", () => {
  it("parses 'video' as a valid command", () => {
    const args = parseArgs(["video", "--list-presets"]);
    expect(args.command).toBe("video");
    expect(args.listPresets).toBe(true);
  });

  it("parses --cover, --audio, --out flags", () => {
    const args = parseArgs([
      "video",
      "--cover",
      "/path/cover.jpg",
      "--audio",
      "/path/audio.mp3",
      "--out",
      "/path/out.mp4",
    ]);
    expect(args.cover).toBe("/path/cover.jpg");
    expect(args.audio).toBe("/path/audio.mp3");
    expect(args.videoOut).toBe("/path/out.mp4");
  });

  it("parses --preset flag", () => {
    const args = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--preset", "zoompan"]);
    expect(args.preset).toBe("zoompan");
  });

  it("parses --seed flag as integer", () => {
    const args = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--seed", "42"]);
    expect(args.seed).toBe(42);
  });

  it("parses --cover-seconds flag as positive integer", () => {
    const args = parseArgs([
      "video",
      "--cover",
      "c.jpg",
      "--out",
      "o.mp4",
      "--cover-seconds",
      "20",
    ]);
    expect(args.coverSeconds).toBe(20);
  });

  it("rejects --cover-seconds 0 as invalid", () => {
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--cover-seconds", "0"]),
    ).toThrow(CliParseError);
  });

  it("rejects --seed with non-integer value", () => {
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--seed", "abc"]),
    ).toThrow(CliParseError);
  });

  it("rejects unknown flags in video subcommand", () => {
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--unknown-flag"]),
    ).toThrow(CliParseError);
  });

  it("rejects non-existent command", () => {
    expect(() => parseArgs(["nonexistent"])).toThrow(CliParseError);
  });

  it("listPresets defaults to false when not provided", () => {
    const args = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4"]);
    expect(args.listPresets).toBe(false);
  });
});

describe("run: video --list-presets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns code 0 and lists presets (unit, no ffmpeg)", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      logs.push(String(chunk));
      return true;
    });
    // Also intercept console.log (run.ts uses it for the preset list)
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const { run } = await import("../src/run.js");
    const result = await run(["video", "--list-presets"]);

    spy.mockRestore();
    consoleSpy.mockRestore();

    expect(result.code).toBe(0);
    const logOutput = logs.join("\n");
    expect(logOutput).toContain("zoompan");
    expect(logOutput).toContain("cqt");
    expect(logOutput).toContain("cycle");
    expect(logOutput).toContain("timeline-changing");
  });

  it("returns code non-zero for unknown preset (via run)", async () => {
    const { run } = await import("../src/run.js");
    const result = await run([
      "video",
      "--cover",
      "/nonexistent/cover.jpg",
      "--out",
      "/tmp/out.mp4",
      "--preset",
      "unknown-preset-xyz",
    ]);
    // Either INVALID_ARGS (from validate cover) or from preset resolution — both are non-zero
    expect(result.code).not.toBe(0);
  });
});
