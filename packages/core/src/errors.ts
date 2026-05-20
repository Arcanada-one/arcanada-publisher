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
