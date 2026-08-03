// PUB-0040: LinkedIn can elide the middle of long URL-like tokens in rendered
// comment text. A rendered body is therefore not always byte-equal to the
// operator's submitted body.
//
// This is deliberately the same bounded oracle as the PUB-0039 Facebook
// implementation. It is not general subsequence matching: every skipped span
// must remain inside one token, so a whole line or word cannot disappear while
// the oracle is still accepted.

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
    // An elided rendering never drops leading text.
    if (index === 0 && at !== 0) return false;
    // A skipped span may only be the elided middle of one unbroken token.
    if (index > 0 && /\s/.test(expected.slice(cursor, at))) return false;
    cursor = at + fragment.length;
  }
  // Tail elision is allowed only inside the final token.
  if (cursor === expected.length) return true;
  return ELLIPSIS.test(candidate.slice(-3)) && !/\s/.test(expected.slice(cursor));
}

/** The exact implementation source injected into LinkedIn's page context. */
export const matchesElidedTextSource = matchesElidedText.toString();
