// Cost circuit-breaker: a per-platform sliding-window rate limiter. This is the
// AAL L2 "cost-circuit-breaker-per-platform" control — it caps how many real
// publishes an agent can trigger per platform per hour, so a runaway loop or a
// misbehaving caller cannot burn an account's posting reputation. A breach maps
// to the existing RATE_LIMIT (8) error code.
//
// State is in-memory and per-process: the limiter lives for the lifetime of the
// loopback server. Dry-runs never touch it (no real cost), so callers must only
// check/record on the live path.

import { AdapterError, ErrorCode } from "./errors.js";
import type { Platform } from "./platform.js";

/** Default ceiling: 5 publishes per platform per rolling hour. */
export const DEFAULT_RATE_PER_HOUR = 5;

/** Sliding-window width: one hour in milliseconds. */
export const WINDOW_MS = 60 * 60 * 1000;

export interface RateLimiterOptions {
  /** Clock source (ms epoch). Injectable for deterministic tests. */
  now?: () => number;
  /**
   * Env-key suffix so a second limiter class (e.g. preflight metering) can be
   * tuned independently: key becomes ARCANADA_PUBLISHER_RATE_<PLATFORM><suffix>.
   */
  envSuffix?: string;
  /** Default ceiling override for this limiter instance. */
  defaultPerHour?: number;
}

export class RateLimiter {
  private readonly now: () => number;
  private readonly envSuffix: string;
  private readonly defaultPerHour: number;
  private readonly events = new Map<Platform, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.envSuffix = options.envSuffix ?? "";
    this.defaultPerHour = options.defaultPerHour ?? DEFAULT_RATE_PER_HOUR;
  }

  /** Resolve the per-hour ceiling for a platform, honouring the env override. */
  private limitFor(platform: Platform): number {
    const raw = process.env[`ARCANADA_PUBLISHER_RATE_${platform.toUpperCase()}${this.envSuffix}`];
    if (raw === undefined) return this.defaultPerHour;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : this.defaultPerHour;
  }

  /** Drop events that have aged out of the window; return the surviving list. */
  private prune(platform: Platform): number[] {
    const cutoff = this.now() - WINDOW_MS;
    const kept = (this.events.get(platform) ?? []).filter((ts) => ts > cutoff);
    this.events.set(platform, kept);
    return kept;
  }

  /**
   * Throw RATE_LIMIT if recording one more publish would breach the platform's
   * window ceiling. Call this BEFORE the adapter publish; call {@link record}
   * after it succeeds. Prunes expired events as a side effect.
   */
  check(platform: Platform): void {
    const current = this.prune(platform).length;
    const limit = this.limitFor(platform);
    if (current >= limit) {
      throw new AdapterError(
        ErrorCode.RATE_LIMIT,
        `rate limit exceeded for ${platform}: ${current}/${limit} publishes in the last hour`,
        { platform, limit, current, windowMs: WINDOW_MS },
      );
    }
  }

  /** Record a successful publish at the current time. */
  record(platform: Platform): void {
    const list = this.events.get(platform) ?? [];
    list.push(this.now());
    this.events.set(platform, list);
  }

  /** Live count of events within the window (for diagnostics / tests). */
  count(platform: Platform): number {
    return this.prune(platform).length;
  }
}
