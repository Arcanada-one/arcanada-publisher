// Language→playlist binding: EN/RU route by STABLE playlist ids from env
// config, verified against the live channel (ownership AND canonical title —
// a swapped/tampered binding pointing at another owned playlist fails closed).
// Bootstrap is read-before-create, duplicate-protected, audited, and
// operator-gated (plan C10, D-REQ-04).

import { AdapterError, ErrorCode, type AuditOptions } from "@arcanada/publisher-core";
import { ARCANADA_CHANNEL_ID } from "./channel-oracle.js";
import { beginMutation, completeMutation, requireArmed, type AuditAppend } from "./gate.js";
import { apiJson, type Transport } from "./transport.js";

export type PublishLanguage = "en" | "ru";

export const CANONICAL_PLAYLIST_TITLES: Record<PublishLanguage, string> = {
  en: "Arcanada — English",
  ru: "Arcanada — Русский",
};

const ENV_KEYS: Record<PublishLanguage, string> = {
  en: "YOUTUBE_PLAYLIST_EN",
  ru: "YOUTUBE_PLAYLIST_RU",
};

export const PLAYLISTS_URL = "https://www.googleapis.com/youtube/v3/playlists";
export const PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";

export function resolveLanguage(language: string | undefined): PublishLanguage {
  if (language === "en" || language === "ru") return language;
  throw new AdapterError(
    ErrorCode.LANGUAGE_UNRESOLVED,
    `explicit language 'en'|'ru' is required for YouTube (got '${language ?? "none"}') — failing closed rather than guessing a playlist`,
    { language: language ?? null },
  );
}

export function resolveBinding(env: NodeJS.ProcessEnv): Record<PublishLanguage, string> {
  const en = env[ENV_KEYS.en];
  const ru = env[ENV_KEYS.ru];
  if (!en || !ru) {
    throw new AdapterError(
      ErrorCode.PLAYLIST_BINDING_BROKEN,
      `playlist binding missing: set ${ENV_KEYS.en} and ${ENV_KEYS.ru} (bootstrap creates the playlists under operator gate)`,
      { enPresent: Boolean(en), ruPresent: Boolean(ru) },
    );
  }
  return { en, ru };
}

interface PlaylistsListResponse {
  items?: Array<{ id?: string; snippet?: { channelId?: string; title?: string } }>;
}

/**
 * Verify both bound playlists exist, belong to the Arcanada channel, AND still
 * carry their canonical titles. Title drift = possible EN↔RU swap or foreign
 * re-binding — fail closed until the operator re-bootstraps or confirms.
 */
export async function verifyBinding(
  transport: Transport,
  accessToken: string,
  binding: Record<PublishLanguage, string>,
): Promise<void> {
  const url = `${PLAYLISTS_URL}?part=snippet&id=${binding.en},${binding.ru}`;
  const parsed = (await apiJson(
    transport,
    accessToken,
    { method: "GET", url },
    "playlist binding",
  )) as PlaylistsListResponse;
  const byId = new Map((parsed.items ?? []).map((item) => [item.id, item.snippet]));
  for (const language of ["en", "ru"] as const) {
    const snippet = byId.get(binding[language]);
    if (!snippet) {
      throw broken(`playlist ${binding[language]} (${language}) does not exist or is not readable`);
    }
    if (snippet.channelId !== ARCANADA_CHANNEL_ID) {
      throw broken(`playlist ${binding[language]} (${language}) belongs to a foreign channel`);
    }
    if (snippet.title !== CANONICAL_PLAYLIST_TITLES[language]) {
      throw broken(
        `playlist ${binding[language]} (${language}) title diverged from canonical «${CANONICAL_PLAYLIST_TITLES[language]}» — possible binding swap; re-bootstrap or confirm`,
      );
    }
  }
}

function broken(message: string): AdapterError {
  return new AdapterError(ErrorCode.PLAYLIST_BINDING_BROKEN, `playlist binding: ${message}`);
}

interface PlaylistItemsListResponse {
  items?: Array<{ id?: string }>;
}

/** Explicit duplicate pre-check — regular playlists silently accept duplicates. */
export async function isVideoInPlaylist(
  transport: Transport,
  accessToken: string,
  playlistId: string,
  videoId: string,
): Promise<boolean> {
  const url = `${PLAYLIST_ITEMS_URL}?part=id&playlistId=${playlistId}&videoId=${videoId}`;
  const parsed = (await apiJson(
    transport,
    accessToken,
    { method: "GET", url },
    "playlist duplicate pre-check",
  )) as PlaylistItemsListResponse;
  return (parsed.items ?? []).length > 0;
}

export async function insertIntoPlaylist(
  transport: Transport,
  accessToken: string,
  playlistId: string,
  videoId: string,
): Promise<void> {
  await apiJson(
    transport,
    accessToken,
    {
      method: "POST",
      url: `${PLAYLIST_ITEMS_URL}?part=snippet`,
      body: JSON.stringify({
        snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
      }),
    },
    "playlist insert",
  );
}

export interface BootstrapDeps {
  transport: Transport;
  accessToken: string;
  /** Arming gate source — bootstrap enforces it ITSELF (code-enforced, D-REQ-12). */
  env: NodeJS.ProcessEnv;
  /** Fail-closed audit destination — bootstrap calls auditOrAbort itself. */
  auditOptions: AuditOptions;
  journal: import("./recovery-journal.js").RecoveryJournal;
  auditAppend?: AuditAppend;
}

/** Paginated playlists.list mine=true (a >50-playlist channel must not miss the canonical title). */
async function listOwnPlaylists(deps: BootstrapDeps): Promise<PlaylistsListResponse["items"]> {
  const items: NonNullable<PlaylistsListResponse["items"]> = [];
  let pageToken = "";
  for (let page = 0; page < 20; page += 1) {
    const url = `${PLAYLISTS_URL}?part=snippet&mine=true&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const parsed = (await apiJson(
      deps.transport,
      deps.accessToken,
      { method: "GET", url },
      "playlist bootstrap read-before-create",
    )) as PlaylistsListResponse & { nextPageToken?: string };
    items.push(...(parsed.items ?? []));
    if (!parsed.nextPageToken) break;
    pageToken = parsed.nextPageToken;
  }
  return items;
}

/**
 * Read-before-create bootstrap: reuse an existing canonical-title playlist,
 * create only what is missing. The arming gate and the fail-closed audit are
 * enforced HERE (not delegated to callers) — an unarmed call mutates nothing.
 */
export async function bootstrapPlaylists(
  deps: BootstrapDeps,
): Promise<Record<PublishLanguage, string>> {
  requireArmed(deps.env, "playlist bootstrap");
  const result = {} as Record<PublishLanguage, string>;
  for (const language of ["en", "ru"] as const) {
    const canonical = CANONICAL_PLAYLIST_TITLES[language];
    const key = `canonical:${language}`;
    const spec = {
      kind: "playlist-create" as const,
      key,
      account: ARCANADA_CHANNEL_ID,
      action: "playlist-create" as const,
      intent: { language, canonicalTitle: canonical },
    };
    const control = {
      journal: deps.journal,
      auditOptions: deps.auditOptions,
      ...(deps.auditAppend ? { auditAppend: deps.auditAppend } : {}),
    };
    await deps.journal.withMutationLease("playlist-create", key, async () => {
      const pendingOperation = await deps.journal.find("playlist-create", key);
      const freshExisting = { items: await listOwnPlaylists(deps) } as PlaylistsListResponse;
      const matches = (freshExisting.items ?? []).filter(
        (item) => item.snippet?.title === canonical,
      );
      if (matches.length > 1) {
        throw broken(`duplicate canonical-title playlists for ${language} — operator must resolve`);
      }
      if (matches.length === 1 && matches[0]?.id) {
        const existingId = matches[0].id;
        if (pendingOperation) {
          if (
            pendingOperation.state === "applied" &&
            pendingOperation.result?.["playlistId"] !== existingId
          ) {
            throw broken(
              `applied playlist-create operation points to a different id than canonical ${existingId}`,
            );
          }
          const entry = await beginMutation(control, spec);
          await completeMutation(
            control,
            { ...spec, postUrl: `https://www.youtube.com/playlist?list=${existingId}` },
            entry,
            { playlistId: existingId },
          );
        }
        result[language] = existingId;
        return;
      }
      if (pendingOperation) {
        throw new AdapterError(
          ErrorCode.PLAYLIST_BINDING_BROKEN,
          `ambiguous playlist-create recovery for ${language}: intent exists but no canonical playlist is proven`,
          { operationId: pendingOperation.operationId, recoverable: true },
        );
      }
      const entry = await beginMutation(control, spec);
      const created = (await apiJson(
        deps.transport,
        deps.accessToken,
        {
          method: "POST",
          url: `${PLAYLISTS_URL}?part=snippet,status`,
          body: JSON.stringify({
            snippet: { title: canonical, defaultLanguage: language },
            status: { privacyStatus: "public" },
          }),
        },
        "playlist create",
      )) as { id?: string };
      if (!created.id) throw broken(`playlist create for ${language} returned no id`);
      await completeMutation(
        control,
        { ...spec, postUrl: `https://www.youtube.com/playlist?list=${created.id}` },
        entry,
        { playlistId: created.id },
      );
      result[language] = created.id;
    });
  }
  return result;
}
