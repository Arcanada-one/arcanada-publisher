import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode } from "@arcanada/publisher-core";
import { RedditAdapter, type RedditTransport, type RedditCommentInput } from "../src/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "comment-reply.json"), "utf8")) as {
  request: { path: string; form: { parent: string } };
  response: { json: unknown };
};

describe("reddit comment — recorded-fixture trace (V-AC-12: parent_id == t1_<id>)", () => {
  it("a reply to a COMMENT sends parent=t1_<id> and the recorded response confirms parent_id == t1_<id>", async () => {
    const captured: Array<{ path: string; form: Record<string, string> }> = [];
    const transport: RedditTransport = vi.fn(async (req) => {
      captured.push(req);
      return { status: 200, json: fixture.response.json };
    });
    const adapter = new RedditAdapter({ transport });

    const input: RedditCommentInput = {
      parentPostUrl: "https://www.reddit.com/r/test/comments/p0st99/title/l9abc12/",
      parentKind: "comment",
      parentId: "l9abc12",
      text: "thanks for the detail",
      profile: "p1",
    };
    const res = await adapter.comment(input);

    // The request the adapter SENT must carry the t1_ parent fullname.
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/api/comment");
    expect(captured[0].form.parent).toBe("t1_l9abc12");
    expect(captured[0].form.parent).toMatch(/^t1_/);

    // It must match the recorded fixture's request shape (oracle).
    expect(captured[0].form.parent).toBe(fixture.request.form.parent);

    // The recorded RESPONSE's thing has parent_id == t1_<id> — the trace oracle.
    const things = (
      fixture.response.json as {
        json: { data: { things: Array<{ data: { parent_id: string } }> } };
      }
    ).json.data.things;
    expect(things[0].data.parent_id).toBe("t1_l9abc12");
    expect(things[0].data.parent_id).toMatch(/^t1_/);

    expect(res.commentId).toBe("l9def34");
  });

  it("a top-level comment on a POST sends parent=t3_<id> (not t1_)", async () => {
    const captured: Array<{ form: Record<string, string> }> = [];
    const transport: RedditTransport = vi.fn(async (req) => {
      captured.push(req);
      return {
        status: 200,
        json: { json: { data: { things: [{ data: { id: "top1" } }] } } },
      };
    });
    const adapter = new RedditAdapter({ transport });
    await adapter.comment({
      parentPostUrl: "https://www.reddit.com/r/test/comments/p0st99/",
      parentKind: "post",
      parentId: "p0st99",
      text: "first!",
      profile: "p1",
    } as RedditCommentInput);
    expect(captured[0].form.parent).toBe("t3_p0st99");
    expect(captured[0].form.parent).toMatch(/^t3_/);
  });

  it("delete: read-before-delete aborts when fetched body does not match expectedContent", async () => {
    const calls: string[] = [];
    const transport: RedditTransport = vi.fn(async (req) => {
      calls.push(req.path);
      if (req.path === "/api/info") {
        return {
          status: 200,
          json: { data: { children: [{ data: { body: "a totally different comment" } }] } },
        };
      }
      return { status: 200, json: {} };
    });
    const adapter = new RedditAdapter({ transport });
    await expect(
      adapter.delete({
        targetUrl: "https://www.reddit.com/r/test/comments/p0st99/",
        kind: "comment",
        expectedContent: "the real comment text",
        profile: "p1",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    // /api/del must NOT have been called.
    expect(calls).not.toContain("/api/del");
  });
});
