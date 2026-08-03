import { describe, expect, it } from "vitest";
import { matchesElidedText, matchesElidedTextSource } from "../src/elided-text.js";

const BODY = [
  "Store: https://chromewebstore.google.com/detail/conversation-to-markdown/jhnhkmnignbhmcjbhoihdbjhjfljpili",
  "Article: https://arcanada.ai/ru/blog/conversation-to-markdown-long-chats-images",
  "Source: https://github.com/Arcanada-one/conversation-to-markdown",
].join("\n");

const RENDERED = [
  "Store: https://chromewebstore.google.com/.../jhnhkmnignbhmcjbhoi...",
  "Article: https://arcanada.ai/.../conversation-to-markdown-long...",
  "Source: https://github.com/Arcanada-one/conversation-to-markdown",
].join("\n");

describe("LinkedIn bounded elision oracle", () => {
  it("uses the shipped function source as the browser oracle", () => {
    const inPage = Function(`return (${matchesElidedTextSource});`)() as typeof matchesElidedText;
    expect(matchesElidedTextSource).toBe(matchesElidedText.toString());
    expect(inPage(RENDERED, BODY)).toBe(matchesElidedText(RENDERED, BODY));
    expect(inPage(RENDERED, BODY)).toBe(true);
  });

  it("accepts exact, URL-token elision, and Unicode ellipsis", () => {
    expect(matchesElidedText(BODY, BODY)).toBe(true);
    expect(matchesElidedText(RENDERED, BODY)).toBe(true);
    expect(matchesElidedText(RENDERED.replace(/\.\.\./g, "…"), BODY)).toBe(true);
  });

  it("rejects a keeper whose extra lines merely contain the oracle as a subsequence", () => {
    const keeper = [
      RENDERED.split("\n")[0],
      RENDERED.split("\n")[2],
      RENDERED.split("\n")[1],
      "Telegram: https://t.me/valentovtypes/257",
      "X: https://x.com/VeritasArcanaAI/status/1",
    ].join("\n");
    expect(matchesElidedText(keeper, BODY)).toBe(false);
  });

  it.each([
    ["whole line omitted", [RENDERED.split("\n")[0], RENDERED.split("\n")[2]].join("\n")],
    [
      "fragments reordered",
      [RENDERED.split("\n")[0], RENDERED.split("\n")[2], RENDERED.split("\n")[1]].join("\n"),
    ],
    ["leading text omitted", RENDERED.split("\n")[2]],
    ["bare ellipsis", "..."],
    ["extra line", `${RENDERED}\nP.S. extra content`],
  ])("rejects %s", (_label, candidate) => {
    expect(matchesElidedText(candidate, BODY)).toBe(false);
  });
});
