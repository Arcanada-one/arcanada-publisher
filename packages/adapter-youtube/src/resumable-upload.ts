// Official resumable-upload protocol over the transport seam: session start →
// PUT → on interruption a `Content-Range: bytes */TOTAL` probe → `308` with a
// server-reported Range → resume from THAT offset (which may not be a chunk
// boundary). Exponential backoff on 5xx; 401 mid-upload refreshes the access
// token and resumes the SAME session; 404 = expired session (plan C11,
// D-REQ-05). Session URIs are bearer capabilities: never logged, never thrown.

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { isRetryableStatus, mapApiError, parseJson, type Transport } from "./transport.js";

export const UPLOAD_START_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

export interface ByteSource {
  size: number;
  /** Read from `offset` to the end. */
  slice(offset: number): Uint8Array | AsyncIterable<Uint8Array>;
}

export interface UploadDeps {
  transport: Transport;
  getAccessToken: () => Promise<string>;
  /** Force-mint a NEW access token (a cached getAccessToken is a no-op on 401). */
  refreshAccessToken?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startSession(
  deps: UploadDeps,
  metadata: object,
  totalBytes: number,
  mime: string,
): Promise<string> {
  const response = await deps.transport({
    method: "POST",
    url: UPLOAD_START_URL,
    headers: {
      authorization: `Bearer ${await deps.getAccessToken()}`,
      "content-type": "application/json; charset=utf-8",
      "x-upload-content-length": String(totalBytes),
      "x-upload-content-type": mime,
    },
    body: JSON.stringify(metadata),
  });
  if (response.status !== 200) throw mapApiError(response, "resumable session start");
  const sessionUri = response.headers["location"];
  if (!sessionUri) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "resumable session start returned no Location");
  }
  return sessionUri;
}

export type ProbeResult =
  | { kind: "incomplete"; receivedBytes: number }
  | { kind: "done"; videoId: string }
  | { kind: "expired" };

/** Status probe: PUT with a star Content-Range ("bytes STAR/TOTAL"). */
export async function probeSession(
  deps: UploadDeps,
  sessionUri: string,
  totalBytes: number,
): Promise<ProbeResult> {
  const response = await deps.transport({
    method: "PUT",
    url: sessionUri,
    headers: {
      authorization: `Bearer ${await deps.getAccessToken()}`,
      "content-range": `bytes */${totalBytes}`,
    },
  });
  if (response.status === 308) {
    const range = response.headers["range"]; // "bytes=0-LAST"
    const last = range ? Number.parseInt(range.split("-")[1] ?? "", 10) : Number.NaN;
    return { kind: "incomplete", receivedBytes: Number.isFinite(last) ? last + 1 : 0 };
  }
  if (response.status === 200 || response.status === 201) {
    return { kind: "done", videoId: extractVideoId(response, "resumable probe") };
  }
  if (response.status === 404) return { kind: "expired" };
  throw mapApiError(response, "resumable probe");
}

function extractVideoId(
  response: { status: number; text: string; headers: Record<string, string> },
  context: string,
): string {
  const parsed = parseJson(response, context) as { id?: string };
  if (!parsed.id) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, `${context}: response carried no video id`);
  }
  return parsed.id;
}

/**
 * Upload from `offset` to completion, resuming through 5xx (backoff + probe →
 * continue from the server-reported offset) and 401 (token refresh, same
 * session). Returns the videoId.
 */
export async function uploadFromOffset(
  deps: UploadDeps,
  sessionUri: string,
  source: ByteSource,
  startOffset: number,
): Promise<string> {
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let offset = startOffset;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await deps.transport({
      method: "PUT",
      url: sessionUri,
      headers: {
        authorization: `Bearer ${await deps.getAccessToken()}`,
        "content-range": `bytes ${offset}-${source.size - 1}/${source.size}`,
        "content-length": String(source.size - offset),
      },
      body: source.slice(offset),
      timeoutMs: 3_600_000,
    });
    if (response.status === 200 || response.status === 201) {
      return extractVideoId(response, "resumable upload");
    }
    if (response.status === 308) {
      const probe = await probeSession(deps, sessionUri, source.size);
      if (probe.kind === "done") return probe.videoId;
      if (probe.kind === "expired") {
        throw new AdapterError(ErrorCode.INVALID_ARGS, "resumable session expired mid-upload");
      }
      offset = probe.receivedBytes;
      continue;
    }
    if (response.status === 404) {
      // The session URI itself is gone (undocumented finite TTL).
      throw new AdapterError(ErrorCode.INVALID_ARGS, "resumable session expired (404)");
    }
    if (response.status === 401) {
      // Access token aged out mid-upload (multi-GB files exceed the ~1h TTL):
      // FORCE a refresh (the cached getAccessToken would return the same dead
      // token) and resume the SAME session from the server-confirmed offset.
      await (deps.refreshAccessToken ?? deps.getAccessToken)();
      const probe = await probeSession(deps, sessionUri, source.size);
      if (probe.kind === "done") return probe.videoId;
      if (probe.kind === "expired") {
        throw new AdapterError(ErrorCode.AUTH_EXPIRED, "session expired during token refresh");
      }
      offset = probe.receivedBytes;
      continue;
    }
    if (isRetryableStatus(response.status)) {
      await sleep(Math.min(2 ** attempt * 1_000, 32_000));
      const probe = await probeSession(deps, sessionUri, source.size);
      if (probe.kind === "done") return probe.videoId;
      if (probe.kind === "expired") {
        throw new AdapterError(ErrorCode.INVALID_ARGS, "resumable session expired during retry");
      }
      offset = probe.receivedBytes;
      continue;
    }
    throw mapApiError(response, "resumable upload");
  }
  throw new AdapterError(ErrorCode.INVALID_ARGS, "resumable upload: retry budget exhausted", {
    maxAttempts,
  });
}
