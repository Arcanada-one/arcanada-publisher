import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileManager } from "@arcanada/publisher-core";
import {
  assertExactCommentBinding,
  replaceCommentText,
  type ReplaceCommentRecorder,
} from "../src/comment.js";
import { VERIFY_DELAY_MS } from "../src/timing.js";

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0017-fb-replace-"));
  mkdirSync(join(root, "facebook", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

const PARENT = "https://www.facebook.com/100012345/posts/777";
const AUTHOR_PROFILE = "https://www.facebook.com/pavelvalentov";

describe("facebook R10 — comment-text change is DELETE+ADD, never in-place edit", () => {
  it("R10: replaceCommentText deletes the old comment, then adds the new one (in that order)", async () => {
    const order: string[] = [];
    const rec: ReplaceCommentRecorder = {
      deleteOldComment: vi.fn(async () => {
        order.push("deleteOldComment");
        return { preDeleteCommentIds: ["1326931196274132"] };
      }),
      addNewComment: vi.fn(async () => {
        order.push("addNewComment");
        return {
          commentId: "999888",
          commentHref: `${PARENT}?comment_id=999888`,
          preSubmitCommentIds: [],
          renderedBody: "new\nmulti\nline",
          renderedAuthorProfileUrl: AUTHOR_PROFILE,
        };
      }),
    };
    const res = await replaceCommentText(
      {
        parentPostUrl: PARENT,
        commentId: "1326931196274132",
        expectedAuthorProfileUrl: AUTHOR_PROFILE,
        oldText: "old link line",
        text: "new\nmulti\nline",
        profile: "p1",
      },
      { profileManager: makeProfiles(), page: { dummy: true } as never, __recorder: rec },
    );
    expect(order).toEqual(["deleteOldComment", "addNewComment"]);
    expect(res.commentId).toBe("999888");
  });

  it("R10: never performs an in-place edit — there is NO edit step in the recorder contract", async () => {
    const rec: ReplaceCommentRecorder = {
      deleteOldComment: vi.fn(async () => ({ preDeleteCommentIds: ["1326931196274132"] })),
      addNewComment: vi.fn(async () => ({
        commentId: "1",
        commentHref: `${PARENT}?comment_id=1`,
        preSubmitCommentIds: [],
        renderedBody: "y",
        renderedAuthorProfileUrl: AUTHOR_PROFILE,
      })),
    };
    await replaceCommentText(
      {
        parentPostUrl: PARENT,
        commentId: "1326931196274132",
        expectedAuthorProfileUrl: AUTHOR_PROFILE,
        oldText: "x",
        text: "y",
        profile: "p1",
      },
      { profileManager: makeProfiles(), page: { dummy: true } as never, __recorder: rec },
    );
    // The contract only exposes delete + add; an in-place "edit" arm does not exist.
    expect(Object.keys(rec)).toEqual(["deleteOldComment", "addNewComment"]);
  });

  it("fails closed when the exact existing comment id is missing", async () => {
    await expect(
      replaceCommentText(
        {
          parentPostUrl: PARENT,
          commentId: "",
          expectedAuthorProfileUrl: AUTHOR_PROFILE,
          oldText: "old text",
          text: "new text",
          profile: "p1",
        },
        { profileManager: makeProfiles() },
      ),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("binds deletion to the exact parent, comment id, and complete old content", () => {
    const input = {
      parentPostUrl: PARENT,
      commentId: "1326931196274132",
      expectedAuthorProfileUrl: AUTHOR_PROFILE,
      oldText: "first line\nsecond line",
      text: "replacement",
      profile: "p1",
    };
    expect(() =>
      assertExactCommentBinding(input, {
        commentHref: `${PARENT}?comment_id=1326931196274132`,
        commentId: "1326931196274132",
        renderedBodyCandidates: ["first line\nsecond line"],
        renderedAuthorProfileHrefs: [AUTHOR_PROFILE],
      }),
    ).not.toThrow();

    expect(() =>
      assertExactCommentBinding(input, {
        commentHref: `${PARENT}?comment_id=999`,
        commentId: "999",
        renderedBodyCandidates: ["first line\nsecond line"],
        renderedAuthorProfileHrefs: [AUTHOR_PROFILE],
      }),
    ).toThrowError(/comment id mismatch/i);
    expect(() =>
      assertExactCommentBinding(input, {
        commentHref: "https://www.facebook.com/100012345/posts/other?comment_id=1326931196274132",
        commentId: "1326931196274132",
        renderedBodyCandidates: ["first line\nsecond line"],
        renderedAuthorProfileHrefs: [AUTHOR_PROFILE],
      }),
    ).toThrowError(/parent post mismatch/i);
    expect(() =>
      assertExactCommentBinding(input, {
        commentHref: `${PARENT}?comment_id=1326931196274132`,
        commentId: "1326931196274132",
        renderedBodyCandidates: ["first line"],
        renderedAuthorProfileHrefs: [AUTHOR_PROFILE],
      }),
    ).toThrowError(/exact old content mismatch/i);
    expect(() =>
      assertExactCommentBinding(input, {
        commentHref: `${PARENT}?comment_id=1326931196274132`,
        commentId: "1326931196274132",
        renderedBodyCandidates: ["first line\nsecond line"],
        renderedAuthorProfileHrefs: ["https://www.facebook.com/impostor"],
      }),
    ).toThrowError(/expected author mismatch/i);
  });

  it("fails closed when expectedAuthorProfileUrl is missing", async () => {
    await expect(
      replaceCommentText(
        {
          parentPostUrl: PARENT,
          commentId: "1326931196274132",
          expectedAuthorProfileUrl: "",
          oldText: "old text",
          text: "new text",
          profile: "p1",
        },
        { profileManager: makeProfiles() },
      ),
    ).rejects.toMatchObject({ code: 2 });
  });
});

describe("facebook R11 — verify delay constant is ≥ 12 seconds", () => {
  it("R11: VERIFY_DELAY_MS is at least 12000 ms (publish/comment settle window)", () => {
    expect(VERIFY_DELAY_MS).toBeGreaterThanOrEqual(12_000);
  });
});
