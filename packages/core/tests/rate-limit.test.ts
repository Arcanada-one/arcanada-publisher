import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RateLimiter, DEFAULT_RATE_PER_HOUR, WINDOW_MS } from "../src/rate-limit.js";
import { AdapterError, ErrorCode } from "../src/errors.js";

describe("RateLimiter", () => {
  // A mutable clock the limiter reads through its injected `now()`.
  let clock: number;
  const now = (): number => clock;

  beforeEach(() => {
    clock = 1_000_000_000_000; // fixed epoch ms
    delete process.env.ARCANADA_PUBLISHER_RATE_X;
    delete process.env.ARCANADA_PUBLISHER_RATE_FACEBOOK;
  });

  afterEach(() => {
    delete process.env.ARCANADA_PUBLISHER_RATE_X;
    delete process.env.ARCANADA_PUBLISHER_RATE_FACEBOOK;
  });

  it("does not throw while under the default limit", () => {
    const rl = new RateLimiter({ now });
    for (let i = 0; i < DEFAULT_RATE_PER_HOUR; i++) {
      expect(() => rl.check("x")).not.toThrow();
      rl.record("x");
    }
  });

  it("throws AdapterError(RATE_LIMIT) on the call that would exceed the limit", () => {
    const rl = new RateLimiter({ now });
    for (let i = 0; i < DEFAULT_RATE_PER_HOUR; i++) {
      rl.check("x");
      rl.record("x");
    }
    let caught: unknown;
    try {
      rl.check("x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as AdapterError).code).toBe(ErrorCode.RATE_LIMIT);
    expect((caught as AdapterError).details).toMatchObject({
      platform: "x",
      limit: DEFAULT_RATE_PER_HOUR,
    });
  });

  it("counts platforms independently", () => {
    const rl = new RateLimiter({ now });
    for (let i = 0; i < DEFAULT_RATE_PER_HOUR; i++) {
      rl.check("x");
      rl.record("x");
    }
    // x is now saturated, but facebook has a fresh budget.
    expect(() => rl.check("x")).toThrow();
    expect(() => rl.check("facebook")).not.toThrow();
  });

  it("frees budget once events age out of the sliding window", () => {
    const rl = new RateLimiter({ now });
    for (let i = 0; i < DEFAULT_RATE_PER_HOUR; i++) {
      rl.check("x");
      rl.record("x");
    }
    expect(() => rl.check("x")).toThrow();
    // Advance just past the window — all prior events expire.
    clock += WINDOW_MS + 1;
    expect(() => rl.check("x")).not.toThrow();
  });

  it("respects the ARCANADA_PUBLISHER_RATE_<PLATFORM> env override", () => {
    process.env.ARCANADA_PUBLISHER_RATE_X = "2";
    const rl = new RateLimiter({ now });
    rl.check("x");
    rl.record("x");
    rl.check("x");
    rl.record("x");
    expect(() => rl.check("x")).toThrow();
  });

  it("ignores a non-numeric env override and falls back to the default", () => {
    process.env.ARCANADA_PUBLISHER_RATE_X = "not-a-number";
    const rl = new RateLimiter({ now });
    for (let i = 0; i < DEFAULT_RATE_PER_HOUR; i++) {
      rl.check("x");
      rl.record("x");
    }
    expect(() => rl.check("x")).toThrow();
  });

  it("prunes timestamps older than the window to bound memory", () => {
    const rl = new RateLimiter({ now });
    rl.record("x");
    rl.record("x");
    expect(rl.count("x")).toBe(2);
    clock += WINDOW_MS + 1;
    // check() prunes as a side effect.
    rl.check("x");
    expect(rl.count("x")).toBe(0);
  });
});
