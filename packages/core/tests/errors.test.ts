import { describe, it, expect } from "vitest";
import { AdapterError, ErrorCode } from "../src/errors.js";

describe("ErrorCode enum", () => {
  it("pins canonical numeric values", () => {
    expect(ErrorCode.SUCCESS).toBe(0);
    expect(ErrorCode.INVALID_ARGS).toBe(1);
    expect(ErrorCode.MISSING_INPUT).toBe(2);
    expect(ErrorCode.NO_PROFILE).toBe(3);
    expect(ErrorCode.SELECTOR_TIMEOUT).toBe(4);
    expect(ErrorCode.PUBLISH_BUTTON_ABSENT).toBe(5);
    expect(ErrorCode.VERIFY_FAILED).toBe(6);
    expect(ErrorCode.NETWORK_GUARD).toBe(7);
    expect(ErrorCode.RATE_LIMIT).toBe(8);
    expect(ErrorCode.INTERNAL_PANIC).toBe(99);
  });
});

describe("AdapterError", () => {
  it("captures code, message, and optional details", () => {
    const err = new AdapterError(ErrorCode.NETWORK_GUARD, "boom", { bind: "0.0.0.0" });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(ErrorCode.NETWORK_GUARD);
    expect(err.message).toBe("boom");
    expect(err.name).toBe("AdapterError");
    expect(err.details).toEqual({ bind: "0.0.0.0" });
  });

  it("serializes via toJSON with details when present", () => {
    const err = new AdapterError(ErrorCode.RATE_LIMIT, "slow down", { hits: 12 });
    expect(err.toJSON()).toEqual({
      code: ErrorCode.RATE_LIMIT,
      name: "AdapterError",
      message: "slow down",
      details: { hits: 12 },
    });
  });

  it("omits details from toJSON when not supplied", () => {
    const err = new AdapterError(ErrorCode.INVALID_ARGS, "bad flag");
    const json = err.toJSON();
    expect(json).toEqual({
      code: ErrorCode.INVALID_ARGS,
      name: "AdapterError",
      message: "bad flag",
    });
    expect("details" in json).toBe(false);
  });
});
