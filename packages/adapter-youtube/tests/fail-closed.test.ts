// PUB-0035 V-AC-3: exactly the six fail-closed branches, each asserting its
// dedicated ErrorCode AND that the recorded transport saw no mutating request
// (for the mid-flight oracle branch: no PLAYLIST mutation after the failed
// re-assert — the upload legitimately happened before it).

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ErrorCode, RateLimiter } from "@arcanada/publisher-core";
import { describe, expect, it } from "vitest";
import { AuthManager } from "../src/auth.js";
import { UploadLedger } from "../src/ledger.js";
import { publishYouTube, type PublishDeps } from "../src/publish.js";
import {
  CHANNEL_ID,
  UPLOADS_ID,
  channelResponder,
  json,
  makeFixture,
  makeTransport,
  playlistsResponder,
  processedVideo,
  tokenResponder,
  uploadResponders,
  videoStatusResponder,
  type Recorder,
  type Responder,
} from "./helpers.js";

const RU = { title: "Заголовок выпуска", text: "Описание: https://arcanada.ai/ru/blog/x" };

async function harness(responders: Responder[], envOver: Record<string, string | undefined> = {}) {
  const fixture = await makeFixture();
  const recorder: Recorder = makeTransport(responders);
  const env = { ...fixture.env, ...envOver } as NodeJS.ProcessEnv;
  const auth = new AuthManager("origin", {
    transport: recorder.transport,
    env,
    profilesRoot: fixture.profilesRoot,
  });
  const bytes = new Uint8Array(await readFile(fixture.videoPath));
  const ledger = new UploadLedger(join(dirname(auth.tokenPath()), "ledger.jsonl"));
  const deps: PublishDeps = {
    transport: recorder.transport,
    auth,
    env,
    ledger,
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
  return { deps, recorder, auth, ledger };
}

const input = (over: Record<string, unknown> = {}) => ({
  ...RU,
  profile: "origin",
  language: "ru",
  videoPath: "via-injected-loadSource.mp4",
  privacyStatus: "private" as const,
  ...over,
});

describe("V-AC-3 fail-closed branches", () => {
  it("1. channel-oracle mismatch at preflight → CHANNEL_MISMATCH, zero mutations", async () => {
    const { deps, recorder } = await harness([
      tokenResponder,
      channelResponder("UCforeign00000000000000"),
    ]);
    await expect(publishYouTube(input(), deps)).rejects.toMatchObject({
      code: ErrorCode.CHANNEL_MISMATCH,
    });
    expect(recorder.mutating()).toEqual([]);
  });

  it("2. oracle mismatch BETWEEN preflight and playlist mutation → no playlist mutation", async () => {
    const { deps, recorder } = await harness([
      tokenResponder,
      (req, index) =>
        req.method === "GET" && req.url.includes("/channels?")
          ? json(200, {
              items: [
                {
                  id: index === 0 ? CHANNEL_ID : "UChijacked000000000000",
                  contentDetails: { relatedPlaylists: { uploads: UPLOADS_ID } },
                },
              ],
            })
          : undefined,
      playlistsResponder(),
      ...uploadResponders(),
      videoStatusResponder(processedVideo()),
    ]);
    await expect(publishYouTube(input(), deps)).rejects.toMatchObject({
      code: ErrorCode.CHANNEL_MISMATCH,
    });
    expect(recorder.requests.some((r) => r.url.includes("/playlistItems"))).toBe(false);
  });

  it("3. unknown/missing language → LANGUAGE_UNRESOLVED, zero requests", async () => {
    const { deps, recorder } = await harness([tokenResponder]);
    await expect(publishYouTube(input({ language: undefined }), deps)).rejects.toMatchObject({
      code: ErrorCode.LANGUAGE_UNRESOLVED,
    });
    await expect(publishYouTube(input({ language: "de" }), deps)).rejects.toMatchObject({
      code: ErrorCode.LANGUAGE_UNRESOLVED,
    });
    expect(recorder.requests).toEqual([]); // validation precedes any network call
  });

  it("4. missing/foreign playlist binding → PLAYLIST_BINDING_BROKEN, zero mutations", async () => {
    const missing = await harness([tokenResponder, channelResponder()], {
      YOUTUBE_PLAYLIST_RU: undefined,
    });
    await expect(publishYouTube(input(), missing.deps)).rejects.toMatchObject({
      code: ErrorCode.PLAYLIST_BINDING_BROKEN,
    });
    expect(missing.recorder.mutating()).toEqual([]);

    const foreign = await harness([
      tokenResponder,
      channelResponder(),
      playlistsResponder(undefined, "UCother0000000000000000"),
    ]);
    await expect(publishYouTube(input(), foreign.deps)).rejects.toMatchObject({
      code: ErrorCode.PLAYLIST_BINDING_BROKEN,
    });
    expect(foreign.recorder.mutating()).toEqual([]);
  });

  it("5. unarmed live attempt → NOT_ARMED, zero mutations", async () => {
    const { deps, recorder } = await harness(
      [tokenResponder, channelResponder(), playlistsResponder()],
      { YOUTUBE_LIVE_ARMED: undefined },
    );
    await expect(publishYouTube(input(), deps)).rejects.toMatchObject({
      code: ErrorCode.NOT_ARMED,
    });
    expect(recorder.mutating()).toEqual([]);
  });

  it("6. corrupt ledger line → fail closed, zero mutations", async () => {
    const { deps, recorder, ledger } = await harness([
      tokenResponder,
      channelResponder(),
      playlistsResponder(),
    ]);
    await ledger.append({
      sha256: "seed".padEnd(64, "0"),
      title: "x",
      totalBytes: 1,
      startedAt: "2026-07-16T00:00:00Z",
    });
    const path = (ledger as unknown as { path: string }).path;
    await writeFile(path, '{"sha256": broken\n', { mode: 0o600 });
    const failure = publishYouTube(input(), deps);
    await expect(failure).rejects.toThrow(/ledger corrupt/);
    await failure.catch((error: unknown) => {
      expect((error as { code: number }).code).toBe(ErrorCode.INVALID_ARGS);
    });
    expect(recorder.mutating()).toEqual([]);
  });
});
