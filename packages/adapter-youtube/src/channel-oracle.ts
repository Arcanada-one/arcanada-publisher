// Fail-closed channel oracle: the target channel is a COMPILED-IN constant —
// env may not override it (a doctored process env must not be able to re-aim
// the adapter at another channel). Asserted after token acquisition, at
// preflight, and re-asserted before every mutating call (plan C9, D-REQ-03).

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { apiJson, type Transport } from "./transport.js";

/** Arcanada. Permanent channel id — handles/custom URLs are mutable, this is not. */
export const ARCANADA_CHANNEL_ID = "UC2zUfwafsM2OxaidE0iNM7w";

export const CHANNELS_URL =
  "https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&mine=true";

export interface ChannelInfo {
  channelId: string;
  /** Authoritative uploads playlist (reconciliation source — never search.list). */
  uploadsPlaylistId: string;
}

interface ChannelsListResponse {
  items?: Array<{
    id?: string;
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }>;
}

export async function assertChannel(
  transport: Transport,
  accessToken: string,
): Promise<ChannelInfo> {
  const parsed = (await apiJson(
    transport,
    accessToken,
    { method: "GET", url: CHANNELS_URL },
    "channel oracle",
  )) as ChannelsListResponse;
  const item = parsed.items?.[0];
  if (!item?.id || item.id !== ARCANADA_CHANNEL_ID) {
    throw new AdapterError(
      ErrorCode.CHANNEL_MISMATCH,
      `authenticated identity does not own the Arcanada channel (got '${item?.id ?? "none"}', require '${ARCANADA_CHANNEL_ID}') — aborting with zero mutations`,
      { got: item?.id ?? null, want: ARCANADA_CHANNEL_ID },
    );
  }
  const uploads = item.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) {
    throw new AdapterError(
      ErrorCode.CHANNEL_MISMATCH,
      "channel oracle: uploads playlist missing from channels.list response",
    );
  }
  return { channelId: item.id, uploadsPlaylistId: uploads };
}
