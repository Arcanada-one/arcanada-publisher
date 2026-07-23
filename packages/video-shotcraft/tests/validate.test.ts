// Path validation: NUL / existence / extension allowlist (F8), mirroring the
// proven video-generator validate tests.

import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateTextFilePath, validateAssetPath, validateOutputPath } from "../src/validate.js";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");

describe("validateTextFilePath", () => {
  it("rejects NUL byte", () => {
    expect(() => validateTextFilePath("/x\0/post.txt")).toThrow(AdapterError);
  });
  it("throws MISSING_INPUT for a missing file", () => {
    try {
      validateTextFilePath("/nope/post.txt");
      expect.fail("should throw");
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.MISSING_INPUT);
    }
  });
  it("rejects a disallowed extension", () => {
    const f = join(tmpdir(), `sc-post-${Date.now()}.exe`);
    writeFileSync(f, "x");
    try {
      validateTextFilePath(f);
      expect.fail("should throw");
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    } finally {
      unlinkSync(f);
    }
  });
  it("accepts a .txt fixture", () => {
    expect(() => validateTextFilePath(join(FIX, "post.txt"))).not.toThrow();
  });
});

describe("validateAssetPath", () => {
  it("rejects NUL byte", () => {
    expect(() => validateAssetPath("/x\0/cover.png")).toThrow(AdapterError);
  });
  it("rejects a non-image extension", () => {
    const f = join(tmpdir(), `sc-asset-${Date.now()}.txt`);
    writeFileSync(f, "x");
    try {
      validateAssetPath(f);
      expect.fail("should throw");
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    } finally {
      unlinkSync(f);
    }
  });
  it("accepts a .png fixture", () => {
    expect(() => validateAssetPath(join(FIX, "cover.png"))).not.toThrow();
  });
});

describe("validateOutputPath", () => {
  it("rejects NUL byte", () => {
    expect(() => validateOutputPath("/x\0.mp4")).toThrow(AdapterError);
  });
  it("rejects when the parent directory is missing", () => {
    try {
      validateOutputPath("/no/such/dir/out.mp4");
      expect.fail("should throw");
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    }
  });
  it("accepts an output path in an existing dir", () => {
    expect(() => validateOutputPath(join(tmpdir(), `sc-out-${Date.now()}.mp4`))).not.toThrow();
  });
});
