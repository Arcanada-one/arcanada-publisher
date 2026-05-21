import { describe, it, expect } from "vitest";
import { FacebookAdapter, extractPostUrlFromHref } from "../src/index.js";

describe("INFRA-0190 — POST_URL quote-strip closure", () => {
  it("FacebookAdapter is exported and extends platform=facebook", () => {
    const adapter = new FacebookAdapter();
    expect(adapter.platform).toBe("facebook");
  });

  it("extractPostUrlFromHref returns clean URL without literal quotes (canonical href)", () => {
    const raw = "https://www.facebook.com/100012345/posts/987654321";
    const out = extractPostUrlFromHref(raw);
    expect(out).toBe(raw);
    expect(out).not.toContain('"');
    expect(out).toMatch(/^https:\/\/www\.facebook\.com\/[^"]+\/posts\/[0-9]+$/);
  });

  it("extractPostUrlFromHref strips literal wrapping quotes (legacy fb-publish shape)", () => {
    const wrapped = '"https://www.facebook.com/100012345/posts/987654321"';
    const out = extractPostUrlFromHref(wrapped);
    expect(out).not.toContain('"');
    expect(out).toMatch(/^https:\/\/www\.facebook\.com\/[^"]+\/posts\/[0-9]+$/);
  });

  it("extractPostUrlFromHref preserves pfbid-style post identifiers", () => {
    const raw = "https://www.facebook.com/permalink.php?story_fbid=pfbid0abc&id=100012345";
    const out = extractPostUrlFromHref(raw);
    expect(out).toBe(raw);
  });

  it("extractPostUrlFromHref rejects empty input", () => {
    expect(() => extractPostUrlFromHref("")).toThrow();
  });

  it("extractPostUrlFromHref rejects non-facebook host", () => {
    expect(() => extractPostUrlFromHref("https://evil.example.com/posts/123")).toThrow();
  });
});
