import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; username?: string };
  from?: { id: number };
  sender_chat?: { id: number };
  forward_origin?: {
    type: string;
    chat?: { id: number; username?: string };
    message_id?: number;
  };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
  video?: {
    file_id: string;
    file_size?: number;
    width: number;
    height: number;
    duration: number;
    file_name?: string;
  };
  reply_to_message?: { message_id: number; chat: { id: number } };
  message_thread_id?: number;
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export type TelegramTransport = (
  method: string,
  body?: URLSearchParams | FormData,
) => Promise<unknown>;

export function createTransport(token: string, fetchImpl: typeof fetch = fetch): TelegramTransport {
  return async (method, body) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(300_000),
    });
    const raw = await response.text();
    if (!raw) throw unknownState(method, "empty response");
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw unknownState(method, "non-JSON response");
    }
  };
}

export function requireResult<T>(value: unknown, method: string): T {
  const envelope = value as TelegramEnvelope<T>;
  if (!envelope || envelope.ok !== true || envelope.result === undefined) {
    throw unknownState(method, envelope?.description ?? "ok/result absent");
  }
  return envelope.result;
}

export function requireMessage(value: unknown, method: string): TelegramMessage {
  const message = requireResult<TelegramMessage>(value, method);
  if (!Number.isInteger(message.message_id)) throw unknownState(method, "message_id absent");
  return message;
}

export function unknownState(method: string, reason: string): AdapterError {
  return new AdapterError(
    ErrorCode.VERIFY_FAILED,
    `${method}: Telegram state UNKNOWN; do not retry blindly (${reason})`,
    { unknown: true, reconcileRequired: true, method },
  );
}
