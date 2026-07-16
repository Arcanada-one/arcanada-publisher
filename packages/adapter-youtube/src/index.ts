// YouTubeAdapter: API-first adapter for the Arcanada channel (PUB-0035).
// No browser automation — YouTube ToS forbids it and the Data API covers every
// requirement (see datarim INSIGHTS-PUB-0035). comment/delete are unsupported
// by design; edit is metadata-only via videos.update.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  AdapterError,
  BaseAdapter,
  EditResultSchema,
  ErrorCode,
  VerifyResultSchema,
  type CommentInput,
  type CommentResult,
  type DeleteInput,
  type DeleteResult,
  type EditInput,
  type EditResult,
  type LoginOptions,
  type PublishInput,
  type PublishResult,
  type VerifyResult,
} from "@arcanada/publisher-core";
import { AuthManager, type AuthDeps } from "./auth.js";
import { ARCANADA_CHANNEL_ID, assertChannel } from "./channel-oracle.js";
import { UploadLedger } from "./ledger.js";
import {
  auditOrAbort,
  publishYouTube,
  requireArmed,
  VIDEOS_URL,
  type PublishDeps,
} from "./publish.js";
import { createFetchTransport, apiJson, type Transport } from "./transport.js";
import { dirname, join } from "node:path";

export { ARCANADA_CHANNEL_ID } from "./channel-oracle.js";
export { CANONICAL_PLAYLIST_TITLES, bootstrapPlaylists } from "./playlist-binding.js";
export { isArmed, requireArmed, youtubeRateLimiter } from "./publish.js";
export { AuthManager } from "./auth.js";
export type { Transport, TransportRequest, TransportResponse } from "./transport.js";

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

export interface YouTubeAdapterOptions {
  transport?: Transport;
  env?: NodeJS.ProcessEnv;
  profilesRoot?: string;
  auditBaseDir?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  openUrl?: AuthDeps["openUrl"];
}

export class YouTubeAdapter extends BaseAdapter {
  readonly platform = "youtube" as const;
  private readonly transport: Transport;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: YouTubeAdapterOptions = {}) {
    super();
    this.transport = options.transport ?? createFetchTransport();
    this.env = options.env ?? process.env;
  }

  private auth(profile: string): AuthManager {
    return new AuthManager(profile, {
      transport: this.transport,
      env: this.env,
      ...(this.options.profilesRoot ? { profilesRoot: this.options.profilesRoot } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.openUrl ? { openUrl: this.options.openUrl } : {}),
    });
  }

  private ledgerFor(profile: string): UploadLedger {
    const auth = this.auth(profile);
    return new UploadLedger(join(dirname(auth.tokenPath()), "ledger.jsonl"));
  }

  async login(options: LoginOptions): Promise<void> {
    await this.auth(options.profile).login();
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const deps: PublishDeps = {
      transport: this.transport,
      auth: this.auth(input.profile),
      env: this.env,
      ledger: this.ledgerFor(input.profile),
      loadSource: async (videoPath) => {
        const bytes = new Uint8Array(await readFile(videoPath));
        return {
          bytes,
          source: { size: bytes.length, slice: (offset: number) => bytes.subarray(offset) },
          mime: VIDEO_MIME_BY_EXT[extname(videoPath).toLowerCase()] ?? "application/octet-stream",
        };
      },
      auditOptions: this.options.auditBaseDir ? { baseDir: this.options.auditBaseDir } : {},
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.pollIntervalMs !== undefined
        ? { pollIntervalMs: this.options.pollIntervalMs }
        : {}),
      ...(this.options.pollTimeoutMs !== undefined
        ? { pollTimeoutMs: this.options.pollTimeoutMs }
        : {}),
    };
    return publishYouTube(input, deps);
  }

  comment(_input: CommentInput): Promise<CommentResult> {
    return Promise.reject(
      new AdapterError(
        ErrorCode.UNSUPPORTED_OPERATION,
        "YouTube comments are outside the publishing flow by design (PUB-0035)",
      ),
    );
  }

  /** Metadata-only edit via videos.update — categoryId is ALWAYS re-sent (official gotcha). */
  async edit(input: EditInput): Promise<EditResult> {
    requireArmed(this.env, "edit");
    const videoId = parseVideoId(input.postUrl);
    const auth = this.auth(input.profile);
    const token = await auth.getAccessToken();
    const channel = await assertChannel(this.transport, token);
    const current = (await apiJson(
      this.transport,
      token,
      { method: "GET", url: `${VIDEOS_URL}?part=snippet&id=${videoId}` },
      "edit read-before-update",
    )) as { items?: Array<{ snippet?: Record<string, unknown> }> };
    const snippet = current.items?.[0]?.snippet;
    if (!snippet) {
      throw new AdapterError(ErrorCode.VERIFY_FAILED, `edit: video ${videoId} not found`);
    }
    const updated = {
      ...snippet,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.text !== undefined ? { description: input.text } : {}),
      categoryId: snippet["categoryId"], // required whenever the snippet part is sent
    };
    await apiJson(
      this.transport,
      token,
      {
        method: "PUT",
        url: `${VIDEOS_URL}?part=snippet`,
        body: JSON.stringify({ id: videoId, snippet: updated }),
      },
      "videos.update",
    );
    const auditRef = await auditOrAbort(
      { account: channel.channelId, action: "edit", postUrl: input.postUrl },
      this.options.auditBaseDir ? { baseDir: this.options.auditBaseDir } : {},
    );
    return EditResultSchema.parse({
      ok: true,
      platform: "youtube",
      account: channel.channelId,
      postUrl: input.postUrl,
      edited: true,
      auditRef,
    });
  }

  delete(_input: DeleteInput): Promise<DeleteResult> {
    return Promise.reject(
      new AdapterError(
        ErrorCode.UNSUPPORTED_OPERATION,
        "deleting YouTube videos is an operator action in Studio, not an agent operation (PUB-0035)",
      ),
    );
  }

  /** Authenticated verify — BaseAdapter's HEAD cannot see private/processing videos. */
  override async verify(postUrl: string): Promise<VerifyResult> {
    const videoId = parseVideoId(postUrl);
    const token = await this.auth("").getAccessToken();
    const parsed = (await apiJson(
      this.transport,
      token,
      { method: "GET", url: `${VIDEOS_URL}?part=status&id=${videoId}` },
      "verify",
    )) as { items?: Array<{ id?: string }> };
    const reachable = (parsed.items ?? []).length > 0;
    return VerifyResultSchema.parse({
      ok: reachable,
      platform: "youtube",
      postUrl,
      reachable,
      status: reachable ? 200 : 404,
      account: ARCANADA_CHANNEL_ID,
    });
  }
}

function parseVideoId(postUrl: string): string {
  try {
    const url = new URL(postUrl);
    const id = url.searchParams.get("v") ?? basename(url.pathname);
    if (id && /^[A-Za-z0-9_-]{5,}$/.test(id)) return id;
  } catch {
    // fall through
  }
  throw new AdapterError(ErrorCode.INVALID_ARGS, `cannot parse a videoId from '${postUrl}'`);
}
