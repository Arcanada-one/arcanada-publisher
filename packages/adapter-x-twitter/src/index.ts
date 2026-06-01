// XAdapter — the third production adapter in arcanada-publisher (Phase 3).
//
// Verified by dry-run + unit (280 UTF-16 counter, R12 rate-limit detection,
// selectors). A real live tweet is operator-gated and platform-limited: X
// anti-bot rate-limits automated sign-in, and that limit must not be
// circumvented, so the live publish smoke is gated behind X_LIVE_SMOKE=1 and
// does not block the build.

import {
  BaseAdapter,
  AdapterError,
  ErrorCode,
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
import { comment as commentImpl, type CommentOptions } from "./comment.js";
import { del as deleteImpl, type DeleteOptions } from "./delete.js";

export interface XAdapterOptions {
  loginContext?: LoginContext;
  publishOptions?: PublishOptions;
  commentOptions?: CommentOptions;
  deleteOptions?: DeleteOptions;
}

export class XAdapter extends BaseAdapter {
  readonly platform = "x" as const;
  private readonly opts: XAdapterOptions;

  constructor(options: XAdapterOptions = {}) {
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

  /** X does not support editing a published tweet — callers must delete+repost. */
  async edit(_input: EditInput): Promise<EditResult> {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "x: editing a published tweet is not supported — delete and repost instead",
    );
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    return deleteImpl(input, this.opts.deleteOptions);
  }
}

export { utf16Length, withinTweetLimit, X_MAX_UTF16_UNITS } from "./counter.js";
export { selectors, isRateLimited, RATE_LIMIT_INDICATOR } from "./selectors.js";
export { collectImagePath } from "./publish.js";
export type { PublishStepRecorder } from "./publish.js";
