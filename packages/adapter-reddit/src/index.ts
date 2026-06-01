// RedditAdapter — HTTP-API adapter (Phase 4). Unlike the browser adapters,
// Reddit posts via the OAuth API: /api/submit (self-post), /api/comment
// (self-comment with a `parent` fullname), /api/del (delete). The transport is
// injectable so the request trace is verifiable against a recorded fixture
// without live posting.

import {
  BaseAdapter,
  AdapterError,
  ErrorCode,
  PublishResultSchema,
  CommentResultSchema,
  DeleteResultSchema,
  EditResultSchema,
  type CommentInput,
  type CommentResult,
  type DeleteInput,
  type DeleteResult,
  type EditInput,
  type EditResult,
  type LoginOptions,
  type PublishInput,
  type PublishResult,
} from "@arcanada/publisher-core";
import { fullname, isCommentFullname, isPostFullname } from "./fullname.js";
import { resolveTransport, type RedditClientOptions, type RedditTransport } from "./client.js";

export interface RedditPublishInput extends PublishInput {
  /** Target subreddit (without the r/ prefix). */
  subreddit: string;
  /** Post title (Reddit self-posts require a title; `text` is the body). */
  title: string;
}

export interface RedditCommentInput extends CommentInput {
  /** Kind of the parent thing the comment replies to. */
  parentKind: "post" | "comment";
  /** Raw id of the parent (with or without the t1_/t3_ prefix). */
  parentId: string;
}

export type RedditAdapterOptions = RedditClientOptions;

export class RedditAdapter extends BaseAdapter {
  readonly platform = "reddit" as const;
  private readonly transport: RedditTransport;

  constructor(options: RedditAdapterOptions = {}) {
    super();
    this.transport = resolveTransport(options);
  }

  /** Reddit auth is token-based; there is no headed login. */
  async login(_options: LoginOptions): Promise<void> {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "reddit: login is token-based — supply an OAuth accessToken to the adapter options",
    );
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const ri = input as RedditPublishInput;
    if (!ri.subreddit) {
      throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: 'subreddit' is required");
    }
    if (!ri.title || ri.title.trim() === "") {
      throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: 'title' is required");
    }
    if (input.dryRun) {
      return PublishResultSchema.parse({
        ok: true,
        platform: "reddit",
        account: ri.subreddit,
        postUrl: `https://www.reddit.com/r/${ri.subreddit}/comments/dryrun/`,
        attachments: [],
        commentIds: [],
      });
    }
    const res = await this.transport({
      path: "/api/submit",
      form: { sr: ri.subreddit, kind: "self", title: ri.title, text: input.text },
    });
    const { id, url } = parseSubmit(res.json);
    return PublishResultSchema.parse({
      ok: true,
      platform: "reddit",
      account: ri.subreddit,
      postUrl: url,
      attachments: [],
      commentIds: [],
      auditRef: fullname("post", id),
    });
  }

  async comment(input: CommentInput): Promise<CommentResult> {
    const ci = input as RedditCommentInput;
    if (!input.text || input.text.trim() === "") {
      throw new AdapterError(ErrorCode.MISSING_INPUT, "comment: 'text' is required");
    }
    if (!ci.parentId) {
      throw new AdapterError(ErrorCode.MISSING_INPUT, "comment: 'parentId' is required");
    }
    // A reply to a comment uses t1_<id>; a top-level comment uses t3_<id>.
    const parent = fullname(ci.parentKind, ci.parentId);
    if (ci.parentKind === "comment" && !isCommentFullname(parent)) {
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        "comment: comment parent must be a t1_ fullname",
      );
    }
    if (ci.parentKind === "post" && !isPostFullname(parent)) {
      throw new AdapterError(ErrorCode.INVALID_ARGS, "comment: post parent must be a t3_ fullname");
    }
    const res = await this.transport({
      path: "/api/comment",
      form: { parent, text: input.text },
    });
    const commentId = parseComment(res.json);
    return CommentResultSchema.parse({
      ok: true,
      platform: "reddit",
      account: "self",
      commentId,
      parentPostUrl: input.parentPostUrl,
    });
  }

  /** Reddit supports editing self-text via /api/editusertext (post or comment). */
  async edit(input: EditInput): Promise<EditResult> {
    if (!input.text) {
      throw new AdapterError(ErrorCode.MISSING_INPUT, "edit: 'text' is required for reddit");
    }
    await this.transport({
      path: "/api/editusertext",
      form: { thing_id: input.postUrl, text: input.text },
    });
    return EditResultSchema.parse({
      ok: true,
      platform: "reddit",
      account: "self",
      postUrl: toThingUrl(input.postUrl),
      edited: true,
    });
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    if (!input.expectedContent || input.expectedContent.trim() === "") {
      throw new AdapterError(
        ErrorCode.MISSING_INPUT,
        "delete: 'expectedContent' is required (read-before-delete oracle)",
      );
    }
    // Read-before-delete: fetch the thing, confirm it contains expectedContent.
    const info = await this.transport({
      path: "/api/info",
      form: { id: thingIdFromUrl(input.targetUrl) },
    });
    const body = extractThingBody(info.json);
    if (!body.includes(input.expectedContent)) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "delete: fetched content does not match expectedContent — aborting without deletion",
        { targetUrl: input.targetUrl, kind: input.kind, redditErrorType: "verify_mismatch" },
      );
    }
    await this.transport({ path: "/api/del", form: { id: thingIdFromUrl(input.targetUrl) } });
    return DeleteResultSchema.parse({
      ok: true,
      platform: "reddit",
      account: "self",
      deleted: true,
      targetUrl: input.targetUrl,
    });
  }
}

// --- response parsing -------------------------------------------------------

function parseSubmit(json: unknown): { id: string; url: string } {
  const data = (json as { json?: { data?: { id?: string; url?: string } } })?.json?.data;
  if (!data?.id || !data?.url) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "publish: reddit /api/submit returned no id/url",
      {
        json,
      },
    );
  }
  return { id: data.id, url: data.url };
}

function parseComment(json: unknown): string {
  const things = (json as { json?: { data?: { things?: Array<{ data?: { id?: string } }> } } })
    ?.json?.data?.things;
  const id = things?.[0]?.data?.id;
  if (!id) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "comment: reddit /api/comment returned no thing id",
      { json },
    );
  }
  return id;
}

function extractThingBody(json: unknown): string {
  const children = (
    json as { data?: { children?: Array<{ data?: { body?: string; selftext?: string } }> } }
  )?.data?.children;
  const d = children?.[0]?.data;
  return d?.body ?? d?.selftext ?? "";
}

function thingIdFromUrl(url: string): string {
  // Accept a raw fullname (t1_/t3_) or a permalink ending in the id.
  if (/^t[0-9]_/.test(url)) return url;
  const m = /comments\/([a-z0-9]+)/i.exec(url);
  return m?.[1] ? fullname("post", m[1]) : url;
}

function toThingUrl(thingId: string): string {
  return `https://www.reddit.com/${thingId}`;
}

export {
  fullname,
  commentParent,
  isCommentFullname,
  isPostFullname,
  type ThingKind,
} from "./fullname.js";
export type { RedditTransport, RedditRequest, RedditResponse } from "./client.js";
