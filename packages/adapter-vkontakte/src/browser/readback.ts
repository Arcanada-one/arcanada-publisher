// Live read-back oracle for a published VK post (D-REQ-04).
//
// After publish, the adapter re-reads the rendered post and asserts: the author
// is the expected operator account, the full body round-trips (whitespace-
// normalised, so VK's own spacing changes don't cause a false negative), and the
// video is attached. Any mismatch STOPs with VERIFY_FAILED.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface PostReadBack {
  account: string;
  text: string;
  hasVideo: boolean;
  hasImage: boolean;
}

export interface ExpectedPost {
  account: string;
  /** The canonical body the adapter typed (from the pinned article asset). */
  text: string;
  requireMediaKind: "image" | "video";
}

function normalize(text: string): string {
  // VK's renderer typographically rewrites a double hyphen in code snippets
  // (for example `--json`) to an em dash. Treat that presentation rewrite as
  // equivalent while keeping the full normalized body comparison fail-closed
  // for truncation or omitted content.
  return text.replace(/—/g, "--").replace(/\s+/g, " ").trim();
}

/**
 * Assert the rendered post matches expectations. Text is compared on a
 * whitespace-normalised basis: the rendered body MUST contain the full expected
 * body (VK may re-wrap whitespace and rewrite URLs, but must not truncate).
 */
export function assertPostReadBack(actual: PostReadBack, expected: ExpectedPost): void {
  if (actual.account !== expected.account) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `vk read-back: author "${actual.account}" != expected "${expected.account}" — STOP`,
      { observed: actual.account, expected: expected.account },
    );
  }
  if (!normalize(actual.text).includes(normalize(expected.text))) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk read-back: rendered text does not contain the full expected body (truncated?) — STOP",
    );
  }
  if (expected.requireMediaKind === "video" && !actual.hasVideo) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk read-back: video is not attached to the published post — STOP",
    );
  }
  if (expected.requireMediaKind === "image" && !actual.hasImage) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "vk read-back: image is not attached to the published post — STOP",
    );
  }
}
