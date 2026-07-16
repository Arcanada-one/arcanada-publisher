// Publish orchestration (plan C13): preflight [auth → channel oracle →
// language/playlist binding → metadata validation → ledger gate → arming
// check] → resumable upload → processing poll (timeout-capped, terminal-state
// matrix incl. `terminated`) → playlist duplicate pre-check → insert (only
// after `processed`) → read-back (divergences → warnings; private-lock
// detection) → fail-closed audit.

import {
  AdapterError,
  ErrorCode,
  PublishResultSchema,
  RateLimiter,
  appendAudit,
  type AuditAction,
  type AuditOptions,
  type PublishInput,
  type PublishResult,
} from "@arcanada/publisher-core";
import type { AuthManager } from "./auth.js";
import { ARCANADA_CHANNEL_ID, assertChannel } from "./channel-oracle.js";
import { UploadLedger, sha256Bytes, type LedgerEntry } from "./ledger.js";
import {
  isVideoInPlaylist,
  insertIntoPlaylist,
  resolveBinding,
  resolveLanguage,
  verifyBinding,
} from "./playlist-binding.js";
import { startSession, uploadFromOffset, type ByteSource, type UploadDeps } from "./resumable-upload.js";
import { apiJson, type Transport } from "./transport.js";
import {
  validateDescriptionBytes,
  validateLanguagePurity,
  validateTitle,
} from "./templates.js";

export const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

/**
 * MODULE-SCOPED limiter shared across adapter instances: the loopback API
 * constructs a fresh adapter per request, so a per-instance limiter would
 * start every request at zero. Dry-run preflights are metered too — they cost
 * credentialed token refreshes and quota reads.
 */
export const youtubeRateLimiter = new RateLimiter();

export function isArmed(env: NodeJS.ProcessEnv): boolean {
  return env["YOUTUBE_LIVE_ARMED"] === "1";
}

export function requireArmed(env: NodeJS.ProcessEnv, operation: string): void {
  if (!isArmed(env)) {
    throw new AdapterError(
      ErrorCode.NOT_ARMED,
      `${operation}: live YouTube mutations require the operator-armed state (YOUTUBE_LIVE_ARMED=1 after dry-run plan review)`,
      { operation },
    );
  }
}

/** Fail-closed audit: the stock appendAudit is fail-soft; YouTube mutations abort on a null ref. */
export async function auditOrAbort(
  input: { account: string; action: AuditAction; postUrl?: string },
  options: AuditOptions,
): Promise<string> {
  const ref = await appendAudit({ platform: "youtube", ...input }, options);
  if (ref === null) {
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      "audit append failed — aborting the mutation (fail-closed AAL L2 control)",
    );
  }
  return ref;
}

export interface PublishDeps {
  transport: Transport;
  auth: Pick<AuthManager, "getAccessToken">;
  env: NodeJS.ProcessEnv;
  ledger: UploadLedger;
  /** Byte source loader for the video file (injectable for tests). */
  loadSource: (videoPath: string) => Promise<{ source: ByteSource; bytes: Uint8Array | undefined; mime: string }>;
  auditOptions: AuditOptions;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  limiter?: RateLimiter;
}

interface VideoStatus {
  uploadStatus?: string;
  privacyStatus?: string;
  failureReason?: string;
  rejectionReason?: string;
}

interface VideosListItem {
  id?: string;
  status?: VideoStatus;
  snippet?: { title?: string; description?: string; channelId?: string };
  contentDetails?: { duration?: string };
  processingDetails?: { processingStatus?: string };
}

const DEFAULT_POLL_INTERVAL_MS = 12_000;
const DEFAULT_POLL_TIMEOUT_MS = 3_600_000;

export async function publishYouTube(input: PublishInput, deps: PublishDeps): Promise<PublishResult> {
  const limiter = deps.limiter ?? youtubeRateLimiter;
  const title = input.title ?? "";
  const description = input.text;
  const language = resolveLanguage(input.language);
  const privacy = input.privacyStatus ?? "private";
  if (!input.videoPath) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "publish: 'videoPath' is required for YouTube");
  }
  validateTitle(title);
  validateDescriptionBytes(description);
  validateLanguagePurity(language, title, description);

  // Metered preflight (dry-run included — credentialed reads have real cost).
  limiter.check("youtube");
  const accessToken = await deps.auth.getAccessToken();
  const channel = await assertChannel(deps.transport, accessToken);
  const binding = resolveBinding(deps.env);
  await verifyBinding(deps.transport, accessToken, binding);

  const { source, bytes, mime } = await deps.loadSource(input.videoPath);
  const sha256 = bytes !== undefined ? sha256Bytes(bytes) : await hashSource(source);
  const pending = await deps.ledger.gate(sha256);

  const planWarnings = [
    `plan: channel=${channel.channelId}`,
    `plan: playlist(${language})=${binding[language]}`,
    `plan: privacyStatus=${privacy}`,
    `plan: sha256=${sha256}`,
    `plan: bytes=${source.size}`,
  ];
  if (input.dryRun) {
    return PublishResultSchema.parse({
      ok: true,
      platform: "youtube",
      account: channel.channelId,
      postUrl: "https://www.youtube.com/watch?v=dry-run",
      attachments: [{ kind: "video", src: input.videoPath }],
      warnings: ["dry-run: no mutation performed", ...planWarnings],
    });
  }

  requireArmed(deps.env, "publish");

  const uploadDeps: UploadDeps = {
    transport: deps.transport,
    getAccessToken: () => deps.auth.getAccessToken(),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  const videoId = await runUpload(uploadDeps, deps, {
    pending,
    sha256,
    title,
    description,
    language,
    privacy,
    source,
    mime,
  });
  await deps.ledger.complete(sha256, videoId);

  await pollProcessing(deps, videoId);

  // Oracle re-assert before the playlist mutation (D-REQ-03: every mutating call).
  const freshToken = await deps.auth.getAccessToken();
  await assertChannel(deps.transport, freshToken);
  if (!(await isVideoInPlaylist(deps.transport, freshToken, binding[language], videoId))) {
    await insertIntoPlaylist(deps.transport, freshToken, binding[language], videoId);
  }

  const readBack = await fetchVideo(deps, videoId);
  const warnings = collectDivergences(readBack, { title, description, privacy });
  const postUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const auditRef = await auditOrAbort(
    { account: channel.channelId, action: "publish", postUrl },
    deps.auditOptions,
  );
  limiter.record("youtube");
  return PublishResultSchema.parse({
    ok: true,
    platform: "youtube",
    account: channel.channelId,
    postUrl,
    attachments: [{ kind: "video", src: input.videoPath }],
    warnings,
    auditRef,
  });
}

async function hashSource(source: ByteSource): Promise<string> {
  const chunks: Uint8Array[] = [];
  const slice = source.slice(0);
  if (slice instanceof Uint8Array) return sha256Bytes(slice);
  for await (const chunk of slice) chunks.push(chunk);
  return sha256Bytes(Buffer.concat(chunks));
}

interface UploadPlan {
  pending: LedgerEntry | undefined;
  sha256: string;
  title: string;
  description: string;
  language: "en" | "ru";
  privacy: string;
  source: ByteSource;
  mime: string;
}

async function runUpload(uploadDeps: UploadDeps, deps: PublishDeps, plan: UploadPlan): Promise<string> {
  const metadata = {
    snippet: {
      title: plan.title,
      description: plan.description,
      defaultLanguage: plan.language,
      defaultAudioLanguage: plan.language,
    },
    status: { privacyStatus: plan.privacy, selfDeclaredMadeForKids: false },
  };
  const freshSession = async (): Promise<string> => {
    const uri = await startSession(uploadDeps, metadata, plan.source.size, plan.mime);
    await deps.ledger.append({
      sha256: plan.sha256,
      title: plan.title,
      totalBytes: plan.source.size,
      startedAt: new Date().toISOString(),
      sessionUri: uri,
    });
    return uri;
  };
  const sessionUri = plan.pending?.sessionUri ?? (await freshSession());
  try {
    return await uploadFromOffset(uploadDeps, sessionUri, plan.source, 0);
  } catch (error) {
    // Expired session (undocumented TTL): restart ONLY behind the ledger gate —
    // the duplicate check already passed for this sha256 in this invocation.
    if (error instanceof AdapterError && /expired/.test(error.message)) {
      return uploadFromOffset(uploadDeps, await freshSession(), plan.source, 0);
    }
    throw error;
  }
}

async function fetchVideo(deps: PublishDeps, videoId: string): Promise<VideosListItem> {
  const token = await deps.auth.getAccessToken();
  const parsed = (await apiJson(
    deps.transport,
    token,
    {
      method: "GET",
      url: `${VIDEOS_URL}?part=snippet,status,contentDetails,processingDetails&id=${videoId}`,
    },
    "video read-back",
  )) as { items?: VideosListItem[] };
  const item = parsed.items?.[0];
  if (!item) {
    throw new AdapterError(ErrorCode.VERIFY_FAILED, `read-back: video ${videoId} not found`);
  }
  return item;
}

async function pollProcessing(deps: PublishDeps, videoId: string): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeout = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const startedAt = now();
  for (;;) {
    const item = await fetchVideo(deps, videoId);
    const upload = item.status?.uploadStatus;
    const processing = item.processingDetails?.processingStatus;
    if (upload === "rejected") {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        `processing rejected (${item.status?.rejectionReason ?? "unknown"}) — duplicate backstop or policy`,
        { videoId, rejectionReason: item.status?.rejectionReason },
      );
    }
    if (upload === "failed") {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        `processing failed (${item.status?.failureReason ?? "unknown"})`,
        { videoId, failureReason: item.status?.failureReason },
      );
    }
    // `terminated` = processing info no longer available — a normal terminal
    // state; `processed` = done.
    if (upload === "processed" || processing === "terminated") return;
    if (now() - startedAt > timeout) {
      throw new AdapterError(ErrorCode.VERIFY_FAILED, "processing poll timeout exceeded", {
        videoId,
        timeoutMs: timeout,
      });
    }
    await sleep(interval);
  }
}

function collectDivergences(
  item: VideosListItem,
  requested: { title: string; description: string; privacy: string },
): string[] {
  const warnings: string[] = [];
  const effectivePrivacy = item.status?.privacyStatus;
  if (effectivePrivacy && effectivePrivacy !== requested.privacy) {
    warnings.push(
      `privacyStatus divergence: requested '${requested.privacy}', effective '${effectivePrivacy}' — likely the unaudited-project private-lock; flip manually in Studio per runbook`,
    );
  }
  if (item.snippet?.title !== undefined && item.snippet.title !== requested.title) {
    warnings.push("read-back divergence: title differs from the requested metadata");
  }
  if (item.snippet?.description !== undefined && item.snippet.description !== requested.description) {
    warnings.push("read-back divergence: description differs from the requested metadata");
  }
  if (item.snippet?.channelId !== undefined && item.snippet.channelId !== ARCANADA_CHANNEL_ID) {
    warnings.push("read-back divergence: video landed on an unexpected channel");
  }
  if (!item.contentDetails?.duration) {
    warnings.push("read-back: duration not exposed by the API for this video");
  }
  return warnings;
}
