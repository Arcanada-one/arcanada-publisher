// PUB-0035 templates: bilingual title/description validation — byte-aware
// limits and the no-language-mixing rule (plan Phase 3.4, V-AC-1 fixtures).

import { describe, expect, it } from "vitest";
import {
  utf8ByteLength,
  validateDescriptionBytes,
  validateLanguagePurity,
  validateTags,
  validateTitle,
} from "../src/templates.js";

describe("byte-aware description limit (5000 bytes, not chars)", () => {
  it("accepts exactly 5000 bytes of Cyrillic (2500 chars × 2 bytes)", () => {
    const desc = "ж".repeat(2_500);
    expect(utf8ByteLength(desc)).toBe(5_000);
    expect(() => validateDescriptionBytes(desc)).not.toThrow();
  });

  it("rejects 5001 bytes — a straddling Cyrillic code point may not be split", () => {
    // 2499 Cyrillic (4998 bytes) + "a" (4999) + "ж" (5001) — the final 2-byte
    // char crosses the boundary; the validator must count whole code points.
    const desc = "ж".repeat(2_499) + "a" + "ж";
    expect(utf8ByteLength(desc)).toBe(5_001);
    expect(() => validateDescriptionBytes(desc)).toThrow(/5000 bytes/);
  });

  it("accepts 5000 ASCII bytes and rejects 5001", () => {
    expect(() => validateDescriptionBytes("a".repeat(5_000))).not.toThrow();
    expect(() => validateDescriptionBytes("a".repeat(5_001))).toThrow(/5000 bytes/);
  });
});

describe("title limits", () => {
  it("accepts 100 characters, rejects 101", () => {
    expect(() => validateTitle("т".repeat(100))).not.toThrow();
    expect(() => validateTitle("т".repeat(101))).toThrow(/100/);
  });

  it("rejects angle brackets (official constraint)", () => {
    expect(() => validateTitle("a < b")).toThrow(/[<>]/);
    expect(() => validateTitle("a > b")).toThrow(/[<>]/);
  });
});

describe("tags total limit (500 chars incl separators)", () => {
  it("accepts a small tag set", () => {
    expect(() => validateTags(["arcanada", "ai", "два слова"])).not.toThrow();
  });

  it("rejects when the joined representation exceeds 500", () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag-number-${i}-padding`);
    expect(() => validateTags(tags)).toThrow(/500/);
  });
});

describe("language purity (no mixing)", () => {
  it("EN content must contain no Cyrillic", () => {
    expect(() =>
      validateLanguagePurity("en", "Arcanada release", "Watch the article: https://arcanada.ai/en/blog/x"),
    ).not.toThrow();
    expect(() => validateLanguagePurity("en", "Arcanada релиз", "clean")).toThrow(/mixing/i);
    expect(() => validateLanguagePurity("en", "clean", "статья: https://arcanada.ai/ru/blog/x")).toThrow(
      /mixing/i,
    );
  });

  it("RU title must actually be Russian (contains Cyrillic)", () => {
    expect(() =>
      validateLanguagePurity("ru", "Релиз Арканады", "Статья: https://arcanada.ai/ru/blog/x"),
    ).not.toThrow();
    expect(() => validateLanguagePurity("ru", "Pure English title", "чистое описание")).toThrow(/mixing/i);
  });

  it("EN links must not point at /ru/ paths", () => {
    expect(() =>
      validateLanguagePurity("en", "Title", "See https://arcanada.ai/ru/blog/post"),
    ).toThrow(/mixing/i);
  });
});
