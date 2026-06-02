// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21
// Source: bin/li-publish.sh (headed login polling).

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
const LINKEDIN_HOME = "https://www.linkedin.com/feed/";

export interface LoginContext {
  profileManager?: ProfileManager;
}

/**
 * Headed-only first-time login. Polls every 5s up to 5 minutes until the
 * Start-a-post button becomes visible (= operator has finished sign-in and
 * landed on the feed).
 */
export async function login(options: LoginOptions, ctx: LoginContext = {}): Promise<void> {
  if (!options.headed) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "linkedin login MUST be headed (operator-driven sign-in required)",
    );
  }
  const profiles = ctx.profileManager ?? new ProfileManager();
  const profileDir = profiles.exists("linkedin", options.profile)
    ? profiles.getProfilePath("linkedin", options.profile)
    : profiles.createEmptyProfile("linkedin", options.profile);

  const session = await launchSession({ profileDir, headed: true });
  try {
    await session.page.goto(LINKEDIN_HOME);
    const startPost = session.page.getByRole("button", { name: selectors.startPostButton }).first();
    for (let i = 0; i < LOGIN_POLL_ITERATIONS; i++) {
      try {
        if (await startPost.isVisible()) {
          return;
        }
      } catch {
        // intermediate evaluation errors are non-fatal — page may still be loading
      }
      await session.page.waitForTimeout(LOGIN_POLL_INTERVAL_MS);
    }
    throw new AdapterError(
      ErrorCode.SELECTOR_TIMEOUT,
      `linkedin login timed out after ${LOGIN_POLL_ITERATIONS * LOGIN_POLL_INTERVAL_MS}ms`,
      { profile: options.profile },
    );
  } finally {
    await session.close();
  }
}
