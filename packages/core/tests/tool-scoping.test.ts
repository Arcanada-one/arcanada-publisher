import { describe, it, expect } from "vitest";
import {
  validateText,
  validateImageMime,
  validateProfileName,
  IMAGE_MIME_ALLOWLIST,
  PLATFORM_TEXT_LIMITS,
} from "../src/tool-scoping.js";
import { AdapterError, ErrorCode } from "../src/errors.js";

describe("validateText", () => {
  it("accepts a 279-UTF-16-unit X text", () => {
    const text = "a".repeat(279);
    expect(() => validateText(text, "x")).not.toThrow();
  });

  it("rejects a 281-UTF-16-unit X text with INVALID_ARGS", () => {
    const text = "a".repeat(281);
    let caught: unknown;
    try {
      validateText(text, "x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    expect((caught as AdapterError).details).toMatchObject({ platform: "x", limit: 280 });
  });

  it("counts astral characters (emoji) as two UTF-16 units", () => {
    // 140 astral code points = 280 UTF-16 units = exactly at the X limit.
    const atLimit = "😀".repeat(140);
    expect(() => validateText(atLimit, "x")).not.toThrow();
    // One more astral char pushes it to 282 → over the 280 limit.
    const overLimit = "😀".repeat(141);
    expect(() => validateText(overLimit, "x")).toThrow();
  });

  it("applies the per-platform limit, not a single global cap", () => {
    // A 1000-char body is fine for facebook/linkedin/reddit/vk but over X's 280.
    const text = "a".repeat(1000);
    expect(() => validateText(text, "facebook")).not.toThrow();
    expect(() => validateText(text, "linkedin")).not.toThrow();
    expect(() => validateText(text, "reddit")).not.toThrow();
    expect(() => validateText(text, "vkontakte")).not.toThrow();
    expect(() => validateText(text, "x")).toThrow();
  });

  it("exposes the X limit as 280 in PLATFORM_TEXT_LIMITS", () => {
    expect(PLATFORM_TEXT_LIMITS.x).toBe(280);
  });
});

describe("validateImageMime", () => {
  it.each(["image/png", "image/jpeg", "image/webp"])("accepts whitelisted mime %s", (mime) => {
    expect(() => validateImageMime(mime)).not.toThrow();
  });

  it.each(["image/gif", "image/svg+xml", "application/pdf", "text/plain", ""])(
    "rejects non-whitelisted mime %s with INVALID_ARGS",
    (mime) => {
      let caught: unknown;
      try {
        validateImageMime(mime);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AdapterError);
      expect((caught as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    },
  );

  it("exposes the allowlist as png/jpeg/webp", () => {
    expect([...IMAGE_MIME_ALLOWLIST].sort()).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });
});

describe("validateProfileName", () => {
  it.each(["default", "pavel-personal", "acct_01", "ABC123"])(
    "accepts safe profile name %s",
    (name) => {
      expect(() => validateProfileName(name)).not.toThrow();
    },
  );

  it("accepts an empty string (default profile)", () => {
    expect(() => validateProfileName("")).not.toThrow();
  });

  it.each(["has space", "../escape", "name;rm -rf", "name/slash", "naïve"])(
    "rejects unsafe profile name %s with INVALID_ARGS",
    (name) => {
      let caught: unknown;
      try {
        validateProfileName(name);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AdapterError);
      expect((caught as AdapterError).code).toBe(ErrorCode.INVALID_ARGS);
    },
  );
});
