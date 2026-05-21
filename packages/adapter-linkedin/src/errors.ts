// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21 (PUB-0004)
// Source: lib/playwright-helpers.sh (pw_classify_error / pw_error_exit_code)
//
// li-publish error taxonomy → core ErrorCode mapping. Lossy by design (LI has
// more LinkedIn-specific distinctions than the core enum); the original token
// is preserved in `AdapterError.details.liErrorType` for forensics.
//
// New token vs FB adapter: `urn_not_found` (INFRA-0260 surface — Activity URN
// extraction failure).

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { isCaptchaBlob, selectors } from "./selectors.js";

export type LiErrorType =
  | "ok"
  | "not_logged_in"
  | "composer_not_found"
  | "publish_button_disabled"
  | "captcha"
  | "timeout"
  | "runtime_error"
  | "verify_mismatch"
  | "urn_not_found"
  | "unknown";

const MAPPING: Record<Exclude<LiErrorType, "ok" | "unknown">, ErrorCode> = {
  not_logged_in: ErrorCode.NO_PROFILE,
  composer_not_found: ErrorCode.PUBLISH_BUTTON_ABSENT,
  publish_button_disabled: ErrorCode.PUBLISH_BUTTON_ABSENT,
  captcha: ErrorCode.RATE_LIMIT,
  timeout: ErrorCode.SELECTOR_TIMEOUT,
  runtime_error: ErrorCode.INTERNAL_PANIC,
  verify_mismatch: ErrorCode.VERIFY_FAILED,
  urn_not_found: ErrorCode.VERIFY_FAILED,
};

const MESSAGES: Record<Exclude<LiErrorType, "ok" | "unknown">, string> = {
  not_logged_in: "LinkedIn session expired or profile not logged in",
  composer_not_found:
    "Composer / Post button not found — UI drift or guideline violation suspected",
  publish_button_disabled: "Post button disabled — guideline violation suspected",
  captcha: "LinkedIn security check / captcha detected — operator headed re-login required",
  timeout: "Playwright selector timeout — locator did not become ready",
  runtime_error: "Internal Playwright / Chromium runtime error",
  verify_mismatch: "Post-publish verification failed — URL or content mismatch",
  urn_not_found: "Activity URN not found in toast or recent-activity feed (INFRA-0260 surface)",
};

/** Map a `LiErrorType` token to an `AdapterError`. */
export function mapLiError(
  liErrorType: LiErrorType,
  detail?: { message?: string; cause?: unknown; extra?: Record<string, unknown> },
): AdapterError {
  if (liErrorType === "ok") {
    throw new Error("mapLiError: cannot map 'ok' to AdapterError");
  }
  const code: ErrorCode =
    liErrorType === "unknown" ? ErrorCode.INTERNAL_PANIC : MAPPING[liErrorType];
  const baseMessage =
    liErrorType === "unknown" ? "Unrecognised li-publish error type" : MESSAGES[liErrorType];
  const finalMessage = detail?.message ? `${baseMessage}: ${detail.message}` : baseMessage;
  return new AdapterError(code, finalMessage, {
    liErrorType,
    ...(detail?.cause !== undefined ? { cause: serializeCause(detail.cause) } : {}),
    ...(detail?.extra ?? {}),
  });
}

/**
 * Classify a Playwright / LinkedIn error blob (snapshot text + stderr) into a
 * `LiErrorType`. Mirrors `pw_classify_error()` from li-publish helpers.
 */
export function classifyLiError(blob: string): LiErrorType {
  if (!blob) {
    return "unknown";
  }
  if (
    /(Sign in to LinkedIn|Войти в LinkedIn|input.*name="session_key"|Email or phone)/i.test(blob)
  ) {
    return "not_logged_in";
  }
  if (isCaptchaBlob(blob) || selectors.rateLimitIndicator.test(blob)) {
    return "captcha";
  }
  if (/(timeout|deadline exceeded|navigation timeout)/i.test(blob)) {
    return "timeout";
  }
  if (/button.*"(Опубликовать|Post)".*\[disabled\]/i.test(blob)) {
    return "publish_button_disabled";
  }
  if (/(daemon|pid|browser|connection refused|ECONNREFUSED|target closed)/i.test(blob)) {
    return "runtime_error";
  }
  return "unknown";
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return cause;
}
