// X (Twitter) counts a tweet's length in UTF-16 code units, not JavaScript
// string length and not Unicode code points. A character outside the BMP
// (codePoint > 0xFFFF — most emoji) is a surrogate pair and counts as 2.
// The post limit is 280 of these units.
//
// NOTE: X also applies "weighted" counting (URLs = 23, CJK = 2) in its live
// composer; we intentionally use the simpler UTF-16 unit count as the
// pre-flight guard — it is the conservative oracle the dry-run and CLI gate on.

export const X_MAX_UTF16_UNITS = 280;

// PUB-0033: X Premium (formerly Twitter Blue) raises the composer limit to
// 25 000 characters for long-form posts. This is opt-in per call (premium=true)
// — the free-tier 280 unit guard remains the default so a non-Premium account
// can never silently exceed its real limit.
export const X_MAX_UTF16_UNITS_PREMIUM = 25_000;

/** Resolve the active UTF-16 unit ceiling for a post (free vs Premium). */
export function tweetLimit(premium = false): number {
  return premium ? X_MAX_UTF16_UNITS_PREMIUM : X_MAX_UTF16_UNITS;
}

/** Count a string's length in UTF-16 code units (astral chars = 2). */
export function utf16Length(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += (ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
  }
  return units;
}

/**
 * True when the text fits within X's UTF-16-unit limit. Defaults to the
 * free-tier 280 ceiling; pass `premium=true` to gate on the 25 000 Premium
 * long-form ceiling instead.
 */
export function withinTweetLimit(text: string, premium = false): boolean {
  return utf16Length(text) <= tweetLimit(premium);
}
