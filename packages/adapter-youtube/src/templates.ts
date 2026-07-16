// Bilingual metadata validation: byte-aware YouTube limits and the fail-closed
// no-language-mixing rule for the EN/RU channel (plan C14, D-REQ-09).
//
// Official limits (INSIGHTS-PUB-0035, verified 2026-07-16): title ≤100 chars
// excluding < and >; description ≤5000 BYTES (UTF-8, not characters); tags
// ≤500 chars total including separators.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export const TITLE_MAX_CHARS = 100;
export const DESCRIPTION_MAX_BYTES = 5_000;
export const TAGS_MAX_CHARS = 500;

const encoder = new TextEncoder();
const CYRILLIC_RE = /[Ѐ-ӿ]/;
const RU_PATH_RE = /\/ru(\/|$)/;

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

export function validateTitle(title: string): void {
  const chars = [...title].length;
  if (chars === 0 || chars > TITLE_MAX_CHARS) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `title must be 1..${TITLE_MAX_CHARS} characters (got ${chars})`,
      { chars },
    );
  }
  if (/[<>]/.test(title)) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "title may not contain '<' or '>'", {});
  }
}

export function validateDescriptionBytes(description: string): void {
  const bytes = utf8ByteLength(description);
  if (bytes > DESCRIPTION_MAX_BYTES) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `description exceeds ${DESCRIPTION_MAX_BYTES} bytes (got ${bytes}); the limit is bytes, not characters`,
      { bytes },
    );
  }
  if (/[<>]/.test(description)) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "description may not contain '<' or '>'", {});
  }
}

/** Joined-representation length per the official rule: commas between items, quotes around spaced tags. */
export function validateTags(tags: string[]): void {
  const joined = tags.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(",");
  if (joined.length > TAGS_MAX_CHARS) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `tags exceed ${TAGS_MAX_CHARS} characters total (got ${joined.length})`,
      { length: joined.length },
    );
  }
}

/**
 * Fail-closed language-mixing guard:
 * - EN content must contain no Cyrillic and must not link into /ru/ paths.
 * - RU titles must actually be Russian (≥1 Cyrillic char) — a pure-Latin title
 *   routed to the RU playlist is the wrong-language mistake this exists for.
 */
export function validateLanguagePurity(
  language: "en" | "ru",
  title: string,
  description: string,
): void {
  if (language === "en") {
    if (CYRILLIC_RE.test(title) || CYRILLIC_RE.test(description)) {
      throw new AdapterError(
        ErrorCode.LANGUAGE_UNRESOLVED,
        "language mixing: EN content contains Cyrillic",
        { language },
      );
    }
    if (RU_PATH_RE.test(description)) {
      throw new AdapterError(
        ErrorCode.LANGUAGE_UNRESOLVED,
        "language mixing: EN description links into a /ru/ path",
        { language },
      );
    }
    return;
  }
  if (!CYRILLIC_RE.test(title)) {
    throw new AdapterError(
      ErrorCode.LANGUAGE_UNRESOLVED,
      "language mixing: RU title contains no Cyrillic",
      { language },
    );
  }
}
