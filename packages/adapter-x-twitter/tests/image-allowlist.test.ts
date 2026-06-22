// T8: X adapter validateImagePath — allowlist accepts .mp4 and .mov after PUB-0027.
// Also verifies that unsupported extensions are still rejected.

import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateImagePath } from "../src/image.js";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

function makeTmpFile(ext: string): string {
  const p = join(tmpdir(), `pub-x-img-${Date.now()}${ext}`);
  writeFileSync(p, Buffer.from([0x00, 0x01, 0x02])); // minimal fake bytes
  return p;
}

describe("validateImagePath: PUB-0027 video allowlist extension", () => {
  it("accepts .mp4 (video cover for X)", () => {
    const p = makeTmpFile(".mp4");
    try {
      expect(() => validateImagePath(p)).not.toThrow();
    } finally {
      unlinkSync(p);
    }
  });

  it("accepts .mov (video cover for X)", () => {
    const p = makeTmpFile(".mov");
    try {
      expect(() => validateImagePath(p)).not.toThrow();
    } finally {
      unlinkSync(p);
    }
  });

  it("still accepts .png (existing allowlist)", () => {
    const p = makeTmpFile(".png");
    try {
      expect(() => validateImagePath(p)).not.toThrow();
    } finally {
      unlinkSync(p);
    }
  });

  it("still accepts .jpg (existing allowlist)", () => {
    const p = makeTmpFile(".jpg");
    try {
      expect(() => validateImagePath(p)).not.toThrow();
    } finally {
      unlinkSync(p);
    }
  });

  it("rejects .bmp (not in allowlist)", () => {
    const p = makeTmpFile(".bmp");
    try {
      validateImagePath(p);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
      expect((err as AdapterError).message).toContain(".bmp");
    } finally {
      unlinkSync(p);
    }
  });

  it("rejects .pdf (not in allowlist)", () => {
    const p = makeTmpFile(".pdf");
    try {
      validateImagePath(p);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    } finally {
      unlinkSync(p);
    }
  });

  it("rejects NUL byte in path", () => {
    expect(() => validateImagePath("/path\0/file.mp4")).toThrow(AdapterError);
  });
});
