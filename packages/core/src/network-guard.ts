import { AdapterError, ErrorCode } from "./errors.js";

const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopback(bind: string): boolean {
  return LOOPBACK_BINDS.has(bind);
}

export function assertLoopback(bind: string): void {
  if (!isLoopback(bind)) {
    throw new AdapterError(
      ErrorCode.NETWORK_GUARD,
      `bind '${bind}' is not loopback — Tier 1 default required, override via explicit --bind flag`,
      { bind, allowed: Array.from(LOOPBACK_BINDS) },
    );
  }
}
