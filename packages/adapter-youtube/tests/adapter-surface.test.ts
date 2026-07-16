// PUB-0035 adapter-surface coverage added at the /dr-do verify round: playlist
// bootstrap (gate + audit + read-before-create), edit contract (categoryId
// re-send, oracle, validation, arming), comment/delete UNSUPPORTED_OPERATION,
// authenticated verify with channel-ownership check.

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ErrorCode, appendAudit } from "@arcanada/publisher-core";
import { describe, expect, it } from "vitest";
import { YouTubeAdapter } from "../src/index.js";
import { RecoveryJournal } from "../src/recovery-journal.js";
import {
  CHANNEL_ID,
  channelResponder,
  json,
  makeFixture,
  makeTransport,
  tokenResponder,
  type Responder,
} from "./helpers.js";

async function adapterWith(
  responders: Responder[],
  envOver: Record<string, string | undefined> = {},
  auditAppend?: typeof appendAudit,
) {
  const fixture = await makeFixture();
  const recorder = makeTransport(responders);
  const env = { ...fixture.env, ...envOver } as NodeJS.ProcessEnv;
  const adapter = new YouTubeAdapter({
    transport: recorder.transport,
    env,
    profilesRoot: fixture.profilesRoot,
    auditBaseDir: fixture.auditBaseDir,
    ...(auditAppend ? { auditAppend } : {}),
  });
  return { adapter, recorder, fixture };
}

const failAudit =
  (action: "playlist-create" | "edit", phase: "intent" | "outcome"): typeof appendAudit =>
  (input, options) =>
    input.action === action && input.phase === phase
      ? Promise.resolve(null)
      : appendAudit(input, options);

const ownPlaylists =
  (items: Array<{ id: string; title: string }>): Responder =>
  (req) =>
    req.method === "GET" && req.url.includes("mine=true")
      ? json(200, {
          items: items.map((i) => ({
            id: i.id,
            snippet: { title: i.title, channelId: CHANNEL_ID },
          })),
        })
      : undefined;

const playlistCreate: Responder = (req, index) =>
  req.method === "POST" && req.url.includes("/playlists?part=snippet,status")
    ? json(200, { id: `PLnew00${index}` })
    : undefined;

describe("playlist bootstrap", () => {
  it("unarmed bootstrap → NOT_ARMED, zero mutations", async () => {
    const { adapter, recorder } = await adapterWith(
      [tokenResponder, channelResponder(), ownPlaylists([])],
      { YOUTUBE_LIVE_ARMED: undefined },
    );
    await expect(adapter.bootstrapPlaylists("origin")).rejects.toMatchObject({
      code: ErrorCode.NOT_ARMED,
    });
    expect(recorder.mutating()).toEqual([]);
  });

  it("read-before-create: existing canonical playlists are reused, nothing created", async () => {
    const { adapter, recorder } = await adapterWith([
      tokenResponder,
      channelResponder(),
      ownPlaylists([
        { id: "PLenX", title: "Arcanada — English" },
        { id: "PLruX", title: "Arcanada — Русский" },
      ]),
    ]);
    const binding = await adapter.bootstrapPlaylists("origin");
    expect(binding).toEqual({ en: "PLenX", ru: "PLruX" });
    expect(recorder.mutating()).toEqual([]);
  });

  it("missing playlists are created and each creation is audited (playlist-create)", async () => {
    const { adapter, recorder, fixture } = await adapterWith([
      tokenResponder,
      channelResponder(),
      ownPlaylists([]),
      playlistCreate,
    ]);
    const binding = await adapter.bootstrapPlaylists("origin");
    expect(binding.en).toMatch(/^PLnew/);
    expect(binding.ru).toMatch(/^PLnew/);
    expect(recorder.mutating()).toHaveLength(2);
    const auditFiles = await readdir(fixture.auditBaseDir);
    const audit = await readFile(join(fixture.auditBaseDir, auditFiles[0] ?? ""), "utf8");
    expect(audit.match(/"action":"playlist-create"/g)).toHaveLength(4);
  });

  it("playlist-create intent audit failure sends zero POSTs", async () => {
    const { adapter, recorder } = await adapterWith(
      [tokenResponder, channelResponder(), ownPlaylists([]), playlistCreate],
      {},
      failAudit("playlist-create", "intent"),
    );
    await expect(adapter.bootstrapPlaylists("origin")).rejects.toThrow(/intent audit failed/);
    expect(recorder.mutating()).toEqual([]);
  });

  it("playlist-create outcome audit failure leaves an applied recovery record", async () => {
    const { adapter, recorder, fixture } = await adapterWith(
      [tokenResponder, channelResponder(), ownPlaylists([]), playlistCreate],
      {},
      failAudit("playlist-create", "outcome"),
    );
    await expect(adapter.bootstrapPlaylists("origin")).rejects.toThrow(/recoverable/);
    expect(recorder.mutating()).toHaveLength(1);
    const raw = await readFile(
      join(fixture.profilesRoot, "youtube", "origin", "recovery.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual([
      expect.objectContaining({ kind: "playlist-create", state: "applied" }),
    ]);
  });

  it("reconciles an applied playlist-create without a second POST", async () => {
    const { adapter, recorder, fixture } = await adapterWith([
      tokenResponder,
      channelResponder(),
      ownPlaylists([
        { id: "PLenRecovered", title: "Arcanada — English" },
        { id: "PLruX", title: "Arcanada — Русский" },
      ]),
    ]);
    const journal = new RecoveryJournal(
      join(fixture.profilesRoot, "youtube", "origin", "recovery.json"),
    );
    const entry = await journal.begin("playlist-create", "canonical:en", { language: "en" });
    await journal.markApplied(entry.operationId, { playlistId: "PLenRecovered" });
    await expect(adapter.bootstrapPlaylists("origin")).resolves.toEqual({
      en: "PLenRecovered",
      ru: "PLruX",
    });
    expect(recorder.mutating()).toEqual([]);
    expect(await journal.load()).toEqual([]);
  });

  it("fails closed when applied playlist-create id conflicts with the canonical remote id", async () => {
    const { adapter, recorder, fixture } = await adapterWith([
      tokenResponder,
      channelResponder(),
      ownPlaylists([
        { id: "PLenCanonical", title: "Arcanada — English" },
        { id: "PLruX", title: "Arcanada — Русский" },
      ]),
    ]);
    const journal = new RecoveryJournal(
      join(fixture.profilesRoot, "youtube", "origin", "recovery.json"),
    );
    const entry = await journal.begin("playlist-create", "canonical:en", { language: "en" });
    await journal.markApplied(entry.operationId, { playlistId: "PLdifferent" });
    await expect(adapter.bootstrapPlaylists("origin")).rejects.toThrow(/different id/i);
    expect(recorder.mutating()).toEqual([]);
  });

  it("duplicate canonical-title playlists on the channel abort (operator must resolve)", async () => {
    const { adapter } = await adapterWith([
      tokenResponder,
      channelResponder(),
      ownPlaylists([
        { id: "PLa", title: "Arcanada — English" },
        { id: "PLb", title: "Arcanada — English" },
      ]),
    ]);
    await expect(adapter.bootstrapPlaylists("origin")).rejects.toMatchObject({
      code: ErrorCode.PLAYLIST_BINDING_BROKEN,
    });
  });
});

const videoSnippet =
  (over: Record<string, unknown> = {}): Responder =>
  (req) =>
    req.method === "GET" && req.url.includes("/videos?part=snippet&id=")
      ? json(200, {
          items: [
            {
              snippet: {
                title: "Заголовок",
                description: "Описание",
                categoryId: "22",
                defaultLanguage: "ru",
                channelId: CHANNEL_ID,
                ...over,
              },
            },
          ],
        })
      : undefined;

const videosUpdate: Responder = (req) =>
  req.method === "PUT" && req.url.includes("/videos?part=snippet")
    ? json(200, { id: "vid001" })
    : undefined;

const WATCH = "https://www.youtube.com/watch?v=vid00001";

describe("edit contract", () => {
  it("always re-sends categoryId with the snippet part (official gotcha)", async () => {
    const { adapter, recorder } = await adapterWith([
      tokenResponder,
      channelResponder(),
      videoSnippet(),
      videosUpdate,
    ]);
    const result = await adapter.edit({
      postUrl: WATCH,
      title: "Новый заголовок",
      profile: "origin",
    });
    expect(result.edited).toBe(true);
    const update = recorder.requests.find((r) => r.method === "PUT");
    const body = JSON.parse(update?.body as string) as {
      snippet: { categoryId: string; title: string };
    };
    expect(body.snippet.categoryId).toBe("22");
    expect(body.snippet.title).toBe("Новый заголовок");
  });

  it("edit intent audit failure sends zero PUTs", async () => {
    const { adapter, recorder } = await adapterWith(
      [tokenResponder, channelResponder(), videoSnippet(), videosUpdate],
      {},
      failAudit("edit", "intent"),
    );
    await expect(
      adapter.edit({ postUrl: WATCH, title: "Новый заголовок", profile: "origin" }),
    ).rejects.toThrow(/intent audit failed/);
    expect(recorder.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("edit outcome audit failure leaves an applied recovery record", async () => {
    const { adapter, recorder, fixture } = await adapterWith(
      [tokenResponder, channelResponder(), videoSnippet(), videosUpdate],
      {},
      failAudit("edit", "outcome"),
    );
    await expect(
      adapter.edit({ postUrl: WATCH, title: "Новый заголовок", profile: "origin" }),
    ).rejects.toThrow(/recoverable/);
    expect(recorder.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    const raw = await readFile(
      join(fixture.profilesRoot, "youtube", "origin", "recovery.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual([expect.objectContaining({ kind: "edit", state: "applied" })]);
  });

  it("reconciles an applied edit without a second PUT", async () => {
    const nextTitle = "Новый заголовок";
    const { adapter, recorder, fixture } = await adapterWith([
      tokenResponder,
      channelResponder(),
      videoSnippet({ title: nextTitle }),
    ]);
    const key = createHash("sha256")
      .update(JSON.stringify({ videoId: "vid00001", title: nextTitle, description: "Описание" }))
      .digest("hex");
    const journal = new RecoveryJournal(
      join(fixture.profilesRoot, "youtube", "origin", "recovery.json"),
    );
    const entry = await journal.begin("edit", key, { videoId: "vid00001" });
    await journal.markApplied(entry.operationId, { videoId: "vid00001" });
    await expect(
      adapter.edit({
        postUrl: WATCH,
        title: nextTitle,
        expectedContent: "obsolete pre-edit content",
        profile: "origin",
      }),
    ).resolves.toMatchObject({ edited: true });
    expect(recorder.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(await journal.load()).toEqual([]);
  });

  it("unarmed edit → NOT_ARMED before any network call", async () => {
    const { adapter, recorder } = await adapterWith([tokenResponder], {
      YOUTUBE_LIVE_ARMED: undefined,
    });
    await expect(
      adapter.edit({ postUrl: WATCH, title: "x", profile: "origin" }),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_ARMED,
    });
    expect(recorder.requests).toEqual([]);
  });

  it("read-before-edit oracle mismatch fails closed with no update", async () => {
    const { adapter, recorder } = await adapterWith([
      tokenResponder,
      channelResponder(),
      videoSnippet(),
    ]);
    await expect(
      adapter.edit({
        postUrl: WATCH,
        title: "Новый",
        expectedContent: "нет такого текста",
        profile: "origin",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(recorder.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("edit enforces the same metadata validation as publish (language purity)", async () => {
    const { adapter, recorder } = await adapterWith([
      tokenResponder,
      channelResponder(),
      videoSnippet({ defaultLanguage: "en", title: "English title", description: "clean" }),
    ]);
    await expect(
      adapter.edit({ postUrl: WATCH, title: "Кириллица в EN-видео", profile: "origin" }),
    ).rejects.toMatchObject({ code: ErrorCode.LANGUAGE_UNRESOLVED });
    expect(recorder.requests.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("unsupported operations", () => {
  it("comment and delete fail with UNSUPPORTED_OPERATION by design", async () => {
    const { adapter } = await adapterWith([]);
    await expect(
      adapter.comment({ parentPostUrl: WATCH, text: "x", profile: "origin" }),
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_OPERATION });
    await expect(
      adapter.delete({ targetUrl: WATCH, kind: "post", expectedContent: "x", profile: "origin" }),
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_OPERATION });
  });
});

describe("authenticated verify", () => {
  const verifyItems =
    (channelId: string): Responder =>
    (req) =>
      req.method === "GET" && req.url.includes("/videos?part=status,snippet")
        ? json(200, { items: [{ id: "vid00001", snippet: { channelId } }] })
        : undefined;

  it("own video verifies ok", async () => {
    const { adapter } = await adapterWith([tokenResponder, verifyItems(CHANNEL_ID)]);
    const result = await adapter.verify(WATCH);
    expect(result.ok).toBe(true);
    expect(result.reachable).toBe(true);
  });

  it("a reachable FOREIGN video must not verify green", async () => {
    const { adapter } = await adapterWith([tokenResponder, verifyItems("UCforeign000000000000")]);
    const result = await adapter.verify(WATCH);
    expect(result.reachable).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("page-name URLs fail fast as INVALID_ARGS (no API spend)", async () => {
    const { adapter, recorder } = await adapterWith([tokenResponder]);
    await expect(adapter.verify("https://www.youtube.com/playlist?list=PLx")).rejects.toMatchObject(
      {
        code: ErrorCode.INVALID_ARGS,
      },
    );
    await expect(adapter.verify("https://www.youtube.com/watch")).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGS,
    });
    expect(recorder.requests.filter((r) => r.url.includes("/videos"))).toEqual([]);
  });
});
