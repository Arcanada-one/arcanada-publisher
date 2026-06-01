// X (Twitter) counts a tweet's length in UTF-16 code units, not JavaScript
// string length and not Unicode code points. A character outside the BMP
// (codePoint > 0xFFFF — most emoji) is a surrogate pair and counts as 2.
// The post limit is 280 of these units.
//
// NOTE: X also applies "weighted" counting (URLs = 23, CJK = 2) in its live
// composer; we intentionally use the simpler UTF-16 unit count as the
// pre-flight guard — it is the conservative oracle the dry-run and CLI gate on.

export const X_MAX_UTF16_UNITS = 280;

/** Count a string's length in UTF-16 code units (astral chars = 2). */
export function utf16Length(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += (ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
  }
  return units;
}

/** True when the text fits within X's 280 UTF-16-unit limit. */
export function withinTweetLimit(text: string): boolean {
  return utf16Length(text) <= X_MAX_UTF16_UNITS;
}
