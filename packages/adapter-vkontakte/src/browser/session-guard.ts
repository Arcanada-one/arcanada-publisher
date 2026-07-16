// Fail-closed session/identity guard for the VK browser mode (D-REQ-02).
//
// Before every mutating action the adapter reads a SessionState off the live
// page and calls `assertAuthorized`. This is a POSITIVE check: it is not enough
// that no login redirect is present — the observed account must match the
// expected operator account. Absence of a login redirect is only a secondary
// (negative) signal, surfaced by `detectExpiredFromUrl`.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface SessionState {
  /** True only when an authorised-UI element (avatar / user menu) is present. */
  loggedIn: boolean;
  /** Numeric VK id of the logged-in user, when observable. */
  accountId?: string;
  /** Display name of the logged-in user, when observable. */
  accountName?: string;
  /** The URL the page currently sits on (for redirect-based expiry detection). */
  url: string;
}

export interface ExpectedAccount {
  accountId?: string;
  accountName?: string;
}

// Path prefixes a logged-out browser is redirected to, per host.
const VK_LOGOUT_PATHS = /^\/(login|restore)\b/;
const ID_AUTH_PATHS = /^\/auth\b/;

/** Negative signal: the URL looks like a logged-out redirect target. */
export function detectExpiredFromUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  if ((host === "vk.com" || host === "vk.ru" || host === "m.vk.com") && VK_LOGOUT_PATHS.test(parsed.pathname)) {
    return true;
  }
  if ((host === "id.vk.com" || host === "id.vk.ru") && ID_AUTH_PATHS.test(parsed.pathname)) {
    return true;
  }
  return false;
}

/**
 * Fail-closed authorization. Throws:
 *  - `NO_PROFILE` when not logged in, or logged in but no identity is observable
 *    (we cannot prove the account, so we must not act);
 *  - `VERIFY_FAILED` when logged in as an account that does not match `expected`.
 * Returns silently only on a positive identity match.
 */
export function assertAuthorized(state: SessionState, expected: ExpectedAccount): void {
  if (!state.loggedIn || detectExpiredFromUrl(state.url)) {
    throw new AdapterError(
      ErrorCode.NO_PROFILE,
      "vk: session is not authorised (expired or absent) — operator must log in (headed)",
      { url: state.url },
    );
  }
  const wantId = expected.accountId;
  const wantName = expected.accountName;
  if (wantId === undefined && wantName === undefined) {
    // Caller asked for no identity — degenerate; require an explicit expectation.
    throw new AdapterError(
      ErrorCode.NO_PROFILE,
      "vk: no expected account provided — cannot assert identity",
    );
  }
  if (wantId !== undefined) {
    if (state.accountId === undefined) {
      throw new AdapterError(
        ErrorCode.NO_PROFILE,
        "vk: logged-in account id is not observable — cannot confirm identity, STOP",
        { url: state.url },
      );
    }
    if (state.accountId !== wantId) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        `vk: logged in as account ${state.accountId}, expected ${wantId} — STOP before any publish`,
        { observed: state.accountId, expected: wantId },
      );
    }
  }
  if (wantName !== undefined) {
    if (state.accountName === undefined) {
      throw new AdapterError(
        ErrorCode.NO_PROFILE,
        "vk: logged-in account name is not observable — cannot confirm identity, STOP",
      );
    }
    if (state.accountName !== wantName) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        `vk: logged in as "${state.accountName}", expected "${wantName}" — STOP`,
        { observed: state.accountName, expected: wantName },
      );
    }
  }
}
