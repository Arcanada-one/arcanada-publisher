// Canonical VK wall-permalink extraction from a live-DOM href (D-REQ-04).
//
// Mirrors the adapter-facebook url-extraction contract: strip incidental
// wrapping quotes, assert the host is vk.com/vk.ru, and require the path to be a
// `wall{owner}_{id}` permalink. Anything else STOPs with VERIFY_FAILED.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

/** `wall<owner>_<id>` — owner may be negative (community). */
export const WALL_PATH_RE = /^\/wall(-?\d+)_(\d+)$/;

const VK_HOSTS = new Set(["vk.com", "vk.ru", "m.vk.com"]);

/**
 * Normalise a candidate href into a clean VK wall permalink, or throw
 * `VERIFY_FAILED`. Strips one pair of wrapping double-quotes (defence in depth).
 */
export function extractWallPermalink(rawHref: string): string {
  if (!rawHref) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "vk: empty permalink href", { rawHref });
  }
  let candidate = rawHref.trim();
  if (candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1);
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "vk: permalink is not a parseable URL", {
      rawHref,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (!VK_HOSTS.has(parsed.hostname)) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `vk: permalink host '${parsed.hostname}' is not a vk host`,
      { rawHref, hostname: parsed.hostname },
    );
  }
  if (!WALL_PATH_RE.test(parsed.pathname)) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `vk: '${parsed.pathname}' is not a wall{owner}_{id} permalink`,
      { rawHref },
    );
  }
  return candidate;
}
