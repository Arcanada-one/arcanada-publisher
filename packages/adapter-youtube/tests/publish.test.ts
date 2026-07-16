// PUB-0035 publish orchestration (plan Phase 4.2, C16 mapping): terminal
// states, ordering (playlist insert only post-processed), read-back warnings,
// private-lock detection, fail-closed audit, module-scope limiter persistence,
// title-consistency guard, env non-override of the channel constant, duplicate
// abort at the ledger, expired-session fresh start.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ErrorCode, RateLimiter } from "@arcanada/publisher-core";
import { afterEach, describe, expect, it } from "vitest";
import { AuthManager } from "../src/auth.js";
import { UploadLedger } from "../src/ledger.js";
import { publishYouTube, type PublishDeps } from "../src/publish.js";
import { YouTubeAdapter } from "../src/index.js";
import {
  CHANNEL_ID,
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
  const bytes = new Uint8Array(await readFile(fixture.videoPath));
  const deps: PublishDeps = {
    transport: recorder.transport,
    auth,
    env,
    ledger: new UploadLedger(ledgerPath),
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
  };
  return { deps, recorder, fixture, ledgerPath, env };
}

const input = (over: Record<string, unknown> = {}) => ({
  ...RU,
  profile: "origin",
  language: "ru",
  videoPath: "unused-by-injected-loadSource.mp4",
  privacyStatus: "private" as const,
  ...over,
});

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
      videoStatusResponder({ status: { uploadStatus: "uploaded" }, processingDetails: { processingStatus: "processing" } }),
    ]);
    deps.now = () => (clock += 120_000);
    deps.pollTimeoutMs = 300_000;
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/timeout/);
  });
});

describe("read-back and playlist phase", () => {
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

  it("expired pending session restarts fresh behind the ledger gate", async () => {
    const { deps, ledgerPath } = await makeDeps([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
      (req) =>
        req.method === "PUT" && req.url.includes("upload_id=DEAD") ? json(404, {}) : undefined,
      ...uploadResponders("vid002"),
      videoStatusResponder(processedVideo(), "vid002"),
      ...playlistItemsResponders(),
    ]);
    const bytes = new Uint8Array(await readFile("/dev/null").catch(() => Buffer.alloc(0)));
    void bytes;
    // Seed a pending entry with a dead session for the fixture file's hash.
    const loaded = await deps.loadSource("x");
    const { sha256Bytes } = await import("../src/ledger.js");
    const sha = sha256Bytes(loaded.bytes ?? new Uint8Array());
    await deps.ledger.append({
      sha256: sha,
      title: RU.title,
      totalBytes: loaded.source.size,
      startedAt: "2026-07-16T00:00:00Z",
      sessionUri: "https://upload.googleapis.com/session?upload_id=DEAD",
    });
    const result = await publishYouTube(input(), deps);
    expect(result.postUrl).toContain("vid002");
    expect(await readFile(ledgerPath, "utf8")).not.toContain("upload_id=DEAD"); // scrubbed on completion
  });
});

describe("fail-closed audit", () => {
  it("audit append failure ABORTS the publish (no fail-soft)", async () => {
    const { deps, fixture } = await makeDeps(happyResponders());
    // Make the audit base dir an unwritable path: a file where the dir should be.
    await writeFile(fixture.auditBaseDir, "not-a-directory");
    await expect(publishYouTube(input(), deps)).rejects.toThrow(/audit append failed/);
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

describe("module-scoped rate limiter", () => {
  const KEY = "ARCANADA_PUBLISHER_RATE_YOUTUBE";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("limiter state survives across two adapter constructions", async () => {
    process.env[KEY] = "1";
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
    const first = await make().publish({
      ...RU,
      profile: "origin",
      language: "ru",
      videoPath: fixture.videoPath,
      privacyStatus: "private",
    });
    expect(first.postUrl).toContain("vid001");
    // Fresh adapter instance — the recorded publish must still count.
    await expect(
      make().publish({
        ...RU,
        profile: "origin",
        language: "ru",
        videoPath: fixture.videoPath,
        privacyStatus: "private",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMIT });
  });
});
