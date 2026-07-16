import { describe, it, expect } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import {
  detectExpiredFromUrl,
  assertAuthorized,
  type SessionState,
} from "../../src/browser/session-guard.js";

const LOGGED_IN: SessionState = {
  loggedIn: true,
  accountId: "12345",
  accountName: "Pavel Valentov",
  url: "https://vk.com/feed",
};

describe("vk browser — expired-session detection", () => {
  it("flags login / VK ID auth / restore redirect URLs as expired", () => {
    for (const u of [
      "https://vk.com/login?role=fast&to=feed",
      "https://id.vk.com/auth?app_id=1",
      "https://id.vk.ru/auth",
      "https://vk.com/restore",
    ]) {
      expect(detectExpiredFromUrl(u)).toBe(true);
    }
  });

  it("does not flag the authorised feed / wall URLs", () => {
    for (const u of ["https://vk.com/feed", "https://vk.com/id12345", "https://vk.com/wall12345_10"]) {
      expect(detectExpiredFromUrl(u)).toBe(false);
    }
  });
});

describe("vk browser — fail-closed authorization (positive check)", () => {
  it("passes when logged in AND identity matches the expected account", () => {
    expect(() =>
      assertAuthorized(LOGGED_IN, { accountId: "12345" }),
    ).not.toThrow();
    expect(() =>
      assertAuthorized(LOGGED_IN, { accountName: "Pavel Valentov" }),
    ).not.toThrow();
  });

  it("STOPs with NO_PROFILE when not logged in (expired/absent session)", () => {
    const expired: SessionState = { loggedIn: false, url: "https://vk.com/login" };
    expect(() => assertAuthorized(expired, { accountId: "12345" })).toThrowError(
      expect.objectContaining({ code: ErrorCode.NO_PROFILE }),
    );
  });

  it("STOPs with VERIFY_FAILED when logged in as the WRONG account (identity mismatch)", () => {
    expect(() =>
      assertAuthorized(LOGGED_IN, { accountId: "99999" }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }));
    expect(() =>
      assertAuthorized(LOGGED_IN, { accountName: "Someone Else" }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.VERIFY_FAILED }));
  });

  it("STOPs with NO_PROFILE when logged in but no identity is observable", () => {
    const noId: SessionState = { loggedIn: true, url: "https://vk.com/feed" };
    expect(() => assertAuthorized(noId, { accountId: "12345" })).toThrowError(
      expect.objectContaining({ code: ErrorCode.NO_PROFILE }),
    );
  });
});
