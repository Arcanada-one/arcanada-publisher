// VKontakteAdapter — HTTP-API adapter (Phase 5). VK posts via the API:
// wall.post (wall post), wall.createComment (comment / reply via
// reply_to_comment), wall.delete / wall.deleteComment. The transport is
// injectable so the request trace — notably the reply_to_comment param — is
// verifiable against a recorded fixture without live posting.

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
import {
  resolveTransport,
  assertNoVkError,
  type VkClientOptions,
  type VkTransport,
} from "./client.js";

export interface VkPublishInput extends PublishInput {
  /** Owner id of the wall (negative for a community/group). */
  ownerId: number;
  /** Comma-separated attachment ids (e.g. "photo123_456"); optional. */
  attachments?: string;
}

export interface VkCommentInput extends CommentInput {
  /** Owner id of the wall the post lives on. */
  ownerId: number;
  /** The post id to comment on. */
  postId: number;
  /** R-reply: when set, the comment is a reply TO this comment id. */
  replyToComment?: number;
}

export type VkAdapterOptions = VkClientOptions;

export class VKontakteAdapter extends BaseAdapter {
  readonly platform = "vkontakte" as const;
  private readonly transport: VkTransport;

  constructor(options: VkAdapterOptions = {}) {
    super();
    this.transport = resolveTransport(options);
  }

  /** VK auth is token-based; there is no headed login. */
  async login(_options: LoginOptions): Promise<void> {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "vk: login is token-based — supply an access token to the adapter options",
    );
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const vi = input as VkPublishInput;
    if (!input.text || input.text.trim() === "") {
      throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: 'text' is required");
    }
    if (vi.ownerId === undefined || vi.ownerId === null) {
      throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: 'ownerId' is required");
    }
    if (input.dryRun) {
      return PublishResultSchema.parse({
        ok: true,
        platform: "vkontakte",
        account: String(vi.ownerId),
        postUrl: `https://vk.com/wall${vi.ownerId}_0`,
        attachments: [],
        commentIds: [],
      });
    }
    const params: Record<string, string> = { owner_id: String(vi.ownerId), message: input.text };
    if (vi.attachments) {
      params["attachments"] = vi.attachments;
    }
    const res = await this.transport({ method: "wall.post", params });
    assertNoVkError(res.json, "publish");
    const postId = parsePostId(res.json);
    return PublishResultSchema.parse({
      ok: true,
      platform: "vkontakte",
      account: String(vi.ownerId),
      postUrl: `https://vk.com/wall${vi.ownerId}_${postId}`,
      attachments: [],
      commentIds: [],
    });
  }

  async comment(input: CommentInput): Promise<CommentResult> {
    const vi = input as VkCommentInput;
    if (!input.text || input.text.trim() === "") {
      throw new AdapterError(ErrorCode.MISSING_INPUT, "comment: 'text' is required");
    }
    if (vi.ownerId === undefined || vi.postId === undefined) {
      throw new AdapterError(
        ErrorCode.MISSING_INPUT,
        "comment: 'ownerId' and 'postId' are required",
      );
    }
    const params: Record<string, string> = {
      owner_id: String(vi.ownerId),
      post_id: String(vi.postId),
      message: input.text,
    };
    // V-AC-13: a reply to a specific comment carries reply_to_comment=<id>.
    if (vi.replyToComment !== undefined) {
      params["reply_to_comment"] = String(vi.replyToComment);
    }
    const res = await this.transport({ method: "wall.createComment", params });
    assertNoVkError(res.json, "comment");
    const commentId = parseCommentId(res.json);
    return CommentResultSchema.parse({
      ok: true,
      platform: "vkontakte",
      account: String(vi.ownerId),
      commentId: String(commentId),
      parentPostUrl: input.parentPostUrl,
    });
  }

  /** VK supports editing a wall post via wall.edit. */
  async edit(input: EditInput): Promise<EditResult> {
    if (!input.text) {
      throw new AdapterError(ErrorCode.MISSING_INPUT, "edit: 'text' is required for vk");
    }
    const { ownerId, postId } = parseWallUrl(input.postUrl);
    const res = await this.transport({
      method: "wall.edit",
      params: { owner_id: String(ownerId), post_id: String(postId), message: input.text },
    });
    assertNoVkError(res.json, "edit");
    return EditResultSchema.parse({
      ok: true,
      platform: "vkontakte",
      account: String(ownerId),
      postUrl: input.postUrl,
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
    const { ownerId, postId } = parseWallUrl(input.targetUrl);
    // Read-before-delete: wall.getById → confirm the post text matches.
    const info = await this.transport({
      method: "wall.getById",
      params: { posts: `${ownerId}_${postId}` },
    });
    assertNoVkError(info.json, "delete");
    const body = parsePostText(info.json);
    if (!body.includes(input.expectedContent)) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "delete: fetched content does not match expectedContent — aborting without deletion",
        { targetUrl: input.targetUrl, kind: input.kind, vkErrorType: "verify_mismatch" },
      );
    }
    const method = input.kind === "comment" ? "wall.deleteComment" : "wall.delete";
    const params =
      input.kind === "comment"
        ? { owner_id: String(ownerId), comment_id: String(postId) }
        : { owner_id: String(ownerId), post_id: String(postId) };
    const res = await this.transport({ method, params });
    assertNoVkError(res.json, "delete");
    return DeleteResultSchema.parse({
      ok: true,
      platform: "vkontakte",
      account: String(ownerId),
      deleted: true,
      targetUrl: input.targetUrl,
    });
  }
}

// --- response / url parsing -------------------------------------------------

function parsePostId(json: unknown): number {
  const id = (json as { response?: { post_id?: number } })?.response?.post_id;
  if (id === undefined) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "publish: vk wall.post returned no post_id", {
      json,
    });
  }
  return id;
}

function parseCommentId(json: unknown): number {
  const id = (json as { response?: { comment_id?: number } })?.response?.comment_id;
  if (id === undefined) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "comment: vk wall.createComment returned no comment_id",
      {
        json,
      },
    );
  }
  return id;
}

function parsePostText(json: unknown): string {
  const items = (json as { response?: { items?: Array<{ text?: string }> } })?.response?.items;
  return items?.[0]?.text ?? "";
}

function parseWallUrl(url: string): { ownerId: number; postId: number } {
  // Accept https://vk.com/wall<owner>_<id> or a raw "<owner>_<id>".
  const m = /wall(-?\d+)_(\d+)/.exec(url) ?? /^(-?\d+)_(\d+)$/.exec(url);
  if (!m) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, `vk: cannot parse owner/post id from '${url}'`);
  }
  return { ownerId: Number(m[1]), postId: Number(m[2]) };
}

export type { VkTransport, VkRequest, VkResponse } from "./client.js";
