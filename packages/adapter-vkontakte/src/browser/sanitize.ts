// Composer input hardening for the VK browser mode.
//
// Two guarantees before any text is typed into the VK web composer:
//  1. Control-character rejection (D-REQ-07): only printable text plus "\n"
//     reaches the composer — stray control sequences could trigger composer
//     hotkeys (e.g. submit) or corrupt the post mid-typing. A tab is folded to
//     a single space; any other C0/C1 control char is a hard error.
//  2. Preflight length cap (PUB-0034): the official VK wall-post limit is not
//     published; secondary sources converge on ~16 000 chars. We stop at a
//     conservative 15 000 CODE POINTS (not UTF-16 units) rather than let VK
//     silently truncate.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

/** Conservative preflight cap (code points). VK's real limit is unconfirmed. */
export const POST_MAX_CHARS = 15_000;

// Disallow C0 controls (0x00-0x1F), DEL (0x7F), and C1 controls (0x80-0x9F),
// except newline (0x0A). Tab (0x09) and CR (0x0D) are normalised before this
// scan runs (tab -> space, CRLF/CR -> newline).
function hasDisallowedControl(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x0a) continue;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return true;
  }
  return false;
}

/**
 * Return `text` with tabs folded to a space and CR/CRLF normalised to "\n", or
 * throw `INVALID_ARGS` if it carries any other C0/C1/DEL control character.
 * Newlines are preserved.
 */
export function sanitizeComposerText(text: string): string {
  const folded = text.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  if (hasDisallowedControl(folded)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "vk: text carries a disallowed control character (only printable + newline allowed)",
    );
  }
  return folded;
}

/** Count Unicode code points (so a surrogate-pair emoji counts as one). */
function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * Sanitize then length-check the post body. Throws `MISSING_INPUT` on empty,
 * `INVALID_ARGS` on a control char or on overflow past {@link POST_MAX_CHARS}.
 * Returns the sanitized text on success (no truncation — overflow STOPs).
 */
export function preflightPostText(text: string): string {
  if (!text || text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "vk: post text is required");
  }
  const clean = sanitizeComposerText(text);
  const len = codePointLength(clean);
  if (len > POST_MAX_CHARS) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `vk: post text is ${len} chars, over the ${POST_MAX_CHARS}-char preflight cap — STOP (shorten or split; VK limit unconfirmed)`,
      { length: len, cap: POST_MAX_CHARS },
    );
  }
  return clean;
}
