// Top-level VK comment orchestration with 4-link read-back (D-REQ-06).
//
// Contract: exactly one TOP-LEVEL comment (never a reply) from the operator
// account, carrying exactly four links in a fixed order. The composer step and
// the read-back are behind a `VkCommentSteps` seam so misbinding (a reply
// instead of a top-level comment) and link order/count are unit-testable.

import { AdapterError, ErrorCode, CommentResultSchema, type CommentResult } from "@arcanada/publisher-core";
import { assertAuthorized, type ExpectedAccount, type SessionState } from "./session-guard.js";
import { extractWallPermalink } from "./url-extraction.js";

export const REQUIRED_LINK_COUNT = 4;

/**
 * Normalise a rendered comment link for comparison: VK rewrites external links
 * as `https://vk.com/away.php?to=<urlencoded>&...`, so unwrap the `to` param
 * back to the original URL. Non-away links are returned trimmed.
 */
export function unwrapVkAwayLink(href: string): string {
  try {
    const u = new URL(href);
    if ((u.hostname === "vk.com" || u.hostname === "m.vk.com") && u.pathname === "/away.php") {
      const to = u.searchParams.get("to");
      if (to) return to;
    }
  } catch {
    // not a URL — fall through to the raw value
  }
  return href.trim();
}

export interface VkBrowserCommentInput {
  parentPostUrl: string;
  /** Exactly four links, in the required order: Telegram, X, Site, Article. */
  links: string[];
  profile: string;
  expectedAccount: ExpectedAccount;
}

export interface PostedComment {
  commentId: string;
  /** Set only if the composer bound the comment as a REPLY (misbinding). */
  replyToCommentId?: string;
}

export interface CommentReadBack {
  text: string;
  isReply: boolean;
  /** Links as they appear in the rendered comment, in order. */
  links: string[];
}

export interface VkCommentSteps {
  readSession(): Promise<SessionState>;
  /** Post a top-level comment; MUST NOT bind as a reply. */
  postTopLevelComment(text: string): Promise<PostedComment>;
  readBackComment(commentId: string): Promise<CommentReadBack>;
}

function assertLinksEqualInOrder(actual: string[], expected: string[], where: string): void {
  if (actual.length !== expected.length) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `vk comment ${where}: expected ${expected.length} links, got ${actual.length} — STOP`,
      { expected, actual },
    );
  }
  for (let i = 0; i < expected.length; i++) {
    if (unwrapVkAwayLink(actual[i]!) !== expected[i]) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        `vk comment ${where}: link ${i + 1} mismatch — STOP`,
        { position: i, expected: expected[i], actual: actual[i] },
      );
    }
  }
}

/**
 * Run the top-level comment flow: assert host + identity, require exactly four
 * links, post as a top-level comment (never a reply), then read back and verify
 * the comment is top-level and carries all four links in order.
 */
export async function runVkComment(
  input: VkBrowserCommentInput,
  steps: VkCommentSteps,
): Promise<CommentResult> {
  // Host check first (cheap, before any session/DOM work). A malformed parent
  // URL is an INPUT error (INVALID_ARGS), distinct from a read-back VERIFY_FAILED.
  try {
    extractWallPermalink(input.parentPostUrl);
  } catch {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `vk comment: parentPostUrl is not a valid vk wall permalink: ${input.parentPostUrl}`,
      { parentPostUrl: input.parentPostUrl },
    );
  }

  if (input.links.length !== REQUIRED_LINK_COUNT) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `vk comment: exactly ${REQUIRED_LINK_COUNT} links are required, got ${input.links.length}`,
    );
  }

  const session = await steps.readSession();
  assertAuthorized(session, input.expectedAccount);

  const commentText = input.links.join("\n");
  const posted = await steps.postTopLevelComment(commentText);
  if (posted.replyToCommentId !== undefined) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk comment: composer bound the comment as a REPLY, not top-level — STOP",
      { replyToCommentId: posted.replyToCommentId },
    );
  }

  const back = await steps.readBackComment(posted.commentId);
  if (back.isReply) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk comment read-back: comment rendered as a reply, expected top-level — STOP",
    );
  }
  assertLinksEqualInOrder(back.links, input.links, "read-back");

  return CommentResultSchema.parse({
    ok: true,
    platform: "vkontakte",
    account: session.accountId ?? session.accountName ?? "unknown",
    commentId: posted.commentId,
    parentPostUrl: input.parentPostUrl,
  });
}
