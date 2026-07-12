import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileManager, type EditResult } from "@arcanada/publisher-core";
import { completePostEditMutation, edit, type FacebookEditInput } from "../src/edit.js";

function makeProfiles(): { mgr: ProfileManager; root: string } {
  const root = mkdtempSync(join(tmpdir(), "pub-0003-edit-"));
  const platformDir = join(root, "facebook", "p1");
  mkdirSync(platformDir, { recursive: true });
  return { mgr: new ProfileManager({ root }), root };
}

const okResult = (postUrl: string): EditResult => ({
  ok: true,
  platform: "facebook",
  account: "100012345",
  postUrl,
  edited: true,
});

describe("edit post-mutation UNKNOWN boundary", () => {
  const before = {
    canonicalPermalink: "https://www.facebook.com/pavel/posts/pfbid1",
    authorProfileIdentity: "www.facebook.com/pavel",
    normalizedBody: "Title",
    hasImage: true,
    mediaIdentity: "https://www.facebook.com/photo/?fbid=hero",
  };
  const valid = { ...before, normalizedBody: "Full body" };
  const base = {
    save: async () => {},
    settle: async () => {},
    readback: async () => valid,
    before,
    target: before.canonicalPermalink,
    expectedAuthor: before.authorProfileIdentity,
    expectedBody: "Full body",
  };

  for (const [name, override] of [
    [
      "Save throw",
      {
        save: async () => {
          throw new Error("save");
        },
      },
    ],
    [
      "settle failure",
      {
        settle: async () => {
          throw new Error("settle");
        },
      },
    ],
    [
      "readback failure",
      {
        readback: async () => {
          throw new Error("readback");
        },
      },
    ],
    ["media identity mismatch", { readback: async () => ({ ...valid, mediaIdentity: "other" }) }],
  ] as const) {
    it(`${name} returns UNKNOWN/reconcile`, async () => {
      await expect(completePostEditMutation({ ...base, ...override })).rejects.toMatchObject({
        code: 6,
        details: { unknown: true, reconcileRequired: true, stage: "post_edit_verify" },
      });
    });
  }
});

describe("edit — union dispatch (postUrl-only vs commentId)", () => {
  it("routes to editPost when commentId is absent", async () => {
    const { mgr } = makeProfiles();
    const editPost = vi.fn(async (_p, i: FacebookEditInput) => okResult(i.postUrl));
    const editComment = vi.fn(async (_p, i: FacebookEditInput) => okResult(i.postUrl));

    await edit(
      {
        postUrl: "https://www.facebook.com/100012345/posts/777",
        text: "updated body",
        expectedContent: "current body",
        expectedAuthorProfileUrl: "https://www.facebook.com/100012345",
        expectedMediaKind: "image",
        profile: "p1",
      },
      {
        profileManager: mgr,
        page: { dummy: true } as never,
        __editPost: editPost as never,
        __editComment: editComment as never,
      },
    );
    expect(editPost).toHaveBeenCalledTimes(1);
    expect(editComment).not.toHaveBeenCalled();
  });

  it("routes to editComment when commentId is present", async () => {
    const { mgr } = makeProfiles();
    const editPost = vi.fn(async (_p, i: FacebookEditInput) => okResult(i.postUrl));
    const editComment = vi.fn(async (_p, i: FacebookEditInput) => okResult(i.postUrl));

    await edit(
      {
        postUrl: "https://www.facebook.com/100012345/posts/777",
        commentId: "999",
        text: "updated comment",
        profile: "p1",
      },
      {
        profileManager: mgr,
        page: { dummy: true } as never,
        __editPost: editPost as never,
        __editComment: editComment as never,
      },
    );
    expect(editComment).toHaveBeenCalledTimes(1);
    expect(editPost).not.toHaveBeenCalled();
  });

  it("rejects when both text and imagePath are absent", async () => {
    const { mgr } = makeProfiles();
    await expect(
      edit(
        { postUrl: "https://www.facebook.com/100012345/posts/777", profile: "p1" },
        { profileManager: mgr },
      ),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("requires exact current content, stable author, and image oracle for post edits", async () => {
    const { mgr } = makeProfiles();
    await expect(
      edit(
        {
          postUrl: "https://www.facebook.com/100012345/posts/777",
          text: "updated body",
          profile: "p1",
        },
        { profileManager: mgr },
      ),
    ).rejects.toMatchObject({ code: 2 });
  });
});
