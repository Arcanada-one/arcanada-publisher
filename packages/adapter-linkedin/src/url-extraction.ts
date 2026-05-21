// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21 (PUB-0004)
// Source: bin/li-publish.sh:290-313 (extract_post_url) — INFRA-0260 site.
//
// Pure URL-extraction helpers for LinkedIn activity URNs.
//
// INFRA-0260 fix: the legacy bash `extract_post_url` accepted any
// `a[href*="/feed/update/urn:li:activity:"]` OR `a[href*="/posts/"]`. The
// `/posts/` arm matches recommended-company cards (e.g.
// `https://www.linkedin.com/company/lazy-programmer/posts/`) → wrong URL
// returned. This module tightens the contract:
//   - Strict regex matching `urn:li:activity:<digits>` only.
//   - `extractActivityUrn(href)` is pure (string-in, string-out) → unit-testable
//     without a `Page`. `publish.ts` walks the DOM, filters by `offsetParent`
//     visibility, and calls this normaliser on each candidate href.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

const LINKEDIN_HOSTNAMES = new Set(["www.linkedin.com", "linkedin.com"]);
export const ACTIVITY_URN_RE =
  /^https:\/\/(?:www\.)?linkedin\.com\/feed\/update\/urn:li:activity:(\d+)\/?(?:\?.*)?$/;

/**
 * Normalise a candidate href into a clean LinkedIn activity URL.
 *
 * - Trims whitespace.
 * - Strips a single matching pair of wrapping double-quotes (defence-in-depth
 *   against any legacy shell-quote artefact).
 * - Asserts the URL parses, hostname is `www.linkedin.com`, and the path
 *   matches `^/feed/update/urn:li:activity:<digits>/?$` — recommended-card
 *   `/company/.../posts/` candidates are rejected by construction (INFRA-0260).
 *
 * Throws `AdapterError(VERIFY_FAILED)` on failure.
 */
export function extractActivityUrn(rawHref: string): string {
  if (rawHref === null || rawHref === undefined || rawHref === "") {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "extractActivityUrn: empty href", { rawHref });
  }
  let candidate = rawHref.trim();
  if (candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1);
  }
  if (candidate.includes('"')) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "extractActivityUrn: residual literal quotes after strip",
      { rawHref, candidate },
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "extractActivityUrn: not a parseable URL", {
      rawHref,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (!LINKEDIN_HOSTNAMES.has(parsed.hostname)) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `extractActivityUrn: host '${parsed.hostname}' is not a LinkedIn host`,
      { rawHref, hostname: parsed.hostname, allowed: Array.from(LINKEDIN_HOSTNAMES) },
    );
  }
  if (!ACTIVITY_URN_RE.test(candidate)) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "extractActivityUrn: URL does not match strict activity URN pattern (INFRA-0260)",
      { rawHref, candidate, pattern: ACTIVITY_URN_RE.source },
    );
  }
  return candidate;
}

/** Extract the numeric activity id from a normalised activity URL. */
export function extractActivityId(activityUrl: string): string {
  const m = ACTIVITY_URN_RE.exec(activityUrl);
  if (!m || !m[1]) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "extractActivityId: not an activity URL", {
      activityUrl,
    });
  }
  return m[1];
}

/**
 * Pick the first href from `candidates` that normalises through
 * `extractActivityUrn`. Filters silently — returns `undefined` when no
 * candidate matches (caller decides whether to throw).
 */
export function pickFirstActivityHref(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      return extractActivityUrn(candidate);
    } catch {
      // skip non-activity hrefs (company/.../posts, recommended cards, etc.)
    }
  }
  return undefined;
}
