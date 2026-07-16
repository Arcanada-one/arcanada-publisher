// YouTubeAdapter: API-first adapter for the Arcanada channel (PUB-0035).
import { createHash } from "node:crypto";
// No browser automation — YouTube ToS forbids it and the Data API covers every
// requirement (see datarim INSIGHTS-PUB-0035). comment/delete are unsupported
// by design; edit is metadata-only via videos.update.

import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
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
import { beginMutation, completeMutation, requireArmed, type AuditAppend } from "./gate.js";
import { publishYouTube, VIDEOS_URL, type PublishDeps } from "./publish.js";
import { bootstrapPlaylists, type PublishLanguage } from "./playlist-binding.js";
import { validateDescriptionBytes, validateLanguagePurity, validateTitle } from "./templates.js";
import { createFetchTransport, apiJson, type Transport } from "./transport.js";

export { ARCANADA_CHANNEL_ID } from "./channel-oracle.js";
export { CANONICAL_PLAYLIST_TITLES, bootstrapPlaylists } from "./playlist-binding.js";
export { isArmed, requireArmed } from "./gate.js";
export { youtubeRateLimiter, youtubePreflightLimiter } from "./publish.js";
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
  /** Consent-flow timeout override (default 10 min). */
  consentTimeoutMs?: number;
  auditAppend?: AuditAppend;
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
      ...(this.options.consentTimeoutMs !== undefined
        ? { consentTimeoutMs: this.options.consentTimeoutMs }
        : {}),
    });
  }

  private ledgerFor(profile: string): UploadLedger {
    const auth = this.auth(profile);
    return new UploadLedger(join(dirname(auth.tokenPath()), "ledger.jsonl"));
  }

  private journalFor(profile: string) {
    return this.ledgerFor(profile).recoveryJournal();
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
      journal: this.journalFor(input.profile),
      ...(this.options.auditAppend ? { auditAppend: this.options.auditAppend } : {}),
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

  /** Metadata-only edit via videos.update - categoryId is always re-sent. */
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
    if (!snippet)
      throw new AdapterError(ErrorCode.VERIFY_FAILED, `edit: video ${videoId} not found`);
    const nextTitle = input.title ?? String(snippet["title"] ?? "");
    const nextDescription = input.text ?? String(snippet["description"] ?? "");
    validateTitle(nextTitle);
    validateDescriptionBytes(nextDescription);
    const lang = snippet["defaultLanguage"];
    if (lang === "en" || lang === "ru") validateLanguagePurity(lang, nextTitle, nextDescription);

    const key = createHash("sha256")
      .update(JSON.stringify({ videoId, title: nextTitle, description: nextDescription }))
      .digest("hex");
    const journal = this.journalFor(input.profile);
    const spec = {
      kind: "edit" as const,
      key,
      account: channel.channelId,
      action: "edit" as const,
      postUrl: input.postUrl,
      intent: { videoId, title: nextTitle, description: nextDescription },
    };
    const control = {
      journal,
      auditOptions: this.options.auditBaseDir ? { baseDir: this.options.auditBaseDir } : {},
      ...(this.options.auditAppend ? { auditAppend: this.options.auditAppend } : {}),
    };
    const pending = await journal.find("edit", key);
    const alreadyApplied =
      pending !== undefined &&
      String(snippet["title"] ?? "") === nextTitle &&
      String(snippet["description"] ?? "") === nextDescription;
    if (
      !alreadyApplied &&
      input.expectedContent !== undefined &&
      !String(snippet["description"] ?? "").includes(input.expectedContent)
    ) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "edit: read-before-edit oracle mismatch - current description does not contain expectedContent",
      );
    }
    if (pending && !alreadyApplied) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "ambiguous edit recovery: intent exists but requested metadata is not proven remote",
        { operationId: pending.operationId, recoverable: true },
      );
    }
    const entry = await beginMutation(control, spec);
    if (!alreadyApplied) {
      const updated = {
        ...snippet,
        title: nextTitle,
        description: nextDescription,
        categoryId: snippet["categoryId"],
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
    }
    const auditRef = await completeMutation(control, spec, entry, {
      videoId,
      postUrl: input.postUrl,
    });
    return EditResultSchema.parse({
      ok: true,
      platform: "youtube",
      account: channel.channelId,
      postUrl: input.postUrl,
      edited: true,
      auditRef,
    });
  }

  /**
   * Operator-gated playlist bootstrap (PRD Technical Approach item 4): armed
   * state enforced inside bootstrapPlaylists; every creation audited fail-closed.
   */
  async bootstrapPlaylists(profile: string): Promise<Record<PublishLanguage, string>> {
    const token = await this.auth(profile).getAccessToken();
    await assertChannel(this.transport, token);
    return bootstrapPlaylists({
      transport: this.transport,
      accessToken: token,
      env: this.env,
      auditOptions: this.options.auditBaseDir ? { baseDir: this.options.auditBaseDir } : {},
      journal: this.journalFor(profile),
      ...(this.options.auditAppend ? { auditAppend: this.options.auditAppend } : {}),
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
      { method: "GET", url: `${VIDEOS_URL}?part=status,snippet&id=${videoId}` },
      "verify",
    )) as { items?: Array<{ id?: string; snippet?: { channelId?: string } }> };
    const item = parsed.items?.[0];
    const reachable = item !== undefined;
    // ok requires OUR channel — a reachable foreign video must not verify green.
    const owned = item?.snippet?.channelId === ARCANADA_CHANNEL_ID;
    return VerifyResultSchema.parse({
      ok: reachable && owned,
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
    const fromParam = url.searchParams.get("v");
    const fromShort =
      url.hostname === "youtu.be"
        ? basename(url.pathname)
        : url.pathname.startsWith("/shorts/")
          ? url.pathname.split("/")[2]
          : undefined;
    const id = fromParam ?? fromShort;
    if (id && /^[A-Za-z0-9_-]{5,}$/.test(id)) return id;
  } catch {
    // fall through
  }
  // Path basenames like "watch"/"playlist" are page names, not video ids — fail fast.
  throw new AdapterError(ErrorCode.INVALID_ARGS, `cannot parse a videoId from '${postUrl}'`);
}
