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
    let submitted = false;
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
      locator: (selector: string) =>
        selector.includes("tiptap") ? failingLocator() : okLocator(cssClicks),
      isClosed: () => false,
      waitForTimeout: async () => {},
      keyboard: {
        insertText: async () => {},
        press: async (key: string) => {
          if (key === "Control+Enter") submitted = true;
        },
      },
      evaluate: async (src: unknown, expected?: string) => {
        if (typeof src !== "string") {
          return submitted ? [{ text: expected ?? "", id: "9999" }] : [];
        }
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

describe("delete — verified target control binding (PUB-0032)", () => {
  it("opens the menu inside the verified target before using global menu controls", async () => {
    const clicks: string[] = [];
    const targetButton = {
      first: () => targetButton,
      or: () => targetButton,
      waitFor: async () => {},
      click: async () => {
        clicks.push("target-menu");
      },
    };
    const target = {
      count: async () => 1,
      getByRole: () => targetButton,
    };
    const globalControl = {
      first: () => globalControl,
      waitFor: async () => {},
      click: async () => {
        clicks.push("global-control");
      },
    };
    const page = {
      goto: async () => {},
      getByRole: () => globalControl,
      locator: (selector: string) =>
        selector.includes("data-arcanada-delete-target") ? target : failingLocator(),
      isClosed: () => false,
      waitForTimeout: async () => {},
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
    expect(clicks).toEqual(["target-menu", "global-control", "global-control"]);
  });

  it("fails closed before any global control when the verified target marker is absent", async () => {
    const globalClick = vi.fn(async () => {});
    const globalControl = {
      first: () => globalControl,
      waitFor: async () => {},
      click: globalClick,
    };
    const missingTarget = {
      count: async () => 0,
      getByRole: () => failingLocator(),
    };
    const page = {
      goto: async () => {},
      getByRole: () => globalControl,
      locator: () => missingTarget,
      isClosed: () => false,
      waitForTimeout: async () => {},
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
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(globalClick).not.toHaveBeenCalled();
  });
});
