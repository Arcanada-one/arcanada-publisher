export { PLATFORMS, isPlatform } from "./platform.js";
export type { Platform } from "./platform.js";

export { ErrorCode, AdapterError } from "./errors.js";
export type { AdapterErrorJSON } from "./errors.js";

export {
  PublishResultSchema,
  CommentResultSchema,
  EditResultSchema,
  VerifyResultSchema,
  DeleteResultSchema,
} from "./result.js";
export type {
  PublishResult,
  CommentResult,
  EditResult,
  VerifyResult,
  DeleteResult,
} from "./result.js";

export { assertLoopback, isLoopback } from "./network-guard.js";

export { ProfileManager } from "./profile.js";
export type { ProfileManagerOptions } from "./profile.js";

export { BaseAdapter } from "./adapter.js";
export type {
  Adapter,
  PublishInput,
  CommentInput,
  EditInput,
  DeleteInput,
  LoginOptions,
} from "./adapter.js";

export { enforce, PolicyConfigSchema } from "./policy/index.js";
export type { PolicyConfig, PolicyInput, EnforcedPost } from "./policy/index.js";

export {
  validateText,
  validateImageMime,
  validateProfileName,
  PLATFORM_TEXT_LIMITS,
  IMAGE_MIME_ALLOWLIST,
} from "./tool-scoping.js";

export { appendAudit, AUDIT_REF_RE } from "./audit.js";
export type { AuditInput, AuditOptions, AuditAction } from "./audit.js";

export { RateLimiter, DEFAULT_RATE_PER_HOUR, WINDOW_MS } from "./rate-limit.js";
export type { RateLimiterOptions } from "./rate-limit.js";
