import { describe, it, expect } from "vitest";
import { utf16Length, withinTweetLimit, X_MAX_UTF16_UNITS } from "../src/counter.js";

describe("x 280 UTF-16 counter (V-AC-10/11 oracle)", () => {
  it("counts ASCII as one unit each", () => {
    expect(utf16Length("hello")).toBe(5);
    expect(utf16Length("")).toBe(0);
  });

  it("counts an astral character (emoji) as TWO UTF-16 units", () => {
    expect(utf16Length("😀")).toBe(2);
    expect(utf16Length("a😀b")).toBe(4);
  });

  it("counts BMP non-ASCII (Cyrillic) as one unit each", () => {
    expect(utf16Length("привет")).toBe(6);
  });

  it("279 units is WITHIN the limit (ok)", () => {
    const text = "a".repeat(279);
    expect(utf16Length(text)).toBe(279);
    expect(withinTweetLimit(text)).toBe(true);
  });

  it("280 units is exactly at the limit (ok)", () => {
    const text = "a".repeat(280);
    expect(withinTweetLimit(text)).toBe(true);
  });

  it("281 units is OVER the limit (reject)", () => {
    const text = "a".repeat(281);
    expect(utf16Length(text)).toBe(281);
    expect(withinTweetLimit(text)).toBe(false);
  });

  it("140 emoji = 280 units = at the limit; 141 emoji = 282 = over", () => {
    expect(withinTweetLimit("😀".repeat(140))).toBe(true);
    expect(withinTweetLimit("😀".repeat(141))).toBe(false);
  });

  it("the limit constant is 280", () => {
    expect(X_MAX_UTF16_UNITS).toBe(280);
  });
});
