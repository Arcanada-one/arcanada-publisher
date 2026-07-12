import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { del, defaultPerformDelete, markDeleteTargetJs } from "../src/delete.js";

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

  it("fails closed when an unrelated first post and the target both contain expected text", () => {
    const expected = "TARGET EXACT TEXT";
    const unrelated = fakePost(`UNRELATED FIRST POST with nested quote: ${expected}`, null);
    const target = fakePost(expected, null);
    const result = runTargetResolver(
      markDeleteTargetJs(expected, "data-arcanada-delete-target", "^More actions"),
      [unrelated, target],
    );
    expect(result).toBe(2);
    expect(unrelated.attributes.has("data-arcanada-delete-target")).toBe(false);
    expect(target.attributes.has("data-arcanada-delete-target")).toBe(false);
  });

  it("uses the URL activity id to select the target instead of an unrelated first post", () => {
    const expected = "TARGET EXACT TEXT";
    const unrelated = fakePost(`UNRELATED FIRST POST with nested quote: ${expected}`, null);
    const target = fakePost(expected, "urn:li:activity:7481761119305527296");
    const result = runTargetResolver(
      markDeleteTargetJs(
        expected,
        "data-arcanada-delete-target",
        "^More actions",
        "7481761119305527296",
      ),
      [unrelated, target],
    );
    expect(result).toBe(1);
    expect(unrelated.attributes.has("data-arcanada-delete-target")).toBe(false);
    expect(target.attributes.get("data-arcanada-delete-target")).toBe("true");
  });

  it("clicks the delete menu only inside the exact marked target container", async () => {
    const targetButton = {
      or: () => targetButton,
      first: () => targetButton,
      waitFor: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
    };
    const target = {
      count: vi.fn(async () => 1),
      getByRole: vi.fn(() => targetButton),
    };
    const globalMenuItem = {
      first: () => globalMenuItem,
      waitFor: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
    };
    const page = {
      locator: vi.fn(() => target),
      getByRole: vi.fn(() => globalMenuItem),
      waitForTimeout: vi.fn(async () => {}),
    };

    await defaultPerformDelete(page as never, {
      targetUrl: TARGET,
      kind: "post",
      expectedContent: "TARGET EXACT TEXT",
      profile: "p1",
    });
    expect(targetButton.click).toHaveBeenCalledTimes(1);
    expect(target.getByRole).toHaveBeenCalledTimes(2);
  });
});

interface FakePost {
  innerText: string;
  attributes: Map<string, string>;
  querySelectorAll: (selector: string) => unknown[];
  getAttribute: (name: string) => string | null;
  contains: (other: unknown) => boolean;
  setAttribute: (name: string, value: string) => void;
}

function fakePost(innerText: string, urn: string | null): FakePost {
  const attributes = new Map<string, string>();
  if (urn) attributes.set("data-urn", urn);
  const menu = {
    innerText: "",
    getAttribute: (name: string) => (name === "aria-label" ? "More actions" : null),
  };
  return {
    innerText,
    attributes,
    querySelectorAll: () => [menu],
    getAttribute: (name: string) => attributes.get(name) ?? null,
    contains: () => false,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
}

function runTargetResolver(source: string, posts: FakePost[]): number {
  const document = { querySelectorAll: () => posts };
  return Function("document", `return ${source};`)(document) as number;
}
