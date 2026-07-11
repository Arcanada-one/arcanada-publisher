// Tool scoping: input validation applied at the agent-callable boundary before
// any adapter call. This is the AAL L2 "tool-scoping-input-validation" control —
// it bounds what an agent can ask the publisher to do (text length per platform,
// image MIME, profile name shape) so a malformed or over-broad request fails
// closed with INVALID_ARGS rather than reaching a browser session.

import { AdapterError, ErrorCode } from "./errors.js";
import type { Platform } from "./platform.js";

/**
 * Per-platform text length ceilings, counted in UTF-16 code units (the same
 * oracle the X adapter gates on — an astral character is a surrogate pair and
 * counts as 2). These are conservative pre-flight caps, not the platforms' exact
 * weighted limits.
 */
export const PLATFORM_TEXT_LIMITS: Record<Platform, number> = {
  x: 280,
  facebook: 63_206,
  linkedin: 3_000,
  reddit: 40_000,
  vkontakte: 16_384,
  telegram: 4_096,
};

/** Image MIME types an agent may attach. */
export const IMAGE_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** Profile names must be a single safe token — no paths, spaces, or shell metacharacters. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Count a string's length in UTF-16 code units (astral chars count as 2). */
function utf16Length(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += (ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
  }
  return units;
}

/** Throw INVALID_ARGS if `text` exceeds the platform's UTF-16 length ceiling. */
export function validateText(text: string, platform: Platform): void {
  const limit = PLATFORM_TEXT_LIMITS[platform];
  const length = utf16Length(text);
  if (length > limit) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `text exceeds ${platform} limit of ${limit} UTF-16 units (got ${length})`,
      { platform, limit, length },
    );
  }
}

/** Throw INVALID_ARGS if `mime` is not in the image allowlist. */
export function validateImageMime(mime: string): void {
  if (!IMAGE_MIME_ALLOWLIST.has(mime)) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, `unsupported image MIME type '${mime}'`, {
      mime,
      allowed: Array.from(IMAGE_MIME_ALLOWLIST),
    });
  }
}

/**
 * Throw INVALID_ARGS if `name` is not a safe profile token. An empty string is
 * allowed — it resolves to the "default" profile downstream.
 */
export function validateProfileName(name: string): void {
  if (name === "") {
    return;
  }
  if (!PROFILE_NAME_RE.test(name)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `invalid profile name '${name}' — allowed: ${PROFILE_NAME_RE.source}`,
      { name },
    );
  }
}
