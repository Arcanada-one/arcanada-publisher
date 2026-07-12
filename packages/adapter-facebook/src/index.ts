// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21
// Source: bin/fb-publish.sh + bin/fb-edit-post.sh + bin/fb-edit-comment.sh.
//
// FacebookAdapter — first production-ready Adapter in arcanada-publisher.
// Composes pure modules (selectors / errors / context / url-extraction) with
// IO modules (login / publish / comment / edit). `verify()` inherited from
// `BaseAdapter` (fetch HEAD).

import {
  BaseAdapter,
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

import { login as loginImpl, type LoginContext } from "./login.js";
import { publish as publishImpl, type PublishOptions } from "./publish.js";
import {
  comment as commentImpl,
  replaceCommentText as replaceCommentTextImpl,
  type CommentOptions,
  type ReplaceCommentInput,
  type ReplaceCommentOptions,
} from "./comment.js";
import { edit as editImpl, type EditOptions, type FacebookEditInput } from "./edit.js";
import { del as deleteImpl, type DeleteOptions } from "./delete.js";
import {
  inspectFacebookProfilePost as inspectFacebookProfilePostImpl,
  type InspectFacebookProfileOptions,
  type InspectFacebookProfilePostInput,
  type InspectFacebookProfilePostResult,
} from "./inspect-profile.js";

export interface FacebookAdapterOptions {
  loginContext?: LoginContext;
  publishOptions?: PublishOptions;
  commentOptions?: CommentOptions;
  replaceCommentOptions?: ReplaceCommentOptions;
  editOptions?: EditOptions;
  deleteOptions?: DeleteOptions;
  inspectProfileOptions?: InspectFacebookProfileOptions;
}

export class FacebookAdapter extends BaseAdapter {
  readonly platform = "facebook" as const;
  private readonly opts: FacebookAdapterOptions;

  constructor(options: FacebookAdapterOptions = {}) {
    super();
    this.opts = options;
  }

  async login(options: LoginOptions): Promise<void> {
    return loginImpl(options, this.opts.loginContext);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    return publishImpl(input, this.opts.publishOptions);
  }

  async comment(input: CommentInput): Promise<CommentResult> {
    return commentImpl(input, this.opts.commentOptions);
  }

  /**
   * R10: change a comment's text by deleting the old comment and adding a new
   * one (in-place edit breaks the contenteditable field). Not part of the core
   * `Adapter` contract — a Facebook-specific safe-replace surface.
   */
  async replaceComment(input: ReplaceCommentInput): Promise<CommentResult> {
    return replaceCommentTextImpl(input, this.opts.replaceCommentOptions);
  }

  /** Read-only bounded profile scan; not part of the mutation Adapter contract. */
  async inspectProfilePost(
    input: InspectFacebookProfilePostInput,
  ): Promise<InspectFacebookProfilePostResult> {
    return inspectFacebookProfilePostImpl(input, this.opts.inspectProfileOptions);
  }

  async edit(input: EditInput | FacebookEditInput): Promise<EditResult> {
    return editImpl(input as FacebookEditInput, this.opts.editOptions);
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    return deleteImpl(input, this.opts.deleteOptions);
  }
}

export { extractPostUrlFromHref, extractAccountFromUrl } from "./url-extraction.js";
export { selectors, matchesExact, isCaptchaBlob } from "./selectors.js";
export { classifyFbError, mapFbError } from "./errors.js";
export type { FbErrorType } from "./errors.js";
export type { FacebookEditInput } from "./edit.js";
export type { ReplaceCommentInput } from "./comment.js";
export { inspectFacebookProfilePost } from "./inspect-profile.js";
export type {
  InspectFacebookProfilePostInput,
  InspectFacebookProfilePostResult,
  InspectFacebookCommentSummary,
} from "./inspect-profile.js";
