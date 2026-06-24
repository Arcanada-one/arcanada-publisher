import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { comment } from "../src/comment.js";
import { del } from "../src/delete.js";

// PUB-0032: LinkedIn 2026-UI selector drift — delete + comment.
//
// Both flows must tolerate (a) localized accessible names (DE/FI labels the prior
// regexes missed) and (b) drifted structural containers. These tests drive the
// real flows with fake pages whose role-locators FAIL (simulating drift) and
// assert the structural / shadow-walk fallbacks recover.

function makeProfiles(slug = "p1"): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0032-"));
  mkdirSync(join(root, "linkedin", slug), { recursive: true });
  return new ProfileManager({ root });
}

const PARENT = "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/";

/** A locator that never becomes visible (waitFor rejects) — simulates drift. */
function failingLocator() {
  const l = {
    first: () => l,
    waitFor: async () => {
      throw new Error("locator.waitFor: Timeout 8000ms exceeded");
    },
    click: vi.fn(async () => {}),
    or: () => l,
  };
  return l;
}

/** A locator that resolves visible and records clicks. */
function okLocator(clicks: { n: number }) {
  const l = {
    first: () => l,
    waitFor: async () => {},
    click: async () => {
      clicks.n += 1;
    },
    or: () => l,
  };
  return l;
}

describe("comment — composer selector drift fallback (PUB-0032)", () => {
  it("falls back to the structural CSS editor when the localized name locator misses", async () => {
    const cssClicks = { n: 0 };
    let getByRoleCalls = 0;
    const page = {
      goto: async () => {},
      getByRole: (role: string) => {
        // textbox-by-name MISSES (drift); any other role lookup is irrelevant here.
        if (role === "textbox") {
          getByRoleCalls += 1;
          return failingLocator();
        }
        return failingLocator();
      },
      locator: () => okLocator(cssClicks), // cssSelectors.commentEditor resolves
      isClosed: () => false,
      waitForTimeout: async () => {},
      keyboard: { insertText: async () => {}, press: async () => {} },
      evaluate: async (src: string) => {
        // commentId extraction → return a real id so the flow succeeds.
        if (src.includes("urn:li:comment")) return "9999";
        return "";
      },
    } as unknown as never;

    const res = await comment(
      { parentPostUrl: PARENT, text: "first comment", profile: "p1" },
      { profileManager: makeProfiles(), page, verifyParent: async () => true },
    );
    expect(res.ok).toBe(true);
    expect(res.commentId).toBe("9999");
    expect(getByRoleCalls).toBe(1); // tried the name locator first
    expect(cssClicks.n).toBe(1); // then clicked the structural fallback
  });
});

describe("delete — control-menu shadow-walk fallback (PUB-0032)", () => {
  it("uses the shadow-walk DOM click when the role locators all miss (drift)", async () => {
    const shadowClicks: string[] = [];
    const page = {
      goto: async () => {},
      // All role/menuitem/button locators miss → forces the shadow-walk path.
      getByRole: () => failingLocator(),
      locator: () => failingLocator(),
      isClosed: () => false,
      waitForTimeout: async () => {},
      evaluate: async (src: string) => {
        // shadow-walk button click → record which stage pattern fired, return true.
        if (src.includes("hit.click()")) {
          shadowClicks.push("clicked");
          return true;
        }
        return 0;
      },
    } as unknown as never;

    // read-before-delete is injected so the flow reaches the destructive choreography.
    const res = await del(
      {
        targetUrl: PARENT,
        kind: "post",
        expectedContent: "my bad post",
        profile: "p1",
      },
      {
        profileManager: makeProfiles(),
        page,
        __readContent: async () => "my bad post — full text",
      },
    );
    expect(res.deleted).toBe(true);
    // three shadow-walk clicks: control-menu, delete menu-item, confirm.
    expect(shadowClicks).toHaveLength(3);
  });

  it("throws PUBLISH_BUTTON_ABSENT when neither locator nor shadow-walk finds the control", async () => {
    const page = {
      goto: async () => {},
      getByRole: () => failingLocator(),
      locator: () => failingLocator(),
      isClosed: () => false,
      waitForTimeout: async () => {},
      evaluate: async () => false, // shadow-walk never finds the control either
    } as unknown as never;

    await expect(
      del(
        { targetUrl: PARENT, kind: "post", expectedContent: "x", profile: "p1" },
        {
          profileManager: makeProfiles(),
          page,
          __readContent: async () => "x — full text",
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PUBLISH_BUTTON_ABSENT });
  });
});
