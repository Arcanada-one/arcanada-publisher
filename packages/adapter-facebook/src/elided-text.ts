// PUB-0039: Facebook elides long URLs when rendering text —
//   https://chromewebstore.google.com/detail/conversation-to-markdown/jhn…ili
// renders as
//   https://chromewebstore.google.com/.../jhnhkmnignbhmcjbhoi...
//
// So `rendered === expected` can NEVER hold for a comment containing long links.
// That exact-equality assumption is what made comment verification report false
// negatives, and blind retries on those false negatives produced duplicate
// comments (LinkedIn and Facebook, 2026-08-01/02).
//
// The matcher must NOT degrade into subsequence matching: Facebook only elides
// the middle of a single unbroken token, never whole words or lines. Each skipped
// span is therefore required to sit INSIDE one token (no whitespace). Without
// that constraint a 3-link body is a subsequence of any richer body carrying the
// same links in the same order, and the oracle binds to the WRONG comment —
// verified live on 2026-08-02, where a 3-link oracle matched both the duplicate
// and the keeper.
//
// This module is the single source of truth. `matchesElidedTextSource` exposes
// the function's source so the identical rule can run inside `page.evaluate`
// without a second, drift-prone copy.

export function matchesElidedText(rendered: string, expected: string): boolean {
  const candidate = rendered.replace(/\r\n/g, "\n");
  if (candidate === expected) return true;

  const ELLIPSIS = /\.\.\.|…/;
  if (!ELLIPSIS.test(candidate)) return false;

  const fragments = candidate.split(/(?:\.\.\.|…)+/).filter((part) => part !== "");
  if (fragments.length === 0) return false;
  // A rendering that is nothing but ellipsis carries no evidence at all.
  if (fragments.every((fragment) => fragment.trim() === "")) return false;

  let cursor = 0;
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index]!;
    const at = expected.indexOf(fragment, cursor);
    if (at === -1) return false;
    // The first visible fragment must start the body: an elided rendering never
    // drops leading text, so a later match would mean a different comment.
    if (index === 0 && at !== 0) return false;
    // Everything skipped between two visible fragments must belong to a single
    // token — the elided middle of one URL. Whitespace in the gap means real
    // content was dropped, i.e. this is a different comment.
    if (index > 0 && /\s/.test(expected.slice(cursor, at))) return false;
    cursor = at + fragment.length;
  }
  // Trailing elision is allowed (FB truncates the tail), but only within the
  // final token: the remainder must not contain whitespace either.
  if (cursor === expected.length) return true;
  return ELLIPSIS.test(candidate.slice(-3)) && !/\s/.test(expected.slice(cursor));
}

/**
 * Source text of `matchesElidedText`, for injection into `page.evaluate` bodies.
 * Keeping ONE implementation and shipping its source avoids the classic
 * copy-drift bug where the in-page copy and the Node copy disagree.
 */
export const matchesElidedTextSource = matchesElidedText.toString();
