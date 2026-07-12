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
import {
  publish as publishImpl,
  type PublishOptions,
  type AbortedPublishResult,
} from "./publish.js";
import {
  comment as commentImpl,
  editComment as editCommentImpl,
  type CommentOptions,
  type EditCommentInput,
  type EditCommentOptions,
} from "./comment.js";
import { edit as editImpl, type EditOptions, type LinkedInEditInput } from "./edit.js";
import { del as deleteImpl, type DeleteOptions } from "./delete.js";
import {
  inspectComposer as inspectComposerImpl,
  type ComposerDiagnostics,
  type ComposerInspectOptions,
} from "./composer-inspect.js";

export interface LinkedInAdapterOptions {
  loginContext?: LoginContext;
  publishOptions?: PublishOptions;
  commentOptions?: CommentOptions;
  editCommentOptions?: EditCommentOptions;
  editOptions?: EditOptions;
  deleteOptions?: DeleteOptions;
  composerInspectOptions?: ComposerInspectOptions;
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
    const result = await publishImpl(input, this.opts.publishOptions);
    // The Adapter contract returns a real PublishResult. The abort dry-run is a
    // LinkedIn-specific verification surface exposed via `publishDryRunNoPost`,
    // NOT this contract method — so a normal publish() never yields an abort.
    if ((result as AbortedPublishResult).aborted) {
      throw new Error(
        "publish(): unexpected aborted result — use publishDryRunNoPost() for the no-post dry-run",
      );
    }
    return result as PublishResult;
  }

  /**
   * No-publish live verification (PUB-0031/PUB-0032): run the full composer flow
   * against the real LinkedIn UI and ABORT before clicking «Post». NOTHING is
   * published. Returns whether media attached (the scoped <video> preview for a
   * video). LinkedIn-specific — not part of the generic Adapter contract.
   */
  async publishDryRunNoPost(input: PublishInput): Promise<AbortedPublishResult> {
    const result = await publishImpl(input, {
      ...this.opts.publishOptions,
      abortBeforePost: true,
    });
    if (!(result as AbortedPublishResult).aborted) {
      throw new Error("publishDryRunNoPost(): flow did not abort before posting");
    }
    return result as AbortedPublishResult;
  }

  async inspectComposer(profile = "default"): Promise<ComposerDiagnostics> {
    return inspectComposerImpl(profile, this.opts.composerInspectOptions);
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
export { isVideoPath, isAbortedPublish } from "./publish.js";
export type { AbortedPublishResult } from "./publish.js";
