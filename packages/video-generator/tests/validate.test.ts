// T8 (partial): validate.ts path-safety tests.
// Tests that NUL bytes, missing files, and bad extensions are caught before
// any ffmpeg spawn.

import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateCoverPath, validateAudioPath, validateOutputPath, validateDimensions } from "../src/validate.js";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures");

describe("validateCoverPath", () => {
  it("rejects NUL byte in path", () => {
    expect(() => validateCoverPath("/some/path\0/cover.jpg")).toThrow(AdapterError);
    try {
      validateCoverPath("/some/path\0/cover.jpg");
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    }
  });

  it("throws MISSING_INPUT for non-existent file", () => {
    try {
      validateCoverPath("/nonexistent/definitely/cover.png");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.MISSING_INPUT);
    }
  });

  it("throws INVALID_ARGS for unsupported extension .txt", () => {
    const tmpFile = join(tmpdir(), `pub-test-cover-${Date.now()}.txt`);
    writeFileSync(tmpFile, "test");
    try {
      validateCoverPath(tmpFile);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
      expect((err as AdapterError).message).toContain(".txt");
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("accepts .png extension (fixture)", () => {
    const p = join(FIXTURE_DIR, "cover.png");
    expect(() => validateCoverPath(p)).not.toThrow();
  });

  it("accepts .jpg extension (fixture)", () => {
    const p = join(FIXTURE_DIR, "cover.jpg");
    expect(() => validateCoverPath(p)).not.toThrow();
  });
});

describe("validateAudioPath", () => {
  it("rejects NUL byte in path", () => {
    expect(() => validateAudioPath("/audio\0/file.mp3")).toThrow(AdapterError);
  });

  it("throws MISSING_INPUT for non-existent file", () => {
    expect(() => validateAudioPath("/nonexistent/audio.mp3")).toThrow(AdapterError);
    try {
      validateAudioPath("/nonexistent/audio.mp3");
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.MISSING_INPUT);
    }
  });

  it("throws INVALID_ARGS for .mp4 extension (not in audio allowlist)", () => {
    const tmpFile = join(tmpdir(), `pub-test-audio-${Date.now()}.mp4`);
    writeFileSync(tmpFile, "test");
    try {
      validateAudioPath(tmpFile);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("accepts .mp3 extension (fixture)", () => {
    const p = join(FIXTURE_DIR, "audio.mp3");
    expect(() => validateAudioPath(p)).not.toThrow();
  });
});

describe("validateOutputPath", () => {
  it("rejects NUL byte", () => {
    expect(() => validateOutputPath("/out\0.mp4")).toThrow(AdapterError);
  });

  it("throws INVALID_ARGS when parent directory does not exist", () => {
    expect(() => validateOutputPath("/nonexistent/dir/out.mp4")).toThrow(AdapterError);
    try {
      validateOutputPath("/nonexistent/dir/out.mp4");
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    }
  });

  it("accepts output path in an existing directory", () => {
    const p = join(tmpdir(), `pub-test-out-${Date.now()}.mp4`);
    expect(() => validateOutputPath(p)).not.toThrow();
  });
});

describe("validateDimensions", () => {
  it("defaults to the 16:9 landscape canvas", () => {
    expect(validateDimensions(undefined, undefined)).toEqual({ width: 1280, height: 720 });
  });

  it("accepts an explicit 9:16 portrait canvas", () => {
    expect(validateDimensions(720, 1280)).toEqual({ width: 720, height: 1280 });
  });

  it("rejects odd dimensions, which h264 yuv420p cannot encode", () => {
    // Refused at the boundary on purpose: ffmpeg's failure for an odd size
    // surfaces deep inside a filter graph, far from the caller that chose it.
    expect(() => validateDimensions(721, 1280)).toThrow(/even/i);
    expect(() => validateDimensions(720, 1281)).toThrow(/even/i);
  });

  it("rejects zero, negative and non-integer dimensions", () => {
    expect(() => validateDimensions(0, 720)).toThrow(/positive integer/i);
    expect(() => validateDimensions(-720, 1280)).toThrow(/positive integer/i);
    expect(() => validateDimensions(720.5, 1280)).toThrow(/positive integer/i);
  });
});
