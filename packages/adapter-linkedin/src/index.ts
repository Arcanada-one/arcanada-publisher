// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21
// Source: bin/li-publish.sh + bin/li-edit-post.sh + bin/li-comment.sh + bin/li-edit-comment.sh.
//
// LinkedInAdapter — second production-ready Adapter in arcanada-publisher.
// Composes pure modules (selectors / errors / url-extraction) with IO modules
// (login / publish / comment / edit). `verify()` inherited from `BaseAdapter`.
//
// INFRA-0259 / INFRA-0260 / INFRA-0261 closed structurally (see publish.ts,
// url-extraction.ts, and edit.ts headers respectively).

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
  editComment as editCommentImpl,
  type CommentOptions,
  type EditCommentInput,
  type EditCommentOptions,
} from "./comment.js";
import { edit as editImpl, type EditOptions, type LinkedInEditInput } from "./edit.js";
import { del as deleteImpl, type DeleteOptions } from "./delete.js";

export interface LinkedInAdapterOptions {
  loginContext?: LoginContext;
  publishOptions?: PublishOptions;
  commentOptions?: CommentOptions;
  editCommentOptions?: EditCommentOptions;
  editOptions?: EditOptions;
  deleteOptions?: DeleteOptions;
}

export class LinkedInAdapter extends BaseAdapter {
  readonly platform = "linkedin" as const;
  private readonly opts: LinkedInAdapterOptions;

  constructor(options: LinkedInAdapterOptions = {}) {
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
   * R10: edit an existing comment's text in place (menu → Edit → Save changes).
   * LinkedIn supports this; Facebook does not (it uses delete+add). Not part of
   * the core `Adapter` contract — a LinkedIn-specific surface.
   */
  async editComment(input: EditCommentInput): Promise<CommentResult> {
    return editCommentImpl(input, this.opts.editCommentOptions);
  }

  async edit(input: EditInput | LinkedInEditInput): Promise<EditResult> {
    return editImpl(input as LinkedInEditInput, this.opts.editOptions);
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    return deleteImpl(input, this.opts.deleteOptions);
  }
}

export {
  extractActivityUrn,
  extractActivityId,
  pickFirstActivityHref,
  ACTIVITY_URN_RE,
} from "./url-extraction.js";
export { selectors, matchesExact, isCaptchaBlob } from "./selectors.js";
export { classifyLiError, mapLiError } from "./errors.js";
export type { LiErrorType } from "./errors.js";
export type { LinkedInEditInput } from "./edit.js";
export type { EditCommentInput } from "./comment.js";
