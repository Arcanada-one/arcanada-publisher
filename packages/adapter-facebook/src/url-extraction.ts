// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21
// Source: bin/fb-publish.sh:165-175 (extract_post_url) — INFRA-0190 site.
//
// Pure URL-extraction helpers. The native Playwright `page.$eval(...)` returns
// a JS string directly to TypeScript — no shell-quoting wrapper layer — so the
// INFRA-0190 literal-quote-wrap defect structurally cannot recur. This helper
// additionally strips any incidental wrapping quotes (defence-in-depth) and
// validates the host before returning, to match AC-3 contract regex.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

const POST_URL_HOST = "www.facebook.com";

/**
 * Normalise a candidate href into a clean FB post URL.
 *
 * - Trims whitespace.
 * - Strips a single matching pair of literal wrapping double-quotes (defence
 *   against legacy `pw eval --raw` output shape — INFRA-0190).
 * - Asserts the URL parses and the host is `www.facebook.com`.
 *
 * Throws `AdapterError(VERIFY_FAILED, 6)` on failure.
 */
export function extractPostUrlFromHref(rawHref: string): string {
  if (rawHref === null || rawHref === undefined || rawHref === "") {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "extractPostUrlFromHref: empty href", {
      rawHref,
    });
  }
  let candidate = rawHref.trim();
  if (candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1);
  }
  if (candidate.includes('"')) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "extractPostUrlFromHref: residual literal quotes after strip",
      { rawHref, candidate },
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "extractPostUrlFromHref: not a parseable URL", {
      rawHref,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (parsed.hostname !== POST_URL_HOST) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `extractPostUrlFromHref: host '${parsed.hostname}' is not '${POST_URL_HOST}'`,
      { rawHref, hostname: parsed.hostname },
    );
  }
  return candidate;
}

/** Derive an account slug from a post URL (`https://www.facebook.com/<slug>/posts/<id>`). */
export function extractAccountFromUrl(postUrl: string): string {
  const parsed = new URL(postUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] === "permalink.php") {
    const story = parsed.searchParams.get("id");
    if (story) return story;
  }
  return segments[0] ?? "unknown";
}
