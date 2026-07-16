// PUB-0035 core seam: "youtube" platform registration and the contract
// extensions the YouTube adapter consumes. These tests pin the seam BEFORE any
// consumer code exists (plan Phase 1.2).

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  PLATFORMS,
  PLATFORM_TEXT_LIMITS,
  PublishResultSchema,
  appendAudit,
  isPlatform,
  validateText,
  type EditInput,
  type PublishInput,
} from "../src/index.js";

describe("youtube platform registration", () => {
  it("PLATFORMS includes youtube and isPlatform accepts it", () => {
    expect(PLATFORMS).toContain("youtube");
    expect(isPlatform("youtube")).toBe(true);
  });

  it("text limit entry exists: 5000 UTF-16 units (coarse route cap)", () => {
    expect(PLATFORM_TEXT_LIMITS.youtube).toBe(5_000);
    expect(() => validateText("a".repeat(5_000), "youtube")).not.toThrow();
    expect(() => validateText("a".repeat(5_001), "youtube")).toThrow(/5000 UTF-16/);
  });
});

describe("PublishInput / EditInput extensions", () => {
  it("accepts the YouTube-specific optional fields (compile-time contract)", () => {
    const input: PublishInput = {
      text: "description",
      profile: "origin",
      videoPath: "/videos/a.mp4",
      language: "ru",
      privacyStatus: "private",
      title: "Заголовок",
    };
    const edit: EditInput = {
      postUrl: "https://youtube.com/watch?v=x",
      profile: "origin",
      title: "t",
    };
    expect(input.videoPath).toBe("/videos/a.mp4");
    expect(edit.title).toBe("t");
  });
});

describe("PublishResultSchema warnings", () => {
  const base = {
    ok: true as const,
    platform: "youtube" as const,
    account: "UC2zUfwafsM2OxaidE0iNM7w",
    postUrl: "https://www.youtube.com/watch?v=abc123",
    attachments: [{ kind: "video" as const, src: "/videos/a.mp4" }],
  };

  it("defaults warnings to [] when absent", () => {
    const parsed = PublishResultSchema.parse(base);
    expect(parsed.warnings).toEqual([]);
  });

  it("preserves warnings content (private-lock signal must survive parsing)", () => {
    const parsed = PublishResultSchema.parse({
      ...base,
      warnings: ["privacyStatus locked to private (compliance audit pending)"],
    });
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/private/);
  });
});

describe("ErrorCode namespace 9-15", () => {
  it("declares the seven new codes with the planned values", () => {
    expect(ErrorCode.CHANNEL_MISMATCH).toBe(9);
    expect(ErrorCode.LANGUAGE_UNRESOLVED).toBe(10);
    expect(ErrorCode.PLAYLIST_BINDING_BROKEN).toBe(11);
    expect(ErrorCode.AUTH_EXPIRED).toBe(12);
    expect(ErrorCode.QUOTA_EXCEEDED).toBe(13);
    expect(ErrorCode.UNSUPPORTED_OPERATION).toBe(14);
    expect(ErrorCode.NOT_ARMED).toBe(15);
  });

  it("keeps every numeric value unique", () => {
    const numeric = Object.values(ErrorCode).filter((v): v is number => typeof v === "number");
    expect(new Set(numeric).size).toBe(numeric.length);
  });
});

describe("AuditAction playlist-create", () => {
  it("appendAudit writes a playlist-create record", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "pub0035-audit-"));
    const now = new Date("2026-07-16T15:00:00Z");
    const ref = await appendAudit(
      {
        platform: "youtube",
        account: "UC2zUfwafsM2OxaidE0iNM7w",
        action: "playlist-create",
        postUrl: "https://www.youtube.com/playlist?list=PLxxxx",
      },
      { baseDir, now },
    );
    expect(ref).toMatch(/^PUB-audit-20260716-/);
    const body = await readFile(join(baseDir, "2026-07-16.jsonl"), "utf8");
    expect(body).toContain('"action":"playlist-create"');
  });
});
