import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { editComment, type EditCommentRecorder } from "../src/comment.js";

function makeProfiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "pub-0017-li-editc-"));
  mkdirSync(join(root, "linkedin", "p1"), { recursive: true });
  return new ProfileManager({ root });
}

const PARENT = "https://www.linkedin.com/feed/update/urn:li:activity:7462962260978642944/";

describe("linkedin R10 — comment edit via menu + Save changes", () => {
  it("R10: runs menu → edit → replace → SAVE CHANGES in that exact order", async () => {
    const order: string[] = [];
    const rec: EditCommentRecorder = {
      openCommentMenu: vi.fn(async () => {
        order.push("openCommentMenu");
      }),
      clickEditItem: vi.fn(async () => {
        order.push("clickEditItem");
      }),
      replaceText: vi.fn(async () => {
        order.push("replaceText");
      }),
      clickSaveChanges: vi.fn(async () => {
        order.push("clickSaveChanges");
      }),
    };
    const res = await editComment(
      { parentPostUrl: PARENT, oldText: "old", text: "new text", profile: "p1" },
      { profileManager: makeProfiles(), page: { dummy: true } as never, __recorder: rec },
    );
    expect(order).toEqual(["openCommentMenu", "clickEditItem", "replaceText", "clickSaveChanges"]);
    expect(res.ok).toBe(true);
  });

  it("R10: requires oldText (read-before-edit oracle) — empty oldText → MISSING_INPUT", async () => {
    await expect(
      editComment(
        { parentPostUrl: PARENT, oldText: "", text: "new", profile: "p1" },
        { profileManager: makeProfiles(), page: { dummy: true } as never },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("R10: rejects a non-LinkedIn parentPostUrl with INVALID_ARGS", async () => {
    await expect(
      editComment(
        {
          parentPostUrl: "https://evil.example.com/feed/update/urn:li:activity:1/",
          oldText: "old",
          text: "new",
          profile: "p1",
        },
        { profileManager: makeProfiles(), page: { dummy: true } as never },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });
});
