import { describe, it, expect } from "vitest";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { mapFbError, classifyFbError } from "../src/errors.js";

describe("errors — fb-publish taxonomy → core ErrorCode mapping (AC-4)", () => {
  it("not_logged_in → NO_PROFILE (3)", () => {
    const err = mapFbError("not_logged_in");
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.code).toBe(ErrorCode.NO_PROFILE);
    expect(err.details).toMatchObject({ fbErrorType: "not_logged_in" });
  });

  it("composer_not_found → PUBLISH_BUTTON_ABSENT (5)", () => {
    expect(mapFbError("composer_not_found").code).toBe(ErrorCode.PUBLISH_BUTTON_ABSENT);
  });

  it("publish_button_disabled → PUBLISH_BUTTON_ABSENT (5)", () => {
    expect(mapFbError("publish_button_disabled").code).toBe(ErrorCode.PUBLISH_BUTTON_ABSENT);
  });

  it("captcha → RATE_LIMIT (8)", () => {
    expect(mapFbError("captcha").code).toBe(ErrorCode.RATE_LIMIT);
  });

  it("timeout → SELECTOR_TIMEOUT (4)", () => {
    expect(mapFbError("timeout").code).toBe(ErrorCode.SELECTOR_TIMEOUT);
  });

  it("runtime_error → INTERNAL_PANIC (99)", () => {
    expect(mapFbError("runtime_error").code).toBe(ErrorCode.INTERNAL_PANIC);
  });

  it("verify_mismatch → VERIFY_FAILED (6)", () => {
    expect(mapFbError("verify_mismatch").code).toBe(ErrorCode.VERIFY_FAILED);
  });

  it("unknown fallback → INTERNAL_PANIC (99)", () => {
    expect(mapFbError("unknown").code).toBe(ErrorCode.INTERNAL_PANIC);
  });

  it("drops raw cause messages and path-bearing nested details", () => {
    const secret = "/private/operator/secret.txt";
    const error = mapFbError("runtime_error", {
      message: secret,
      cause: new Error(secret),
      extra: { cause: { message: secret }, filePath: secret, stage: "composer_open" },
    });
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("cause");
    expect(error.details).toEqual({ fbErrorType: "runtime_error", stage: "composer_open" });
  });

  it("mapFbError refuses to map 'ok'", () => {
    expect(() => mapFbError("ok")).toThrow();
  });

  it("classifyFbError detects not_logged_in blob", () => {
    expect(classifyFbError("Войти в Facebook")).toBe("not_logged_in");
    expect(classifyFbError("Log into Facebook to continue")).toBe("not_logged_in");
  });

  it("classifyFbError detects captcha", () => {
    expect(classifyFbError("Пожалуйста, пройдите проверку безопасности")).toBe("captcha");
  });

  it("classifyFbError detects timeout", () => {
    expect(classifyFbError("Error: Timeout 30000ms exceeded.")).toBe("timeout");
  });

  it("classifyFbError detects publish_button_disabled", () => {
    expect(classifyFbError('button "Опубликовать" [disabled] [ref=e12]')).toBe(
      "publish_button_disabled",
    );
  });

  it("classifyFbError detects runtime_error", () => {
    expect(classifyFbError("connection refused while spawning chromium daemon")).toBe(
      "runtime_error",
    );
  });

  it("classifyFbError returns 'unknown' on benign blobs", () => {
    expect(classifyFbError("Welcome to Facebook")).toBe("unknown");
    expect(classifyFbError("")).toBe("unknown");
  });
});
