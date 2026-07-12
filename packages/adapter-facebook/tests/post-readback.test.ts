import { describe, expect, it } from "vitest";
import {
  canonicalFacebookPostUrl,
  facebookProfileIdentity,
  normalizeFacebookText,
} from "../src/post-readback.js";

describe("Facebook exact post readback primitives", () => {
  it("normalizes only Unicode, CRLF, and terminal whitespace", () => {
    expect(normalizeFacebookText("  Title\r\n\r\nBody  \n")).toBe("Title\n\nBody");
  });

  it("canonicalizes a tracked permalink without accepting another surface", () => {
    expect(
      canonicalFacebookPostUrl(
        "https://www.facebook.com/pavelvalentov/posts/pfbid123?__cft__[0]=tracking",
      ),
    ).toBe("https://www.facebook.com/pavelvalentov/posts/pfbid123");
    expect(() => canonicalFacebookPostUrl("https://example.com/posts/1")).toThrow();
  });

  it("derives only stable Facebook author identities", () => {
    expect(facebookProfileIdentity("https://www.facebook.com/PavelValentov")).toBe(
      "www.facebook.com/pavelvalentov",
    );
    expect(facebookProfileIdentity("https://www.facebook.com/profile.php?id=123")).toBe(
      "www.facebook.com/profile.php?id=123",
    );
    expect(() => facebookProfileIdentity("https://www.facebook.com/a/posts/1")).toThrow();
  });
});
