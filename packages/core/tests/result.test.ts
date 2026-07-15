import { describe, it, expect } from "vitest";
import {
  PublishResultSchema,
  CommentResultSchema,
  EditResultSchema,
  VerifyResultSchema,
  DeleteResultSchema,
} from "../src/result.js";

describe("PublishResultSchema", () => {
  it("parses a minimal valid result and applies array defaults", () => {
    const parsed = PublishResultSchema.parse({
      ok: true,
      platform: "facebook",
      account: "pavel",
      postUrl: "https://www.facebook.com/posts/1",
    });
    expect(parsed.attachments).toEqual([]);
    expect(parsed.commentIds).toEqual([]);
  });

  it("rejects non-URL postUrl", () => {
    const r = PublishResultSchema.safeParse({
      ok: true,
      platform: "x",
      account: "@pavel",
      postUrl: "not-a-url",
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown platform", () => {
    const r = PublishResultSchema.safeParse({
      ok: true,
      platform: "myspace",
      account: "x",
      postUrl: "https://example.com/p/1",
    });
    expect(r.success).toBe(false);
  });

  it("accepts attachments + commentIds when provided", () => {
    const parsed = PublishResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account: "pavel",
      postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
      attachments: [{ kind: "image", src: "/tmp/a.png" }],
      commentIds: ["c1"],
    });
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.commentIds[0]).toBe("c1");
  });
});

describe("CommentResultSchema", () => {
  it("requires commentId and parentPostUrl", () => {
    const ok = CommentResultSchema.safeParse({
      ok: true,
      platform: "reddit",
      account: "u_pavel",
      commentId: "t1_abc",
      parentPostUrl: "https://www.reddit.com/r/test/comments/xx/yy/",
    });
    expect(ok.success).toBe(true);

    const bad = CommentResultSchema.safeParse({
      ok: true,
      platform: "reddit",
      account: "u_pavel",
      commentId: "",
      parentPostUrl: "https://www.reddit.com/r/test/comments/xx/yy/",
    });
    expect(bad.success).toBe(false);
  });
});

describe("EditResultSchema", () => {
  it("parses edited true/false flag", () => {
    const r = EditResultSchema.parse({
      ok: true,
      platform: "vkontakte",
      account: "pavel",
      postUrl: "https://vk.com/wall1_1",
      edited: true,
    });
    expect(r.edited).toBe(true);
  });
});

describe("DeleteResultSchema", () => {
  it("parses a valid delete result (R13)", () => {
    const r = DeleteResultSchema.parse({
      ok: true,
      platform: "facebook",
      account: "pavel",
      deleted: true,
      targetUrl: "https://www.facebook.com/posts/1",
    });
    expect(r.deleted).toBe(true);
    expect(r.targetUrl).toBe("https://www.facebook.com/posts/1");
  });

  it("rejects a non-URL targetUrl", () => {
    const r = DeleteResultSchema.safeParse({
      ok: true,
      platform: "facebook",
      account: "pavel",
      deleted: true,
      targetUrl: "not-a-url",
    });
    expect(r.success).toBe(false);
  });
});

describe("VerifyResultSchema", () => {
  it("accepts non-ok verify with status > 0", () => {
    const r = VerifyResultSchema.parse({
      ok: false,
      platform: "x",
      postUrl: "https://x.com/u/status/1",
      reachable: false,
      status: 404,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});

describe("PublishResultSchema multi-post bundle", () => {
  it("preserves ordered post IDs and URLs without treating post 2 as a comment", () => {
    const parsed = PublishResultSchema.parse({
      ok: true,
      platform: "telegram",
      account: "-1003855619081",
      postUrl: "https://t.me/c/3855619081/8",
      postUrls: ["https://t.me/c/3855619081/8", "https://t.me/c/3855619081/9"],
      postIds: ["8", "9"],
      commentIds: [],
    });

    expect(parsed.postIds).toEqual(["8", "9"]);
    expect(parsed.postUrls).toHaveLength(2);
    expect(parsed.commentIds).toEqual([]);
  });
});
