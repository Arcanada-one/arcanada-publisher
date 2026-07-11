// Adapter factory: map a platform string to a constructed Adapter. Browser
// adapters (facebook/linkedin/x) need no constructor args; the API adapters
// (reddit/vkontakte) need an access token supplied via the environment.

import { type Adapter, type Platform, AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { FacebookAdapter } from "@arcanada/publisher-facebook";
import { LinkedInAdapter } from "@arcanada/publisher-linkedin";
import { XAdapter } from "@arcanada/publisher-x";
import { RedditAdapter } from "@arcanada/publisher-reddit";
import { VKontakteAdapter } from "@arcanada/publisher-vkontakte";
import { TelegramAdapter } from "@arcanada/publisher-telegram";
import { type ParsedArgs } from "./parse-args.js";

export function makeAdapter(platform: Platform, args: ParsedArgs): Adapter {
  switch (platform) {
    case "facebook":
      return new FacebookAdapter();
    case "linkedin":
      return new LinkedInAdapter();
    case "x":
      // PUB-0033: --headed runs a visible browser so large video uploads settle
      // reliably; default (no flag) keeps the headless behaviour.
      return args.headed
        ? new XAdapter({
            publishOptions: { headed: true },
            commentOptions: { headed: true },
          })
        : new XAdapter();
    case "reddit":
      return new RedditAdapter({ accessToken: requireToken("REDDIT_ACCESS_TOKEN", args) });
    case "vkontakte":
      return new VKontakteAdapter({ accessToken: requireToken("VK_ACCESS_TOKEN", args) });
    case "telegram":
      return makeTelegramAdapter(requireToken("TELEGRAM_BOT_TOKEN", args));
    default:
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        `unsupported platform '${platform as string}'`,
      );
  }
}

function telegramAllowedChats(): string[] | undefined {
  const value = process.env["TELEGRAM_ALLOWED_CHAT_IDS"];
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
}

function makeTelegramAdapter(botToken: string): TelegramAdapter {
  const allowedLiveChatIds = telegramAllowedChats();
  return new TelegramAdapter({ botToken, ...(allowedLiveChatIds ? { allowedLiveChatIds } : {}) });
}

/** API adapters read their token from the environment (never a CLI flag). */
function requireToken(envVar: string, args: ParsedArgs): string {
  // dry-run never hits the network, so a placeholder token is fine.
  if (args.dryRun) {
    return "dry-run";
  }
  const token = process.env[envVar];
  if (!token) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `${envVar} environment variable is required for this platform`,
    );
  }
  return token;
}
