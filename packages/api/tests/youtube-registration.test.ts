// PUB-0035 API registration: /publish body forwarding for the YouTube field
// set, /edit title forwarding, and the statusForCode mapping for the new
// ErrorCode range 9-15 (plan Phase 5.1, VC-14).

import { ErrorCode, type Adapter, type PublishInput, type EditInput } from "@arcanada/publisher-core";
import { describe, expect, it } from "vitest";
import { dispatchPost, statusForCode } from "../src/routes.js";
import { RateLimiter } from "@arcanada/publisher-core";

function fakeAdapter(captured: { publish: PublishInput[]; edit: EditInput[] }): Adapter {
  return {
    platform: "youtube",
    login: () => Promise.resolve(),
    publish: (input) => {
      captured.publish.push(input);
      return Promise.resolve({
        ok: true as const,
        platform: "youtube" as const,
        account: "UC2zUfwafsM2OxaidE0iNM7w",
        postUrl: "https://www.youtube.com/watch?v=vid001",
        attachments: [],
        commentIds: [],
        warnings: [],
      });
    },
    comment: () => Promise.reject(new Error("unused")),
    edit: (input) => {
      captured.edit.push(input);
      return Promise.resolve({
        ok: true as const,
        platform: "youtube" as const,
        account: "UC2zUfwafsM2OxaidE0iNM7w",
        postUrl: input.postUrl,
        edited: true,
      });
    },
    delete: () => Promise.reject(new Error("unused")),
    verify: () => Promise.reject(new Error("unused")),
  };
}

describe("statusForCode — new codes must not collapse into 500", () => {
  it("maps the PUB-0035 range to actionable statuses", () => {
    expect(statusForCode(ErrorCode.AUTH_EXPIRED)).toBe(401);
    expect(statusForCode(ErrorCode.NOT_ARMED)).toBe(403);
    expect(statusForCode(ErrorCode.QUOTA_EXCEEDED)).toBe(429);
    expect(statusForCode(ErrorCode.CHANNEL_MISMATCH)).toBe(400);
    expect(statusForCode(ErrorCode.LANGUAGE_UNRESOLVED)).toBe(400);
    expect(statusForCode(ErrorCode.PLAYLIST_BINDING_BROKEN)).toBe(400);
    expect(statusForCode(ErrorCode.UNSUPPORTED_OPERATION)).toBe(400);
    expect(statusForCode(ErrorCode.INTERNAL_PANIC)).toBe(500);
  });
});

describe("POST /publish forwards the YouTube field set", () => {
  it("videoPath/language/privacyStatus/title ride the body spread", async () => {
    const captured = { publish: [] as PublishInput[], edit: [] as EditInput[] };
    await dispatchPost(
      "/publish",
      {
        platform: "youtube",
        text: "Описание",
        title: "Заголовок",
        videoPath: "/videos/a.mp4",
        language: "ru",
        privacyStatus: "private",
        dryRun: true,
        profile: "origin",
      },
      { makeAdapter: () => fakeAdapter(captured), rateLimiter: new RateLimiter() },
    );
    const input = captured.publish[0]!;
    expect(input.videoPath).toBe("/videos/a.mp4");
    expect(input.language).toBe("ru");
    expect(input.privacyStatus).toBe("private");
    expect(input.title).toBe("Заголовок");
    expect(input.dryRun).toBe(true);
  });

  it("a malformed privacyStatus is dropped, never forwarded", async () => {
    const captured = { publish: [] as PublishInput[], edit: [] as EditInput[] };
    await dispatchPost(
      "/publish",
      { platform: "youtube", text: "Описание", privacyStatus: "secret", dryRun: true },
      { makeAdapter: () => fakeAdapter(captured), rateLimiter: new RateLimiter() },
    );
    expect(captured.publish[0]?.privacyStatus).toBeUndefined();
  });
});

describe("POST /edit forwards title", () => {
  it("metadata-only edit reaches the adapter with title", async () => {
    const captured = { publish: [] as PublishInput[], edit: [] as EditInput[] };
    await dispatchPost(
      "/edit",
      {
        platform: "youtube",
        targetUrl: "https://www.youtube.com/watch?v=vid001",
        title: "Новый заголовок",
        profile: "origin",
      },
      { makeAdapter: () => fakeAdapter(captured), rateLimiter: new RateLimiter() },
    );
    expect(captured.edit[0]?.title).toBe("Новый заголовок");
    expect(captured.edit[0]?.text).toBeUndefined();
  });
});
