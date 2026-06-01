// Headed-only first-time X login. R12: if X surfaces the anti-bot rate-limit
// notice during sign-in, we STOP and report — the limit is never circumvented.

import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  type LoginOptions,
} from "@arcanada/publisher-core";
import { launchSession } from "./context.js";
import { selectors, isRateLimited } from "./selectors.js";

const LOGIN_POLL_INTERVAL_MS = 5_000;
const LOGIN_POLL_ITERATIONS = 60;
const X_HOME = "https://x.com/home";

export interface LoginContext {
  profileManager?: ProfileManager;
}

export async function login(options: LoginOptions, ctx: LoginContext = {}): Promise<void> {
  if (!options.headed) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "x login MUST be headed (operator-driven sign-in required)",
    );
  }
  const profiles = ctx.profileManager ?? new ProfileManager();
  const profileDir = profiles.exists("x", options.profile)
    ? profiles.getProfilePath("x", options.profile)
    : profiles.createEmptyProfile("x", options.profile);

  const session = await launchSession({ profileDir, headed: true });
  try {
    await session.page.goto(X_HOME);
    const composeBtn = session.page.locator(selectors.loginCheck).first();
    for (let i = 0; i < LOGIN_POLL_ITERATIONS; i++) {
      // R12: bail out the moment X rate-limits — do not keep retrying sign-in.
      const blob = await safeContent(session.page);
      if (isRateLimited(blob)) {
        throw new AdapterError(
          ErrorCode.RATE_LIMIT,
          "x login: anti-bot rate-limit detected — stopping (limit must not be circumvented)",
          { xErrorType: "rate_limited", profile: options.profile },
        );
      }
      try {
        if (await composeBtn.isVisible()) {
          return;
        }
      } catch {
        // page may still be reloading
      }
      await session.page.waitForTimeout(LOGIN_POLL_INTERVAL_MS);
    }
    throw new AdapterError(
      ErrorCode.SELECTOR_TIMEOUT,
      `x login timed out after ${LOGIN_POLL_ITERATIONS * LOGIN_POLL_INTERVAL_MS}ms`,
      { profile: options.profile },
    );
  } finally {
    await session.close();
  }
}

async function safeContent(page: { content(): Promise<string> }): Promise<string> {
  try {
    return await page.content();
  } catch {
    return "";
  }
}
