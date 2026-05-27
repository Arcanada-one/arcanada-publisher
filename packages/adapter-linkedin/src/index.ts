// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21 (PUB-0004)
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
  type EditInput,
  type EditResult,
  type LoginOptions,
  type PublishInput,
  type PublishResult,
} from "@arcanada/publisher-core";

import { login as loginImpl, type LoginContext } from "./login.js";
import { publish as publishImpl, type PublishOptions } from "./publish.js";
import { comment as commentImpl, type CommentOptions } from "./comment.js";
import { edit as editImpl, type EditOptions, type LinkedInEditInput } from "./edit.js";

export interface LinkedInAdapterOptions {
  loginContext?: LoginContext;
  publishOptions?: PublishOptions;
  commentOptions?: CommentOptions;
  editOptions?: EditOptions;
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

  async edit(input: EditInput | LinkedInEditInput): Promise<EditResult> {
    return editImpl(input as LinkedInEditInput, this.opts.editOptions);
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
