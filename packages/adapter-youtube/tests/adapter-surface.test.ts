// PUB-0035 adapter-surface coverage added at the /dr-do verify round: playlist
// bootstrap (gate + audit + read-before-create), edit contract (categoryId
// re-send, oracle, validation, arming), comment/delete UNSUPPORTED_OPERATION,
// authenticated verify with channel-ownership check.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode } from "@arcanada/publisher-core";
import { describe, expect, it } from "vitest";
import { YouTubeAdapter } from "../src/index.js";
import {
  CHANNEL_ID,
  channelResponder,
  json,
  makeFixture,
  makeTransport,
  tokenResponder,
  type Responder,
} from "./helpers.js";

async function adapterWith(responders: Responder[], envOver: Record<string, string | undefined> = {}) {
  const fixture = await makeFixture();
  const recorder = makeTransport(responders);
  const env = { ...fixture.env, ...envOver } as NodeJS.ProcessEnv;
  const adapter = new YouTubeAdapter({
    transport: recorder.transport,
    env,
    profilesRoot: fixture.profilesRoot,
    auditBaseDir: fixture.auditBaseDir,
  });
  return { adapter, recorder, fixture };
}

const ownPlaylists = (items: Array<{ id: string; title: string }>): Responder => (req) =>
  req.method === "GET" && req.url.includes("mine=true")
    ? json(200, { items: items.map((i) => ({ id: i.id, snippet: { title: i.title, channelId: CHANNEL_ID } })) })
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
    expect(audit.match(/"action":"playlist-create"/g)).toHaveLength(2);
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

const videoSnippet = (over: Record<string, unknown> = {}): Responder => (req) =>
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
  req.method === "PUT" && req.url.includes("/videos?part=snippet") ? json(200, { id: "vid001" }) : undefined;

const WATCH = "https://www.youtube.com/watch?v=vid00001";

describe("edit contract", () => {
  it("always re-sends categoryId with the snippet part (official gotcha)", async () => {
    const { adapter, recorder } = await adapterWith([
      tokenResponder,
      channelResponder(),
      videoSnippet(),
      videosUpdate,
    ]);
    const result = await adapter.edit({ postUrl: WATCH, title: "Новый заголовок", profile: "origin" });
    expect(result.edited).toBe(true);
    const update = recorder.requests.find((r) => r.method === "PUT");
    const body = JSON.parse(update?.body as string) as { snippet: { categoryId: string; title: string } };
    expect(body.snippet.categoryId).toBe("22");
    expect(body.snippet.title).toBe("Новый заголовок");
  });

  it("unarmed edit → NOT_ARMED before any network call", async () => {
    const { adapter, recorder } = await adapterWith([tokenResponder], { YOUTUBE_LIVE_ARMED: undefined });
    await expect(adapter.edit({ postUrl: WATCH, title: "x", profile: "origin" })).rejects.toMatchObject({
      code: ErrorCode.NOT_ARMED,
    });
    expect(recorder.requests).toEqual([]);
  });

  it("read-before-edit oracle mismatch fails closed with no update", async () => {
    const { adapter, recorder } = await adapterWith([tokenResponder, channelResponder(), videoSnippet()]);
    await expect(
      adapter.edit({ postUrl: WATCH, title: "Новый", expectedContent: "нет такого текста", profile: "origin" }),
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
  const verifyItems = (channelId: string): Responder => (req) =>
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
    await expect(adapter.verify("https://www.youtube.com/playlist?list=PLx")).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGS,
    });
    await expect(adapter.verify("https://www.youtube.com/watch")).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGS,
    });
    expect(recorder.requests.filter((r) => r.url.includes("/videos"))).toEqual([]);
  });
});
