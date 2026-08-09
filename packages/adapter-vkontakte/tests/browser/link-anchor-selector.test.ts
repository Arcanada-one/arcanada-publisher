import { describe, it, expect } from "vitest";
import { vkLinkAnchorSelector } from "../../src/browser/index.js";

describe("vkLinkAnchorSelector — verification must survive VK's link elision", () => {
  const STORE_URL = "https://chromewebstore.google.com/detail/jhnhkmnignbhmcjbhoihdbjhjfljpili";

  it("matches the percent-encoded form VK puts in its /away.php redirect", () => {
    // Live DOM 2026-08-09: href="/away.php?to=https%3A%2F%2Fchromewebstore…"
    const selector = vkLinkAnchorSelector(STORE_URL);
    const awayHref =
      "/away.php?to=https%3A%2F%2Fchromewebstore.google.com%2Fdetail%2Fjhnhkmnignbhmcjbhoihdbjhjfljpili&utf=1";
    const needle = selector.split(",")[0]!.replace('a[href*="', "").replace('"]', "");
    expect(awayHref).toContain(needle);
  });

  it("also matches a verbatim href for links VK leaves unwrapped", () => {
    expect(vkLinkAnchorSelector(STORE_URL)).toContain(`a[href="${STORE_URL}"]`);
  });

  it("does not rely on the visible text, which VK truncates", () => {
    // The rendered anchor text is elided to "…google.com/detail/jhnhkmnignbh..",
    // so the full URL is absent from innerText. A text-based oracle can never
    // match it — that is what made a posted comment look like a failure and
    // produced two identical comments on wall277123371_479.
    const renderedText = "https://chromewebstore.google.com/detail/jhnhkmnignbh..";
    expect(renderedText.includes(STORE_URL)).toBe(false);
    expect(vkLinkAnchorSelector(STORE_URL)).toContain("href");
  });
});
