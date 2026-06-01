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
