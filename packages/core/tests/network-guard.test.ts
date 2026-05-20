import { describe, it, expect } from "vitest";
import { assertLoopback, isLoopback } from "../src/network-guard.js";
import { AdapterError, ErrorCode } from "../src/errors.js";

describe("isLoopback", () => {
  it.each(["127.0.0.1", "localhost", "::1"])("accepts %s", (bind) => {
    expect(isLoopback(bind)).toBe(true);
  });

  it.each(["0.0.0.0", "1.2.3.4", "example.com", "", "192.168.1.1", "::"])("rejects %s", (bind) => {
    expect(isLoopback(bind)).toBe(false);
  });
});

describe("assertLoopback", () => {
  it.each(["127.0.0.1", "localhost", "::1"])("does not throw on %s", (bind) => {
    expect(() => assertLoopback(bind)).not.toThrow();
  });

  it.each([["0.0.0.0"], ["1.2.3.4"], ["example.com"]])(
    "throws AdapterError(NETWORK_GUARD) on %s",
    (bind) => {
      let caught: unknown;
      try {
        assertLoopback(bind);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AdapterError);
      const e = caught as AdapterError;
      expect(e.code).toBe(ErrorCode.NETWORK_GUARD);
      expect(e.details).toMatchObject({ bind });
    },
  );
});
