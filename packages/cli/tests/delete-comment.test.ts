// PUB-0031: `delete --kind comment` CLI surface. Guards the two properties that
// matter at this layer: the kind reaches the adapter verbatim (so a comment
// delete can never be silently downgraded to a post delete), and the ownership
// oracle is mandatory before any browser work starts.

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";

const del = vi.hoisted(() => vi.fn());
vi.mock("../src/adapters.js", () => ({
  makeAdapter: () => ({ delete: del }),
}));

import { run } from "../src/run.js";

const PARENT = "https://www.facebook.com/pavelvalentov/posts/pfbid-target";
const COMMENT_URL = `${PARENT}?comment_id=2232816490902550`;
const AUTHOR = "https://www.facebook.com/pavelvalentov";
const BODY = "Плагин в Chrome Web Store:\nhttps://chromewebstore.google.com/detail/x";

function oracleFile(body = BODY): string {
  const dir = mkdtempSync(join(tmpdir(), "publisher-fb-delete-comment-"));
  const path = join(dir, "comment.txt");
  writeFileSync(path, `${body}\n`);
  return path;
}

describe("delete --kind comment CLI", () => {
  beforeEach(() => {
    del.mockReset();
    del.mockResolvedValue({
      ok: true,
      platform: "facebook",
      account: "pavelvalentov",
      deleted: true,
      targetUrl: COMMENT_URL,
    });
  });

  it("passes kind=comment, the exact oracle and the author URL to the adapter", async () => {
    const result = await run([
      "delete",
      "--platform",
      "facebook",
      "--kind",
      "comment",
      "--target-url",
      COMMENT_URL,
      "--expected-content-file",
      oracleFile(),
      "--expected-author-profile-url",
      AUTHOR,
      "--profile",
      "default",
    ]);

    expect(result.code).toBe(ErrorCode.SUCCESS);
    expect(result.message).toContain("comment");
    expect(del).toHaveBeenCalledWith({
      targetUrl: COMMENT_URL,
      kind: "comment",
      expectedContent: BODY,
      expectedAuthorProfileUrl: AUTHOR,
      profile: "default",
    });
  });

  it("defaults to kind=post when --kind is omitted (no behaviour change)", async () => {
    await run([
      "delete",
      "--platform",
      "facebook",
      "--target-url",
      PARENT,
      "--expected-content-file",
      oracleFile(),
    ]);
    expect(del).toHaveBeenCalledWith(expect.objectContaining({ kind: "post" }));
  });

  it("refuses a comment delete with no author oracle and never touches the browser", async () => {
    const result = await run([
      "delete",
      "--platform",
      "facebook",
      "--kind",
      "comment",
      "--target-url",
      COMMENT_URL,
      "--expected-content-file",
      oracleFile(),
    ]);

    expect(result.code).toBe(ErrorCode.MISSING_INPUT);
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses comment deletion on platforms that do not implement it", async () => {
    const result = await run([
      "delete",
      "--platform",
      "linkedin",
      "--kind",
      "comment",
      "--target-url",
      COMMENT_URL,
      "--expected-content-file",
      oracleFile(),
      "--expected-author-profile-url",
      AUTHOR,
    ]);

    expect(result.code).toBe(ErrorCode.INVALID_ARGS);
    expect(del).not.toHaveBeenCalled();
  });

  it("rejects an unknown --kind value at parse time", async () => {
    const result = await run([
      "delete",
      "--platform",
      "facebook",
      "--kind",
      "reply",
      "--target-url",
      COMMENT_URL,
      "--expected-content-file",
      oracleFile(),
    ]);

    expect(result.code).toBe(ErrorCode.INVALID_ARGS);
    expect(del).not.toHaveBeenCalled();
  });
});
