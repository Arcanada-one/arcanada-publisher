// Route handlers for the loopback API. Each agent-callable mutation passes
// through the same gauntlet before it ever reaches an adapter:
//   tool-scoping (validate inputs) → rate-limit check → adapter call →
//   audit append (live publishes only).
// Adapter construction, the audit base dir, and the rate limiter are injected
// (see RouteDeps) so the server is fully testable with an in-memory FakeAdapter
// and a temp audit dir — no browser, no network, no home-dir writes in tests.

import {
  type Adapter,
  type PublishResult,
  type Platform,
  AdapterError,
  ErrorCode,
  RateLimiter,
  appendAudit,
  isPlatform,
  validateProfileName,
  validateText,
} from "@arcanada/publisher-core";

/** Dependencies a request handler needs. Injected by the server at listen() time. */
export interface RouteDeps {
  makeAdapter: (platform: Platform) => Adapter;
  rateLimiter: RateLimiter;
  auditBaseDir?: string;
}

/** Parsed POST body — a loose bag validated per-action below. */
type Body = Record<string, unknown>;

/** Map an ErrorCode to the HTTP status the route surface returns. */
export function statusForCode(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.INVALID_ARGS:
    case ErrorCode.MISSING_INPUT:
      return 400;
    case ErrorCode.NETWORK_GUARD:
    case ErrorCode.NOT_ARMED:
      return 403;
    case ErrorCode.AUTH_EXPIRED:
      return 401;
    case ErrorCode.RATE_LIMIT:
    case ErrorCode.QUOTA_EXCEEDED:
      return 429;
    case ErrorCode.CHANNEL_MISMATCH:
    case ErrorCode.LANGUAGE_UNRESOLVED:
    case ErrorCode.PLAYLIST_BINDING_BROKEN:
    case ErrorCode.UNSUPPORTED_OPERATION:
      return 400;
    default:
      return 500;
  }
}

/** Resolve + validate the platform field, throwing INVALID_ARGS when unknown. */
function requirePlatform(body: Body): Platform {
  const platform = body.platform;
  if (!isPlatform(platform)) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, `unknown platform '${String(platform)}'`);
  }
  return platform;
}

/** Resolve the profile name (default ""), validating its shape (tool scoping). */
function resolveProfile(body: Body): string {
  const profile = typeof body.profile === "string" ? body.profile : "";
  validateProfileName(profile);
  return profile;
}

/** POST /publish — validate, rate-check, publish, audit (live only). */
async function handlePublish(body: Body, deps: RouteDeps): Promise<unknown> {
  const platform = requirePlatform(body);
  const text = typeof body.text === "string" ? body.text : "";
  const profile = resolveProfile(body);
  validateText(text, platform);
  const dryRun = body.dryRun === true;

  if (!dryRun) deps.rateLimiter.check(platform);
  const adapter = deps.makeAdapter(platform);
  const imagePaths = Array.isArray(body.imagePaths) ? (body.imagePaths as string[]) : undefined;
  const result = await adapter.publish({
    text,
    profile,
    dryRun,
    ...(imagePaths ? { imagePaths } : {}),
    ...(typeof body.subreddit === "string" ? { subreddit: body.subreddit } : {}),
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.ownerId === "number" && Number.isInteger(body.ownerId)
      ? { ownerId: body.ownerId }
      : {}),
    ...(typeof body.chatId === "string" ? { chatId: body.chatId } : {}),
    ...(typeof body.videoPath === "string" ? { videoPath: body.videoPath } : {}),
    ...(typeof body.language === "string" ? { language: body.language } : {}),
    ...(body.privacyStatus === "private" ||
    body.privacyStatus === "unlisted" ||
    body.privacyStatus === "public"
      ? { privacyStatus: body.privacyStatus }
      : {}),
  });

  if (dryRun) return result;
  deps.rateLimiter.record(platform);
  // The youtube adapter audits internally (fail-closed) and carries its own
  // auditRef — do not double-audit or displace the stronger ref. Pinned to the
  // platform so a spurious auditRef from any OTHER adapter can never suppress
  // the route-layer audit (route semantics unchanged for other platforms).
  if (platform === "youtube" && (result as { auditRef?: string }).auditRef) return result;
  const auditRef = await appendAudit(
    { platform, account: result.account, action: "publish", postUrl: result.postUrl },
    deps.auditBaseDir ? { baseDir: deps.auditBaseDir } : {},
  );
  // Non-youtube adapters do not own audit refs: drop any spurious incoming ref
  // so the caller never receives a ref that corresponds to no route record.
  const { auditRef: _spurious, ...clean } = result as PublishResult & { auditRef?: string };
  return { ...clean, ...(auditRef ? { auditRef } : {}) };
}

/** POST /comment — validate then comment (no rate-limit; comments are cheap). */
async function handleComment(body: Body, deps: RouteDeps): Promise<unknown> {
  const platform = requirePlatform(body);
  const profile = resolveProfile(body);
  const text = typeof body.text === "string" ? body.text : "";
  const parentPostUrl = typeof body.parentUrl === "string" ? body.parentUrl : "";
  return deps.makeAdapter(platform).comment({ parentPostUrl, text, profile });
}

/** POST /edit — validate then edit the target post. */
async function handleEdit(body: Body, deps: RouteDeps): Promise<unknown> {
  const platform = requirePlatform(body);
  const profile = resolveProfile(body);
  const postUrl = typeof body.targetUrl === "string" ? body.targetUrl : "";
  const text = typeof body.text === "string" ? body.text : undefined;
  const title = typeof body.title === "string" ? body.title : undefined;
  const privacyStatus =
    body.privacyStatus === "private" ||
    body.privacyStatus === "unlisted" ||
    body.privacyStatus === "public"
      ? body.privacyStatus
      : undefined;
  return deps.makeAdapter(platform).edit({
    postUrl,
    profile,
    ...(text !== undefined ? { text } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(privacyStatus !== undefined ? { privacyStatus } : {}),
  });
}

/** POST /delete — read-before-delete oracle is enforced by the adapter. */
async function handleDelete(body: Body, deps: RouteDeps): Promise<unknown> {
  const platform = requirePlatform(body);
  const profile = resolveProfile(body);
  const targetUrl = typeof body.targetUrl === "string" ? body.targetUrl : "";
  const expectedContent = typeof body.expectedContent === "string" ? body.expectedContent : "";
  const kind = body.kind === "comment" ? "comment" : "post";
  return deps.makeAdapter(platform).delete({ targetUrl, kind, expectedContent, profile });
}

const POST_ROUTES: Record<string, (body: Body, deps: RouteDeps) => Promise<unknown>> = {
  "/publish": handlePublish,
  "/comment": handleComment,
  "/edit": handleEdit,
  "/delete": handleDelete,
};

/** True when `path` is a known POST route. */
export function isPostRoute(path: string): boolean {
  return path in POST_ROUTES;
}

/**
 * Dispatch a parsed POST body to its handler and return the `data` payload.
 * Throws AdapterError on any validation / rate-limit / adapter failure; the
 * caller maps that to the error envelope via {@link statusForCode}.
 */
export async function dispatchPost(path: string, body: Body, deps: RouteDeps): Promise<unknown> {
  const handler = POST_ROUTES[path];
  if (!handler) throw new AdapterError(ErrorCode.INVALID_ARGS, `no route ${path}`);
  return handler(body, deps);
}
