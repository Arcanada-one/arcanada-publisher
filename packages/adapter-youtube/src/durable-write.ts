import { open } from "node:fs/promises";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

export interface SyncableDirectory {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type OpenDirectory = (directoryPath: string) => Promise<SyncableDirectory>;

const openDirectory: OpenDirectory = async (directoryPath) => open(directoryPath, "r");

/**
 * Persist a preceding atomic rename by syncing its parent directory.
 *
 * Node's directory FileHandle works on both macOS and Linux. Unsupported or
 * failed directory syncs are never ignored: callers must not report a durable
 * mutation when the platform could not establish that durability.
 */
export async function syncDirectoryDurably(
  directoryPath: string,
  opener: OpenDirectory = openDirectory,
): Promise<void> {
  let directory: SyncableDirectory | undefined;
  try {
    directory = await opener(directoryPath);
    await directory.sync();
    await directory.close();
    directory = undefined;
  } catch (error) {
    await directory?.close().catch(() => undefined);
    throw new AdapterError(
      ErrorCode.INTERNAL_PANIC,
      `directory fsync failed on ${process.platform}; refusing to report durable mutation`,
      { directoryPath, platform: process.platform, cause: String(error), recoverable: true },
    );
  }
}
