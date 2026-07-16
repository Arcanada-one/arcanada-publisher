import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

import { acquireFileLease } from "./file-lease.js";
export type MutationKind = "upload" | "playlist-create" | "playlist-insert" | "edit";
export type RecoveryState = "intent" | "applied";

export interface RecoveryEntry {
  operationId: string;
  kind: MutationKind;
  key: string;
  state: RecoveryState;
  intent: Record<string, unknown>;
  result?: Record<string, unknown>;
  createdAt: string;
  appliedAt?: string;
}

const MUTATION_KINDS = new Set<MutationKind>([
  "upload",
  "playlist-create",
  "playlist-insert",
  "edit",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(record: Record<string, unknown>, keys: string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(record).length === keys.length &&
    Object.keys(record).every((key) => expected.has(key))
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validPayload(
  kind: MutationKind,
  key: string,
  state: RecoveryState,
  intent: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): boolean {
  const applied = state === "applied";
  if (kind === "upload") {
    return (
      hasOnly(intent, ["sha256", "totalBytes"]) &&
      typeof intent["sha256"] === "string" &&
      /^[0-9a-f]{64}$/.test(intent["sha256"] as string) &&
      key === intent["sha256"] &&
      typeof intent["totalBytes"] === "number" &&
      intent["totalBytes"] > 0 &&
      (!applied ||
        (result !== undefined &&
          hasOnly(result, ["videoId", "postUrl"]) &&
          nonEmpty(result["videoId"]) &&
          nonEmpty(result["postUrl"])))
    );
  }
  if (kind === "playlist-create") {
    return (
      hasOnly(intent, ["language", "canonicalTitle"]) &&
      (intent["language"] === "en" || intent["language"] === "ru") &&
      nonEmpty(intent["canonicalTitle"]) &&
      key === `canonical:${String(intent["language"])}` &&
      (!applied ||
        (result !== undefined && hasOnly(result, ["playlistId"]) && nonEmpty(result["playlistId"])))
    );
  }
  if (kind === "playlist-insert") {
    return (
      hasOnly(intent, ["playlistId", "videoId"]) &&
      nonEmpty(intent["playlistId"]) &&
      nonEmpty(intent["videoId"]) &&
      key === `${String(intent["playlistId"])}:${String(intent["videoId"])}` &&
      (!applied ||
        (result !== undefined &&
          hasOnly(result, ["playlistId", "videoId"]) &&
          result["playlistId"] === intent["playlistId"] &&
          result["videoId"] === intent["videoId"]))
    );
  }
  return (
    hasOnly(intent, ["videoId", "title", "description"]) &&
    nonEmpty(intent["videoId"]) &&
    typeof intent["title"] === "string" &&
    typeof intent["description"] === "string" &&
    (!applied ||
      (result !== undefined &&
        hasOnly(result, ["videoId", "postUrl"]) &&
        result["videoId"] === intent["videoId"] &&
        nonEmpty(result["postUrl"])))
  );
}

function validateEntries(value: unknown): RecoveryEntry[] {
  if (!Array.isArray(value)) throw new Error("root is not an array");
  const operationIds = new Set<string>();
  const keys = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) throw new Error("entry is not an object");
    const operationId = candidate["operationId"];
    const kind = candidate["kind"];
    const key = candidate["key"];
    const state = candidate["state"];
    const createdAt = candidate["createdAt"];
    if (
      typeof operationId !== "string" ||
      operationId.length === 0 ||
      typeof kind !== "string" ||
      !MUTATION_KINDS.has(kind as MutationKind) ||
      typeof key !== "string" ||
      key.length === 0 ||
      (state !== "intent" && state !== "applied") ||
      !isRecord(candidate["intent"]) ||
      typeof createdAt !== "string" ||
      Number.isNaN(Date.parse(createdAt)) ||
      (candidate["result"] !== undefined && !isRecord(candidate["result"]))
    ) {
      throw new Error("entry schema invalid");
    }
    const topKeys =
      state === "applied"
        ? ["operationId", "kind", "key", "state", "intent", "result", "createdAt", "appliedAt"]
        : ["operationId", "kind", "key", "state", "intent", "createdAt"];
    if (
      !hasOnly(candidate, topKeys) ||
      !validPayload(
        kind as MutationKind,
        key,
        state as RecoveryState,
        candidate["intent"] as Record<string, unknown>,
        candidate["result"] as Record<string, unknown> | undefined,
      )
    ) {
      throw new Error("mutation payload schema invalid");
    }
    if (
      state === "applied" &&
      (!isRecord(candidate["result"]) ||
        typeof candidate["appliedAt"] !== "string" ||
        Number.isNaN(Date.parse(candidate["appliedAt"] as string)))
    ) {
      throw new Error("applied entry schema invalid");
    }
    const mutationKey = `${kind}:${key}`;
    if (operationIds.has(operationId) || keys.has(mutationKey)) {
      throw new Error("duplicate recovery identity");
    }
    operationIds.add(operationId);
    keys.add(mutationKey);
  }
  return value as RecoveryEntry[];
}

export class RecoveryJournal {
  private static readonly locks = new Map<string, Promise<unknown>>();
  async withMutationLease<T>(kind: MutationKind, key: string, fn: () => Promise<T>): Promise<T> {
    const digest = createHash("sha256").update(`${kind}:${key}`).digest("hex");
    const release = await acquireFileLease(`${this.path}.mutation.${digest}`);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  constructor(private readonly path: string) {}

  async load(): Promise<RecoveryEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return validateEntries(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new AdapterError(
        ErrorCode.INVALID_ARGS,
        "recovery journal corrupt — fail closed before mutation",
      );
    }
  }

  async find(kind: MutationKind, key: string): Promise<RecoveryEntry | undefined> {
    return (await this.load()).find((entry) => entry.kind === kind && entry.key === key);
  }

  async begin(
    kind: MutationKind,
    key: string,
    intent: Record<string, unknown>,
  ): Promise<RecoveryEntry> {
    return (await this.beginWithStatus(kind, key, intent)).entry;
  }

  async beginWithStatus(
    kind: MutationKind,
    key: string,
    intent: Record<string, unknown>,
  ): Promise<{ entry: RecoveryEntry; created: boolean }> {
    return this.withLock(async () => {
      const entries = await this.load();
      const existing = entries.find((entry) => entry.kind === kind && entry.key === key);
      if (existing) {
        if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
          throw new AdapterError(
            ErrorCode.VERIFY_FAILED,
            "recovery operation intent does not match the requested mutation",
          );
        }
        return { entry: existing, created: false };
      }
      const entry: RecoveryEntry = {
        operationId: randomUUID(),
        kind,
        key,
        state: "intent",
        intent,
        createdAt: new Date().toISOString(),
      };
      await this.write([...entries, entry]);
      return { entry, created: true };
    });
  }

  async markApplied(operationId: string, result: Record<string, unknown>): Promise<void> {
    await this.update(operationId, (entry) => ({
      ...entry,
      state: "applied",
      result,
      appliedAt: new Date().toISOString(),
    }));
  }

  async resolve(operationId: string): Promise<void> {
    await this.withLock(async () => {
      const entries = await this.load();
      await this.write(entries.filter((entry) => entry.operationId !== operationId));
    });
  }

  private async update(
    operationId: string,
    transform: (entry: RecoveryEntry) => RecoveryEntry,
  ): Promise<void> {
    await this.withLock(async () => {
      const entries = await this.load();
      const index = entries.findIndex((entry) => entry.operationId === operationId);
      if (index < 0) {
        throw new AdapterError(ErrorCode.INVALID_ARGS, "recovery operation not found");
      }
      entries[index] = transform(entries[index] as RecoveryEntry);
      await this.write(entries);
    });
  }

  private async write(entries: RecoveryEntry[]): Promise<void> {
    validateEntries(entries);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let moved = false;
    try {
      await writeFile(temp, JSON.stringify(entries) + "\n", { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      const file = await open(temp, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.path);
      moved = true;
      await chmod(this.path, 0o600);
      const parent = await open(dirname(this.path), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      if (!moved) await unlink(temp).catch(() => undefined);
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = RecoveryJournal.locks.get(this.path) ?? Promise.resolve();
    const execute = async (): Promise<T> => {
      const release = await acquireFileLease(this.path, 250);
      try {
        return await fn();
      } finally {
        await release();
      }
    };
    const next = previous.then(execute, execute);
    RecoveryJournal.locks.set(
      this.path,
      next.catch(() => undefined),
    );
    return next;
  }
}
