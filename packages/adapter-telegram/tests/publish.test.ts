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

  it.each([
    { name: "photo", fileName: "hero.png", method: "sendPhoto", field: "photo" },
    { name: "video", fileName: "hero.mp4", method: "sendVideo", field: "video" },
  ])("uses Telegram's $field multipart field for a $name", async ({ fileName, method, field }) => {
    const media = makeMedia(fileName);
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
      .mockResolvedValueOnce({ ok: true, result: [] })
      .mockImplementationOnce(async (actualMethod: string, body: FormData) => {
        expect(actualMethod).toBe(method);
        expect([...body.keys()].sort()).toEqual(["caption", "chat_id", field].sort());
        const caption = String(body.get("caption"));
        return {
          ok: true,
          result: {
            message_id: 1,
            chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
            from: { id: 42 },
            caption,
            ...(field === "photo"
              ? { photo: [{ file_id: "photo", width: 1, height: 1 }] }
              : {
                  video: {
                    file_id: "video",
                    width: 1,
                    height: 1,
                    duration: 1,
                    file_name: fileName,
                  },
                }),
          },
        };
      });
    const adapter = new TelegramAdapter({ transport, nonce: () => "fixed" });
    await adapter.publish({
      text: "Title\n\nLead",
      imagePaths: [media],
      profile: "",
      chatId: TELEGRAM_TEST_CHAT_ID,
    });
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

  it.each([
    { name: "terminal LF", suffix: "\n", expectedSuffix: "" },
    { name: "terminal CRLF", suffix: "\r\n", expectedSuffix: "" },
    { name: "no terminal newline", suffix: "", expectedSuffix: "" },
    { name: "intentional trailing spaces", suffix: "  ", expectedSuffix: "  " },
    {
      name: "intentional trailing spaces before LF",
      suffix: "  \n",
      expectedSuffix: "  ",
    },
  ])("normalizes $name without trimming other whitespace", async ({ suffix, expectedSuffix }) => {
    const base = `${"hero words ".repeat(100)}\n\n${"body words ".repeat(180)}`.trimEnd();
    const { heroCaption, replyText } = await runPatternA(`${base}${suffix}`, {
      reply: removeOneTerminalLineEnding,
    });
    expect(heroCaption).toMatch(/\n\n#PUB_0029_fixed$/);
    expect(`${stripMarker(heroCaption)}${replyText}`).toBe(`${base}${expectedSuffix}`);
  });

  it("normalizes a terminal LF before the Pattern A length limit", async () => {
    const normalized = `${"😀".repeat(400)}${"a".repeat(199)} ${"b".repeat(4096)}`;
    expect(normalized.length).toBe(5_096);
    const { heroCaption, replyText } = await runPatternA(`${normalized}\n`, {
      reply: removeOneTerminalLineEnding,
    });
    expect(`${stripMarker(heroCaption)}${replyText}`).toBe(normalized);
  });

  it("accepts channel-authored hero and reply responses without Message.from", async () => {
    const text = `${"hero words ".repeat(100)}\n\n${"body words ".repeat(180)}`;
    const channelIdentity = { sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) } };
    await expect(
      runPatternA(text, {}, { hero: channelIdentity, reply: channelIdentity }),
    ).resolves.toMatchObject({ heroCaption: expect.any(String), replyText: expect.any(String) });
  });

  it.each([
    { part: "hero", caseName: "missing sender_chat", identity: {} },
    { part: "reply", caseName: "missing sender_chat", identity: {} },
    {
      part: "hero",
      caseName: "mismatched sender_chat",
      identity: { sender_chat: { id: -1001 } },
    },
    {
      part: "reply",
      caseName: "mismatched sender_chat",
      identity: { sender_chat: { id: -1001 } },
    },
    {
      part: "hero",
      caseName: "wrong from with otherwise valid sender_chat",
      identity: { from: { id: 999 }, sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) } },
    },
    {
      part: "reply",
      caseName: "wrong from with otherwise valid sender_chat",
      identity: { from: { id: 999 }, sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) } },
    },
  ] as const)("rejects $caseName on the $part", async ({ part, identity }) => {
    const text = `${"hero words ".repeat(100)}\n\n${"body words ".repeat(180)}`;
    const validChannelIdentity = { sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) } };
    await expect(
      runPatternA(
        text,
        {},
        {
          hero: part === "hero" ? identity : validChannelIdentity,
          reply: part === "reply" ? identity : validChannelIdentity,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
  });

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

  it("edits an allowlisted Telegram photo post to multipart video after exact baseline checks", async () => {
    const video = makeMedia("telegram-ru.mp4");
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
      .mockResolvedValueOnce({
        ok: true,
        result: [
          {
            channel_post: {
              message_id: 208,
              chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
              sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
              caption: "old caption\n\n#PUB_0029_unique",
              photo: [{ file_id: "old-photo", width: 800, height: 400 }],
            },
          },
        ],
      })
      .mockImplementationOnce(async (method: string, body: FormData) => {
        expect(method).toBe("editMessageMedia");
        expect([...body.keys()].sort()).toEqual(["chat_id", "media", "media_file", "message_id"]);
        expect(body.get("chat_id")).toBe(TELEGRAM_TEST_CHAT_ID);
        expect(body.get("message_id")).toBe("208");
        expect(JSON.parse(String(body.get("media")))).toEqual({
          type: "video",
          media: "attach://media_file",
          caption: "new caption",
        });
        return {
          ok: true,
          result: {
            message_id: 208,
            chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
            sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
            caption: "new caption",
            video: {
              file_id: "new-video",
              file_size: 21_732_579,
              width: 1280,
              height: 720,
              duration: 245,
              file_name: "telegram-ru.mp4",
            },
          },
        };
      });
    const adapter = new TelegramAdapter({ transport });

    await expect(
      adapter.edit({
        postUrl: "https://t.me/c/3855619081/208",
        text: "new caption",
        imagePath: video,
        expectedContent: "#PUB_0029_unique",
        expectedMediaKind: "image",
        profile: "",
      }),
    ).resolves.toMatchObject({ postUrl: "https://t.me/c/3855619081/208", edited: true });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each([
    { expectedContent: "wrong marker", expectedMediaKind: "image" as const },
    { expectedContent: "#PUB_0029_unique", expectedMediaKind: "video" as const },
  ])(
    "fails before editMessageMedia when the current Telegram baseline mismatches",
    async (oracle) => {
      const transport = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
        .mockResolvedValueOnce({
          ok: true,
          result: [
            {
              channel_post: {
                message_id: 208,
                chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
                sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
                caption: "old caption\n\n#PUB_0029_unique",
                photo: [{ file_id: "old-photo", width: 800, height: 400 }],
              },
            },
          ],
        });
      const adapter = new TelegramAdapter({ transport });

      await expect(
        adapter.edit({
          postUrl: "https://t.me/c/3855619081/208",
          text: "new caption",
          imagePath: makeMedia("telegram-ru.mp4"),
          ...oracle,
          profile: "",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects a mismatched editMessageMedia response as UNKNOWN state", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
      .mockResolvedValueOnce({
        ok: true,
        result: [
          {
            channel_post: {
              message_id: 208,
              chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
              sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
              caption: "old caption\n\n#PUB_0029_unique",
              photo: [{ file_id: "old-photo", width: 800, height: 400 }],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          message_id: 209,
          chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
          sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
          caption: "new caption",
          video: {
            file_id: "new-video",
            width: 1280,
            height: 720,
            duration: 245,
            file_name: "telegram-ru.mp4",
          },
        },
      });
    const adapter = new TelegramAdapter({ transport });

    await expect(
      adapter.edit({
        postUrl: "https://t.me/c/3855619081/208",
        text: "new caption",
        imagePath: makeMedia("telegram-ru.mp4"),
        expectedContent: "#PUB_0029_unique",
        expectedMediaKind: "image",
        profile: "",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
  });

  it("edits exactly one existing longread reply after content and parent read-before-edit", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { id: 42 } })
      .mockResolvedValueOnce({
        ok: true,
        result: [
          {
            channel_post: {
              message_id: 209,
              chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
              sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
              text: "old longread marker",
              reply_to_message: {
                message_id: 208,
                chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
              },
            },
          },
        ],
      })
      .mockImplementationOnce(async (method: string, body: URLSearchParams) => {
        expect(method).toBe("editMessageText");
        return {
          ok: true,
          result: {
            message_id: 209,
            chat: { id: Number(TELEGRAM_TEST_CHAT_ID), username: "test" },
            sender_chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
            text: String(body.get("text")),
            reply_to_message: {
              message_id: 208,
              chat: { id: Number(TELEGRAM_TEST_CHAT_ID) },
            },
          },
        };
      });
    const adapter = new TelegramAdapter({ transport });

    await expect(
      adapter.edit({
        postUrl: "https://t.me/c/3855619081/209",
        text: "new longread",
        expectedContent: "old longread marker",
        expectedMediaKind: "none",
        expectedParentUrl: "https://t.me/c/3855619081/208",
        profile: "",
      }),
    ).resolves.toMatchObject({ postUrl: "https://t.me/c/3855619081/209", edited: true });
  });
});

function makeImage(): string {
  return makeMedia("hero.png");
}

function makeMedia(fileName: string): string {
  const dir = mkdtempSync(join(tmpdir(), "publisher-telegram-"));
  const file = join(dir, fileName);
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

async function runPatternA(
  text: string,
  mutate: Partial<Record<"hero" | "reply", (value: string) => string>> = {},
  identity: Partial<Record<"hero" | "reply", TestMessageIdentity>> = {},
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
          ...(identity.hero ?? { from: { id: 42 } }),
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
          ...(identity.reply ?? { from: { id: 42 } }),
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

interface TestMessageIdentity {
  from?: { id: number };
  sender_chat?: { id: number };
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

function removeOneTerminalLineEnding(text: string): string {
  return text.replace(/\r?\n$/, "");
}
