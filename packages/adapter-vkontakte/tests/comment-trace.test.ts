import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode } from "@arcanada/publisher-core";
import { VKontakteAdapter, type VkTransport } from "../src/index.js";
import type { VkCommentInput } from "../src/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "comment-reply.json"), "utf8")) as {
  request: { method: string; params: Record<string, string> };
  response: { json: unknown };
};

describe("vk comment — recorded-fixture trace (V-AC-13: reply_to_comment parent match)", () => {
  it("a reply to a comment sends reply_to_comment=<id> matching the recorded request", async () => {
    const captured: Array<{ method: string; params: Record<string, string> }> = [];
    const transport: VkTransport = vi.fn(async (req) => {
      captured.push(req);
      return { status: 200, json: fixture.response.json };
    });
    const adapter = new VKontakteAdapter({ transport });

    const input: VkCommentInput = {
      parentPostUrl: "https://vk.com/wall-123456_789",
      ownerId: -123456,
      postId: 789,
      replyToComment: 42,
      text: "спасибо за детали",
      profile: "p1",
    };
    const res = await adapter.comment(input);

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("wall.createComment");
    // V-AC-13: the reply_to_comment param carries the parent comment id.
    expect(captured[0].params["reply_to_comment"]).toBe("42");
    expect(captured[0].params["reply_to_comment"]).toBe(fixture.request.params["reply_to_comment"]);
    expect(captured[0].params["owner_id"]).toBe("-123456");
    expect(captured[0].params["post_id"]).toBe("789");
    expect(res.commentId).toBe("57");
  });

  it("a top-level comment (no replyToComment) omits reply_to_comment entirely", async () => {
    const captured: Array<{ params: Record<string, string> }> = [];
    const transport: VkTransport = vi.fn(async (req) => {
      captured.push(req);
      return { status: 200, json: { response: { comment_id: 1 } } };
    });
    const adapter = new VKontakteAdapter({ transport });
    await adapter.comment({
      parentPostUrl: "https://vk.com/wall-123456_789",
      ownerId: -123456,
      postId: 789,
      text: "первый",
      profile: "p1",
    } as VkCommentInput);
    expect(captured[0].params["reply_to_comment"]).toBeUndefined();
  });

  it("surfaces a VK API error as VERIFY_FAILED", async () => {
    const transport: VkTransport = vi.fn(async () => ({
      status: 200,
      json: { error: { error_code: 15, error_msg: "Access denied" } },
    }));
    const adapter = new VKontakteAdapter({ transport });
    await expect(
      adapter.comment({
        parentPostUrl: "https://vk.com/wall-123456_789",
        ownerId: -123456,
        postId: 789,
        text: "x",
        profile: "p1",
      } as VkCommentInput),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
  });

  it("delete: read-before-delete aborts when fetched post text does not match expectedContent", async () => {
    const calls: string[] = [];
    const transport: VkTransport = vi.fn(async (req) => {
      calls.push(req.method);
      if (req.method === "wall.getById") {
        return { status: 200, json: { response: { items: [{ text: "a different post" }] } } };
      }
      return { status: 200, json: { response: 1 } };
    });
    const adapter = new VKontakteAdapter({ transport });
    await expect(
      adapter.delete({
        targetUrl: "https://vk.com/wall-123456_789",
        kind: "post",
        expectedContent: "the real post text",
        profile: "p1",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(calls).not.toContain("wall.delete");
  });
});
