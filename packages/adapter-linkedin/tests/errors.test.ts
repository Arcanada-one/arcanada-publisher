import { describe, it, expect } from "vitest";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { mapLiError, classifyLiError } from "../src/errors.js";

describe("errors — li-publish taxonomy → core ErrorCode mapping", () => {
  it("not_logged_in → NO_PROFILE (3)", () => {
    const err = mapLiError("not_logged_in");
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.code).toBe(ErrorCode.NO_PROFILE);
    expect(err.details).toMatchObject({ liErrorType: "not_logged_in" });
  });

  it("composer_not_found → PUBLISH_BUTTON_ABSENT (5)", () => {
    expect(mapLiError("composer_not_found").code).toBe(ErrorCode.PUBLISH_BUTTON_ABSENT);
  });

  it("publish_button_disabled → PUBLISH_BUTTON_ABSENT (5)", () => {
    expect(mapLiError("publish_button_disabled").code).toBe(ErrorCode.PUBLISH_BUTTON_ABSENT);
  });

  it("captcha → RATE_LIMIT (8)", () => {
    expect(mapLiError("captcha").code).toBe(ErrorCode.RATE_LIMIT);
  });

  it("timeout → SELECTOR_TIMEOUT (4)", () => {
    expect(mapLiError("timeout").code).toBe(ErrorCode.SELECTOR_TIMEOUT);
  });

  it("runtime_error → INTERNAL_PANIC (99)", () => {
    expect(mapLiError("runtime_error").code).toBe(ErrorCode.INTERNAL_PANIC);
  });

  it("verify_mismatch → VERIFY_FAILED (6)", () => {
    expect(mapLiError("verify_mismatch").code).toBe(ErrorCode.VERIFY_FAILED);
  });

  it("urn_not_found → VERIFY_FAILED (6) [INFRA-0260 surface]", () => {
    const err = mapLiError("urn_not_found");
    expect(err.code).toBe(ErrorCode.VERIFY_FAILED);
    expect(err.details).toMatchObject({ liErrorType: "urn_not_found" });
  });

  it("unknown fallback → INTERNAL_PANIC (99)", () => {
    expect(mapLiError("unknown").code).toBe(ErrorCode.INTERNAL_PANIC);
  });

  it("mapLiError refuses to map 'ok'", () => {
    expect(() => mapLiError("ok")).toThrow();
  });

  it("classifyLiError detects not_logged_in blob (RU+EN)", () => {
    expect(classifyLiError("Войти в LinkedIn")).toBe("not_logged_in");
    expect(classifyLiError("Sign in to LinkedIn to continue")).toBe("not_logged_in");
    expect(classifyLiError('<input name="session_key">')).toBe("not_logged_in");
  });

  it("classifyLiError detects captcha", () => {
    expect(classifyLiError("Подтвердите, что вы человек")).toBe("captcha");
    expect(classifyLiError("Please verify you are human")).toBe("captcha");
  });

  it("classifyLiError detects rate limit indicator (RU+EN)", () => {
    expect(classifyLiError("Your account is temporarily restricted")).toBe("captcha");
    expect(classifyLiError("Аккаунт временно заблокирован")).toBe("captcha");
  });

  it("classifyLiError detects timeout", () => {
    expect(classifyLiError("Error: Timeout 30000ms exceeded.")).toBe("timeout");
  });

  it("classifyLiError detects publish_button_disabled", () => {
    expect(classifyLiError('button "Опубликовать" [disabled] [ref=e12]')).toBe(
      "publish_button_disabled",
    );
  });

  it("classifyLiError detects runtime_error", () => {
    expect(classifyLiError("connection refused while spawning chromium")).toBe("runtime_error");
  });

  it("classifyLiError returns 'unknown' on benign blobs", () => {
    expect(classifyLiError("Welcome back to LinkedIn")).toBe("unknown");
    expect(classifyLiError("")).toBe("unknown");
  });
});
