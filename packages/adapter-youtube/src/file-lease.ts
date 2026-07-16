import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";
import { lock, type LockOptions } from "proper-lockfile";

export type LeaseBackend = (
  resourcePath: string,
  options: LockOptions,
) => Promise<() => Promise<void>>;

export async function acquireFileLease(
  resourcePath: string,
  timeoutMs = 5_000,
  backend: LeaseBackend = lock,
): Promise<() => Promise<void>> {
  await mkdir(dirname(resourcePath), { recursive: true, mode: 0o700 });
  try {
    return await backend(resourcePath, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: {
        retries: Math.max(1, Math.ceil(timeoutMs / 50)),
        factor: 1,
        minTimeout: 50,
        maxTimeout: 50,
      },
    });
  } catch (error) {
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      `ownership lease unavailable - refusing mutation: ${String(error)}`,
      { resourcePath, recoverable: true },
    );
  }
}
