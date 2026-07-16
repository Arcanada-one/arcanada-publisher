// Read-before-post duplicate guard for the VK browser mode (D-REQ-05).
//
// Before publishing, the adapter reads the last N (=20) posts off the operator's
// own wall and compares a normalized 200-code-point fragment of the candidate
// body — plus the video-presence flag — against each. A match STOPs with
// `ErrorCode.DUPLICATE` and cites the existing permalink; the caller reconciles
// by reading, never by retrying. VK's own "too many similar actions" (error 9)
// is treated the same way — a reconcile-by-read signal, not a retry trigger.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

/** Number of recent wall posts to scan for a duplicate. */
export const DUP_SCAN_WINDOW = 20;

/** Length of the normalized comparison fragment, in code points. */
export const FRAGMENT_LEN = 200;

export interface WallPostSummary {
  text: string;
  hasVideo: boolean;
  permalink: string;
}

/** Lowercase, collapse all whitespace runs to one space, cap at FRAGMENT_LEN. */
export function normalizeFragment(text: string, n: number = FRAGMENT_LEN): string {
  const collapsed = text.replace(/\s+/g, " ").trim().toLowerCase();
  return Array.from(collapsed).slice(0, n).join("");
}

/**
 * Throw `ErrorCode.DUPLICATE` if any recent post shares the candidate's
 * normalized fragment AND the same video-presence. Otherwise return silently.
 */
export function assertNotDuplicate(
  candidate: { text: string; hasVideo: boolean },
  recent: WallPostSummary[],
): void {
  const key = normalizeFragment(candidate.text);
  for (const post of recent) {
    if (post.hasVideo === candidate.hasVideo && normalizeFragment(post.text) === key) {
      throw new AdapterError(
        ErrorCode.DUPLICATE,
        "vk: an existing wall post matches this content — STOP (reconcile by read, do not retry)",
        { existingPermalink: post.permalink },
      );
    }
  }
}

/** True when a VK API error body is code 9 ("too many similar actions"). */
export function isSameTypedActionError(json: unknown): boolean {
  const code = (json as { error?: { error_code?: number } })?.error?.error_code;
  return code === 9;
}
