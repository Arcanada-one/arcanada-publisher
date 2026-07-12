import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import {
  assertSafeTargetBinding,
  del,
  statusIdFromUrl,
  locateTargetArticle,
} from "../src/delete.js";

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0017-x-del-"));
  mkdirSync(join(root, "x", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

const TARGET = "https://x.com/paxbeach/status/777";

describe("x delete — read-before-delete (R13 / V-AC-9)", () => {
  it("delete: content mismatch THROWS VERIFY_FAILED and performs NO delete click", async () => {
    const performDelete = vi.fn(async () => {});
    await expect(
      del(
        { targetUrl: TARGET, kind: "post", expectedContent: "the real tweet text", profile: "p1" },
        {
          profileManager: makeProfiles(),
          page: { dummy: true } as never,
          __readContent: async () => "a COMPLETELY different tweet, not the target",
          __performDelete: performDelete as never,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(performDelete).not.toHaveBeenCalled();
  });

  it("delete: content match performs the delete and returns deleted=true", async () => {
    const performDelete = vi.fn(async () => {});
    const res = await del(
      { targetUrl: TARGET, kind: "post", expectedContent: "hello world", profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: { dummy: true } as never,
        __readContent: async () => "hello world",
        __performDelete: performDelete as never,
      },
    );
    expect(performDelete).toHaveBeenCalledTimes(1);
    expect(res.deleted).toBe(true);
    expect(res.targetUrl).toBe(TARGET);
  });

  it("delete: rejects a substring-only match", async () => {
    const performDelete = vi.fn(async () => {});
    await expect(
      del(
        { targetUrl: TARGET, kind: "post", expectedContent: "hello world", profile: "p1" },
        {
          profileManager: makeProfiles(),
          page: { dummy: true } as never,
          __readContent: async () => "hello world — another post",
          __performDelete: performDelete as never,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(performDelete).not.toHaveBeenCalled();
  });

  it("passes the exact verified article binding into the destructive step", async () => {
    const article = { marker: "verified" } as never;
    const performDelete = vi.fn(async (_page, _input, boundArticle) => {
      expect(boundArticle).toBe(article);
    });
    await del(
      { targetUrl: TARGET, kind: "post", expectedContent: "hello world", profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: { dummy: true } as never,
        __readBinding: async () => ({ article, content: "hello world" }),
        __performDelete: performDelete as never,
      },
    );
    expect(performDelete).toHaveBeenCalledTimes(1);
  });

  it("rejects a structurally identified reply even when it renders at article index zero", () => {
    expect(() => assertSafeTargetBinding([{ index: 0, isReply: true }], "post", TARGET)).toThrow(
      /parent-post binding mismatch/,
    );
    expect(assertSafeTargetBinding([{ index: 4, isReply: false }], "post", TARGET)).toBe(4);
  });

  it("delete: rejects empty expectedContent with MISSING_INPUT", async () => {
    await expect(
      del(
        { targetUrl: TARGET, kind: "post", expectedContent: "", profile: "p1" },
        { profileManager: makeProfiles(), page: { dummy: true } as never },
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("delete: rejects a non-X targetUrl with INVALID_ARGS", async () => {
    await expect(
      del(
        {
          targetUrl: "https://evil.example.com/status/1",
          kind: "post",
          expectedContent: "x",
          profile: "p1",
        },
        { profileManager: makeProfiles(), page: { dummy: true } as never },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });
});

describe("PUB-0033 — target the EXACT tweet on a reply permalink (thread bug)", () => {
  it("statusIdFromUrl extracts the numeric id", () => {
    expect(statusIdFromUrl("https://x.com/VeritasArcanaAI/status/2070279076003057839")).toBe(
      "2070279076003057839",
    );
    expect(statusIdFromUrl("https://x.com/foo/status/777?s=20")).toBe("777");
    expect(statusIdFromUrl("https://x.com/home")).toBeNull();
  });

  it("locateTargetArticle scopes to the article anchoring the target status id", () => {
    const calls: string[] = [];
    const fakePage = {
      locator(sel: string) {
        calls.push(sel);
        return { first: () => ({ __sel: sel }) };
      },
    } as never;
    locateTargetArticle(fakePage, {
      targetUrl: "https://x.com/VeritasArcanaAI/status/2070279076003057839",
      kind: "comment",
      expectedContent: "Full write-up",
      profile: "p1",
    });
    expect(calls[0]).toBe('article:has(a[href*="/status/2070279076003057839"])');
  });

  it("locateTargetArticle falls back to plain article when the URL has no status id", () => {
    const calls: string[] = [];
    const fakePage = {
      locator(sel: string) {
        calls.push(sel);
        return { first: () => ({ __sel: sel }) };
      },
    } as never;
    locateTargetArticle(fakePage, {
      targetUrl: "https://x.com/VeritasArcanaAI",
      kind: "post",
      expectedContent: "x",
      profile: "p1",
    });
    expect(calls[0]).toBe("article");
  });
});
