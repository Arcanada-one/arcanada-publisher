import { describe, expect, it, vi } from "vitest";
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

  it("classifies empty and malformed responses as UNKNOWN and never success", () => {
    for (const value of [undefined, {}, { ok: false }, { ok: true, result: {} }]) {
      expect(() => requireMessage(value, "sendMessage")).toThrow(AdapterError);
    }
  });
});
