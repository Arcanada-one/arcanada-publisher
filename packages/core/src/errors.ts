export enum ErrorCode {
  SUCCESS = 0,
  INVALID_ARGS = 1,
  MISSING_INPUT = 2,
  NO_PROFILE = 3,
  SELECTOR_TIMEOUT = 4,
  PUBLISH_BUTTON_ABSENT = 5,
  VERIFY_FAILED = 6,
  NETWORK_GUARD = 7,
  RATE_LIMIT = 8,
  DUPLICATE = 9,
  /** Authenticated identity does not own the expected channel/account. */
  CHANNEL_MISMATCH = 10,
  /** Content language absent or outside the adapter's allowed set. */
  LANGUAGE_UNRESOLVED = 11,
  /** Language→playlist binding missing, foreign, or inconsistent. */
  PLAYLIST_BINDING_BROKEN = 12,
  /** Refresh/access token expired or revoked; re-consent required. */
  AUTH_EXPIRED = 13,
  /** Upstream API quota exhausted. */
  QUOTA_EXCEEDED = 14,
  /** Operation not supported by this adapter by design. */
  UNSUPPORTED_OPERATION = 15,
  /** Live mutation attempted without the operator-armed state. */
  NOT_ARMED = 16,
  INTERNAL_PANIC = 99,
}

export interface AdapterErrorJSON {
  code: ErrorCode;
  name: string;
  message: string;
  details?: Record<string, unknown>;
}

export class AdapterError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.details = details;
  }

  toJSON(): AdapterErrorJSON {
    const out: AdapterErrorJSON = {
      code: this.code,
      name: this.name,
      message: this.message,
    };
    if (this.details !== undefined) {
      out.details = this.details;
    }
    return out;
  }
}
