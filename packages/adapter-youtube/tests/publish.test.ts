// PUB-0035 publish orchestre: "uploading",tion (plan Phase 4.2, C16 mapping): terminal
// states, ordering (playlist insert only post-processed), read-back warnings,
// private-lock detection, fail-closed audit, module-scope limiter persistence,
// title-consistency guard, env non-override of the channel constant, duplicate
// abort at the ledger, expired-session fresh start.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ErrorCode, RateLimiter, appendAudit } from "@arcanada/publisher-core";
import { afterEach, describe, expect, it } from "vitest";
import { AuthManager } from "../src/auth.js";
import { UploadLedger } from "../src/ledger.js";
import { RecoveryJournal } from "../src/recovery-journal.js";
import { publishYouTube, type PublishDeps } from "../src/publish.js";
import { YouTubeAdapter } from "../src/index.js";
import {
  CHANNEL_ID,
  UPLOADS_ID,
  channelResponder,
  happyResponders,
  json,
  makeFixture,
  makeTransport,
  playlistItemsResponders,
  playlistsResponder,
  processedVideo,
  tokenResponder,
  uploadResponders,
  videoStatusResponder,
  type Recorder,
  type Responder,
} from "./helpers.js";

const RU = { title: "Заголовок выпуска", text: "Описание: https://arcanada.ai/ru/blog/x" };

async function makeDeps(responders: Responder[], envOver: Record<string, string | undefined> = {}) {
  const fixture = await makeFixture();
  const recorder: Recorder = makeTransport(responders);
  const env = { ...fixture.env, ...envOver } as NodeJS.ProcessEnv;
  const auth = new AuthManager("origin", {
    transport: recorder.transport,
    env,
    profilesRoot: fixture.profilesRoot,
  });
  const ledgerPath = join(dirname(auth.tokenPath()), "ledger.jsonl");
  const journalPath = join(dirname(auth.tokenPath()), "recovery.json");
  const bytes = new Uint8Array(await readFile(fixture.videoPath));
  const deps: PublishDeps = {
    transport: recorder.transport,
    auth,
    env,
    ledger: new UploadLedger(ledgerPath),
    journal: new RecoveryJournal(journalPath),
    loadSource: () =>
      Promise.resolve({
        bytes,
        source: { size: bytes.length, slice: (o: number) => bytes.subarray(o) },
        mime: "video/mp4",
      }),
    auditOptions: { baseDir: fixture.auditBaseDir },
    sleep: () => Promise.resolve(),
    pollIntervalMs: 1,
    limiter: new RateLimiter(),
    preflightLimiter: new RateLimiter(),
  };
  return { deps, recorder, fixture, ledgerPath, journalPath, env };
}

const input = (over: Record<string, unknown> = {}) => ({
  ...RU,
  profile: "origin",
  language: "ru",
  videoPath: "unused-by-injected-loadSource.mp4",
  privacyStatus: "private" as const,
  ...over,
});

type AuditAppend = typeof appendAudit;

function failAudit(
  action: Parameters<AuditAppend>[0]["action"],
  phase: "intent" | "outcome",
): AuditAppend {
  return (input, options) =>
    input.action === action && input.phase === phase
      ? Promise.resolve(null)
      : appendAudit(input, options);
}

describe("happy path", () => {
  it("uploads, inserts into the RU playlist only after processed, reads back, audits", async () => {
    const { deps, recorder, fixture } = await makeDeps(happyResponders());
    const result = await publishYouTube(input(), deps);
    expect(result.postUrl).toBe("https://www.youtube.com/watch?v=vid001");
    expect(result.account).toBe(CHANNEL_ID);
    expect(result.warnings).toEqual([]);
    expect(result.auditRef).toMatch(/^PUB-audit-/);
    // ordering: the playlistItems POST comes after the videos.list poll
    const urls = recorder.requests.map((r) => `${r.method} ${r.url.split("?")[0]}`);
    const pollIndex = urls.findIndex((u) => u.startsWith("GET") && u.includes("/videos"));
    const insertIndex = urls.findIndex((u) => u.startsWith("POST") && u.includes("/playlistItems"));
    expect(insertIndex).toBeGreaterThan(pollIndex);
    // metadata: made-for-kids + both language fields on the session start
    const start = recorder.requests.find((r) => r.url.includes("uploadType=resumable"));
    const metadata = JSON.parse(start?.body as string) as {
      snippet: { defaultLanguage: string; defaultAudioLanguage: string };
      status: { selfDeclaredMadeForKids: boolean; privacyStatus: string };
    };
    expect(metadata.snippet.defaultLanguage).toBe("ru");
    expect(metadata.snippet.defaultAudioLanguage).toBe("ru");
    expect(metadata.status.selfDeclaredMadeForKids).toBe(false);
    // audit record exists and carries no secrets
    const auditFiles = await readdir(fixture.auditBaseDir);
    const audit = await readFile(join(fixture.auditBaseDir, auditFiles[0] ?? ""), "utf8");
    expect(audit).toContain('"action":"publish"');
    expect(audit).not.toMatch(/upload_id=|ya29\.|GOCSPX-/);
    expect(audit).not.toContain("TESTSESSION"); // the sessionUri bearer capability itself
  });
});

describe("terminal states and poll cap", () => {
  it("rejected(duplicate) fails and never touches the playlist", async () => {
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      ...uploadResponders(),
      videoStatusResponder({ status: { uploadStatus: "rejected", rejectionReason: "duplicate" } }),
    ]);
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/duplicate/);
    expect(recorder.requests.some((r) => r.url.includes("/playlistItems"))).toBe(false);
  });

  it("failed carries the failureReason", async () => {
    const { deps } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      ...uploadResponders(),
      videoStatusResponder({ status: { uploadStatus: "failed", failureReason: "codec" } }),
    ]);
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/codec/);
  });

  it("terminated is terminal — proceeds to read-back", async () => {
    const { deps } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      ...uploadResponders(),
      videoStatusResponder(
        processedVideo({
          status: { uploadStatus: "uploaded", privacyStatus: "private" },
          processingDetails: { processingStatus: "terminated" },
        }),
      ),
      ...playlistItemsResponders(),
    ]);
    const result = await publishYouTube(input(), deps);
    expect(result.postUrl).toContain("vid001");
  });

  it("poll timeout fails explicitly instead of hanging", async () => {
    let clock = 0;
    const { deps } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      ...uploadResponders(),
      videoStatusResponder({
        status: { uploadStatus: "uploaded" },
        processingDetails: { processingStatus: "processing" },
      }),
    ]);
    deps.now = () => (clock += 120_000);
    deps.pollTimeoutMs = 300_000;
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/timeout/);
  });
});

describe("read-back and playlist phase", () => {
  it("does not report a false description divergence when YouTube strips the text-file newline", async () => {
    const { deps } = await makeDeps(happyResponders());
    const result = await publishYouTube(input({ text: `${RU.text}\n` }), deps);
    expect(result.warnings).not.toContain(
      "read-back divergence: description differs from the requested metadata",
    );
  });

  it("private-lock: effective private vs requested public surfaces in warnings", async () => {
    const { deps } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      ...uploadResponders(),
      videoStatusResponder(processedVideo()), // effective: private
      ...playlistItemsResponders(),
    ]);
    const result = await publishYouTube(input({ privacyStatus: "public" }), deps);
    expect(result.warnings.join("\n")).toMatch(/private-lock|privacyStatus divergence/);
  });

  it("read-back divergences: title/description/missing-duration all surface in warnings", async () => {
    const { deps } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      ...uploadResponders(),
      videoStatusResponder(
        processedVideo({
          snippet: {
            title: "Другой заголовок",
            description: "другое описание",
            channelId: CHANNEL_ID,
          },
          contentDetails: {},
        }),
      ),
      ...playlistItemsResponders(),
    ]);
    const result = await publishYouTube(input(), deps);
    const joined = result.warnings.join("\n");
    expect(joined).toMatch(/title differs/);
    expect(joined).toMatch(/description differs/);
    expect(joined).toMatch(/duration not exposed/);
  });

  it("insert failure after processed preserves the videoId in the ledger (reconciliation)", async () => {
    const { deps, ledgerPath } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      ...uploadResponders(),
      videoStatusResponder(processedVideo()),
      (req) =>
        req.method === "GET" && req.url.includes("/playlistItems?part=id")
          ? json(200, { items: [] })
          : undefined,
      (req) =>
        req.method === "POST" && req.url.includes("/playlistItems")
          ? json(500, { error: { message: "backend" } })
          : undefined,
    ]);
    await expect(publishYouTube(input(), deps)).rejects.toThrow();
    const ledger = await readFile(ledgerPath, "utf8");
    expect(ledger).toContain('"videoId":"vid001"'); // upload survived; operator/reconciliation can finish placement
  });

  it("duplicate re-run aborts at the ledger BEFORE any upload request", async () => {
    const { deps, recorder, ledgerPath } = await makeDeps(happyResponders());
    await publishYouTube(input(), deps);
    const before = recorder.requests.length;
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/duplicate upload blocked/);
    const after = recorder.requests.slice(before);
    expect(after.some((r) => r.url.includes("uploadType=resumable"))).toBe(false);
    expect(await readFile(ledgerPath, "utf8")).toContain("vid001");
  });

  it("LIVE pending session: probe→incomplete resumes the SAME session from the server offset", async () => {
    const LIVE_SESSION = "https://upload.googleapis.com/session/PENDINGLIVE";
    const puts: string[] = [];
    const { deps, ledgerPath } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      (req) => {
        if (req.method !== "PUT" || req.url !== LIVE_SESSION) return undefined;
        puts.push(req.headers?.["content-range"] ?? "");
        if (req.headers?.["content-range"]?.startsWith("bytes */")) {
          return { status: 308, headers: { range: "bytes=0-2" }, text: "" };
        }
        return json(200, { id: "vid009" });
      },
      videoStatusResponder(processedVideo(), "vid009"),
      ...playlistItemsResponders(),
    ]);
    const loaded = await deps.loadSource("x");
    const { sha256Bytes } = await import("../src/ledger.js");
    await deps.ledger.append({
      sha256: sha256Bytes(loaded.bytes ?? new Uint8Array()),
      title: RU.title,
      totalBytes: loaded.source.size,
      startedAt: "2026-07-16T00:00:00Z",
      sessionUri: LIVE_SESSION,
    });
    const result = await publishYouTube(input(), deps);
    expect(result.postUrl).toContain("vid009");
    expect(puts[0]).toBe(`bytes */${loaded.source.size}`); // probe first, total pinned
    expect(puts[1]).toBe(`bytes */${loaded.source.size}`); // authoritative probe inside lease
    expect(puts[2]).toBe(`bytes 3-${loaded.source.size - 1}/${loaded.source.size}`); // resume from server offset, not 0
    expect(await readFile(ledgerPath, "utf8")).not.toContain("PENDINGLIVE"); // scrubbed
  });

  it("LIVE pending session: probe→done adopts the existing videoId with zero transfer", async () => {
    const LIVE_SESSION = "https://upload.googleapis.com/session/DONEALREADY";
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      (req) =>
        req.method === "PUT" && req.url === LIVE_SESSION ? json(200, { id: "vid010" }) : undefined,
      videoStatusResponder(processedVideo(), "vid010"),
      ...playlistItemsResponders(),
    ]);
    const loaded = await deps.loadSource("x");
    const { sha256Bytes } = await import("../src/ledger.js");
    await deps.ledger.append({
      sha256: sha256Bytes(loaded.bytes ?? new Uint8Array()),
      title: RU.title,
      totalBytes: loaded.source.size,
      startedAt: "2026-07-16T00:00:00Z",
      sessionUri: LIVE_SESSION,
    });
    const result = await publishYouTube(input(), deps);
    expect(result.postUrl).toContain("vid010");
    // Early probe plus authoritative in-lease probe; zero data re-transfer.
    const sessionPuts = recorder.requests.filter((r) => r.url === LIVE_SESSION);
    expect(sessionPuts).toHaveLength(2);
    expect(sessionPuts.every((request) => request.headers?.["content-range"] === "bytes */8")).toBe(
      true,
    );
    expect(sessionPuts.every((request) => request.body === undefined)).toBe(true);
    expect(recorder.requests.some((r) => r.url.includes("uploadType=resumable"))).toBe(false);
    const probeIndex = recorder.requests.findIndex((request) => request.url === LIVE_SESSION);
    const channelIndex = recorder.requests.findIndex((request) =>
      request.url.includes("/channels?"),
    );
    expect(probeIndex).toBeGreaterThan(-1);
    expect(channelIndex).toBeGreaterThan(probeIndex);
  });

  it("uploaded retry probes first, proves uploads-playlist ownership, and never re-uploads", async () => {
    const SESSION = "https://upload.googleapis.com/session/UPLOADED";
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      (req) =>
        req.method === "PUT" && req.url === SESSION ? json(200, { id: "vid011" }) : undefined,
      (req) =>
        req.method === "GET" &&
        req.url.includes(`playlistId=${UPLOADS_ID}`) &&
        req.url.includes("videoId=vid011")
          ? json(200, { items: [{ id: "uploads-item" }] })
          : undefined,
      videoStatusResponder(processedVideo(), "vid011"),
      ...playlistItemsResponders(),
    ]);
    const loaded = await deps.loadSource("x");
    const { sha256Bytes } = await import("../src/ledger.js");
    await deps.ledger.append({
      sha256: sha256Bytes(loaded.bytes ?? new Uint8Array()),
      title: RU.title,
      totalBytes: loaded.source.size,
      startedAt: "2026-07-16T00:00:00Z",
      sessionUri: SESSION,
      state: "uploaded",
      transferStarted: true,
      videoId: "vid011",
    });
    const result = await publishYouTube(input(), deps);
    expect(result.postUrl).toContain("vid011");
    const probeIndex = recorder.requests.findIndex((request) => request.url === SESSION);
    const channelOracleIndex = recorder.requests.findIndex((request) =>
      request.url.includes("/channels?"),
    );
    const proofIndex = recorder.requests.findIndex((request) =>
      request.url.includes(`playlistId=${UPLOADS_ID}`),
    );
    expect(probeIndex).toBeGreaterThan(-1);
    expect(channelOracleIndex).toBeGreaterThan(probeIndex);
    expect(proofIndex).toBeGreaterThan(channelOracleIndex);
    expect(proofIndex).toBeGreaterThan(probeIndex);
    expect(recorder.requests.some((request) => request.url.includes("uploadType=resumable"))).toBe(
      false,
    );
  });

  it("uploaded state without a saved session URI is ambiguous and never re-uploads", async () => {
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
    ]);
    const loaded = await deps.loadSource("x");
    const { sha256Bytes } = await import("../src/ledger.js");
    await deps.ledger.append({
      sha256: sha256Bytes(loaded.bytes ?? new Uint8Array()),
      title: RU.title,
      totalBytes: loaded.source.size,
      startedAt: "2026-07-16T00:00:00Z",
      state: "uploaded",
      transferStarted: true,
      videoId: "vid-no-session",
    });
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/mandatory session URI|ambiguous/i);
    expect(recorder.mutating()).toEqual([]);
  });

  it("uploading state without a saved session URI fails before any channel or upload request", async () => {
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
    ]);
    const loaded = await deps.loadSource("x");
    const { sha256Bytes } = await import("../src/ledger.js");
    await deps.ledger.append({
      sha256: sha256Bytes(loaded.bytes ?? new Uint8Array()),
      title: RU.title,
      totalBytes: loaded.source.size,
      startedAt: "2026-07-16T00:00:00Z",
    });
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/session URI|ambiguous/i);
    expect(recorder.requests.some((request) => request.url.includes("/channels?"))).toBe(false);
    expect(recorder.mutating()).toEqual([]);
  });

  it("missing uploads-playlist proof fails closed with no fresh upload", async () => {
    const SESSION = "https://upload.googleapis.com/session/UPLOADED-MISSING";
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      (req) =>
        req.method === "PUT" && req.url === SESSION ? json(200, { id: "vid012" }) : undefined,
      (req) =>
        req.method === "GET" && req.url.includes(`playlistId=${UPLOADS_ID}`)
          ? json(200, { items: [] })
          : undefined,
    ]);
    const loaded = await deps.loadSource("x");
    const { sha256Bytes } = await import("../src/ledger.js");
    await deps.ledger.append({
      sha256: sha256Bytes(loaded.bytes ?? new Uint8Array()),
      title: RU.title,
      totalBytes: loaded.source.size,
      startedAt: "2026-07-16T00:00:00Z",
      sessionUri: SESSION,
      state: "uploaded",
      transferStarted: true,
      videoId: "vid012",
    });
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/uploads playlist|ownership/i);
    expect(recorder.requests.some((request) => request.url.includes("uploadType=resumable"))).toBe(
      false,
    );
  });

  it("expired session after transfer started is ambiguous and never starts fresh", async () => {
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      (req) =>
        req.method === "PUT" && req.url.includes("session/DEAD") ? json(404, {}) : undefined,
      ...uploadResponders("must-not-upload"),
    ]);
    const loaded = await deps.loadSource("x");
    const { sha256Bytes } = await import("../src/ledger.js");
    await deps.ledger.append({
      sha256: sha256Bytes(loaded.bytes ?? new Uint8Array()),
      title: RU.title,
      totalBytes: loaded.source.size,
      startedAt: "2026-07-16T00:00:00Z",
      sessionUri: "https://upload.googleapis.com/session/DEAD",
      state: "uploading",
      transferStarted: true,
    });
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/ambiguous|positive proof/i);
    expect(recorder.requests.some((request) => request.url.includes("uploadType=resumable"))).toBe(
      false,
    );
  });

  it("expired session may restart only with positive proof that no data PUT began", async () => {
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      (req) =>
        req.method === "PUT" && req.url.includes("session/UNUSED") ? json(404, {}) : undefined,
      ...uploadResponders("vid002"),
      videoStatusResponder(processedVideo(), "vid002"),
      ...playlistItemsResponders(),
    ]);
    const loaded = await deps.loadSource("x");
    const { sha256Bytes } = await import("../src/ledger.js");
    await deps.ledger.append({
      sha256: sha256Bytes(loaded.bytes ?? new Uint8Array()),
      title: RU.title,
      totalBytes: loaded.source.size,
      startedAt: "2026-07-16T00:00:00Z",
      sessionUri: "https://upload.googleapis.com/session/UNUSED",
      state: "uploading",
      transferStarted: false,
    });
    const result = await publishYouTube(input(), deps);
    expect(result.postUrl).toContain("vid002");
    expect(recorder.requests.some((request) => request.url.includes("uploadType=resumable"))).toBe(
      true,
    );
  });
});

describe("fail-closed audit", () => {
  it("audit append failure ABORTS the publish (no fail-soft)", async () => {
    const { deps, fixture } = await makeDeps(happyResponders());
    // Make the audit base dir an unwritable path: a file where the dir should be.
    await writeFile(fixture.auditBaseDir, "not-a-directory");
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/audit append failed/);
  });

  it("directory fsync failure aborts before the first upload data PUT", async () => {
    const { deps, recorder, ledgerPath } = await makeDeps(happyResponders());
    const openDirectory = async (_directoryPath: string) => ({
      sync: () =>
        Promise.reject(Object.assign(new Error("directory sync unavailable"), { code: "ENOTSUP" })),
      close: () => Promise.resolve(),
    });
    deps.ledger = new UploadLedger(ledgerPath, undefined, openDirectory);
    await expect(publishYouTube(input(), deps)).rejects.toThrow(
      /directory fsync failed.*refusing/i,
    );
    expect(
      recorder.requests.filter(
        (request) => request.method === "PUT" && request.url.includes("/session/"),
      ),
    ).toEqual([]);
  });
});

describe("two-phase mutation audit", () => {
  it("upload intent audit failure sends zero mutating requests", async () => {
    const { deps, recorder } = await makeDeps(happyResponders());
    deps.auditAppend = failAudit("publish", "intent");
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/intent audit failed/);
    expect(recorder.mutating()).toEqual([]);
  });

  it("upload outcome audit failure preserves applied recovery state", async () => {
    const { deps, recorder, journalPath } = await makeDeps(happyResponders());
    deps.auditAppend = failAudit("publish", "outcome");
    await expect(publishYouTube(input(), deps)).rejects.toMatchObject({
      details: { recoverable: true, kind: "upload" },
    });
    expect(
      recorder.mutating().some((request) => request.url.includes("uploadType=resumable")),
    ).toBe(true);
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(journal).toEqual([expect.objectContaining({ kind: "upload", state: "applied" })]);
  });

  it("playlist-insert intent failure sends no playlist mutation", async () => {
    const { deps, recorder } = await makeDeps(happyResponders());
    deps.auditAppend = failAudit("playlist-insert", "intent");
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/intent audit failed/);
    expect(
      recorder.requests.filter(
        (request) => request.method === "POST" && request.url.includes("/playlistItems"),
      ),
    ).toEqual([]);
  });

  it("reconciles an applied playlist-insert without a second POST", async () => {
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      ...uploadResponders("vid001"),
      videoStatusResponder(processedVideo(), "vid001"),
      ...playlistItemsResponders(true),
    ]);
    const entry = await deps.journal.begin("playlist-insert", "PLru001:vid001", {
      playlistId: "PLru001",
      videoId: "vid001",
    });
    await deps.journal.markApplied(entry.operationId, { playlistId: "PLru001", videoId: "vid001" });
    await expect(publishYouTube(input(), deps)).resolves.toMatchObject({ ok: true });
    expect(
      recorder.requests.filter(
        (request) => request.method === "POST" && request.url.includes("/playlistItems"),
      ),
    ).toEqual([]);
    expect(await deps.journal.load()).toEqual([]);
  });

  it("intent audit failure never erases a reused applied recovery entry", async () => {
    const { deps, recorder } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      ...uploadResponders("vid001"),
      videoStatusResponder(processedVideo(), "vid001"),
      ...playlistItemsResponders(true),
    ]);
    const entry = await deps.journal.begin("playlist-insert", "PLru001:vid001", {
      playlistId: "PLru001",
      videoId: "vid001",
    });
    await deps.journal.markApplied(entry.operationId, { playlistId: "PLru001", videoId: "vid001" });
    deps.auditAppend = failAudit("playlist-insert", "intent");
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/intent audit failed/);
    expect(await deps.journal.find("playlist-insert", "PLru001:vid001")).toMatchObject({
      operationId: entry.operationId,
      state: "applied",
    });
    expect(
      recorder.requests.filter(
        (request) => request.method === "POST" && request.url.includes("/playlistItems"),
      ),
    ).toEqual([]);
  });

  it("playlist-insert outcome failure preserves the applied playlist operation", async () => {
    const { deps, recorder, journalPath } = await makeDeps(happyResponders());
    deps.auditAppend = failAudit("playlist-insert", "outcome");
    await expect(publishYouTube(input(), deps)).rejects.toMatchObject({
      details: { recoverable: true, kind: "playlist-insert" },
    });
    expect(
      recorder.requests.filter(
        (request) => request.method === "POST" && request.url.includes("/playlistItems"),
      ),
    ).toHaveLength(1);
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(journal).toEqual([
      expect.objectContaining({ kind: "playlist-insert", state: "applied" }),
    ]);
  });
});

describe("guards living in publish.test.ts per C16 mapping", () => {
  it("canonical-title consistency: same-channel swapped binding fails closed", async () => {
    const { deps } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder({ en: "Arcanada — Русский", ru: "Arcanada — English" }), // swapped titles
    ]);
    await expect(publishYouTube(input(), deps)).rejects.toMatchObject({
      code: ErrorCode.PLAYLIST_BINDING_BROKEN,
    });
  });

  it("channel constant is not env-overridable: hostile YOUTUBE_CHANNEL_ID is ignored", async () => {
    const { deps } = await makeDeps(
      [tokenResponder, channelResponder("UCattacker000000000000000")],
      { YOUTUBE_CHANNEL_ID: "UCattacker000000000000000" },
    );
    await expect(publishYouTube(input(), deps)).rejects.toMatchObject({
      code: ErrorCode.CHANNEL_MISMATCH,
    });
  });
});

describe("preflight metering (dry-run, unarmed, live — every entry counts)", () => {
  const KEY = "ARCANADA_PUBLISHER_RATE_YOUTUBE";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("dry-runs are check+RECORDED — unlimited dry-run floods are impossible", async () => {
    process.env[KEY] = "1";
    const { deps } = await makeDeps(happyResponders());
    deps.preflightLimiter = new RateLimiter();
    const first = await publishYouTube(input({ dryRun: true }), deps);
    expect(first.warnings.join()).toContain("dry-run");
    await expect(publishYouTube(input({ dryRun: true }), deps)).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMIT,
    });
  });

  it("UNARMED live attempts are metered too — the DoS cannot survive one code path over", async () => {
    process.env[KEY] = "1";
    const { deps } = await makeDeps(happyResponders(), { YOUTUBE_LIVE_ARMED: undefined });
    deps.preflightLimiter = new RateLimiter();
    await expect(publishYouTube(input(), deps)).rejects.toMatchObject({
      code: ErrorCode.NOT_ARMED,
    });
    // second unarmed attempt is stopped by the limiter BEFORE any credentialed read
    await expect(publishYouTube(input(), deps)).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMIT,
    });
  });
});

describe("module-scoped rate limiter", () => {
  const KEY = "ARCANADA_PUBLISHER_RATE_YOUTUBE";
  afterEach(() => {
    delete process.env[KEY];
    delete process.env["ARCANADA_PUBLISHER_RATE_YOUTUBE_PREFLIGHT"];
  });

  it("limiter state survives across adapter constructions (module scope)", async () => {
    process.env[KEY] = "2";
    process.env["ARCANADA_PUBLISHER_RATE_YOUTUBE_PREFLIGHT"] = "2";
    const fixture = await makeFixture();
    const make = () =>
      new YouTubeAdapter({
        transport: makeTransport(happyResponders()).transport,
        env: fixture.env,
        profilesRoot: fixture.profilesRoot,
        auditBaseDir: fixture.auditBaseDir,
        sleep: () => Promise.resolve(),
        pollIntervalMs: 1,
      });
    const publishOnce = () =>
      make().publish({
        ...RU,
        profile: "origin",
        language: "ru",
        videoPath: fixture.videoPath,
        privacyStatus: "private",
      });
    const { youtubeRateLimiter } = await import("../src/publish.js");
    const liveBefore = youtubeRateLimiter.count("youtube");
    const first = await publishOnce();
    expect(first.postUrl).toContain("vid001");
    // LIVE limiter is module-scoped: the success was recorded on it and a fresh
    // adapter instance sees the same state.
    expect(youtubeRateLimiter.count("youtube")).toBe(liveBefore + 1);
    // Second construction dies at the duplicate ledger (pinned), third at the
    // preflight cap — every stateful guard persisted across constructions.
    await expect(publishOnce()).rejects.toThrow(/duplicate upload blocked/);
    await expect(publishOnce()).rejects.toMatchObject({ code: ErrorCode.RATE_LIMIT });
  });
});
