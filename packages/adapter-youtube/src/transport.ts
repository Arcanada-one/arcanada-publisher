// Single injectable-fetch seam for EVERY HTTP call the YouTube adapter makes —
// OAuth token exchange, Data API JSON endpoints, and the resumable upload
// session. No other module in this package may call fetch directly; tests run
// recorded fixtures against this seam (plan C7).

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface TransportRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | AsyncIterable<Uint8Array>;
  timeoutMs?: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

const DEFAULT_TIMEOUT_MS = 120_000;

/** Production transport: undici fetch with per-request timeout. */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return async (request) => {
    const streaming =
      request.body !== undefined &&
      typeof request.body !== "string" &&
      !(request.body instanceof Uint8Array);
    const init: Record<string, unknown> = {
      method: request.method,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      // Node fetch requires half-duplex for streaming request bodies.
      ...(streaming ? { duplex: "half" } : {}),
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
    const response = await fetchImpl(request.url, init as Parameters<typeof fetch>[1]);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, text: await response.text() };
  };
}

/** Parse a JSON response body, failing closed on garbage. */
export function parseJson(response: TransportResponse, context: string): unknown {
  try {
    return response.text === "" ? {} : (JSON.parse(response.text) as unknown);
  } catch {
    throw new AdapterError(ErrorCode.INVALID_ARGS, `${context}: non-JSON response`, {
      status: response.status,
    });
  }
}

/** True when the status is the official retry-with-backoff set. */
export function isRetryableStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Map a non-2xx Data API response to the adapter error surface. SECURITY: the
 * response body may echo request URLs (session URIs are bearer capabilities) —
 * only the status and the extracted reason ever reach the error message.
 */
export function mapApiError(response: TransportResponse, context: string): AdapterError {
  const reason = extractReason(response.text);
  if (response.status === 401) {
    return new AdapterError(ErrorCode.AUTH_EXPIRED, `${context}: authorization expired (401)`, {
      status: 401,
    });
  }
  if (response.status === 403 && /quota/i.test(reason)) {
    return new AdapterError(ErrorCode.QUOTA_EXCEEDED, `${context}: API quota exceeded (403)`, {
      status: 403,
      reason,
    });
  }
  if (response.status === 429) {
    return new AdapterError(ErrorCode.RATE_LIMIT, `${context}: upstream rate limit (429)`, {
      status: 429,
    });
  }
  return new AdapterError(
    ErrorCode.INVALID_ARGS,
    `${context}: request failed (${response.status}${reason ? `, ${reason}` : ""})`,
    { status: response.status, reason },
  );
}

function extractReason(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { errors?: Array<{ reason?: string }>; message?: string };
    };
    return parsed.error?.errors?.[0]?.reason ?? parsed.error?.message ?? "";
  } catch {
    return "";
  }
}

/**
 * Authenticated JSON call against the Data API. Retries are NOT handled here —
 * list/insert callers fail closed on first error; only the resumable-upload
 * module implements the official backoff protocol.
 */
export async function apiJson(
  transport: Transport,
  accessToken: string,
  request: Omit<TransportRequest, "headers"> & { headers?: Record<string, string> },
  context: string,
): Promise<unknown> {
  const response = await transport({
    ...request,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
      ...request.headers,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw mapApiError(response, context);
  }
  return parseJson(response, context);
}
