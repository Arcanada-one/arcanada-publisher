import { describe, it, expect } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import {
  normalizeFragment,
  assertNotDuplicate,
  isSameTypedActionError,
  type WallPostSummary,
} from "../../src/browser/duplicate-guard.js";

describe("vk browser — duplicate fragment normalization", () => {
  it("collapses whitespace and lowercases the first 200 code points", () => {
    const a = normalizeFragment("  Привет   МИР\n\nтекст  ");
    const b = normalizeFragment("привет мир текст");
    expect(a).toBe(b);
  });

  it("caps the fragment at 200 code points", () => {
    expect(normalizeFragment("я".repeat(500)).length).toBe(200);
  });
});

describe("vk browser — read-before-post duplicate guard", () => {
  const recent: WallPostSummary[] = [
    {
      text: "Глобальный Адресатор — новая статья цикла Cubrim",
      hasVideo: true,
      permalink: "https://vk.com/wall12345_42",
    },
    { text: "Другой пост без видео", hasVideo: false, permalink: "https://vk.com/wall12345_41" },
  ];

  it("passes when no recent post matches the candidate fragment", () => {
    expect(() =>
      assertNotDuplicate({ text: "Совершенно новый текст поста", hasVideo: true }, recent),
    ).not.toThrow();
  });

  it("STOPs with ErrorCode.DUPLICATE and cites the existing permalink on a fragment+video match", () => {
    try {
      assertNotDuplicate(
        { text: "глобальный адресатор — НОВАЯ статья цикла cubrim", hasVideo: true },
        recent,
      );
      throw new Error("expected a throw");
    } catch (e: unknown) {
      const err = e as { code?: number; details?: Record<string, unknown> };
      expect(err.code).toBe(ErrorCode.DUPLICATE);
      expect(err.details?.["existingPermalink"]).toBe("https://vk.com/wall12345_42");
    }
  });

  it("does NOT treat a text match with differing video-presence as a duplicate", () => {
    expect(() =>
      assertNotDuplicate(
        { text: "Глобальный Адресатор — новая статья цикла Cubrim", hasVideo: false },
        recent,
      ),
    ).not.toThrow();
  });
});

describe("vk browser — error-9 reconciliation signal", () => {
  it("recognises VK 'too many similar actions' (error 9) as a reconcile-by-read signal", () => {
    expect(isSameTypedActionError({ error: { error_code: 9 } })).toBe(true);
    expect(isSameTypedActionError({ error: { error_code: 214 } })).toBe(false);
    expect(isSameTypedActionError(null)).toBe(false);
  });
});
