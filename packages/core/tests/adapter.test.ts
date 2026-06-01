import { describe, it, expect } from "vitest";
import { BaseAdapter } from "../src/adapter.js";
import type { Adapter, PublishInput, DeleteInput } from "../src/adapter.js";
import type { Platform } from "../src/platform.js";
import type { CommentResult, DeleteResult, EditResult, PublishResult } from "../src/result.js";

// Minimal concrete adapter to prove the abstract contract compiles and that
// `delete()` is part of the surface every adapter must implement (R13 / V-AC-1).
class StubAdapter extends BaseAdapter {
  readonly platform: Platform = "facebook";
  async login(): Promise<void> {}
  async publish(): Promise<PublishResult> {
    return {
      ok: true,
      platform: "facebook",
      account: "stub",
      postUrl: "https://www.facebook.com/posts/1",
      attachments: [],
      commentIds: [],
    };
  }
  async comment(): Promise<CommentResult> {
    return {
      ok: true,
      platform: "facebook",
      account: "stub",
      commentId: "c1",
      parentPostUrl: "https://www.facebook.com/posts/1",
    };
  }
  async edit(): Promise<EditResult> {
    return {
      ok: true,
      platform: "facebook",
      account: "stub",
      postUrl: "https://www.facebook.com/posts/1",
      edited: true,
    };
  }
  async delete(input: DeleteInput): Promise<DeleteResult> {
    return {
      ok: true,
      platform: "facebook",
      account: "stub",
      deleted: true,
      targetUrl: input.targetUrl,
    };
  }
}

describe("BaseAdapter — delete() contract (R13 / V-AC-1)", () => {
  it("a concrete adapter implements delete() returning a DeleteResult", async () => {
    const a: Adapter = new StubAdapter();
    const res = await a.delete({
      targetUrl: "https://www.facebook.com/posts/1",
      kind: "post",
      expectedContent: "hello",
      profile: "p1",
    });
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(true);
    expect(res.targetUrl).toBe("https://www.facebook.com/posts/1");
  });

  it("PublishInput accepts imagePaths array (R1 multi-image) alongside the deprecated imagePath alias", () => {
    const multi: PublishInput = {
      text: "post",
      profile: "p1",
      imagePaths: ["/tmp/a.png", "/tmp/b.png"],
    };
    const legacy: PublishInput = {
      text: "post",
      profile: "p1",
      imagePath: "/tmp/a.png",
    };
    expect(multi.imagePaths).toHaveLength(2);
    expect(legacy.imagePath).toBe("/tmp/a.png");
  });
});
