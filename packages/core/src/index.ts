export { PLATFORMS, isPlatform } from "./platform.js";
export type { Platform } from "./platform.js";

export { ErrorCode, AdapterError } from "./errors.js";
export type { AdapterErrorJSON } from "./errors.js";

export {
  PublishResultSchema,
  CommentResultSchema,
  EditResultSchema,
  VerifyResultSchema,
} from "./result.js";
export type { PublishResult, CommentResult, EditResult, VerifyResult } from "./result.js";

export { assertLoopback, isLoopback } from "./network-guard.js";

export { ProfileManager } from "./profile.js";
export type { ProfileManagerOptions } from "./profile.js";

export { BaseAdapter } from "./adapter.js";
export type { Adapter, PublishInput, CommentInput, EditInput, LoginOptions } from "./adapter.js";
