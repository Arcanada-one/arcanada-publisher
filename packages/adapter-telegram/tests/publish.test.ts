import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { TelegramAdapter, TELEGRAM_TEST_CHAT_ID, requireMessage } from "../src/index.js";

describe("TelegramAdapter publish safety", () => {
  it("dry-runs without credentials or network and requires a chat", async () => {
    const transport = vi.fn();
    const adapter = new TelegramAdapter({ transport });
    const result = await adapter.publish({
      text: "Title\n\nLead",
      profile: "",
      dryRun: true,
      chatId: TELEGRAM_TEST_CHAT_ID,
    });
    expect(result.platform).toBe("telegram");
    expect(transport).not.toHaveBeenCalled();
  });

  it("dry-runs a long photo post without credentials or network", async () => {
    const transport = vi.fn();
    const adapter = new TelegramAdapter({ transport });
    const image = join(mkdtempSync(join(tmpdir(), "publisher-telegram-dry-run-")), "missing.png");
    const result = await adapter.publish({
      text: `${"teaser ".repeat(150)}\n\nLong-read body`,
      imagePaths: [image],
      profile: "",
      dryRun: true,
      chatId: TELEGRAM_TEST_CHAT_ID,
    });
    expect(result.ok).toBe(true);
    expect(result.attachments).toEqual([{ kind: "image", src: image }]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("blocks non-test live channels unless explicitly allowed", async () => {
    const adapter = new TelegramAdapter({ transport: vi.fn() });
    await expect(
      adapter.publish({ text: "x", profile: "", chatId: "-1001" }),
    ).rejects.toMatchObject({ code: ErrorCode.NETWORK_GUARD });
  });

  it("captures baseline, embeds a nonce, and verifies bot authorship", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
      .mockResolvedValueOnce({
        ok: true,
        result: [{ channel_post: { message_id: 7, chat: { id: Number(TELEGRAM_TEST_CHAT_ID) } } }],
      })
      .mockImplementationOnce(async (_method: string, body: FormData) => ({
        ok: true,
        result: {
          message_id: 8,
          chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
          from: { id: 42 },
          text: String(body.get("text")),
        },
      }));
    const adapter = new TelegramAdapter({ transport, nonce: () => "fixed" });
    const result = await adapter.publish({
      text: "Title\n\nLead",
      profile: "",
      chatId: TELEGRAM_TEST_CHAT_ID,
    });
    expect(result.postUrl).toBe("https://t.me/test/8");
    expect(transport).toHaveBeenNthCalledWith(1, "getMe", undefined);
    expect(transport).toHaveBeenNthCalledWith(2, "getUpdates", expect.any(URLSearchParams));
  });

  it("publishes Pattern A as a bounded photo caption and a linked body reply", async () => {
    const image = makeImage();
    const text = `${"😀".repeat(400)}${"a".repeat(199)} ${"b".repeat(4096)}`;
    expect(text.length).toBe(5096);
    let heroCaption = "";
    let replyText = "";
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
      .mockResolvedValueOnce({
        ok: true,
        result: [{ channel_post: { message_id: 7, chat: { id: Number(TELEGRAM_TEST_CHAT_ID) } } }],
      })
      .mockImplementationOnce(async (method: string, body: FormData) => {
        expect(method).toBe("sendPhoto");
        heroCaption = String(body.get("caption"));
        return {
          ok: true,
          result: {
            message_id: 8,
            chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
            from: { id: 42 },
            caption: heroCaption,
            photo: [{ file_id: "photo", width: 1, height: 1 }],
          },
        };
      })
      .mockImplementationOnce(async (method: string, body: URLSearchParams) => {
        expect(method).toBe("sendMessage");
        replyText = String(body.get("text"));
        expect(JSON.parse(String(body.get("reply_parameters")))).toEqual({ message_id: 8 });
        return {
          ok: true,
          result: {
            message_id: 9,
            chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
            from: { id: 42 },
            text: replyText,
            reply_to_message: {
              message_id: 8,
              chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
            },
          },
        };
      });
    const adapter = new TelegramAdapter({
      transport,
      nonce: () => "abcdef12-3456-7890-abcd-ef1234567890",
    });
    const result = await adapter.publish({
      text,
      imagePaths: [image],
      profile: "",
      chatId: TELEGRAM_TEST_CHAT_ID,
    });
    expect(result.postUrl).toBe("https://t.me/test/8");
    expect(heroCaption.length).toBeLessThanOrEqual(1024);
    expect(replyText.length).toBeLessThanOrEqual(4096);
    expect(heroCaption).toMatch(/#PUB_0029_abcdef123456$/);
    const heroBody = heroCaption.replace(/\n\n#PUB_0029_abcdef123456$/, "");
    expect(`${heroBody}${replyText}`).toBe(text);
    expect(heroBody).toMatch(/[.!?\s]$/u);
  });

  it.each(["hero", "reply"] as const)(
    "rejects UTF-16-safe middle corruption in the Pattern A %s read-back",
    async (part) => {
      const text = `${"😀 intro words ".repeat(90)}\n\n${"body words 😀 ".repeat(180)}`;
      await expect(runPatternA(text, { [part]: corruptMiddle })).rejects.toMatchObject({
        code: ErrorCode.VERIFY_FAILED,
      });
    },
  );

  it("prefers a paragraph boundary over later sentence and space boundaries", async () => {
    const text = `${"p".repeat(250)}\n\n${"s".repeat(300)}. ${"w".repeat(400)} ${"tail".repeat(100)}`;
    const { heroCaption, replyText } = await runPatternA(text);
    expect(stripMarker(heroCaption)).toBe(text.slice(0, 252));
    expect(`${stripMarker(heroCaption)}${replyText}`).toBe(text);
  });

  it("prefers a sentence boundary over a later space boundary", async () => {
    const text = `${"s".repeat(500)}. ${"w".repeat(400)} ${"tail".repeat(100)}`;
    const { heroCaption, replyText } = await runPatternA(text);
    expect(stripMarker(heroCaption)).toBe(text.slice(0, 502));
    expect(`${stripMarker(heroCaption)}${replyText}`).toBe(text);
  });

  it("uses a space boundary without splitting a word", async () => {
    const text = `${"a".repeat(900)} ${"b".repeat(500)}`;
    const { heroCaption, replyText } = await runPatternA(text);
    expect(stripMarker(heroCaption)).toBe(text.slice(0, 901));
    expect(replyText).toBe(text.slice(901));
    expect(`${stripMarker(heroCaption)}${replyText}`).toBe(text);
  });

  it("fails closed instead of splitting an overlong word", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
      .mockResolvedValueOnce({ ok: true, result: [] });
    const adapter = new TelegramAdapter({ transport, nonce: () => "fixed" });
    await expect(
      adapter.publish({
        text: "a".repeat(1_100),
        imagePaths: [makeImage()],
        profile: "",
        chatId: TELEGRAM_TEST_CHAT_ID,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("fails Pattern A when the returned body is not linked to the hero", async () => {
    const image = makeImage();
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
      .mockResolvedValueOnce({ ok: true, result: [] })
      .mockImplementationOnce(async (_method: string, body: FormData) => ({
        ok: true,
        result: {
          message_id: 1,
          chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
          from: { id: 42 },
          caption: String(body.get("caption")),
          photo: [{ file_id: "photo", width: 1, height: 1 }],
        },
      }))
      .mockImplementationOnce(async (_method: string, body: URLSearchParams) => ({
        ok: true,
        result: {
          message_id: 2,
          chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
          from: { id: 42 },
          text: String(body.get("text")),
          reply_to_message: { message_id: 999, chat: { id: Number(TELEGRAM_TEST_CHAT_ID) } },
        },
      }));
    const adapter = new TelegramAdapter({ transport, nonce: () => "fixed" });
    await expect(
      adapter.publish({
        text: `${"hero words ".repeat(100)}\n\n${"body words ".repeat(350)}`,
        imagePaths: [image],
        profile: "",
        chatId: TELEGRAM_TEST_CHAT_ID,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
  });

  it("rejects Pattern A text over 5096 UTF-16 units before network I/O", async () => {
    const transport = vi.fn();
    const adapter = new TelegramAdapter({ transport });
    await expect(
      adapter.publish({
        text: "😀".repeat(2549),
        imagePaths: [makeImage()],
        profile: "",
        chatId: TELEGRAM_TEST_CHAT_ID,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
    expect(transport).not.toHaveBeenCalled();
  });

  it("classifies empty and malformed responses as UNKNOWN and never success", () => {
    for (const value of [undefined, {}, { ok: false }, { ok: true, result: {} }]) {
      expect(() => requireMessage(value, "sendMessage")).toThrow(AdapterError);
    }
  });
});

function makeImage(): string {
  const dir = mkdtempSync(join(tmpdir(), "publisher-telegram-"));
  const file = join(dir, "hero.png");
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

async function runPatternA(
  text: string,
  mutate: Partial<Record<"hero" | "reply", (value: string) => string>> = {},
): Promise<{ heroCaption: string; replyText: string }> {
  let heroCaption = "";
  let replyText = "";
  const transport = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
    .mockResolvedValueOnce({ ok: true, result: [] })
    .mockImplementationOnce(async (_method: string, body: FormData) => {
      heroCaption = String(body.get("caption"));
      return {
        ok: true,
        result: {
          message_id: 1,
          chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
          from: { id: 42 },
          caption: mutate.hero?.(heroCaption) ?? heroCaption,
          photo: [{ file_id: "photo", width: 1, height: 1 }],
        },
      };
    })
    .mockImplementationOnce(async (_method: string, body: URLSearchParams) => {
      replyText = String(body.get("text"));
      return {
        ok: true,
        result: {
          message_id: 2,
          chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
          from: { id: 42 },
          text: mutate.reply?.(replyText) ?? replyText,
          reply_to_message: { message_id: 1, chat: { id: Number(TELEGRAM_TEST_CHAT_ID) } },
        },
      };
    });
  const adapter = new TelegramAdapter({ transport, nonce: () => "fixed" });
  await adapter.publish({
    text,
    imagePaths: [makeImage()],
    profile: "",
    chatId: TELEGRAM_TEST_CHAT_ID,
  });
  return { heroCaption, replyText };
}

function stripMarker(text: string): string {
  return text.replace(/\n\n#PUB_0029_fixed$/, "");
}

function corruptMiddle(text: string): string {
  const codePoints = Array.from(text);
  const middle = Math.floor(codePoints.length / 2);
  codePoints[middle] = codePoints[middle] === "X" ? "Y" : "X";
  return codePoints.join("");
}
