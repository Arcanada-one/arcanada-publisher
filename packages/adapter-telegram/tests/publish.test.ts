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
    const image = makeImage();
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
