import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AdapterError, ErrorCode } from "@arcanada/publisher-core";

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
    return this.withLock(async () => {
      const entries = await this.load();
      const existing = entries.find((entry) => entry.kind === kind && entry.key === key);
      if (existing) return existing;
      const entry: RecoveryEntry = {
        operationId: randomUUID(),
        kind,
        key,
        state: "intent",
        intent,
        createdAt: new Date().toISOString(),
      };
      await this.write([...entries, entry]);
      return entry;
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
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(entries) + "\n", { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
    await chmod(this.path, 0o600);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = RecoveryJournal.locks.get(this.path) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    RecoveryJournal.locks.set(
      this.path,
      next.catch(() => undefined),
    );
    return next;
  }
}
