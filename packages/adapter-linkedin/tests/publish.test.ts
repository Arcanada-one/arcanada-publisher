import { describe, it, expect } from "vitest";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { publish } from "../src/publish.js";

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
});
