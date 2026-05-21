// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21 (PUB-0003)
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
  type EditInput,
  type EditResult,
  type LoginOptions,
  type PublishInput,
  type PublishResult,
} from "@arcanada/publisher-core";

import { login as loginImpl, type LoginContext } from "./login.js";
import { publish as publishImpl, type PublishOptions } from "./publish.js";
import { comment as commentImpl, type CommentOptions } from "./comment.js";
import { edit as editImpl, type EditOptions, type FacebookEditInput } from "./edit.js";

export interface FacebookAdapterOptions {
  loginContext?: LoginContext;
  publishOptions?: PublishOptions;
  commentOptions?: CommentOptions;
  editOptions?: EditOptions;
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

  async edit(input: EditInput | FacebookEditInput): Promise<EditResult> {
    return editImpl(input as FacebookEditInput, this.opts.editOptions);
  }
}

export { extractPostUrlFromHref, extractAccountFromUrl } from "./url-extraction.js";
export { selectors, matchesExact, isCaptchaBlob } from "./selectors.js";
export { classifyFbError, mapFbError } from "./errors.js";
export type { FbErrorType } from "./errors.js";
export type { FacebookEditInput } from "./edit.js";
