// Reddit HTTP transport seam. The adapter issues form-encoded POSTs to the
// OAuth API (oauth.reddit.com). The transport is injectable so the request
// trace (endpoint + form fields) can be asserted against a recorded fixture
// without any live posting (V-AC-12).

import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface RedditRequest {
  /** Path under https://oauth.reddit.com, e.g. "/api/submit". */
  path: string;
  /** Form-encoded body fields. */
  form: Record<string, string>;
}

export interface RedditResponse {
  status: number;
  json: unknown;
}

/** A transport sends a RedditRequest and returns the parsed response. */
export type RedditTransport = (req: RedditRequest) => Promise<RedditResponse>;

export interface RedditClientOptions {
  accessToken?: string;
  userAgent?: string;
  /** Injected transport (tests / fixtures). Defaults to a live fetch. */
  transport?: RedditTransport;
}

const OAUTH_BASE = "https://oauth.reddit.com";

/** Build the default live transport (form-encoded, bearer-authed fetch). */
export function fetchTransport(opts: { accessToken: string; userAgent: string }): RedditTransport {
  return async (req) => {
    const body = new URLSearchParams({ ...req.form, api_type: "json" }).toString();
    const res = await fetch(`${OAUTH_BASE}${req.path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        "User-Agent": opts.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
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

/** Resolve the transport to use, building the live one if none injected. */
export function resolveTransport(options: RedditClientOptions): RedditTransport {
  if (options.transport) {
    return options.transport;
  }
  if (!options.accessToken) {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "reddit: accessToken is required for the live transport (or inject a transport)",
    );
  }
  return fetchTransport({
    accessToken: options.accessToken,
    userAgent: options.userAgent ?? "arcanada-publisher/0.1 (by /u/arcanada)",
  });
}
