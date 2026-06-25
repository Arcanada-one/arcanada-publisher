import { describe, it, expect } from "vitest";
import {
  utf16Length,
  withinTweetLimit,
  tweetLimit,
  X_MAX_UTF16_UNITS,
  X_MAX_UTF16_UNITS_PREMIUM,
} from "../src/counter.js";

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

describe("x Premium long-form limit (PUB-0033)", () => {
  it("the premium limit constant is 25 000", () => {
    expect(X_MAX_UTF16_UNITS_PREMIUM).toBe(25_000);
  });

  it("tweetLimit() returns 280 by default and on premium=false", () => {
    expect(tweetLimit()).toBe(280);
    expect(tweetLimit(false)).toBe(280);
  });

  it("tweetLimit(true) returns the 25 000 premium ceiling", () => {
    expect(tweetLimit(true)).toBe(25_000);
  });

  it("a 1500-unit body is OVER the free limit but WITHIN the premium limit", () => {
    const text = "a".repeat(1500);
    expect(withinTweetLimit(text)).toBe(false);
    expect(withinTweetLimit(text, false)).toBe(false);
    expect(withinTweetLimit(text, true)).toBe(true);
  });

  it("25 000 units is exactly at the premium limit (ok); 25 001 is over", () => {
    expect(withinTweetLimit("a".repeat(25_000), true)).toBe(true);
    expect(withinTweetLimit("a".repeat(25_001), true)).toBe(false);
  });

  it("premium does not change the free-tier 280 boundary", () => {
    expect(withinTweetLimit("a".repeat(280), false)).toBe(true);
    expect(withinTweetLimit("a".repeat(281), false)).toBe(false);
  });
});
