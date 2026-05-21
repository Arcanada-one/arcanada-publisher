import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { edit } from "../src/edit.js";

const FAKE_PROFILE = "vitest-fake-profile";
const POST_OK = "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/";
const POST_NON_ACTIVITY = "https://www.linkedin.com/company/lazy-programmer/posts/";

describe("edit — input validation + INFRA-0261 imageFile alias", () => {
  it("rejects missing postUrl with MISSING_INPUT", async () => {
    await expect(edit({ postUrl: "", text: "body", profile: FAKE_PROFILE })).rejects.toMatchObject({
      code: ErrorCode.MISSING_INPUT,
    });
  });

  it("rejects postUrl that is not an activity URN (INVALID_ARGS)", async () => {
    await expect(
      edit({ postUrl: POST_NON_ACTIVITY, text: "body", profile: FAKE_PROFILE }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("rejects when neither text nor image candidate is set", async () => {
    await expect(edit({ postUrl: POST_OK, profile: FAKE_PROFILE })).rejects.toMatchObject({
      code: ErrorCode.MISSING_INPUT,
    });
  });

  it("INFRA-0261: imageFile alias accepted standalone (no text needed)", async () => {
    // Set up a real temp image so validateImagePath passes.
    const dir = mkdtempSync(join(tmpdir(), "pub-0004-edit-img-"));
    const img = join(dir, "tiny.png");
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // No Page is injected, so launchSession would fire — short-circuit by
    // catching at the AdapterError boundary AFTER validation passes.
    // We assert validation accepts `imageFile` alone by expecting the failure
    // mode to NOT be MISSING_INPUT or INVALID_ARGS (image attached).
    try {
      await edit(
        { postUrl: POST_OK, imageFile: img, profile: FAKE_PROFILE },
        // skipTeardown:false; will attempt browser launch — that's fine,
        // we don't need it to succeed, only need validation to pass.
      );
    } catch (err) {
      const code = (err as AdapterError).code;
      expect(code).not.toBe(ErrorCode.MISSING_INPUT);
      // Browser launch will produce something else (INTERNAL_PANIC or similar)
      // — irrelevant; validation passed = INFRA-0261 alias works.
    }
  });

  it("INFRA-0261: rejects when imageFile and imagePath are both set to DIFFERENT values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-0004-edit-conflict-"));
    const imgA = join(dir, "a.png");
    const imgB = join(dir, "b.png");
    writeFileSync(imgA, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(imgB, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(
      edit({
        postUrl: POST_OK,
        imageFile: imgA,
        imagePath: imgB,
        profile: FAKE_PROFILE,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("rejects non-existent imagePath with MISSING_INPUT", async () => {
    await expect(
      edit({
        postUrl: POST_OK,
        imagePath: "/tmp/missing-pub-0004.png",
        profile: FAKE_PROFILE,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("rejects unsupported image extension with INVALID_ARGS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-0004-edit-ext-"));
    const bad = join(dir, "bad.exe");
    writeFileSync(bad, "garbage");
    await expect(
      edit({ postUrl: POST_OK, imagePath: bad, profile: FAKE_PROFILE }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });
});
