// Preflight: ffmpeg-absent → MISSING_INPUT + install hint (dry-runnable now).
// Mirrors the video-generator requireFfmpeg contract.

import { describe, it, expect, afterEach } from "vitest";
import { requireFfmpeg, preflight, _resetPreflightCache } from "../src/preflight.js";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

describe("preflight ffmpeg locator", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
    _resetPreflightCache();
  });

  it("throws MISSING_INPUT with an install hint when ffmpeg is absent (empty PATH)", () => {
    process.env.PATH = "";
    _resetPreflightCache();
    try {
      requireFfmpeg();
      expect.fail("should throw when ffmpeg is unavailable");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.MISSING_INPUT);
      expect((err as AdapterError).message).toMatch(/ffmpeg not found/);
    }
  });

  it("preflight() surfaces the same MISSING_INPUT when ffmpeg is absent", () => {
    process.env.PATH = "";
    _resetPreflightCache();
    expect(() => preflight()).toThrow(AdapterError);
  });
});
