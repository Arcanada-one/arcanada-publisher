import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const inspectProfilePost = vi.hoisted(() => vi.fn());
vi.mock("../src/adapters.js", () => ({
  makeAdapter: () => ({ inspectProfilePost }),
}));

import { run } from "../src/run.js";

describe("inspect-profile-post CLI", () => {
  beforeEach(() => {
    inspectProfilePost.mockReset();
    inspectProfilePost.mockResolvedValue({
      canonicalParentPermalink: "https://www.facebook.com/pavelvalentov/posts/pfbid-content-0377",
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      postBodySha256: "post-sha256",
      postBodyLength: 1234,
      postBodyEvidencePath: "/private/post-body.txt",
      screenshotPath: "/private/readback.png",
      comments: [
        {
          id: "1326931196274132",
          authorProfileIdentity: "www.facebook.com/pavelvalentov",
          bodySha256: "comment-sha256",
          bodyLength: 209,
          bodyEvidencePath: "/private/comment-1326931196274132.txt",
        },
      ],
      coverage: { maxScrolls: 12, scrollsPerformed: 12, postsInspected: 18 },
    });
  });

  it("routes exact content to the read-only Facebook adapter without leaking raw bodies", async () => {
    const secretBody = "SECRET_FULL_POST_BODY_MUST_NOT_REACH_STDOUT";
    const root = mkdtempSync(join(tmpdir(), "fb-inspect-cli-"));
    const bodyFile = join(root, "post.txt");
    writeFileSync(bodyFile, `${secretBody}\n`);

    const result = await run([
      "inspect-profile-post",
      "--platform",
      "facebook",
      "--profile-url",
      "https://www.facebook.com/pavelvalentov",
      "--expected-author-profile-url",
      "https://www.facebook.com/pavelvalentov",
      "--expected-content-file",
      bodyFile,
      "--evidence-dir",
      join(root, "evidence"),
      "--max-scrolls",
      "12",
      "--profile",
      "default",
    ]);

    expect(result.code).toBe(0);
    expect(result.message).not.toContain(secretBody);
    expect(JSON.parse(result.message)).toMatchObject({
      canonicalParentPermalink: "https://www.facebook.com/pavelvalentov/posts/pfbid-content-0377",
      comments: [{ id: "1326931196274132", bodySha256: "comment-sha256" }],
      coverage: { scrollsPerformed: 12, postsInspected: 18 },
    });
    expect(inspectProfilePost).toHaveBeenCalledWith({
      profileUrl: "https://www.facebook.com/pavelvalentov",
      expectedAuthorProfileUrl: "https://www.facebook.com/pavelvalentov",
      expectedBody: secretBody,
      evidenceDir: join(root, "evidence"),
      maxScrolls: 12,
      profile: "default",
    });
  });

  it("rejects non-Facebook inspection without constructing a mutation path", async () => {
    const result = await run([
      "inspect-profile-post",
      "--platform",
      "linkedin",
      "--profile-url",
      "https://www.facebook.com/pavelvalentov",
      "--expected-author-profile-url",
      "https://www.facebook.com/pavelvalentov",
      "--content-excerpt",
      "unique excerpt",
      "--evidence-dir",
      "/private/evidence",
      "--max-scrolls",
      "2",
    ]);
    expect(result.code).not.toBe(0);
    expect(inspectProfilePost).not.toHaveBeenCalled();
  });
});
