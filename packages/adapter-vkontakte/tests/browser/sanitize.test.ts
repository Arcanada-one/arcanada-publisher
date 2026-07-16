import { describe, it, expect } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import {
  POST_MAX_CHARS,
  sanitizeComposerText,
  preflightPostText,
} from "../../src/browser/sanitize.js";

describe("vk browser — text sanitization", () => {
  it("passes plain multiline text through unchanged", () => {
    const t = "Первая строка\nВторая строка\n\nАбзац";
    expect(sanitizeComposerText(t)).toBe(t);
  });

  it("preserves emoji and tabs are normalised to a space", () => {
    expect(sanitizeComposerText("hi\tthere")).toBe("hi there");
    expect(sanitizeComposerText("привет 🚀")).toBe("привет 🚀");
  });

  it("normalises CR / CRLF to a plain newline (does not reject a CRLF body)", () => {
    expect(sanitizeComposerText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(() => sanitizeComposerText("line1\r\nline2")).not.toThrow();
  });

  it("rejects C1 control characters (U+0080–U+009F)", () => {
    expect(() => sanitizeComposerText("a\u0085b")).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_ARGS }),
    );
  });

  it("rejects control sequences (e.g. NUL, ESC, form-feed) with INVALID_ARGS", () => {
    for (const bad of ["a\u0000b", "x\u001by", "p\u000cq", "c\u007fd"]) {
      expect(() => sanitizeComposerText(bad)).toThrowError(
        expect.objectContaining({ code: ErrorCode.INVALID_ARGS }),
      );
    }
  });
});

describe("vk browser — post length preflight", () => {
  it(`accepts text up to ${POST_MAX_CHARS} chars`, () => {
    const exact = "я".repeat(POST_MAX_CHARS);
    expect(() => preflightPostText(exact)).not.toThrow();
  });

  it("rejects overflow with INVALID_ARGS and STOPs (no truncation)", () => {
    const over = "я".repeat(POST_MAX_CHARS + 1);
    expect(() => preflightPostText(over)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_ARGS }),
    );
  });

  it("rejects empty text", () => {
    expect(() => preflightPostText("   ")).toThrowError(
      expect.objectContaining({ code: ErrorCode.MISSING_INPUT }),
    );
  });

  it("returns the sanitized text on success", () => {
    expect(preflightPostText("ok\ttext")).toBe("ok text");
  });

  it("length is measured in Unicode code points, not UTF-16 units", () => {
    // Emoji are surrogate pairs in UTF-16; the cap must count them as 1.
    const emojiHeavy = "🚀".repeat(POST_MAX_CHARS);
    expect(() => preflightPostText(emojiHeavy)).not.toThrow();
  });
});
