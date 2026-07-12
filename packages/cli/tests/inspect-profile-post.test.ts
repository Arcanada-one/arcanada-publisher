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
      comments: [
        {
          id: "1326931196274132",
          authorProfileIdentity: "www.facebook.com/pavelvalentov",
          bodySha256: "comment-sha256",
          bodyLength: 209,
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

    expect(result.code, result.message).toBe(0);
    expect(result.message).not.toContain(secretBody);
    expect(result.message).not.toContain(root);
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

  it("reports expected-content read failures without leaking the supplied path", async () => {
    const secretPath = "/private/campaigns/CONTENT-0377/secret-body.txt";
    const result = await run([
      "inspect-profile-post",
      "--platform",
      "facebook",
      "--profile-url",
      "https://www.facebook.com/pavelvalentov",
      "--expected-author-profile-url",
      "https://www.facebook.com/pavelvalentov",
      "--expected-content-file",
      secretPath,
      "--evidence-dir",
      "/private/evidence",
      "--max-scrolls",
      "2",
    ]);

    expect(result.code).toBe(2);
    expect(result.message).toContain("inspect-profile-post: failed to read expected content file");
    expect(result.message).not.toContain(secretPath);
    expect(inspectProfilePost).not.toHaveBeenCalled();
  });

  it("routes exact content to the read-only X inventory adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "x-inspect-cli-"));
    const bodyFile = join(root, "post.txt");
    writeFileSync(bodyFile, "Exact X campaign body\n");
    inspectProfilePost.mockResolvedValueOnce({
      authorHandle: "veritasarcanaai",
      matches: [{ statusId: "2076136745746272281", bodySha256: "sha" }],
      coverage: { maxScrolls: 4, scrollsPerformed: 4, postsInspected: 12 },
    });

    const result = await run([
      "inspect-profile-post",
      "--platform",
      "x",
      "--profile-url",
      "https://x.com/VeritasArcanaAI",
      "--expected-author-profile-url",
      "https://x.com/VeritasArcanaAI",
      "--expected-content-file",
      bodyFile,
      "--evidence-dir",
      join(root, "evidence"),
      "--max-scrolls",
      "4",
      "--profile",
      "default",
    ]);

    expect(result.code, result.message).toBe(0);
    expect(JSON.parse(result.message)).toMatchObject({
      authorHandle: "veritasarcanaai",
      matches: [{ statusId: "2076136745746272281" }],
    });
    expect(inspectProfilePost).toHaveBeenCalledWith({
      profileUrl: "https://x.com/VeritasArcanaAI",
      expectedAuthorProfileUrl: "https://x.com/VeritasArcanaAI",
      expectedBody: "Exact X campaign body",
      evidenceDir: join(root, "evidence"),
      maxScrolls: 4,
      profile: "default",
    });
  });

  it("routes exact content to the read-only LinkedIn inventory adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "li-inspect-cli-"));
    const bodyFile = join(root, "post.txt");
    writeFileSync(bodyFile, "Exact LinkedIn campaign body\n");
    inspectProfilePost.mockResolvedValueOnce({
      canonicalParentPermalink:
        "https://www.linkedin.com/posts/pavelvalentov_post-activity-7482676445432107008-AbCd",
      activityUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7482676445432107008/",
      activityId: "7482676445432107008",
      hasNativeVideo: true,
    });
    const result = await run([
      "inspect-profile-post",
      "--platform",
      "linkedin",
      "--profile-url",
      "https://www.linkedin.com/in/pavelvalentov/",
      "--expected-author-profile-url",
      "https://www.linkedin.com/in/pavelvalentov/",
      "--expected-content-file",
      bodyFile,
      "--evidence-dir",
      join(root, "evidence"),
      "--max-scrolls",
      "2",
    ]);
    expect(result.code, result.message).toBe(0);
    expect(JSON.parse(result.message)).toMatchObject({
      activityId: "7482676445432107008",
      hasNativeVideo: true,
    });
    expect(inspectProfilePost).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBody: "Exact LinkedIn campaign body",
        profile: "default",
      }),
    );
  });
});
