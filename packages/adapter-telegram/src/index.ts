import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import {
  BaseAdapter,
  AdapterError,
  ErrorCode,
  PublishResultSchema,
  CommentResultSchema,
  EditResultSchema,
  VerifyResultSchema,
  type PublishInput,
  type PublishResult,
  type CommentInput,
  type CommentResult,
  type EditInput,
  type EditResult,
  type DeleteInput,
  type DeleteResult,
  type LoginOptions,
  type VerifyResult,
} from "@arcanada/publisher-core";
import {
  createTransport,
  requireMessage,
  requireResult,
  type TelegramMessage,
  type TelegramTransport,
} from "./client.js";

export const TELEGRAM_TEST_CHAT_ID = "-1003855619081";
const TELEGRAM_CAPTION_LIMIT = 1_024;
const TELEGRAM_MESSAGE_LIMIT = 4_096;
const TELEGRAM_PATTERN_A_LIMIT = 5_096;
export interface TelegramAdapterOptions {
  botToken?: string;
  transport?: TelegramTransport;
  nonce?: () => string;
  allowedLiveChatIds?: string[];
}

export class TelegramAdapter extends BaseAdapter {
  readonly platform = "telegram" as const;
  private readonly transport: TelegramTransport;
  private readonly nonce: () => string;
  private readonly allowedLiveChatIds: Set<string>;

  constructor(options: TelegramAdapterOptions = {}) {
    super();
    if (!options.transport && !options.botToken)
      throw new AdapterError(ErrorCode.MISSING_INPUT, "Telegram bot token is required");
    this.transport = options.transport ?? createTransport(options.botToken!);
    this.nonce = options.nonce ?? randomUUID;
    this.allowedLiveChatIds = new Set(options.allowedLiveChatIds ?? [TELEGRAM_TEST_CHAT_ID]);
  }

  async login(_options: LoginOptions): Promise<void> {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "telegram: login is token-based");
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const chatId = requireChatId(input.chatId);
    if (!input.text.trim())
      throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: text is required");
    const media = input.imagePaths?.[0] ?? input.imagePath;
    const kind = media ? mediaKind(media) : undefined;
    if (media && kind === "image" && input.text.length > TELEGRAM_PATTERN_A_LIMIT)
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        `telegram: Pattern A text exceeds ${TELEGRAM_PATTERN_A_LIMIT} UTF-16 units`,
      );
    if (media && kind === "video" && input.text.length > 900)
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        "telegram: media caption must leave room for the idempotency marker (maximum 900 characters)",
      );
    if (input.dryRun)
      return PublishResultSchema.parse({
        ok: true,
        platform: "telegram",
        account: chatId,
        postUrl: dryRunUrl(chatId),
        attachments: media ? [{ kind: mediaKind(media), src: media }] : [],
        commentIds: [],
      });

    if (!this.allowedLiveChatIds.has(chatId))
      throw new AdapterError(
        ErrorCode.NETWORK_GUARD,
        `telegram: live chat '${chatId}' is not operator-allowed; test channel ${TELEGRAM_TEST_CHAT_ID} is the default`,
      );
    const bot = requireResult<{ id: number }>(await this.transport("getMe", undefined), "getMe");
    const baseline = await this.baseline(chatId);
    const markerNonce =
      this.nonce()
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 12) || "nonce";
    const markerSuffix = `\n\n#PUB_0029_${markerNonce}`;
    const pattern =
      media && kind === "image"
        ? patternAText(input.text, TELEGRAM_CAPTION_LIMIT - markerSuffix.length)
        : { hero: input.text };
    const heroText = `${pattern.hero}${markerSuffix}`;
    const body = new FormData();
    body.set("chat_id", chatId);
    let method = "sendMessage";
    if (media) {
      const bytes = await readFile(media);
      const attachmentKind = mediaKind(media);
      method = attachmentKind === "video" ? "sendVideo" : "sendPhoto";
      body.set(attachmentKind === "image" ? "photo" : "video", new Blob([bytes]), basename(media));
      body.set("caption", heroText);
    } else body.set("text", heroText);

    const message = requireMessage(await this.transport(method, body), method);
    await this.assertReadBack(message, chatId, baseline, bot.id, heroText, media);
    if (pattern.reply) {
      const reply = requireMessage(
        await this.transport(
          "sendMessage",
          jsonBody({
            chat_id: chatId,
            text: pattern.reply,
            reply_parameters: { message_id: message.message_id },
          }),
        ),
        "sendMessage",
      );
      await this.assertReadBack(reply, chatId, baseline, bot.id, pattern.reply);
      if (
        reply.message_id <= message.message_id ||
        reply.reply_to_message?.message_id !== message.message_id ||
        reply.reply_to_message.chat.id !== message.chat.id
      )
        throw new AdapterError(
          ErrorCode.VERIFY_FAILED,
          "publish: Telegram Pattern A reply linkage read-back mismatch",
          { heroMessageId: message.message_id, replyMessageId: reply.message_id },
        );
    }
    return PublishResultSchema.parse({
      ok: true,
      platform: "telegram",
      account: chatId,
      postUrl: messageUrl(message),
      attachments: media ? [{ kind: mediaKind(media), src: media }] : [],
      commentIds: [],
    });
  }

  async comment(input: CommentInput): Promise<CommentResult> {
    const { chatId, messageId } = parseMessageUrl(input.parentPostUrl);
    const body = jsonBody({
      chat_id: chatId,
      text: input.text,
      reply_parameters: { message_id: messageId },
    });
    const message = requireMessage(await this.transport("sendMessage", body), "sendMessage");
    if (message.reply_to_message?.message_id !== messageId || !chatMatches(message, chatId))
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "comment: reply linkage read-back mismatch");
    return CommentResultSchema.parse({
      ok: true,
      platform: "telegram",
      account: chatId,
      commentId: String(message.message_id),
      parentPostUrl: input.parentPostUrl,
    });
  }

  async edit(input: EditInput): Promise<EditResult> {
    if (!input.text) throw new AdapterError(ErrorCode.MISSING_INPUT, "edit: text is required");
    const { chatId, messageId } = parseMessageUrl(input.postUrl);
    const message = requireMessage(
      await this.transport(
        "editMessageText",
        jsonBody({ chat_id: chatId, message_id: messageId, text: input.text }),
      ),
      "editMessageText",
    );
    if (message.text !== input.text)
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "edit: returned text mismatch");
    return EditResultSchema.parse({
      ok: true,
      platform: "telegram",
      account: chatId,
      postUrl: input.postUrl,
      edited: true,
    });
  }

  async delete(input: DeleteInput): Promise<DeleteResult> {
    if (!input.expectedContent.trim())
      throw new AdapterError(ErrorCode.MISSING_INPUT, "delete: expectedContent is required");
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "telegram: Bot API cannot read an arbitrary message before delete; refusing unsafe deletion",
      { readBeforeDeleteRequired: true },
    );
  }

  override async verify(postUrl: string): Promise<VerifyResult> {
    parseMessageUrl(postUrl);
    return VerifyResultSchema.parse({
      ok: false,
      platform: "telegram",
      postUrl,
      reachable: false,
      status: 0,
    });
  }

  private async baseline(chatId: string): Promise<number> {
    const updates = requireResult<Array<{ channel_post?: TelegramMessage }>>(
      await this.transport("getUpdates", jsonBody({ allowed_updates: ["channel_post"] })),
      "getUpdates",
    );
    return updates.reduce(
      (max, update) =>
        update.channel_post && chatMatches(update.channel_post, chatId)
          ? Math.max(max, update.channel_post.message_id)
          : max,
      0,
    );
  }

  private async assertReadBack(
    message: TelegramMessage,
    chatId: string,
    baseline: number,
    botId: number,
    expectedText: string,
    media?: string,
  ): Promise<void> {
    const actual = message.caption ?? message.text ?? "";
    if (
      !authoredByExpectedSender(message, chatId, botId) ||
      message.message_id <= baseline ||
      message.forward_origin ||
      actual !== expectedText
    )
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "publish: Telegram returned artifact failed identity/content read-back",
        { messageId: message.message_id, baseline },
      );
    if (
      media &&
      mediaKind(media) === "video" &&
      (!message.video || message.video.file_name !== basename(media))
    )
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "publish: returned video does not match sent filename",
      );
    if (media && mediaKind(media) === "image" && !message.photo?.length)
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "publish: returned artifact is not a photo");
  }
}

function requireChatId(value?: string): string {
  if (!value?.trim())
    throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: chatId is required");
  return value;
}
function mediaKind(path: string): "image" | "video" {
  return /\.(mp4|mov|webm)$/i.test(path) ? "video" : "image";
}
function patternAText(text: string, heroLimit: number): { hero: string; reply?: string } {
  if (text.length <= heroLimit) return { hero: text };
  const minimum = Math.max(0, text.length - TELEGRAM_MESSAGE_LIMIT);
  const splitAt =
    lastBoundary(text, minimum, heroLimit, /\n\s*\n/gu) ??
    lastBoundary(text, minimum, heroLimit, /[.!?]["')\]]?\s+/gu) ??
    lastBoundary(text, minimum, heroLimit, /\s+/gu);
  if (splitAt === undefined)
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "telegram: Pattern A cannot split at a paragraph, sentence, or space boundary",
      { heroLimit, replyLimit: TELEGRAM_MESSAGE_LIMIT },
    );
  return { hero: text.slice(0, splitAt), reply: text.slice(splitAt) };
}
function lastBoundary(
  text: string,
  minimum: number,
  maximum: number,
  pattern: RegExp,
): number | undefined {
  let found: number | undefined;
  for (const match of text.matchAll(pattern)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= minimum && end <= maximum) found = end;
    if (end > maximum) break;
  }
  return found;
}
function jsonBody(value: Record<string, unknown>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, item] of Object.entries(value))
    body.set(key, typeof item === "object" ? JSON.stringify(item) : String(item));
  return body;
}
function dryRunUrl(chatId: string): string {
  return `https://t.me/${chatId.replace(/^@/, "")}/0`;
}
function messageUrl(message: TelegramMessage): string {
  return message.chat.username
    ? `https://t.me/${message.chat.username}/${message.message_id}`
    : `https://t.me/c/${String(message.chat.id).replace(/^-100/, "")}/${message.message_id}`;
}
function chatMatches(message: TelegramMessage, chatId: string): boolean {
  return chatId.startsWith("@")
    ? message.chat.username === chatId.slice(1)
    : String(message.chat.id) === chatId;
}
function authoredByExpectedSender(
  message: TelegramMessage,
  chatId: string,
  botId: number,
): boolean {
  if (!chatMatches(message, chatId)) return false;
  if (message.from) return message.from.id === botId;
  return message.sender_chat?.id === message.chat.id;
}
function parseMessageUrl(url: string): { chatId: string; messageId: number } {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const messageId = Number(parts.at(-1));
  if (parsed.hostname !== "t.me" || !Number.isInteger(messageId) || parts.length < 2)
    throw new AdapterError(ErrorCode.INVALID_ARGS, "invalid Telegram message URL");
  return { chatId: parts[0] === "c" ? `-100${parts[1]}` : `@${parts[0]}`, messageId };
}

export * from "./client.js";
