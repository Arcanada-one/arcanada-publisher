import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { publish, isVideoPath } from "../src/publish.js";

const FAKE_PROFILE = "vitest-fake-profile";

describe("publish — input validation (pre-Playwright)", () => {
  it("rejects empty text with MISSING_INPUT", async () => {
    await expect(publish({ text: "", profile: FAKE_PROFILE })).rejects.toMatchObject({
      code: ErrorCode.MISSING_INPUT,
    });
    await expect(publish({ text: "   ", profile: FAKE_PROFILE })).rejects.toMatchObject({
      code: ErrorCode.MISSING_INPUT,
    });
  });

  it("rejects text > 3000 chars with INVALID_ARGS (LinkedIn limit)", async () => {
    const tooLong = "x".repeat(3001);
    await expect(publish({ text: tooLong, profile: FAKE_PROFILE })).rejects.toBeInstanceOf(
      AdapterError,
    );
    try {
      await publish({ text: tooLong, profile: FAKE_PROFILE });
    } catch (err) {
      expect((err as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    }
  });

  it("rejects imagePath with NUL byte", async () => {
    await expect(
      publish({ text: "ok", imagePath: "/tmp/evil\0.png", profile: FAKE_PROFILE }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("rejects non-existent imagePath with MISSING_INPUT", async () => {
    await expect(
      publish({
        text: "ok",
        imagePath: "/tmp/this-file-does-not-exist-pub-0004.png",
        profile: FAKE_PROFILE,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("rejects imagePath that points to a directory with INVALID_ARGS", async () => {
    // validateImagePath line 212-218 ("not a regular file") — previously uncovered.
    // mkdtemp yields a real directory; passing it as imagePath must fail the
    // statSync(abs).isFile() guard, NOT slip through to extension check.
    const dir = mkdtempSync(join(tmpdir(), "pub-0004-pub-dir-"));
    await expect(
      publish({ text: "ok", imagePath: dir, profile: FAKE_PROFILE }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("rejects imagePath with unsupported extension with INVALID_ARGS", async () => {
    // validateImagePath line 219-226 (extension allowlist) — previously uncovered
    // on the publish path (edit.ts has its own copy + test). LinkedIn rejects
    // .bmp uploads in the composer; we fail fast before launching the browser.
    const dir = mkdtempSync(join(tmpdir(), "pub-0004-pub-ext-"));
    const bad = join(dir, "logo.bmp");
    writeFileSync(bad, Buffer.from([0x42, 0x4d, 0x00, 0x00])); // BMP magic
    await expect(
      publish({ text: "ok", imagePath: bad, profile: FAKE_PROFILE }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  // PUB-0031: LinkedIn now accepts the generated cover+narration video via the
  // same --image path (mirrors X / PUB-0027). .mp4 / .mov must pass validation
  // and be reported as a `video` attachment; a still image stays `image`.
  it("accepts a .mp4 video path and reports it as a video attachment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-0031-mp4-"));
    const vid = join(dir, "cover.mp4");
    writeFileSync(vid, Buffer.from([0x00, 0x00, 0x00, 0x18])); // mp4-ish header
    const res = await publish({ text: "ok", imagePath: vid, profile: FAKE_PROFILE, dryRun: true });
    expect(res.attachments).toEqual([{ kind: "video", src: vid }]);
  });

  it("classifies extensions via isVideoPath", () => {
    expect(isVideoPath("/x/cover.mp4")).toBe(true);
    expect(isVideoPath("/x/cover.MOV")).toBe(true);
    expect(isVideoPath("/x/cover.jpg")).toBe(false);
    expect(isVideoPath("/x/cover.png")).toBe(false);
  });

  it("propagates NO_PROFILE when profile dir does not exist on disk", async () => {
    // Exercises the post-validation → ProfileManager.ensureProfileExists chain
    // on publish.ts:62-63. Previously every test failed at the validation guard
    // before reaching profile lookup. We pass valid inputs + an isolated
    // ProfileManager root with no profile created — ensureProfileExists must
    // throw NO_PROFILE, and publish() must surface it to the caller verbatim.
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pub-0004-no-profile-"));
    const isolatedPM = new ProfileManager({ root: isolatedRoot });
    await expect(
      publish({ text: "valid text", profile: FAKE_PROFILE }, { profileManager: isolatedPM }),
    ).rejects.toMatchObject({ code: ErrorCode.NO_PROFILE });
  });
});
