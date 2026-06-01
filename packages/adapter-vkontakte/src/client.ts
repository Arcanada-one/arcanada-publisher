// VK API HTTP transport seam. Calls go to https://api.vk.com/method/<method>
// with form params (access_token, v, …). The transport is injectable so the
// request trace (method + params, including reply_to_comment) is verifiable
// against a recorded fixture without any live posting (V-AC-13).

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface VkRequest {
  /** VK method name, e.g. "wall.post" or "wall.createComment". */
  method: string;
  /** Method params (excluding access_token / v, which the transport adds). */
  params: Record<string, string>;
}

export interface VkResponse {
  status: number;
  json: unknown;
}

export type VkTransport = (req: VkRequest) => Promise<VkResponse>;

export interface VkClientOptions {
  accessToken?: string;
  apiVersion?: string;
  transport?: VkTransport;
}

const API_BASE = "https://api.vk.com/method";
const DEFAULT_API_VERSION = "5.199";

export function fetchTransport(opts: { accessToken: string; apiVersion: string }): VkTransport {
  return async (req) => {
    const body = new URLSearchParams({
      ...req.params,
      access_token: opts.accessToken,
      v: opts.apiVersion,
    }).toString();
    const res = await fetch(`${API_BASE}/${req.method}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
}

export function resolveTransport(options: VkClientOptions): VkTransport {
  if (options.transport) {
    return options.transport;
  }
  if (!options.accessToken) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "vk: accessToken is required for the live transport (or inject a transport)",
    );
  }
  return fetchTransport({
    accessToken: options.accessToken,
    apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
  });
}

/** VK wraps errors in `{ error: { error_code, error_msg } }`; raise on it. */
export function assertNoVkError(json: unknown, where: string): void {
  const err = (json as { error?: { error_code?: number; error_msg?: string } })?.error;
  if (err) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `${where}: VK API error ${err.error_code}: ${err.error_msg}`,
      {
        vkErrorCode: err.error_code,
      },
    );
  }
}
