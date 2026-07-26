import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
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
const execFileAsync = promisify(execFile);

export interface TelegramVideoMetadata {
  width: number;
  height: number;
  duration: number;
}

export type TelegramFfprobeRunner = (
  executable: string,
  args: readonly string[],
) => Promise<string>;

export interface TelegramAdapterOptions {
  botToken?: string;
  transport?: TelegramTransport;
  nonce?: () => string;
  allowedLiveChatIds?: string[];
  probeVideoMetadata?: (filePath: string) => Promise<TelegramVideoMetadata>;
}

export interface TelegramInspection {
  chatId: string;
  messageId: number;
  content: string;
  marker: string | null;
  mediaKind: "image" | "video" | "none";
  video?: NonNullable<TelegramMessage["video"]>;
}

export class TelegramAdapter extends BaseAdapter {
  readonly platform = "telegram" as const;
  private readonly transport: TelegramTransport;
  private readonly nonce: () => string;
  private readonly allowedLiveChatIds: Set<string>;
  private readonly probeVideoMetadata: (filePath: string) => Promise<TelegramVideoMetadata>;

  constructor(options: TelegramAdapterOptions = {}) {
    super();
    if (!options.transport && !options.botToken)
      throw new AdapterError(ErrorCode.MISSING_INPUT, "Telegram bot token is required");
    this.transport = options.transport ?? createTransport(options.botToken!);
    this.nonce = options.nonce ?? randomUUID;
    this.probeVideoMetadata = options.probeVideoMetadata ?? ffprobeVideoMetadata;
    this.allowedLiveChatIds = new Set([
      TELEGRAM_TEST_CHAT_ID,
      ...(options.allowedLiveChatIds ?? []),
    ]);
  }

  async login(_options: LoginOptions): Promise<void> {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "telegram: login is token-based");
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const chatId = requireChatId(input.chatId);
    const text = normalizeTerminalLineEnding(input.text);
    if (!text.trim()) throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: text is required");
    const media = input.imagePaths?.[0] ?? input.imagePath;
    const kind = media ? mediaKind(media) : undefined;
    const title = input.title?.trim();
    const singleArticle = input.singleArticle === true;
    if (singleArticle && (media || title))
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        "telegram: --single-article forbids --image and --title",
      );
    if (singleArticle && telegramUnits(text) > TELEGRAM_MESSAGE_LIMIT)
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        "telegram: single article text exceeds 4096 UTF-16 units",
      );
    if (title && !media)
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        "telegram: article-bundle --title requires --image",
      );
    const articleBundle = Boolean(media && title);
    const bundleCaption = title ? `<b>${escapeTelegramHtml(title)}</b>` : undefined;
    if (articleBundle && telegramUnits(bundleCaption!) > TELEGRAM_CAPTION_LIMIT)
      throw new AdapterError(ErrorCode.INVALID_ARGS, "telegram: media title exceeds 1024 units");
    if (articleBundle && telegramUnits(text) > TELEGRAM_MESSAGE_LIMIT)
      throw new AdapterError(ErrorCode.INVALID_ARGS, "telegram: article text exceeds 4096 units");
    if (!articleBundle && media && kind === "image" && text.length > TELEGRAM_PATTERN_A_LIMIT)
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        `telegram: Pattern A text exceeds ${TELEGRAM_PATTERN_A_LIMIT} UTF-16 units`,
      );
    if (!articleBundle && media && kind === "video" && text.length > 900)
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        "telegram: media caption must leave room for the idempotency marker (maximum 900 characters)",
      );
    if (input.dryRun) {
      const postUrl = dryRunUrl(chatId);
      return PublishResultSchema.parse({
        ok: true,
        platform: "telegram",
        account: chatId,
        postUrl,
        ...(articleBundle
          ? {
              postUrls: [`${postUrl}?part=1`, `${postUrl}?part=2`],
              postIds: ["dry-run-1", "dry-run-2"],
            }
          : {}),
        attachments: media ? [{ kind: mediaKind(media), src: media }] : [],
        commentIds: [],
      });
    }

    const videoMetadata =
      media && kind === "video" ? await this.loadVideoMetadata(media) : undefined;

    if (!this.allowedLiveChatIds.has(chatId))
      throw new AdapterError(
        ErrorCode.NETWORK_GUARD,
        `telegram: live chat '${chatId}' is not operator-allowed; test channel ${TELEGRAM_TEST_CHAT_ID} is the default`,
      );
    const bot = requireResult<{ id: number }>(await this.transport("getMe", undefined), "getMe");
    const baseline = await this.baseline(chatId);

    if (singleArticle) {
      const body = jsonBody({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: false },
      });
      const message = requireMessage(await this.transport("sendMessage", body), "sendMessage");
      await this.assertReadBack(
        message,
        chatId,
        baseline,
        bot.id,
        telegramVisibleText(text),
        undefined,
        true,
      );
      return PublishResultSchema.parse({
        ok: true,
        platform: "telegram",
        account: chatId,
        postUrl: messageUrl(message),
        attachments: [],
        commentIds: [],
      });
    }

    if (articleBundle) {
      const bytes = await readFile(media!);
      const mediaMethod = kind === "video" ? "sendVideo" : "sendPhoto";
      const mediaBody = new FormData();
      mediaBody.set("chat_id", chatId);
      mediaBody.set(kind === "image" ? "photo" : "video", new Blob([bytes]), basename(media!));
      mediaBody.set("caption", bundleCaption!);
      mediaBody.set("parse_mode", "HTML");
      if (videoMetadata) setTelegramVideoMetadata(mediaBody, videoMetadata);
      const first = requireMessage(await this.transport(mediaMethod, mediaBody), mediaMethod);
      await this.assertReadBack(
        first,
        chatId,
        baseline,
        bot.id,
        telegramVisibleText(bundleCaption!),
        media,
        true,
        videoMetadata,
      );

      const textBody = jsonBody({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_parameters: { message_id: first.message_id },
      });
      let second: TelegramMessage;
      try {
        second = requireMessage(await this.transport("sendMessage", textBody), "sendMessage");
      } catch (error) {
        throw new AdapterError(
          ErrorCode.VERIFY_FAILED,
          "telegram: second channel post failed after post 1; state UNKNOWN; do not retry blindly",
          {
            unknown: true,
            reconcileRequired: true,
            firstMessageId: first.message_id,
            reason: error instanceof Error ? error.message : String(error),
          },
        );
      }
      await this.assertReadBack(
        second,
        chatId,
        first.message_id,
        bot.id,
        telegramVisibleText(text),
        undefined,
      );
      if (
        second.reply_to_message?.message_id !== first.message_id ||
        second.reply_to_message.chat.id !== first.chat.id
      )
        throw new AdapterError(
          ErrorCode.VERIFY_FAILED,
          "telegram: second channel post is not linked to the captured media post",
          { firstMessageId: first.message_id, secondMessageId: second.message_id },
        );
      const postUrls = [messageUrl(first), messageUrl(second)];
      return PublishResultSchema.parse({
        ok: true,
        platform: "telegram",
        account: chatId,
        postUrl: postUrls[0],
        postUrls,
        postIds: [String(first.message_id), String(second.message_id)],
        attachments: [{ kind: kind!, src: media! }],
        commentIds: [],
      });
    }

    const markerNonce =
      this.nonce()
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 12) || "nonce";
    const markerSuffix = `\n\n#PUB_0029_${markerNonce}`;
    const pattern =
      media && kind === "image"
        ? patternAText(text, TELEGRAM_CAPTION_LIMIT - markerSuffix.length)
        : { hero: text };
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
      if (videoMetadata) setTelegramVideoMetadata(body, videoMetadata);
    } else body.set("text", heroText);

    const message = requireMessage(await this.transport(method, body), method);
    await this.assertReadBack(
      message,
      chatId,
      baseline,
      bot.id,
      heroText,
      media,
      false,
      videoMetadata,
    );
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
    const normalizedInput = { ...input, text: normalizeTerminalLineEnding(input.text) };
    const { chatId, messageId } = parseMessageUrl(normalizedInput.postUrl);
    if (!this.allowedLiveChatIds.has(chatId))
      throw new AdapterError(
        ErrorCode.NETWORK_GUARD,
        `telegram: live chat '${chatId}' is not operator-allowed; test channel ${TELEGRAM_TEST_CHAT_ID} is the default`,
      );
    if (normalizedInput.imagePath) return this.editMedia(normalizedInput, chatId, messageId);
    let expectedBotId: number | undefined;
    if (
      normalizedInput.expectedContent ||
      normalizedInput.expectedMediaKind ||
      normalizedInput.expectedParentUrl
    ) {
      const bot = requireResult<{ id: number }>(await this.transport("getMe", undefined), "getMe");
      expectedBotId = bot.id;
      await this.assertCurrentMessage(normalizedInput, chatId, messageId, bot.id);
    }
    const message = requireMessage(
      await this.transport(
        "editMessageText",
        jsonBody({ chat_id: chatId, message_id: messageId, text: normalizedInput.text }),
      ),
      "editMessageText",
    );
    if (
      message.message_id !== messageId ||
      !chatMatches(message, chatId) ||
      (expectedBotId !== undefined &&
        !publisherSourceIdentityMatches(message, chatId, expectedBotId)) ||
      message.forward_origin ||
      !replyParentMatches(message, chatId, normalizedInput.expectedParentUrl) ||
      message.text !== normalizedInput.text
    )
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "edit: returned text mismatch");
    return EditResultSchema.parse({
      ok: true,
      platform: "telegram",
      account: chatId,
      postUrl: normalizedInput.postUrl,
      edited: true,
    });
  }

  async inspect(postUrl: string): Promise<TelegramInspection> {
    const { chatId, messageId } = parseMessageUrl(postUrl);
    if (!this.allowedLiveChatIds.has(chatId))
      throw new AdapterError(
        ErrorCode.NETWORK_GUARD,
        `telegram: live chat '${chatId}' is not operator-allowed`,
      );
    const current = await this.forwardProbe(chatId, messageId);
    const content = current.caption ?? current.text ?? "";
    const marker = /(?:^|\n\n)(#PUB_0029_[A-Za-z0-9]+)$/.exec(content)?.[1] ?? null;
    return {
      chatId,
      messageId,
      content,
      marker,
      mediaKind: current.video ? "video" : current.photo?.length ? "image" : "none",
      ...(current.video ? { video: current.video } : {}),
    };
  }

  private async editMedia(
    input: EditInput,
    chatId: string,
    messageId: number,
  ): Promise<EditResult> {
    if (
      !input.expectedContent?.trim() ||
      !input.expectedMediaKind ||
      input.expectedParentUrl !== undefined ||
      (mediaKind(input.imagePath!) === "video" &&
        (!input.videoWidth || !input.videoHeight || !input.videoDuration))
    )
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        "edit: Telegram media replacement requires exact current content or Publisher marker, expectedMediaKind, and explicit video metadata; parent oracle is unsupported",
      );
    const bot = requireResult<{ id: number }>(await this.transport("getMe", undefined), "getMe");
    const current = await this.forwardProbe(chatId, messageId);
    this.assertCurrentArtifact(input, current, chatId, bot.id);
    const bytes = await readFile(input.imagePath!);
    const uploadSha256 = createHash("sha256").update(bytes).digest("hex");
    const attachmentKind = mediaKind(input.imagePath!);
    const body = new FormData();
    body.set("chat_id", chatId);
    body.set("message_id", String(messageId));
    body.set(
      "media",
      JSON.stringify({
        type: attachmentKind === "video" ? "video" : "photo",
        media: "attach://media_file",
        caption: input.text,
        ...(attachmentKind === "video"
          ? {
              width: input.videoWidth,
              height: input.videoHeight,
              duration: input.videoDuration,
              supports_streaming: true,
            }
          : {}),
      }),
    );
    body.set("media_file", new Blob([bytes]), basename(input.imagePath!));
    let raw: unknown;
    try {
      raw = await this.transport("editMessageMedia", body);
    } catch (cause) {
      throw editUnknownState(chatId, messageId, cause);
    }
    let message: TelegramMessage;
    try {
      message = requireMessage(raw, "editMessageMedia");
    } catch (cause) {
      throw editUnknownState(chatId, messageId, cause);
    }
    const actual = message.caption ?? "";
    const returnedKind = message.video ? "video" : message.photo?.length ? "image" : "none";
    if (
      message.message_id !== messageId ||
      !publisherSourceIdentityMatches(message, chatId, bot.id) ||
      message.forward_origin ||
      actual !== input.text ||
      returnedKind !== attachmentKind ||
      (attachmentKind === "video" &&
        (!message.video?.file_id ||
          message.video.file_name !== basename(input.imagePath!) ||
          message.video.width !== input.videoWidth ||
          message.video.height !== input.videoHeight ||
          message.video.duration !== input.videoDuration))
    )
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "editMessageMedia: Telegram returned artifact failed identity/content/media read-back; state UNKNOWN",
        {
          unknown: true,
          reconcileRequired: true,
          messageId,
          uploadSha256,
          uploadedBytes: bytes.byteLength,
          requested: {
            width: input.videoWidth,
            height: input.videoHeight,
            duration: input.videoDuration,
            fileName: basename(input.imagePath!),
          },
          returned: message.video ?? null,
          note: "Telegram may transform file_size; file_id and requested media metadata are authoritative",
        },
      );
    return EditResultSchema.parse({
      ok: true,
      platform: "telegram",
      account: chatId,
      postUrl: input.postUrl,
      edited: true,
    });
  }

  private async assertCurrentMessage(
    input: EditInput,
    chatId: string,
    messageId: number,
    botId: number,
  ): Promise<void> {
    const updates = requireResult<
      Array<{
        message?: TelegramMessage;
        channel_post?: TelegramMessage;
        edited_message?: TelegramMessage;
        edited_channel_post?: TelegramMessage;
      }>
    >(
      await this.transport(
        "getUpdates",
        jsonBody({
          allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post"],
        }),
      ),
      "getUpdates",
    );
    const candidates = updates.flatMap((update) =>
      [
        update.message,
        update.channel_post,
        update.edited_message,
        update.edited_channel_post,
      ].filter((message): message is TelegramMessage => Boolean(message)),
    );
    const fromUpdates = candidates
      .filter((message) => message.message_id === messageId && chatMatches(message, chatId))
      .at(-1);
    const current = fromUpdates ?? (await this.forwardProbe(chatId, messageId));
    this.assertCurrentArtifact(input, current, chatId, botId);
    if (!replyParentMatches(current, chatId, input.expectedParentUrl))
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "edit: current reply-parent oracle mismatch");
  }

  private assertCurrentArtifact(
    input: EditInput,
    current: TelegramMessage,
    chatId: string,
    botId: number,
  ): void {
    if (!publisherSourceIdentityMatches(current, chatId, botId) || current.forward_origin)
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "edit: current source identity mismatch");
    const actual = current.caption ?? current.text ?? "";
    const currentKind = current.video ? "video" : current.photo?.length ? "image" : "none";
    if (
      input.expectedContent &&
      actual !== input.expectedContent &&
      !actual.endsWith(`\n\n${input.expectedContent}`)
    )
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "edit: current content oracle mismatch");
    if (input.expectedMediaKind && currentKind !== input.expectedMediaKind)
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "edit: current media oracle mismatch");
  }

  private async forwardProbe(chatId: string, messageId: number): Promise<TelegramMessage> {
    if (!this.allowedLiveChatIds.has(TELEGRAM_TEST_CHAT_ID))
      throw new AdapterError(
        ErrorCode.NETWORK_GUARD,
        "edit: Telegram probe chat is not allowlisted",
      );
    let forwarded: unknown;
    try {
      forwarded = await this.transport(
        "forwardMessage",
        jsonBody({
          chat_id: TELEGRAM_TEST_CHAT_ID,
          from_chat_id: chatId,
          message_id: messageId,
        }),
      );
    } catch (cause) {
      throw probeUnknownState("forwardMessage", chatId, messageId, cause);
    }
    const probe = requireMessage(forwarded, "forwardMessage");
    if (!chatMatches(probe, TELEGRAM_TEST_CHAT_ID))
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "forwardMessage: probe landed outside the allowlisted test channel; state UNKNOWN",
        { unknown: true, reconcileRequired: true, probeMessageId: probe.message_id },
      );
    let deleteResult: unknown;
    try {
      deleteResult = await this.transport(
        "deleteMessage",
        jsonBody({ chat_id: TELEGRAM_TEST_CHAT_ID, message_id: probe.message_id }),
      );
    } catch (cause) {
      throw probeUnknownState("deleteMessage", chatId, messageId, cause, probe.message_id);
    }
    let deleted: boolean;
    try {
      deleted = requireResult<boolean>(deleteResult, "deleteMessage");
    } catch (cause) {
      throw probeUnknownState("deleteMessage", chatId, messageId, cause, probe.message_id);
    }
    if (deleted !== true)
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "deleteMessage: Telegram probe deletion not confirmed; source edit blocked",
        {
          unknown: true,
          reconcileRequired: true,
          method: "deleteMessage",
          probeMessageId: probe.message_id,
        },
      );
    const origin = probe.forward_origin;
    if (
      origin?.type !== "channel" ||
      !origin.chat ||
      origin.message_id !== messageId ||
      !chatIdentityMatches(origin.chat, chatId)
    )
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "forwardMessage: returned forward_origin does not match the exact source target",
        { chatId, messageId, probeMessageId: probe.message_id },
      );
    // reply_to_message belongs to the probe destination and is not evidence of
    // the source post's parent. Never synthesize/rebrand it as source metadata.
    const {
      forward_origin: _forwardOrigin,
      reply_to_message: _probeReply,
      ...sourceSnapshot
    } = probe;
    return {
      ...sourceSnapshot,
      message_id: origin.message_id,
      chat: origin.chat,
      sender_chat: origin.chat,
    };
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
    ordinaryOnly = false,
    expectedVideoMetadata?: TelegramVideoMetadata,
  ): Promise<void> {
    const actual = message.caption ?? message.text ?? "";
    if (
      !publisherSourceIdentityMatches(message, chatId, botId) ||
      message.message_id <= baseline ||
      message.forward_origin ||
      (ordinaryOnly &&
        (message.reply_to_message !== undefined || message.message_thread_id !== undefined)) ||
      actual !== expectedText
    )
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "publish: Telegram returned artifact failed identity/content read-back",
        { messageId: message.message_id, baseline },
      );
    if (media && mediaKind(media) === "video" && !message.video)
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "publish: returned artifact is not a video");
    if (media && mediaKind(media) === "video" && message.video?.file_name !== basename(media))
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "publish: returned video filename mismatch");
    if (
      expectedVideoMetadata &&
      message.video &&
      (message.video.width !== expectedVideoMetadata.width ||
        message.video.height !== expectedVideoMetadata.height ||
        message.video.duration !== expectedVideoMetadata.duration)
    )
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "publish: returned video metadata does not match ffprobe",
        { expected: expectedVideoMetadata, returned: message.video },
      );
    if (media && mediaKind(media) === "image" && !message.photo?.length)
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "publish: returned artifact is not a photo");
  }

  private async loadVideoMetadata(filePath: string): Promise<TelegramVideoMetadata> {
    let metadata: TelegramVideoMetadata;
    try {
      metadata = await this.probeVideoMetadata(filePath);
    } catch (cause) {
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        `telegram: ffprobe failed for '${basename(filePath)}'`,
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (
      !Number.isInteger(metadata.width) ||
      metadata.width <= 0 ||
      !Number.isInteger(metadata.height) ||
      metadata.height <= 0 ||
      !Number.isInteger(metadata.duration) ||
      metadata.duration <= 0
    )
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        `telegram: ffprobe returned invalid video metadata for '${basename(filePath)}'`,
        { metadata },
      );
    return metadata;
  }
}

function requireChatId(value?: string): string {
  if (!value?.trim())
    throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: chatId is required");
  return value;
}
function normalizeTerminalLineEnding(text: string): string {
  return text.replace(/\r?\n$/, "");
}
function mediaKind(path: string): "image" | "video" {
  return /\.(mp4|mov|webm)$/i.test(path) ? "video" : "image";
}
function telegramVisibleText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function telegramUnits(value: string): number {
  return Buffer.byteLength(value, "utf16le") / 2;
}
function setTelegramVideoMetadata(body: FormData, metadata: TelegramVideoMetadata): void {
  body.set("width", String(metadata.width));
  body.set("height", String(metadata.height));
  body.set("duration", String(metadata.duration));
  body.set("supports_streaming", "true");
}

export async function ffprobeVideoMetadata(
  filePath: string,
  run: TelegramFfprobeRunner = runFfprobe,
): Promise<TelegramVideoMetadata> {
  const stdout = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,duration:format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number; duration?: string | number }>;
    format?: { duration?: string | number };
  };
  const stream = parsed.streams?.[0];
  const streamDuration = Number(stream?.duration);
  const formatDuration = Number(parsed.format?.duration);
  const rawDuration =
    Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : formatDuration;
  return {
    width: Number(stream?.width),
    height: Number(stream?.height),
    duration: Number.isFinite(rawDuration) ? Math.max(1, Math.round(rawDuration)) : 0,
  };
}

async function runFfprobe(executable: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(executable, [...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_048_576,
  });
  return String(stdout);
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
function chatIdentityMatches(chat: TelegramMessage["chat"], chatId: string): boolean {
  return chatId.startsWith("@") ? chat.username === chatId.slice(1) : String(chat.id) === chatId;
}
function normalizedChatNumericId(chatId: string, chat: TelegramMessage["chat"]): string {
  return chatId.startsWith("@") ? String(chat.id) : chatId;
}
function replyParentMatches(
  message: TelegramMessage,
  chatId: string,
  expectedParentUrl?: string | "none",
): boolean {
  if (expectedParentUrl === undefined) return true;
  if (expectedParentUrl === "none") return message.reply_to_message === undefined;
  const parent = parseMessageUrl(expectedParentUrl);
  return (
    parent.chatId === chatId &&
    message.reply_to_message?.message_id === parent.messageId &&
    String(message.reply_to_message.chat.id) === normalizedChatNumericId(chatId, message.chat)
  );
}
function publisherSourceIdentityMatches(
  message: TelegramMessage,
  chatId: string,
  botId: number,
): boolean {
  if (!chatMatches(message, chatId)) return false;
  if (message.from) return message.from.id === botId;
  // Channel posts expose sender_chat, not the posting bot. This proves only
  // source-channel identity; callers must also bind the Publisher marker and ID.
  return message.sender_chat?.id === message.chat.id;
}
function editUnknownState(chatId: string, messageId: number, cause: unknown): AdapterError {
  return new AdapterError(
    ErrorCode.VERIFY_FAILED,
    "editMessageMedia: Telegram state UNKNOWN; do not retry blindly",
    {
      unknown: true,
      reconcileRequired: true,
      method: "editMessageMedia",
      chatId,
      messageId,
      cause: cause instanceof Error ? cause.message : String(cause),
    },
  );
}
function probeUnknownState(
  method: "forwardMessage" | "deleteMessage",
  chatId: string,
  messageId: number,
  cause: unknown,
  probeMessageId?: number,
): AdapterError {
  return new AdapterError(
    ErrorCode.VERIFY_FAILED,
    `${method}: Telegram probe state UNKNOWN; source edit blocked`,
    {
      unknown: true,
      reconcileRequired: true,
      method,
      chatId,
      messageId,
      ...(probeMessageId !== undefined ? { probeMessageId } : {}),
      cause: cause instanceof Error ? cause.message : String(cause),
    },
  );
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
