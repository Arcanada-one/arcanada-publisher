// Real adapter factory for the loopback API. Browser adapters (facebook /
// linkedin / x) take no constructor args; the API-token adapters (reddit /
// vkontakte) read their token from the environment — never from the request
// body, so an agent cannot smuggle credentials over the wire.

import { type Adapter, type Platform, AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { FacebookAdapter } from "@arcanada/publisher-facebook";
import { LinkedInAdapter } from "@arcanada/publisher-linkedin";
import { XAdapter } from "@arcanada/publisher-x";
import { RedditAdapter } from "@arcanada/publisher-reddit";
import { VKontakteAdapter, VKontakteBrowserAdapter } from "@arcanada/publisher-vkontakte";
import { TelegramAdapter } from "@arcanada/publisher-telegram";
import { YouTubeAdapter } from "@arcanada/publisher-youtube";

/** Construct the live adapter for a platform. `dryRun` lets token adapters skip env. */
export function makeAdapter(platform: Platform, dryRun = false, auditBaseDir?: string): Adapter {
  switch (platform) {
    case "facebook":
      return new FacebookAdapter();
    case "linkedin":
      return new LinkedInAdapter();
    case "x":
      return new XAdapter();
    case "reddit":
      return new RedditAdapter({ accessToken: requireToken("REDDIT_ACCESS_TOKEN", dryRun) });
    case "vkontakte":
      // PUB-0034: ARCANADA_VK_BROWSER=1 selects the headed browser adapter
      // (persistent profile, no token); unset keeps the token-API adapter.
      return process.env["ARCANADA_VK_BROWSER"] === "1"
        ? new VKontakteBrowserAdapter({ headed: true })
        : new VKontakteAdapter({ accessToken: requireToken("VK_ACCESS_TOKEN", dryRun) });
    case "telegram":
      return makeTelegramAdapter(requireToken("TELEGRAM_BOT_TOKEN", dryRun));
    case "youtube":
      // OAuth env credentials are read inside the adapter (never the request
      // body); dry-run performs credentialed read-only preflight (PUB-0035).
      // The API's configured audit dir MUST reach the adapter — its internal
      // fail-closed audits replace the route-layer record (pinned dedup).
      return new YouTubeAdapter(auditBaseDir ? { auditBaseDir } : {});
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

function requireToken(envVar: string, dryRun: boolean): string {
  if (dryRun) return "dry-run";
  const token = process.env[envVar];
  if (!token) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `${envVar} environment variable is required for this platform`,
    );
  }
  return token;
}
