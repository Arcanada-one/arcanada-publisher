import { describe, expect, it, vi } from "vitest";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import {
  assertExactCommentBinding,
  deleteCommentByUrn,
  type LinkedInDeleteCommentInput,
  type LinkedInCommentBindingEvidence,
} from "../src/comment.js";
import { del, parseLinkedInCommentTarget } from "../src/delete.js";
import { matchesElidedTextSource } from "../src/elided-text.js";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ACTIVITY = "7462962260978642944";
const PARENT = `https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY}/`;
const COMMENT_URN = `urn:li:comment:(urn:li:activity:${ACTIVITY},9001)`;
const TARGET = `${PARENT}?commentUrn=${encodeURIComponent(COMMENT_URN)}`;
const AUTHOR = "https://www.linkedin.com/in/pavelvalentov/";
const BODY = "Store: https://example.com/a-very-long-token/ellipsis";
const RENDERED = "Store: https://example.com/.../ellipsis";

function profiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0040-li-comment-delete-"));
  mkdirSync(join(root, "linkedin", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

function input(overrides: Partial<LinkedInDeleteCommentInput> = {}): LinkedInDeleteCommentInput {
  return {
    targetUrl: TARGET,
    parentPostUrl: PARENT,
    commentUrn: COMMENT_URN,
    expectedAuthorProfileUrl: AUTHOR,
    expectedContent: BODY,
    profile: "p1",
    ...overrides,
  };
}

function evidence(overrides: Partial<LinkedInCommentBindingEvidence> = {}) {
  return {
    commentUrn: COMMENT_URN,
    renderedBodyCandidates: [RENDERED],
    renderedAuthorProfileHrefs: [AUTHOR],
    renderedAuthorLines: ["Pavel Valentov Author"],
    ...overrides,
  } satisfies LinkedInCommentBindingEvidence;
}

describe("LinkedIn comment target parsing and binding", () => {
  it("extracts the exact comment URN and canonical parent from a target URL", () => {
    expect(parseLinkedInCommentTarget(TARGET)).toEqual({
      commentUrn: COMMENT_URN,
      parentPostUrl: PARENT,
    });
  });

  it("rejects a target URL without an exact comment URN", () => {
    expect(() => parseLinkedInCommentTarget(PARENT)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_ARGS }),
    );
  });

  it("rejects a comment URN whose parent activity conflicts with the URL path", () => {
    const foreign = `${PARENT}?commentUrn=${encodeURIComponent(
      "urn:li:comment:(urn:li:activity:1,9001)",
    )}`;
    expect(() => parseLinkedInCommentTarget(foreign)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_ARGS }),
    );
  });

  it("accepts exact body elision and an author href or Author line", () => {
    expect(() => assertExactCommentBinding(input(), evidence())).not.toThrow();
    expect(() =>
      assertExactCommentBinding(input(), evidence({ renderedAuthorProfileHrefs: [] })),
    ).not.toThrow();
  });

  it.each([
    ["URN mismatch", { commentUrn: "urn:li:comment:(urn:li:activity:1,2)" }],
    ["body mismatch", { renderedBodyCandidates: ["unrelated"] }],
    [
      "author mismatch",
      {
        renderedAuthorProfileHrefs: ["https://www.linkedin.com/in/impostor"],
        renderedAuthorLines: ["Impostor Author"],
      },
    ],
    [
      "author line mismatch",
      { renderedAuthorProfileHrefs: [], renderedAuthorLines: ["Impostor Author"] },
    ],
  ])("rejects %s before mutation", (_label, change) => {
    expect(() => assertExactCommentBinding(input(), evidence(change))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });
});

describe("LinkedIn comment delete choreography", () => {
  it("routes delete --kind comment to the shared comment arm, never the post arm", async () => {
    const commentStep = vi.fn(async (target: LinkedInDeleteCommentInput) => ({
      ok: true as const,
      platform: "linkedin" as const,
      account: `urn:li:activity:${ACTIVITY}`,
      deleted: true,
      targetUrl: target.targetUrl,
    }));
    const postRead = vi.fn(async () => BODY);
    const result = await del(
      {
        targetUrl: TARGET,
        kind: "comment",
        expectedContent: BODY,
        expectedAuthorProfileUrl: AUTHOR,
        profile: "p1",
      },
      {
        profileManager: profiles(),
        __deleteComment: commentStep,
        __readContent: postRead,
      },
    );
    expect(result.deleted).toBe(true);
    expect(commentStep).toHaveBeenCalledWith(
      expect.objectContaining({ commentUrn: COMMENT_URN, parentPostUrl: PARENT }),
    );
    expect(postRead).not.toHaveBeenCalled();
  });

  it("requires the author oracle before any comment arm seam", async () => {
    const commentStep = vi.fn();
    await expect(
      del(
        {
          targetUrl: TARGET,
          kind: "comment",
          expectedContent: BODY,
          profile: "p1",
        },
        { profileManager: profiles(), __deleteComment: commentStep },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
    expect(commentStep).not.toHaveBeenCalled();
  });

  it("uses one source-injected matcher and returns only after the exact step succeeds", async () => {
    const deleteStep = vi.fn(async (_page: never, target: LinkedInDeleteCommentInput) => {
      expect(target.commentUrn).toBe(COMMENT_URN);
      return { preDeleteCommentUrns: [COMMENT_URN] };
    });
    const result = await deleteCommentByUrn(input(), {
      profileManager: profiles(),
      page: { dummy: true } as never,
      __deleteStep: deleteStep,
    });
    expect(deleteStep).toHaveBeenCalledTimes(1);
    expect(result.deleted).toBe(true);
    expect(result.targetUrl).toBe(TARGET);
    expect(matchesElidedTextSource).toBe(
      (Function(`return (${matchesElidedTextSource});`)() as Function).toString(),
    );
  });

  it("refuses ambiguity before opening a menu", async () => {
    const clicks = { menu: 0, confirm: 0 };
    const page = makeChoreographyPage({
      candidates: [evidence(), evidence()],
      clicks,
    });
    await expect(
      deleteCommentByUrn(input(), { profileManager: profiles(), page: page as never }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(clicks.menu).toBe(0);
    expect(clicks.confirm).toBe(0);
  });

  it("scopes menu and confirmation, then proves detachment", async () => {
    const clicks = { menu: 0, delete: 0, confirm: 0 };
    const page = makeChoreographyPage({ candidates: [evidence()], clicks });
    const result = await deleteCommentByUrn(input(), {
      profileManager: profiles(),
      page: page as never,
    });
    expect(result.deleted).toBe(true);
    expect(clicks).toEqual({ menu: 1, delete: 1, confirm: 1 });
  });

  it("reports UNKNOWN with hashes and lengths only after confirmation", async () => {
    const clicks = { menu: 0, delete: 0, confirm: 0 };
    const page = makeChoreographyPage({
      candidates: [evidence()],
      clicks,
      detachError: true,
    });
    const error = await deleteCommentByUrn(input(), {
      profileManager: profiles(),
      page: page as never,
    }).catch((value: unknown) => value as AdapterError);
    expect(error).toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
      details: {
        unknown: true,
        reconcileRequired: true,
        expectedContentLength: BODY.length,
      },
    });
    expect(JSON.stringify(error.toJSON())).not.toContain(BODY);
    expect(JSON.stringify(error.toJSON())).not.toContain(RENDERED);
    expect(clicks.confirm).toBe(1);
  });
});

function makeChoreographyPage(options: {
  candidates: LinkedInCommentBindingEvidence[];
  clicks: { menu?: number; delete?: number; confirm?: number };
  detachError?: boolean;
}) {
  const target = {
    count: async () => 1,
    first: () => target,
    waitFor: async ({ state }: { state: string }) => {
      if (state === "detached" && options.detachError) throw new Error("detach timeout");
    },
    getByRole: () => targetMenu,
  };
  const targetMenu = {
    count: async () => 1,
    first: () => targetMenu,
    waitFor: async () => {},
    click: async () => {
      options.clicks.menu = (options.clicks.menu ?? 0) + 1;
    },
    or: () => targetMenu,
  };
  const deleteItem = {
    count: async () => 1,
    first: () => deleteItem,
    waitFor: async () => {},
    click: async () => {
      options.clicks.delete = (options.clicks.delete ?? 0) + 1;
    },
    or: () => deleteItem,
  };
  const confirm = {
    count: async () => 1,
    first: () => confirm,
    waitFor: async () => {},
    click: async () => {
      options.clicks.confirm = (options.clicks.confirm ?? 0) + 1;
    },
  };
  const openMenu = { count: async () => 1, last: () => openMenu, getByRole: () => deleteItem };
  const dialog = { count: async () => 1, last: () => dialog, getByRole: () => confirm };
  return {
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (_source: unknown, argument: unknown) => {
      expect((argument as { matcherSource: string }).matcherSource).toBe(matchesElidedTextSource);
      return options.candidates;
    },
    locator: (selector: string) => {
      if (selector.includes("data-arcanada-delete-comment-target")) return target;
      if (selector.includes('[role="menu"]')) return openMenu;
      if (selector.includes('[role="dialog"]')) return dialog;
      return target;
    },
    getByRole: () => confirm,
  };
}
