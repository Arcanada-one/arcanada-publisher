// PUB-0031: Facebook renders long URLs elided ("https://host/.../tail..."), so an
// exact string equality oracle can never match a comment containing long links.
// That defect is what made comment verification report false negatives, and blind
// retries on those false negatives produced duplicate comments.
//
// These tests pin BOTH directions: an elided rendering of the real body matches,
// and a DIFFERENT comment that merely links the same URL does not.

import { describe, expect, it } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import { assertExactCommentBinding, type ReplaceCommentInput } from "../src/comment.js";

const PARENT = "https://www.facebook.com/pavelvalentov/posts/pfbid-target";
const COMMENT_ID = "1071734252183844";
const AUTHOR = "https://www.facebook.com/pavelvalentov";

// The real comment body, with full URLs (what we type / hold on disk).
const REAL_BODY = [
  "Плагин в Chrome Web Store: https://chromewebstore.google.com/detail/conversation-to-markdown/jhnhkmnignbhmcjbhoihdbjhjfljpili",
  "Статья: https://arcanada.ai/ru/blog/conversation-to-markdown-long-chats-images",
  "Исходники (MIT): https://github.com/Arcanada-one/conversation-to-markdown",
].join("\n");

// What Facebook actually renders for that body (captured live 2026-08-02).
const RENDERED_ELIDED = [
  "Плагин в Chrome Web Store: https://chromewebstore.google.com/.../jhnhkmnignbhmcjbhoi...",
  "Статья: https://arcanada.ai/.../conversation-to-markdown-long...",
  "Исходники (MIT): https://github.com/Arcanada-one/conversation-to-markdown",
].join("\n");

function input(overrides: Partial<ReplaceCommentInput> = {}): ReplaceCommentInput {
  return {
    parentPostUrl: PARENT,
    commentId: COMMENT_ID,
    expectedAuthorProfileUrl: AUTHOR,
    oldText: REAL_BODY,
    text: "replacement",
    profile: "default",
    ...overrides,
  };
}

function evidence(body: string) {
  return {
    commentHref: `${PARENT}?comment_id=${COMMENT_ID}`,
    commentId: COMMENT_ID,
    renderedBodyCandidates: [body],
    renderedAuthorProfileHrefs: [AUTHOR],
  };
}

describe("elided-body oracle", () => {
  it("accepts Facebook's elided rendering of the exact body", () => {
    expect(() => assertExactCommentBinding(input(), evidence(RENDERED_ELIDED))).not.toThrow();
  });

  it("accepts a verbatim (non-elided) rendering", () => {
    expect(() => assertExactCommentBinding(input(), evidence(REAL_BODY))).not.toThrow();
  });

  it("accepts the unicode ellipsis variant", () => {
    const unicode = RENDERED_ELIDED.replace(/\.\.\./g, "…");
    expect(() => assertExactCommentBinding(input(), evidence(unicode))).not.toThrow();
  });

  it("rejects a DIFFERENT comment that links the same store URL", () => {
    // The duplicate we actually had to distinguish: same links, extra lines,
    // different order. Must NOT be accepted as the target body.
    const otherComment = [
      "Плагин в Chrome Web Store: https://chromewebstore.google.com/.../jhnhkmnignbhmcjbhoi...",
      "Исходники (MIT): https://github.com/Arcanada-one/conversation-to-markdown",
      "Статья (RU): https://arcanada.ai/.../conversation-to-markdown-long...",
      "Telegram (RU): https://t.me/valentovtypes/257",
      "X (EN): https://x.com/VeritasArcanaAI/status/2083622974007972325",
    ].join("\n");
    expect(() => assertExactCommentBinding(input(), evidence(otherComment))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  // Live regression (2026-08-02): the 3-link oracle bound to BOTH the 3-link
  // duplicate and the 5-link keeper, because the duplicate's lines are a
  // subsequence of the keeper's. Deleting on that binding would have removed the
  // wrong comment. The keeper's real rendered body, verbatim from the page:
  it("rejects the KEEPER whose body merely contains the oracle's lines as a subsequence", () => {
    const keeperRendered = [
      "Плагин в Chrome Web Store: https://chromewebstore.google.com/.../jhnhkmnignbhmcjbhoi...",
      "Исходники (MIT): https://github.com/Arcanada-one/conversation-to-markdown",
      "Статья (RU): https://arcanada.ai/.../conversation-to-markdown-long...",
      "Telegram (RU): https://t.me/valentovtypes/257",
      "X (EN): https://x.com/VeritasArcanaAI/status/2083622974007972325",
    ].join("\n");
    expect(() => assertExactCommentBinding(input(), evidence(keeperRendered))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  it("rejects a body that drops a whole line between visible fragments", () => {
    // Oracle has 3 lines; a rendering that skips the middle line entirely is a
    // different comment, not an elision.
    const missingMiddle = [
      "Плагин в Chrome Web Store: https://chromewebstore.google.com/.../jhnhkmnignbhmcjbhoi...",
      "Исходники (MIT): https://github.com/Arcanada-one/conversation-to-markdown",
    ].join("\n");
    expect(() => assertExactCommentBinding(input(), evidence(missingMiddle))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  it("rejects an unrelated comment body", () => {
    expect(() => assertExactCommentBinding(input(), evidence("Вот это полезное"))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  it("rejects a bare ellipsis (must not match everything)", () => {
    expect(() => assertExactCommentBinding(input(), evidence("..."))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
    expect(() => assertExactCommentBinding(input(), evidence("…"))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  it("rejects a rendering whose visible text does not start the body", () => {
    // Dropping the first line means this is a different (or partially read) comment.
    const tailOnly = "Исходники (MIT): https://github.com/Arcanada-one/conversation-to-markdown";
    expect(() => assertExactCommentBinding(input(), evidence(tailOnly))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  it("rejects fragments that appear out of order in the expected body", () => {
    const swapped = [
      "Плагин в Chrome Web Store: https://chromewebstore.google.com/.../jhnhkmnignbhmcjbhoi...",
      "Исходники (MIT): https://github.com/Arcanada-one/conversation-to-markdown",
      "Статья: https://arcanada.ai/.../conversation-to-markdown-long...",
    ].join("\n");
    expect(() => assertExactCommentBinding(input(), evidence(swapped))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  it("rejects an elided rendering with extra trailing content beyond the body", () => {
    const withExtra = `${RENDERED_ELIDED}\nP.S. добавлено позже`;
    expect(() => assertExactCommentBinding(input(), evidence(withExtra))).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  // Live regression (2026-08-02): Facebook decorates the author link inside a
  // comment header with the comment's own tracking params, e.g.
  // `facebook.com/pavelvalentov?comment_id=…&__cft__[0]=…`. Rejecting any href
  // carrying `comment_id` discarded the only real author link, so ownership of
  // our OWN comment could not be proven and deletion refused.
  it("accepts an author href decorated with comment tracking params", () => {
    const tracked = {
      ...evidence(RENDERED_ELIDED),
      renderedAuthorProfileHrefs: [
        "https://www.facebook.com/pavelvalentov?comment_id=Y29tbWVudDoyNzY2NzY2MDAxOTUyMTc4MF8xMDcx&__cft__[0]=AZ",
      ],
    };
    expect(() => assertExactCommentBinding(input(), tracked)).not.toThrow();
  });

  it("rejects a post permalink even when it is decorated the same way", () => {
    const permalink = {
      ...evidence(RENDERED_ELIDED),
      renderedAuthorProfileHrefs: [`${PARENT}?comment_id=123&__cft__[0]=AZ`],
    };
    expect(() => assertExactCommentBinding(input(), permalink)).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  it("still rejects a DIFFERENT profile carrying tracking params", () => {
    const impostorTracked = {
      ...evidence(RENDERED_ELIDED),
      renderedAuthorProfileHrefs: ["https://www.facebook.com/impostor?comment_id=123"],
    };
    expect(() => assertExactCommentBinding(input(), impostorTracked)).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });

  it("still rejects a comment permalink passed as the operator's author oracle", () => {
    expect(() =>
      assertExactCommentBinding(
        input({ expectedAuthorProfileUrl: `${PARENT}?comment_id=${COMMENT_ID}` }),
        evidence(RENDERED_ELIDED),
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_ARGS }));
  });

  it("still enforces the author oracle on an elided body", () => {
    const impostor = {
      ...evidence(RENDERED_ELIDED),
      renderedAuthorProfileHrefs: ["https://www.facebook.com/impostor"],
    };
    expect(() => assertExactCommentBinding(input(), impostor)).toThrowError(
      expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }),
    );
  });
});
