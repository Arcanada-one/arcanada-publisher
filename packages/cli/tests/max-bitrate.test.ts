// T6: CLI --max-bitrate flag parsing and validation tests (PUB-0028).
// Verifies the cap flag is plumbed through ParsedArgs and rejects invalid inputs.

import { describe, it, expect } from "vitest";
import { parseArgs, CliParseError } from "../src/parse-args.js";

describe("T6: --max-bitrate flag", () => {
  it("parses a valid positive integer → maxBitrateKbps", () => {
    const a = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--max-bitrate", "800"]);
    expect(a.maxBitrateKbps).toBe(800);
  });

  it("parses 300 kbps", () => {
    const a = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--max-bitrate", "300"]);
    expect(a.maxBitrateKbps).toBe(300);
  });

  it("parses 1200 kbps (operator-confirmed upper bound)", () => {
    const a = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--max-bitrate", "1200"]);
    expect(a.maxBitrateKbps).toBe(1200);
  });

  it("maxBitrateKbps defaults to undefined when --max-bitrate not supplied", () => {
    const a = parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4"]);
    expect(a.maxBitrateKbps).toBeUndefined();
  });

  it("rejects non-numeric value 'abc'", () => {
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--max-bitrate", "abc"]),
    ).toThrow(CliParseError);
  });

  it("rejects zero (not positive)", () => {
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--max-bitrate", "0"]),
    ).toThrow(CliParseError);
  });

  it("rejects negative value -100", () => {
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--max-bitrate", "-100"]),
    ).toThrow(CliParseError);
  });

  it("rejects shell injection attempt '$(whoami)'", () => {
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--max-bitrate", "$(whoami)"]),
    ).toThrow(CliParseError);
  });

  it("rejects float '1.5' (strict integer check — no trailing non-digits)", () => {
    // The strict /^\d+$/ guard rejects '1.5' because '.' is not a digit.
    // This is stricter than parseInt alone (which would silently accept the leading 1).
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--max-bitrate", "1.5"]),
    ).toThrow(CliParseError);
  });

  it("rejects trailing-garbage input '300abc'", () => {
    // parseInt('300abc', 10) === 300 — but the strict /^\d+$/ guard rejects it.
    expect(() =>
      parseArgs(["video", "--cover", "c.jpg", "--out", "o.mp4", "--max-bitrate", "300abc"]),
    ).toThrow(CliParseError);
  });
});
