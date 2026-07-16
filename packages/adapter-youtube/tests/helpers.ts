// Shared fixture harness for PUB-0035 adapter tests: a scripted transport with
// full request recording, plus the standard happy-path YouTube API fixture set
// (built from the official response shapes cited in INSIGHTS-PUB-0035; to be
// re-verified against live responses at the Phase 7 preflight).

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport, TransportRequest, TransportResponse } from "../src/transport.js";

export const CHANNEL_ID = "UC2zUfwafsM2OxaidE0iNM7w";
export const UPLOADS_ID = "UUzUfwafsM2OxaidE0iNM7w";
export const SESSION_URI = "https://upload.googleapis.com/session/TESTSESSION";

export type Responder = (req: TransportRequest, callIndex: number) => TransportResponse | undefined;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers, text: JSON.stringify(body) };
}

export interface Recorder {
  transport: Transport;
  requests: TransportRequest[];
  /** Mutating = non-GET, excluding the OAuth token exchange. */
  mutating(): TransportRequest[];
}

export function makeTransport(responders: Responder[]): Recorder {
  const requests: TransportRequest[] = [];
  const counts = new Map<Responder, number>();
  return {
    requests,
    mutating: () =>
      requests.filter((r) => r.method !== "GET" && !r.url.includes("oauth2.googleapis.com")),
    transport: (req) => {
      requests.push(req);
      for (const responder of responders) {
        const index = counts.get(responder) ?? 0;
        const response = responder(req, index);
        if (response) {
          counts.set(responder, index + 1);
          return Promise.resolve(response);
        }
      }
      return Promise.resolve(json(500, { error: { message: `unfixtured: ${req.method} ${req.url}` } }));
    },
  };
}

export const tokenResponder: Responder = (req) =>
  req.url.includes("oauth2.googleapis.com/token")
    ? json(200, { access_token: "at-fixture", expires_in: 3600 })
    : undefined;

export function channelResponder(id: string = CHANNEL_ID): Responder {
  return (req) =>
    req.method === "GET" && req.url.includes("/channels?")
      ? json(200, { items: [{ id, contentDetails: { relatedPlaylists: { uploads: UPLOADS_ID } } }] })
      : undefined;
}

export function playlistsResponder(
  titles: { en: string; ru: string } = { en: "Arcanada — English", ru: "Arcanada — Русский" },
  channelId: string = CHANNEL_ID,
): Responder {
  return (req) =>
    req.method === "GET" && req.url.includes("/playlists?part=snippet&id=")
      ? json(200, {
          items: [
            { id: "PLen001", snippet: { channelId, title: titles.en } },
            { id: "PLru001", snippet: { channelId, title: titles.ru } },
          ],
        })
      : undefined;
}

export function uploadResponders(videoId = "vid001"): Responder[] {
  return [
    (req) =>
      req.method === "POST" && req.url.includes("uploadType=resumable")
        ? json(200, {}, { location: SESSION_URI })
        : undefined,
    (req) =>
      req.method === "PUT" && req.url === SESSION_URI ? json(200, { id: videoId }) : undefined,
  ];
}

export function videoStatusResponder(
  item: Record<string, unknown>,
  videoId = "vid001",
): Responder {
  return (req) =>
    req.method === "GET" && req.url.includes(`/videos?part=`) && req.url.includes(videoId)
      ? json(200, { items: [{ id: videoId, ...item }] })
      : undefined;
}

export const processedVideo = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: { uploadStatus: "processed", privacyStatus: "private" },
  snippet: { title: "Заголовок выпуска", description: "Описание: https://arcanada.ai/ru/blog/x", channelId: CHANNEL_ID },
  contentDetails: { duration: "PT1M30S" },
  processingDetails: { processingStatus: "succeeded" },
  ...over,
});

export function playlistItemsResponders(alreadyIn = false): Responder[] {
  return [
    (req) =>
      req.method === "GET" && req.url.includes("/playlistItems?part=id")
        ? json(200, { items: alreadyIn ? [{ id: "pli1" }] : [] })
        : undefined,
    (req) =>
      req.method === "POST" && req.url.includes("/playlistItems?part=snippet")
        ? json(200, { id: "pli-new" })
        : undefined,
  ];
}

export interface AdapterFixture {
  profilesRoot: string;
  auditBaseDir: string;
  videoPath: string;
  env: NodeJS.ProcessEnv;
}

export const RU_INPUT = {
  text: "Описание выпуска: https://arcanada.ai/ru/blog/x",
  title: "Заголовок выпуска",
  profile: "origin",
  language: "ru",
  videoPath: "", // filled by makeFixture
};

/** Temp dirs + seeded refresh token + a small real video file. */
export async function makeFixture(): Promise<AdapterFixture> {
  const base = await mkdtemp(join(tmpdir(), "pub0035-fix-"));
  const profilesRoot = join(base, "profiles");
  const profileDir = join(profilesRoot, "youtube", "origin");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profileDir, "token.json"), JSON.stringify({ refresh_token: "1//0seed" }), {
    mode: 0o600,
  });
  const defaultDir = join(profilesRoot, "youtube", "default");
  await mkdir(defaultDir, { recursive: true, mode: 0o700 });
  await writeFile(join(defaultDir, "token.json"), JSON.stringify({ refresh_token: "1//0seed" }), {
    mode: 0o600,
  });
  const videoPath = join(base, "episode.mp4");
  await writeFile(videoPath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  return {
    profilesRoot,
    auditBaseDir: join(base, "audit"),
    videoPath,
    env: {
      YOUTUBE_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com",
      YOUTUBE_OAUTH_CLIENT_SECRET: "client-secret-fixture",
      YOUTUBE_PLAYLIST_EN: "PLen001",
      YOUTUBE_PLAYLIST_RU: "PLru001",
      YOUTUBE_LIVE_ARMED: "1",
    } as NodeJS.ProcessEnv,
  };
}

export function happyResponders(videoId = "vid001"): Responder[] {
  return [
    tokenResponder,
    channelResponder(),
    playlistsResponder(),
    ...uploadResponders(videoId),
    videoStatusResponder(processedVideo(), videoId),
    ...playlistItemsResponders(),
  ];
}
