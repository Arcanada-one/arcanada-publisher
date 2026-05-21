// Migrated from Arcanada-one/fb-publish@8df49fa51822795075f746ad7389c8bd400b1aa4 on 2026-05-21 (PUB-0003)
// Source: bin/fb-publish.sh (headed login polling).

import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  type LoginOptions,
} from "@arcanada/publisher-core";
import { launchSession } from "./context.js";
import { selectors } from "./selectors.js";

const LOGIN_POLL_INTERVAL_MS = 5_000;
const LOGIN_POLL_ITERATIONS = 60;
const FB_HOME = "https://www.facebook.com/";

export interface LoginContext {
  profileManager?: ProfileManager;
}

/**
 * Headed-only first-time login. Polls every 5s up to 5 minutes until the
 * composer button becomes visible (= operator has finished sign-in).
 *
 * The persistent profile dir is created (chmod 700) if missing. Returns
 * silently on success; throws `AdapterError(SELECTOR_TIMEOUT)` after the
 * polling budget elapses.
 */
export async function login(options: LoginOptions, ctx: LoginContext = {}): Promise<void> {
  if (!options.headed) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "facebook login MUST be headed (operator-driven sign-in required)",
    );
  }
  const profiles = ctx.profileManager ?? new ProfileManager();
  const profileDir = profiles.exists("facebook", options.profile)
    ? profiles.getProfilePath("facebook", options.profile)
    : profiles.createEmptyProfile("facebook", options.profile);

  const session = await launchSession({ profileDir, headed: true });
  try {
    await session.page.goto(FB_HOME);
    const composer = session.page.getByRole("button", { name: selectors.composerButton }).first();
    for (let i = 0; i < LOGIN_POLL_ITERATIONS; i++) {
      try {
        if (await composer.isVisible()) {
          return;
        }
      } catch {
        // ignore intermediate evaluation errors — page may still be reloading
      }
      await session.page.waitForTimeout(LOGIN_POLL_INTERVAL_MS);
    }
    throw new AdapterError(
      ErrorCode.SELECTOR_TIMEOUT,
      `facebook login timed out after ${LOGIN_POLL_ITERATIONS * LOGIN_POLL_INTERVAL_MS}ms`,
      { profile: options.profile },
    );
  } finally {
    await session.close();
  }
}
