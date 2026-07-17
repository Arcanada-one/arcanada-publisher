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
  type AuditOptions,
  type PublishInput,
  type PublishResult,
} from "@arcanada/publisher-core";
import type { AuthManager } from "./auth.js";
import { ARCANADA_CHANNEL_ID, assertChannel } from "./channel-oracle.js";
import { UploadLedger, sha256Bytes, type LedgerEntry } from "./ledger.js";
import { beginMutation, completeMutation, requireArmed, type AuditAppend } from "./gate.js";
import {
  isVideoInPlaylist,
  insertIntoPlaylist,
  resolveBinding,
  resolveLanguage,
  verifyBinding,
} from "./playlist-binding.js";
import {
  probeSession,
  startSession,
  uploadFromOffset,
  type ByteSource,
  type ProbeResult,
  type UploadDeps,
} from "./resumable-upload.js";
import { apiJson, type Transport } from "./transport.js";
import { validateDescriptionBytes, validateLanguagePurity, validateTitle } from "./templates.js";

export const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

/**
 * MODULE-SCOPED limiter shared across adapter instances: the loopback API
 * constructs a fresh adapter per request, so a per-instance limiter would
 * start every request at zero. Dry-run preflights are metered too — they cost
 * credentialed token refreshes and quota reads.
 */
export const youtubeRateLimiter = new RateLimiter();

/**
 * EVERY publish invocation (dry-run, unarmed, failed, or live) is metered on
 * this module-scoped preflight limiter (check + record on entry) — the live
 * limiter counts only recorded successful publishes, so without this an
 * unattended loop could drive unlimited credentialed preflight reads via
 * dry-runs OR via never-armed live attempts.
 */
export const youtubePreflightLimiter = new RateLimiter({
  envSuffix: "_PREFLIGHT",
  defaultPerHour: 20, // documented flow = 2 preflights per live publish; own knob so raising it never loosens the live cost-circuit-breaker
});

export interface PublishDeps {
  transport: Transport;
  auth: Pick<AuthManager, "getAccessToken" | "refreshAccessToken">;
  env: NodeJS.ProcessEnv;
  ledger: UploadLedger;
  journal?: import("./recovery-journal.js").RecoveryJournal;
  auditAppend?: AuditAppend;
  /** Byte source loader for the video file (injectable for tests). */
  loadSource: (
    videoPath: string,
  ) => Promise<{ source: ByteSource; bytes: Uint8Array | undefined; mime: string }>;
  auditOptions: AuditOptions;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  limiter?: RateLimiter;
  preflightLimiter?: RateLimiter;
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

export async function publishYouTube(
  input: PublishInput,
  deps: PublishDeps,
): Promise<PublishResult> {
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

  // Metered preflight: EVERY invocation (dry-run, unarmed, failed, live) is
  // check+RECORDED on the preflight limiter — credentialed reads have real
  // cost even when the attempt never mutates. The live limiter additionally
  // gates real publishes (recorded only on success).
  const preflight = deps.preflightLimiter ?? youtubePreflightLimiter;
  preflight.check("youtube");
  preflight.record("youtube");
  if (!input.dryRun) {
    limiter.check("youtube");
  }

  const { source, bytes, mime } = await deps.loadSource(input.videoPath);
  const sha256 = bytes !== undefined ? sha256Bytes(bytes) : await hashSource(source);
  const pending = await deps.ledger.gate(sha256);
  const uploadDeps: UploadDeps = {
    transport: deps.transport,
    getAccessToken: () => deps.auth.getAccessToken(),
    refreshAccessToken: () => deps.auth.refreshAccessToken(),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  if (!input.dryRun) {
    requireArmed(deps.env, "publish");
    if (pending) {
      if (!pending.sessionUri) {
        throw ambiguousSession("non-final ledger state is missing its session URI", sha256);
      }
      const earlyProbe = await probeSession(uploadDeps, pending.sessionUri, source.size);
      if (pending.state === "uploaded") probeUploadedState(pending, earlyProbe, sha256);
    }
  }

  const accessToken = await deps.auth.getAccessToken();
  const channel = await assertChannel(deps.transport, accessToken);
  const binding = resolveBinding(deps.env);
  await verifyBinding(deps.transport, accessToken, binding);

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

  const journal = deps.journal ?? deps.ledger.recoveryJournal();

  const mutationControl = {
    journal,
    auditOptions: deps.auditOptions,
    ...(deps.auditAppend ? { auditAppend: deps.auditAppend } : {}),
  };
  const uploadSpec = {
    kind: "upload" as const,
    key: sha256,
    account: channel.channelId,
    action: "publish" as const,
    intent: { sha256, totalBytes: source.size },
  };
  const priorUploadOperation = await journal.find("upload", sha256);
  const uploadEntry = await beginMutation(mutationControl, uploadSpec);
  if (priorUploadOperation && !pending) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "ambiguous upload recovery: durable intent exists without a resumable ledger state",
      { operationId: priorUploadOperation.operationId, recoverable: true },
    );
  }
  const { videoId, recoveringUploaded } = await deps.ledger.withLock(async () => {
    const pendingLocked = await deps.ledger.gate(sha256);
    let authoritativeProbe: ProbeResult | undefined;
    let recoveredVideoId: string | undefined;
    if (pendingLocked) {
      if (!pendingLocked.sessionUri) {
        throw ambiguousSession("non-final ledger state is missing its session URI", sha256);
      }
      authoritativeProbe = await probeSession(uploadDeps, pendingLocked.sessionUri, source.size);
      if (pendingLocked.state === "uploaded") {
        recoveredVideoId = probeUploadedState(pendingLocked, authoritativeProbe, sha256);
      }
    }
    const id = await runUpload(uploadDeps, deps, {
      ...(recoveredVideoId ? { recoveredVideoId } : {}),
      ...(authoritativeProbe ? { preProbe: authoritativeProbe } : {}),
      pending: pendingLocked,
      sha256,
      title,
      description,
      language,
      privacy,
      source,
      mime,
    });
    await deps.ledger.markUploaded(sha256, id);
    return { videoId: id, recoveringUploaded: pendingLocked?.state === "uploaded" };
  });

  const postUrl = `https://www.youtube.com/watch?v=${videoId}`;
  await journal.markApplied(uploadEntry.operationId, { videoId, postUrl });
  const proveUploadOwnership = async (): Promise<void> => {
    const ownershipToken = await deps.auth.getAccessToken();
    const ownershipChannel = await assertChannel(deps.transport, ownershipToken);
    const owned = await isVideoInPlaylist(
      deps.transport,
      ownershipToken,
      ownershipChannel.uploadsPlaylistId,
      videoId,
    );
    if (!owned) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        `uploads playlist ownership proof failed for video ${videoId}; state is ambiguous`,
        { videoId, uploadsPlaylistId: ownershipChannel.uploadsPlaylistId },
      );
    }
  };
  if (recoveringUploaded) await proveUploadOwnership();
  await pollProcessing(deps, videoId);
  if (!recoveringUploaded) await proveUploadOwnership();
  const auditRef = await completeMutation(
    mutationControl,
    { ...uploadSpec, postUrl },
    uploadEntry,
    { videoId, postUrl },
  );
  const freshToken = await deps.auth.getAccessToken();
  await assertChannel(deps.transport, freshToken);
  const playlistId = binding[language];
  const insertKey = `${playlistId}:${videoId}`;
  const insertSpec = {
    kind: "playlist-insert" as const,
    key: insertKey,
    account: channel.channelId,
    action: "playlist-insert" as const,
    postUrl,
    intent: { playlistId, videoId },
  };
  await journal.withMutationLease("playlist-insert", insertKey, async () => {
    const pendingInsert = await journal.find("playlist-insert", insertKey);
    const alreadyInPlaylist = await isVideoInPlaylist(
      deps.transport,
      freshToken,
      playlistId,
      videoId,
    );
    if (!alreadyInPlaylist) {
      if (pendingInsert) {
        throw new AdapterError(
          ErrorCode.VERIFY_FAILED,
          "ambiguous playlist-insert recovery: intent exists but remote insertion is not proven",
          { operationId: pendingInsert.operationId, recoverable: true },
        );
      }
      const insertEntry = await beginMutation(mutationControl, insertSpec);
      await insertIntoPlaylist(deps.transport, freshToken, playlistId, videoId);
      await completeMutation(mutationControl, insertSpec, insertEntry, { playlistId, videoId });
    } else if (pendingInsert) {
      if (
        pendingInsert.state === "applied" &&
        (pendingInsert.result?.["playlistId"] !== playlistId ||
          pendingInsert.result?.["videoId"] !== videoId)
      ) {
        throw new AdapterError(
          ErrorCode.VERIFY_FAILED,
          "applied playlist-insert recovery result conflicts with the proven remote membership",
          { operationId: pendingInsert.operationId, recoverable: true },
        );
      }
      const insertEntry = await beginMutation(mutationControl, insertSpec);
      await completeMutation(mutationControl, insertSpec, insertEntry, { playlistId, videoId });
    }
  });

  const readBack = await fetchVideo(deps, videoId);
  await deps.ledger.finalize(sha256, videoId);
  const warnings = collectDivergences(readBack, { title, description, privacy });
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

function probeUploadedState(pending: LedgerEntry, probe: ProbeResult, sha256: string): string {
  if (!pending.videoId) {
    throw ambiguousSession("uploaded ledger state is missing its mandatory video id", sha256);
  }
  if (probe.kind === "done") {
    if (probe.videoId !== pending.videoId) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "resumable probe returned a different video id",
        { ledgerVideoId: pending.videoId, probeVideoId: probe.videoId },
      );
    }
    return probe.videoId;
  }
  if (probe.kind === "expired") return pending.videoId;
  throw ambiguousSession("uploaded ledger state but resumable probe is incomplete", sha256);
}

interface UploadPlan {
  recoveredVideoId?: string;
  pending: LedgerEntry | undefined;
  sha256: string;
  preProbe?: ProbeResult;
  title: string;
  description: string;
  language: "en" | "ru";
  privacy: string;
  source: ByteSource;
  mime: string;
}

async function runUpload(
  uploadDeps: UploadDeps,
  deps: PublishDeps,
  plan: UploadPlan,
): Promise<string> {
  if (plan.recoveredVideoId) return plan.recoveredVideoId;
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
  const transfer = async (sessionUri: string, offset: number): Promise<string> => {
    await deps.ledger.markTransferStarted(plan.sha256);
    return uploadFromOffset(uploadDeps, sessionUri, plan.source, offset);
  };

  if (plan.pending) {
    if (!plan.pending.sessionUri || !plan.preProbe) {
      throw ambiguousSession("non-final ledger state was not probed before preflight", plan.sha256);
    }
    const probe = plan.preProbe;
    if (probe.kind === "done") return probe.videoId;
    if (probe.kind === "incomplete") {
      return transfer(plan.pending.sessionUri, probe.receivedBytes);
    }
    if (plan.pending.transferStarted !== false) {
      throw ambiguousSession(
        "expired session without positive proof that no data PUT began",
        plan.sha256,
      );
    }
    const replacement = await freshSession();
    return transfer(replacement, 0);
  }

  const sessionUri = await freshSession();
  return transfer(sessionUri, 0);
}

function ambiguousSession(message: string, sha256: string): AdapterError {
  return new AdapterError(
    ErrorCode.INVALID_ARGS,
    `ambiguous resumable upload: ${message}; reconcile against the uploads playlist before retry`,
    { sha256, ambiguous: true },
  );
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
    // Terminal successes: uploadStatus `processed`, or processingDetails
    // reporting `succeeded`/`terminated` (the latter = info no longer
    // available, a normal terminal state) even while uploadStatus lags.
    if (upload === "processed" || processing === "succeeded" || processing === "terminated") return;
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
  if (
    item.snippet?.description !== undefined &&
    normalizeReadBackDescription(item.snippet.description) !==
      normalizeReadBackDescription(requested.description)
  ) {
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

function normalizeReadBackDescription(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n$/, "");
}
