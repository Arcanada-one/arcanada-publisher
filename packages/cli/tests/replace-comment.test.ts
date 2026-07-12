import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

const replaceComment = vi.hoisted(() => vi.fn());
vi.mock("../src/adapters.js", () => ({
  makeAdapter: () => ({ replaceComment }),
}));

import { run } from "../src/run.js";

const PARENT = "https://www.facebook.com/100012345/posts/777";

describe("replace-comment CLI", () => {
  beforeEach(() => {
    replaceComment.mockReset();
    replaceComment.mockResolvedValue({
      ok: true,
      platform: "facebook",
      account: "100012345",
      parentPostUrl: PARENT,
      commentId: "new-comment-id",
    });
  });

  it("routes exact parent/comment/content binding to Facebook safe replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "publisher-fb-comment-retrofit-"));
    const oldText = join(dir, "old.txt");
    const newText = join(dir, "new.txt");
    writeFileSync(oldText, "old first comment\n");
    writeFileSync(newText, "new first comment\n");

    const result = await run([
      "replace-comment",
      "--platform",
      "facebook",
      "--parent-url",
      PARENT,
      "--comment-id",
      "1326931196274132",
      "--expected-author-profile-url",
      "https://www.facebook.com/pavelvalentov",
      "--expected-content-file",
      oldText,
      "--text-file",
      newText,
      "--profile",
      "default",
    ]);

    expect(result).toEqual({ code: 0, message: "comment replaced: new-comment-id" });
    expect(replaceComment).toHaveBeenCalledWith({
      parentPostUrl: PARENT,
      commentId: "1326931196274132",
      expectedAuthorProfileUrl: "https://www.facebook.com/pavelvalentov",
      oldText: "old first comment",
      text: "new first comment",
      profile: "default",
    });
  });

  it("preserves UNKNOWN reconciliation evidence in CLI output", async () => {
    const oldSecret = "CLI_OLD_SECRET_DO_NOT_LEAK";
    const newSecret = "CLI_NEW_SECRET_DO_NOT_LEAK";
    replaceComment.mockRejectedValueOnce(
      new AdapterError(ErrorCode.VERIFY_FAILED, "state UNKNOWN; do not retry blindly", {
        unknown: true,
        reconcileRequired: true,
        oldCommentId: "1326931196274132",
        newCommentIds: ["9000000000000001"],
        expectedOldTextSha256: "old-sha256",
        expectedOldTextLength: oldSecret.length,
        replacementTextSha256: "new-sha256",
        replacementTextLength: newSecret.length,
        evidence: { preSubmitCommentIds: ["7000000000000001"] },
      }),
    );
    const dir = mkdtempSync(join(tmpdir(), "publisher-fb-comment-unknown-"));
    const oldText = join(dir, "old.txt");
    const newText = join(dir, "new.txt");
    writeFileSync(oldText, oldSecret);
    writeFileSync(newText, newSecret);

    const result = await run([
      "replace-comment",
      "--platform",
      "facebook",
      "--parent-url",
      PARENT,
      "--comment-id",
      "1326931196274132",
      "--expected-author-profile-url",
      "https://www.facebook.com/pavelvalentov",
      "--expected-content-file",
      oldText,
      "--text-file",
      newText,
    ]);

    expect(result.code).toBe(ErrorCode.VERIFY_FAILED);
    expect(result.message).not.toContain(oldSecret);
    expect(result.message).not.toContain(newSecret);
    expect(JSON.parse(result.message)).toMatchObject({
      details: {
        unknown: true,
        reconcileRequired: true,
        oldCommentId: "1326931196274132",
        newCommentIds: ["9000000000000001"],
      },
    });
  });
});
