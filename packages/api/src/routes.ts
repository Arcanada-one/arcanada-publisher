// Route handlers for the loopback API. Each agent-callable mutation passes
// through the same gauntlet before it ever reaches an adapter:
//   tool-scoping (validate inputs) → rate-limit check → adapter call →
//   audit append (live publishes only).
// Adapter construction, the audit base dir, and the rate limiter are injected
// (see RouteDeps) so the server is fully testable with an in-memory FakeAdapter
// and a temp audit dir — no browser, no network, no home-dir writes in tests.

import {
  type Adapter,
  type Platform,
  AdapterError,
  ErrorCode,
  RateLimiter,
  appendAudit,
  isPlatform,
  validateProfileName,
  validateText,
  CampaignGuard,
  type CampaignMutationInput,
  type CampaignPublicAction,
} from "@arcanada/publisher-core";

export type CampaignGuardPort = Pick<CampaignGuard, "authorize" | "preflight"> &
  Partial<Pick<CampaignGuard, "recordResult">>;

/** Dependencies a request handler needs. Injected by the server at listen() time. */
export interface RouteDeps {
  makeAdapter: (platform: Platform) => Adapter;
  rateLimiter: RateLimiter;
  auditBaseDir?: string;
  campaignGuard: CampaignGuardPort;
}

/** Parsed POST body — a loose bag validated per-action below. */
type Body = Record<string, unknown>;

/** Map an ErrorCode to the HTTP status the route surface returns. */
export function statusForCode(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.INVALID_ARGS:
    case ErrorCode.MISSING_INPUT:
    case ErrorCode.CAMPAIGN_MANIFEST_REQUIRED:
    case ErrorCode.CAMPAIGN_MANIFEST_INVALID:
      return 400;
    case ErrorCode.NETWORK_GUARD:
    case ErrorCode.CAMPAIGN_TARGET_MISMATCH:
    case ErrorCode.CAMPAIGN_POLICY_UNKNOWN:
    case ErrorCode.CAMPAIGN_EVIDENCE_MISSING:
    case ErrorCode.CAMPAIGN_EVIDENCE_STALE:
    case ErrorCode.CAMPAIGN_ASSET_MISMATCH:
    case ErrorCode.CAMPAIGN_MEDIA_POLICY:
    case ErrorCode.CAMPAIGN_RECEIPT_REQUIRED:
    case ErrorCode.CAMPAIGN_RECEIPT_INVALID:
    case ErrorCode.CAMPAIGN_RECEIPT_EXPIRED:
    case ErrorCode.CAMPAIGN_BACKLINKS_NOT_READY:
      return 403;
    case ErrorCode.CAMPAIGN_RECEIPT_REPLAY:
    case ErrorCode.CAMPAIGN_STATE_UNKNOWN:
      return 409;
    case ErrorCode.RATE_LIMIT:
      return 429;
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

/** Resolve the profile name to the same canonical default used by the CLI and profile store. */
function resolveProfile(body: Body): string {
  const profile =
    typeof body.profile === "string" && body.profile !== "" ? body.profile : "default";
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
  const imagePaths = Array.isArray(body.imagePaths) ? (body.imagePaths as string[]) : [];

  const authorization = await deps.campaignGuard.authorize(
    campaignInput(body, platform, profile, "publish", text, imagePaths, dryRun),
  );
  if (!dryRun) deps.rateLimiter.check(platform);
  const adapter = deps.makeAdapter(platform);
  const result = await adapter.publish({
    text,
    profile,
    dryRun,
    ...(imagePaths.length > 0 ? { imagePaths } : {}),
    ...(typeof body.subreddit === "string" ? { subreddit: body.subreddit } : {}),
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.ownerId === "number" && Number.isInteger(body.ownerId)
      ? { ownerId: body.ownerId }
      : {}),
    ...(typeof body.chatId === "string" ? { chatId: body.chatId } : {}),
  });

  if (dryRun) return result;
  const verification = authorization.managed ? await adapter.verify(result.postUrl) : undefined;
  deps.campaignGuard.recordResult?.(authorization, result.postUrl, verification);
  deps.rateLimiter.record(platform);
  const auditRef = await appendAudit(
    { platform, account: result.account, action: "publish", postUrl: result.postUrl },
    deps.auditBaseDir ? { baseDir: deps.auditBaseDir } : {},
  );
  return { ...result, ...(auditRef ? { auditRef } : {}) };
}

/** POST /comment — validate then comment (no rate-limit; comments are cheap). */
async function handleComment(body: Body, deps: RouteDeps): Promise<unknown> {
  const platform = requirePlatform(body);
  const profile = resolveProfile(body);
  const text = typeof body.text === "string" ? body.text : "";
  const parentPostUrl = typeof body.parentUrl === "string" ? body.parentUrl : "";
  const authorization = await deps.campaignGuard.authorize(
    campaignInput(body, platform, profile, "comment", text, [], false),
  );
  const adapter = deps.makeAdapter(platform);
  const result = await adapter.comment({ parentPostUrl, text, profile });
  const verification = authorization.managed
    ? await adapter.verify(result.parentPostUrl)
    : undefined;
  deps.campaignGuard.recordResult?.(
    authorization,
    `${result.parentPostUrl}#comment:${result.commentId}`,
    verification,
  );
  return result;
}

/** POST /edit — validate then edit the target post. */
async function handleEdit(body: Body, deps: RouteDeps): Promise<unknown> {
  const platform = requirePlatform(body);
  const profile = resolveProfile(body);
  const postUrl = typeof body.targetUrl === "string" ? body.targetUrl : "";
  const text = typeof body.text === "string" ? body.text : undefined;
  const expectedContent =
    typeof body.expectedContent === "string" ? body.expectedContent : undefined;
  const imagePaths = Array.isArray(body.imagePaths) ? (body.imagePaths as string[]) : [];
  const authorization = await deps.campaignGuard.authorize(
    campaignInput(body, platform, profile, "edit", text, imagePaths, false),
  );
  const adapter = deps.makeAdapter(platform);
  const result = await adapter.edit({
    postUrl,
    profile,
    ...(text !== undefined ? { text } : {}),
    ...(imagePaths[0] ? { imagePath: imagePaths[0] } : {}),
    ...(expectedContent !== undefined ? { expectedContent } : {}),
    ...(typeof body.videoWidth === "number" ? { videoWidth: body.videoWidth } : {}),
    ...(typeof body.videoHeight === "number" ? { videoHeight: body.videoHeight } : {}),
    ...(typeof body.videoDuration === "number" ? { videoDuration: body.videoDuration } : {}),
  });
  const verification = authorization.managed ? await adapter.verify(result.postUrl) : undefined;
  deps.campaignGuard.recordResult?.(authorization, result.postUrl, verification);
  return result;
}

/** POST /delete — read-before-delete oracle is enforced by the adapter. */
async function handleDelete(body: Body, deps: RouteDeps): Promise<unknown> {
  const platform = requirePlatform(body);
  const profile = resolveProfile(body);
  const targetUrl = typeof body.targetUrl === "string" ? body.targetUrl : "";
  const expectedContent = typeof body.expectedContent === "string" ? body.expectedContent : "";
  const kind = body.kind === "comment" ? "comment" : "post";
  const authorization = await deps.campaignGuard.authorize(
    campaignInput(body, platform, profile, "delete", expectedContent, [], false),
  );
  const adapter = deps.makeAdapter(platform);
  const result = await adapter.delete({ targetUrl, kind, expectedContent, profile });
  const verification = authorization.managed ? await adapter.verify(result.targetUrl) : undefined;
  deps.campaignGuard.recordResult?.(authorization, result.targetUrl, verification);
  return result;
}

async function handleCampaignPreflight(body: Body, deps: RouteDeps): Promise<unknown> {
  const platform = requirePlatform(body);
  const profile = resolveProfile(body);
  const action = requireCampaignAction(body.action);
  const text = typeof body.text === "string" ? body.text : undefined;
  const imagePaths = Array.isArray(body.imagePaths) ? (body.imagePaths as string[]) : [];
  const input = campaignInput(body, platform, profile, action, text, imagePaths, false);
  const receipt = await deps.campaignGuard.preflight(input);
  return { receipt };
}

const POST_ROUTES: Record<string, (body: Body, deps: RouteDeps) => Promise<unknown>> = {
  "/publish": handlePublish,
  "/comment": handleComment,
  "/edit": handleEdit,
  "/delete": handleDelete,
  "/campaign/preflight": handleCampaignPreflight,
};

function campaignInput(
  body: Body,
  platform: Platform,
  profile: string,
  action: CampaignPublicAction,
  text: string | undefined,
  mediaPaths: readonly string[],
  dryRun: boolean,
): CampaignMutationInput {
  return {
    platform,
    profile,
    ...campaignDestination(body, platform),
    action,
    ...(typeof body.campaignTargetId === "string"
      ? { campaignTargetId: body.campaignTargetId }
      : {}),
    ...campaignSubject(body, action),
    ...(typeof body.campaignManifestPath === "string"
      ? { manifestPath: body.campaignManifestPath }
      : {}),
    ...(typeof body.campaignReceipt === "string" ? { receipt: body.campaignReceipt } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(action === "edit" && typeof body.expectedContent === "string"
      ? { existingText: body.expectedContent }
      : {}),
    mediaPaths,
    dryRun,
  };
}

function campaignSubject(
  body: Body,
  action: CampaignPublicAction,
): Pick<CampaignMutationInput, "subjectUrl"> {
  if (action === "comment" && typeof body.parentUrl === "string") {
    return { subjectUrl: body.parentUrl };
  }
  if ((action === "edit" || action === "delete") && typeof body.targetUrl === "string") {
    return { subjectUrl: body.targetUrl };
  }
  return {};
}

function campaignDestination(
  body: Body,
  platform: Platform,
): Pick<CampaignMutationInput, "destination"> {
  if (platform === "telegram" && typeof body.chatId === "string")
    return { destination: { chatId: body.chatId } };
  if (platform === "reddit" && typeof body.subreddit === "string")
    return { destination: { subreddit: body.subreddit } };
  if (
    platform === "vkontakte" &&
    typeof body.ownerId === "number" &&
    Number.isInteger(body.ownerId)
  )
    return { destination: { ownerId: body.ownerId } };
  if (typeof body.expectedAuthorProfileUrl === "string")
    return { destination: { authorProfileUrl: body.expectedAuthorProfileUrl } };
  return {};
}

function requireCampaignAction(value: unknown): CampaignPublicAction {
  if (
    value === "publish" ||
    value === "comment" ||
    value === "edit" ||
    value === "delete" ||
    value === "backlink-deploy"
  )
    return value;
  throw new AdapterError(ErrorCode.INVALID_ARGS, "invalid campaign action");
}

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
