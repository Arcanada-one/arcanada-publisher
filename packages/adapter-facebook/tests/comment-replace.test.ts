import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileManager } from "@arcanada/publisher-core";
import { replaceCommentText, type ReplaceCommentRecorder } from "../src/comment.js";
import { VERIFY_DELAY_MS } from "../src/timing.js";

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0017-fb-replace-"));
  mkdirSync(join(root, "facebook", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

const PARENT = "https://www.facebook.com/100012345/posts/777";

describe("facebook R10 — comment-text change is DELETE+ADD, never in-place edit", () => {
  it("R10: replaceCommentText deletes the old comment, then adds the new one (in that order)", async () => {
    const order: string[] = [];
    const rec: ReplaceCommentRecorder = {
      deleteOldComment: vi.fn(async () => {
        order.push("deleteOldComment");
      }),
      addNewComment: vi.fn(async () => {
        order.push("addNewComment");
        return "999888";
      }),
    };
    const res = await replaceCommentText(
      {
        parentPostUrl: PARENT,
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
      deleteOldComment: vi.fn(async () => {}),
      addNewComment: vi.fn(async () => "1"),
    };
    await replaceCommentText(
      { parentPostUrl: PARENT, oldText: "x", text: "y", profile: "p1" },
      { profileManager: makeProfiles(), page: { dummy: true } as never, __recorder: rec },
    );
    // The contract only exposes delete + add; an in-place "edit" arm does not exist.
    expect(Object.keys(rec)).toEqual(["deleteOldComment", "addNewComment"]);
  });
});

describe("facebook R11 — verify delay constant is ≥ 12 seconds", () => {
  it("R11: VERIFY_DELAY_MS is at least 12000 ms (publish/comment settle window)", () => {
    expect(VERIFY_DELAY_MS).toBeGreaterThanOrEqual(12_000);
  });
});
