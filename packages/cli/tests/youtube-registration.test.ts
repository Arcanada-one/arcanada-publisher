// PUB-0035 CLI registration: flags parse into ParsedArgs and runPublish/runEdit
// forward the full YouTube field set {text, title, videoPath, language,
// privacyStatus, profile, dryRun} to the adapter (plan Phase 5.1/5.2).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishInput, EditInput } from "@arcanada/publisher-core";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/parse-args.js";
import { run } from "../src/run.js";

const captured: { publish: PublishInput[]; edit: EditInput[] } = { publish: [], edit: [] };

vi.mock("@arcanada/publisher-youtube", () => ({
  YouTubeAdapter: class {
    platform = "youtube" as const;
    publish(input: PublishInput) {
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
    }
    edit(input: EditInput) {
      captured.edit.push(input);
      return Promise.resolve({
        ok: true as const,
        platform: "youtube" as const,
        account: "UC2zUfwafsM2OxaidE0iNM7w",
        postUrl: input.postUrl,
        edited: true,
      });
    }
  },
}));

function textFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "pub0035-cli-")), "text.md");
  writeFileSync(path, content);
  return path;
}

describe("parse-args youtube flags", () => {
  it("parses --video/--language/--privacy", () => {
    const args = parseArgs([
      "publish",
      "--platform",
      "youtube",
      "--text-file",
      "t.md",
      "--video",
      "/videos/a.mp4",
      "--language",
      "ru",
      "--privacy",
      "private",
    ]);
    expect(args.videoPath).toBe("/videos/a.mp4");
    expect(args.language).toBe("ru");
    expect(args.privacy).toBe("private");
  });

  it("rejects an invalid --privacy value fail-closed", () => {
    expect(() =>
      parseArgs(["publish", "--platform", "youtube", "--text-file", "t", "--privacy", "secret"]),
    ).toThrow(/private\|unlisted\|public/);
  });
});

describe("runPublish forwards the full field set", () => {
  it("videoPath/language/privacyStatus/title/dryRun reach the adapter", async () => {
    captured.publish.length = 0;
    const result = await run([
      "publish",
      "--platform",
      "youtube",
      "--text-file",
      textFile("Описание"),
      "--title",
      "Заголовок",
      "--video",
      "/videos/a.mp4",
      "--language",
      "ru",
      "--privacy",
      "private",
      "--dry-run",
      "--profile",
      "origin",
    ]);
    expect(result.code).toBe(0);
    expect(captured.publish).toHaveLength(1);
    const input = captured.publish[0]!;
    expect(input.text).toBe("Описание");
    expect(input.title).toBe("Заголовок");
    expect(input.videoPath).toBe("/videos/a.mp4");
    expect(input.language).toBe("ru");
    expect(input.privacyStatus).toBe("private");
    expect(input.dryRun).toBe(true);
    expect(input.profile).toBe("origin");
  });
});

describe("runEdit metadata-only path", () => {
  it("--title without --text-file is a valid YouTube metadata edit", async () => {
    captured.edit.length = 0;
    const result = await run([
      "edit",
      "--platform",
      "youtube",
      "--target-url",
      "https://www.youtube.com/watch?v=vid001",
      "--title",
      "Новый заголовок",
      "--profile",
      "origin",
    ]);
    expect(result.code).toBe(0);
    expect(captured.edit[0]?.title).toBe("Новый заголовок");
    expect(captured.edit[0]?.text).toBeUndefined();
  });
});
