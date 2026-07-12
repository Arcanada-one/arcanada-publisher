// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21
// Source: lib/playwright-helpers.sh (pw_classify_error / pw_error_exit_code)
//
// fb-publish error taxonomy → core ErrorCode mapping. See the fb-publish migration fixtures doc § 3.
// Mapping is lossy by design (FB has more distinctions than core enum);
// `AdapterError.details.fbErrorType` carries the original token for forensics.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { isCaptchaBlob, selectors } from "./selectors.js";

/** Source taxonomy from fb-publish/lib/playwright-helpers.sh:43-58. */
export type FbErrorType =
  | "ok"
  | "not_logged_in"
  | "composer_not_found"
  | "publish_button_disabled"
  | "captcha"
  | "timeout"
  | "runtime_error"
  | "verify_mismatch"
  | "unknown";

const MAPPING: Record<Exclude<FbErrorType, "ok" | "unknown">, ErrorCode> = {
  not_logged_in: ErrorCode.NO_PROFILE,
  composer_not_found: ErrorCode.PUBLISH_BUTTON_ABSENT,
  publish_button_disabled: ErrorCode.PUBLISH_BUTTON_ABSENT,
  captcha: ErrorCode.RATE_LIMIT,
  timeout: ErrorCode.SELECTOR_TIMEOUT,
  runtime_error: ErrorCode.INTERNAL_PANIC,
  verify_mismatch: ErrorCode.VERIFY_FAILED,
};

const MESSAGES: Record<Exclude<FbErrorType, "ok" | "unknown">, string> = {
  not_logged_in: "Facebook session expired or profile not logged in",
  composer_not_found:
    "Composer/Publish button not found — UI drift or guideline violation suspected",
  publish_button_disabled: "Publish button disabled — guideline violation suspected",
  captcha: "Facebook security check / captcha detected — operator headed re-login required",
  timeout: "Playwright selector timeout — locator did not become ready",
  runtime_error: "Internal Playwright/Chromium runtime error",
  verify_mismatch: "Post-publish verification failed — parent_id or post_url mismatch",
};

/** Map an `FbErrorType` token to an `AdapterError`. */
export function mapFbError(
  fbErrorType: FbErrorType,
  detail?: { message?: string; cause?: unknown; extra?: Record<string, unknown> },
): AdapterError {
  if (fbErrorType === "ok") {
    throw new Error("mapFbError: cannot map 'ok' to AdapterError");
  }
  const code: ErrorCode =
    fbErrorType === "unknown" ? ErrorCode.INTERNAL_PANIC : MAPPING[fbErrorType];
  const baseMessage =
    fbErrorType === "unknown" ? "Unrecognised fb-publish error type" : MESSAGES[fbErrorType];
  return new AdapterError(
    code,
    baseMessage,
    sanitizeDetails({
      fbErrorType,
      ...(detail?.extra ?? {}),
    }),
  );
}

const SAFE_DETAIL_KEY =
  /^(stage|code|artifactId|unknown|reconcileRequired|fbErrorType|[A-Za-z0-9]*(Id|Ids|Hash|Sha256|Length|Lengths))$/;

export function sanitizeAdapterError(error: AdapterError, artifactId?: string): AdapterError {
  const details = sanitizeDetails(error.details ?? {});
  if (artifactId) details["artifactId"] = artifactId;
  return new AdapterError(error.code, error.message, details);
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(
      ([key, value]) =>
        SAFE_DETAIL_KEY.test(key) &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          (Array.isArray(value) &&
            value.every((item) => ["string", "number", "boolean"].includes(typeof item)))),
    ),
  );
}

/**
 * Classify a Playwright/FB error blob (snapshot text + stderr) into an `FbErrorType`.
 * Mirrors `pw_classify_error()` from fb-publish/lib/playwright-helpers.sh.
 */
export function classifyFbError(blob: string): FbErrorType {
  if (!blob) {
    return "unknown";
  }
  if (
    /(textbox\s+"Email)|(input.*name="email")|(Войти в Facebook)|(Log into Facebook)|(Email or phone)/i.test(
      blob,
    )
  ) {
    return "not_logged_in";
  }
  if (isCaptchaBlob(blob) || selectors.rateLimitIndicator.test(blob)) {
    return "captcha";
  }
  if (/(timeout|deadline exceeded|navigation timeout)/i.test(blob)) {
    return "timeout";
  }
  if (/button.*"(Опубликовать|Post|Publish)".*\[disabled\]/i.test(blob)) {
    return "publish_button_disabled";
  }
  if (/(daemon|pid|browser|connection refused|ECONNREFUSED|target closed)/i.test(blob)) {
    return "runtime_error";
  }
  return "unknown";
}
