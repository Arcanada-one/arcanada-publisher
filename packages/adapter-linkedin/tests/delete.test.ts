import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { del, defaultReadContent } from "../src/delete.js";

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0017-li-del-"));
  mkdirSync(join(root, "linkedin", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

const TARGET = "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/";

describe("linkedin delete — read-before-delete (R13 / V-AC-9)", () => {
  it("delete: content mismatch THROWS VERIFY_FAILED and performs NO delete click", async () => {
    const performDelete = vi.fn(async () => {});
    await expect(
      del(
        {
          targetUrl: TARGET,
          kind: "post",
          expectedContent: "my real LinkedIn post",
          profile: "p1",
        },
        {
          profileManager: makeProfiles(),
          page: { dummy: true } as never,
          __readContent: async () => "some unrelated content from the feed sidebar",
          __performDelete: performDelete as never,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(performDelete).not.toHaveBeenCalled();
  });

  it("delete: content match performs the delete and returns deleted=true", async () => {
    const performDelete = vi.fn(async () => {});
    const res = await del(
      { targetUrl: TARGET, kind: "post", expectedContent: "ship log entry", profile: "p1" },
      {
        profileManager: makeProfiles(),
        page: { dummy: true } as never,
        __readContent: async () => "ship log entry — full post text here",
        __performDelete: performDelete as never,
      },
    );
    expect(performDelete).toHaveBeenCalledTimes(1);
    expect(res.deleted).toBe(true);
    expect(res.targetUrl).toBe(TARGET);
  });

  it("delete: rejects empty expectedContent with MISSING_INPUT", async () => {
    await expect(
      del(
        { targetUrl: TARGET, kind: "post", expectedContent: "  ", profile: "p1" },
        { profileManager: makeProfiles(), page: { dummy: true } as never },
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("delete: rejects a non-linkedin targetUrl with INVALID_ARGS", async () => {
    await expect(
      del(
        {
          targetUrl: "https://www.facebook.com/posts/1",
          kind: "post",
          expectedContent: "x",
          profile: "p1",
        },
        { profileManager: makeProfiles(), page: { dummy: true } as never },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("aborts when the visible target article mismatches even if main contains expected text", async () => {
    const article = {
      first: () => article,
      waitFor: vi.fn(async () => {}),
      innerText: vi.fn(async () => "UNRELATED FIRST POST"),
    };
    const main = {
      first: () => main,
      count: vi.fn(async () => 1),
      waitFor: vi.fn(async () => {}),
      innerText: vi.fn(async () => "TARGET EXACT TEXT in another module"),
    };
    const page = {
      goto: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn((selector: string) => (selector === "main" ? main : article)),
    };

    await expect(
      defaultReadContent(page as never, {
        targetUrl: TARGET,
        kind: "post",
        expectedContent: "TARGET EXACT TEXT",
        profile: "p1",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(main.innerText).not.toHaveBeenCalled();
  });
});
