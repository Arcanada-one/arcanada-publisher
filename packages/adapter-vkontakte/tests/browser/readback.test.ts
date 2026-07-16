import { describe, it, expect } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import { extractWallPermalink } from "../../src/browser/url-extraction.js";
import { assertPostReadBack } from "../../src/browser/readback.js";

describe("vk browser — canonical wall permalink extraction", () => {
  it("accepts a personal-wall permalink and returns it verbatim", () => {
    const u = "https://vk.com/wall12345_678";
    expect(extractWallPermalink(u)).toBe(u);
  });

  it("accepts a community (negative owner) wall permalink", () => {
    expect(extractWallPermalink("https://vk.com/wall-987_1")).toBe("https://vk.com/wall-987_1");
  });

  it("strips incidental wrapping quotes (defence-in-depth)", () => {
    expect(extractWallPermalink('"https://vk.com/wall12345_678"')).toBe(
      "https://vk.com/wall12345_678",
    );
  });

  it("rejects a non-vk host with VERIFY_FAILED", () => {
    expect(() => extractWallPermalink("https://evil.example/wall1_2")).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  it("rejects a vk URL that is not a wall permalink", () => {
    expect(() => extractWallPermalink("https://vk.com/feed")).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });
});

describe("vk browser — post read-back oracle", () => {
  const expected = {
    account: "Pavel Valentov",
    text: "Глобальный  Адресатор\n\nполный текст статьи",
    requireVideo: true,
  };

  it("passes when author, normalized text and video all match", () => {
    expect(() =>
      assertPostReadBack(
        { account: "Pavel Valentov", text: "Глобальный Адресатор полный текст статьи", hasVideo: true },
        expected,
      ),
    ).not.toThrow();
  });

  it("STOPs with VERIFY_FAILED when the author differs", () => {
    expect(() =>
      assertPostReadBack(
        { account: "Someone Else", text: "Глобальный Адресатор полный текст статьи", hasVideo: true },
        expected,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }));
  });

  it("STOPs with VERIFY_FAILED when the rendered text is truncated (missing tail)", () => {
    expect(() =>
      assertPostReadBack(
        { account: "Pavel Valentov", text: "Глобальный Адресатор", hasVideo: true },
        expected,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }));
  });

  it("STOPs with VERIFY_FAILED when the video is not attached", () => {
    expect(() =>
      assertPostReadBack(
        { account: "Pavel Valentov", text: "Глобальный Адресатор полный текст статьи", hasVideo: false },
        expected,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }));
  });
});
