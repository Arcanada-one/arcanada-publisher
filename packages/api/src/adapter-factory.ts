// Real adapter factory for the loopback API. Browser adapters (facebook /
// linkedin / x) take no constructor args; the API-token adapters (reddit /
// vkontakte) read their token from the environment — never from the request
// body, so an agent cannot smuggle credentials over the wire.

import { type Adapter, type Platform, AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { FacebookAdapter } from "@arcanada/publisher-facebook";
import { LinkedInAdapter } from "@arcanada/publisher-linkedin";
import { XAdapter } from "@arcanada/publisher-x";
import { RedditAdapter } from "@arcanada/publisher-reddit";
import { VKontakteAdapter } from "@arcanada/publisher-vkontakte";

/** Construct the live adapter for a platform. `dryRun` lets token adapters skip env. */
export function makeAdapter(platform: Platform, dryRun = false): Adapter {
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
      return new VKontakteAdapter({ accessToken: requireToken("VK_ACCESS_TOKEN", dryRun) });
    default:
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        `unsupported platform '${platform as string}'`,
      );
  }
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
