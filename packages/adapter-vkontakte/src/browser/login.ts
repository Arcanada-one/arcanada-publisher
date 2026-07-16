// Headed-only, operator-driven VK login. Ported from adapter-facebook/src/login.ts.
// Polls until the authorised-UI element is visible (operator finished sign-in,
// incl. 2FA via VK ID). The persistent profile dir is created (chmod 700) if
// missing. Throws SELECTOR_TIMEOUT after the polling budget elapses.

import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  type LoginOptions,
} from "@arcanada/publisher-core";
import { launchSession } from "./context.js";

const LOGIN_POLL_INTERVAL_MS = 5_000;
const LOGIN_POLL_ITERATIONS = 60;
const VK_FEED = "https://vk.com/feed";

export interface LoginContext {
  profileManager?: ProfileManager;
}

export async function login(options: LoginOptions, ctx: LoginContext = {}): Promise<void> {
  if (!options.headed) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "vk browser login MUST be headed (operator-driven sign-in required, incl. VK ID 2FA)",
    );
  }
  const profiles = ctx.profileManager ?? new ProfileManager();
  const profileDir = profiles.exists("vkontakte", options.profile)
    ? profiles.getProfilePath("vkontakte", options.profile)
    : profiles.createEmptyProfile("vkontakte", options.profile);

  const session = await launchSession({ profileDir, headed: true });
  try {
    await session.page.goto(VK_FEED);
    // The user-menu / avatar button becomes visible once sign-in completes.
    const authed = session.page
      .locator('[data-testid="rc_menu_button"], .TopNavBtn__profile, a[href^="/id"]')
      .first();
    for (let i = 0; i < LOGIN_POLL_ITERATIONS; i++) {
      try {
        if (await authed.isVisible()) return;
      } catch {
        // page may still be reloading — ignore intermediate errors
      }
      await session.page.waitForTimeout(LOGIN_POLL_INTERVAL_MS);
    }
    throw new AdapterError(
      ErrorCode.SELECTOR_TIMEOUT,
      `vk login timed out after ${LOGIN_POLL_ITERATIONS * LOGIN_POLL_INTERVAL_MS}ms`,
      { profile: options.profile },
    );
  } finally {
    await session.close();
  }
}
