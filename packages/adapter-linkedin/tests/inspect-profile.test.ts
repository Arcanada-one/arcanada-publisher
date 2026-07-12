import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import {
  inspectLinkedInProfilePost,
  type ObservedLinkedInProfilePost,
} from "../src/inspect-profile.js";

const PROFILE = "https://www.linkedin.com/in/pavelvalentov/";
const BODY = "Building the Binary Is Only the Beginning\n\nExact full campaign body.";
const ID = "7482676445432107008";

function post(overrides: Partial<ObservedLinkedInProfilePost> = {}): ObservedLinkedInProfilePost {
  return {
    activityUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`,
    vanityPermalink: `https://www.linkedin.com/posts/pavelvalentov_building-the-binary-activity-${ID}-AbCd`,
    authorProfileHref: PROFILE,
    body: BODY,
    hasNativeVideo: true,
    ...overrides,
  };
}

function options(batches: ObservedLinkedInProfilePost[][]) {
  let scan = 0;
  return {
    page: {
      goto: async () => {},
      screenshot: async ({ path }: { path: string }) => {
        await import("node:fs/promises").then((fs) => fs.writeFile(path, "png"));
      },
    } as never,
    skipTeardown: true,
    __recorder: {
      scanLoadedPosts: async () => batches[Math.min(scan++, batches.length - 1)] ?? [],
      scroll: async () => {},
    },
  };
}

function input(evidenceDir: string) {
  return {
    profileUrl: PROFILE,
    expectedAuthorProfileUrl: PROFILE,
    expectedBody: BODY,
    evidenceDir,
    maxScrolls: 1,
    profile: "default",
  };
}

describe("LinkedIn read-only profile inspection", () => {
  it("binds exact body, author, native video, activity id, and vanity permalink", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "li-inspect-")), "evidence");
    const result = await inspectLinkedInProfilePost(
      input(evidenceDir),
      options([[post()], [post()]]),
    );
    expect(result).toMatchObject({
      canonicalParentPermalink: expect.stringContaining(`/posts/`),
      activityUrl: expect.stringContaining(`urn:li:activity:${ID}`),
      activityId: ID,
      authorProfileIdentity: "www.linkedin.com/in/pavelvalentov",
      postBodyLength: BODY.length,
      hasNativeVideo: true,
      coverage: { maxScrolls: 1, scrollsPerformed: 1, postsInspected: 1 },
    });
    expect(JSON.stringify(result)).not.toContain(BODY);
    expect(statSync(evidenceDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(evidenceDir, "post-body.txt")).mode & 0o777).toBe(0o600);
    expect(statSync(join(evidenceDir, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(evidenceDir, "post-body.txt"), "utf8")).toBe(BODY);
  });

  it("fails closed for wrong author, missing video, missing vanity, or duplicates", async () => {
    const root = mkdtempSync(join(tmpdir(), "li-inspect-"));
    for (const [name, candidates] of [
      ["author", [post({ authorProfileHref: "https://www.linkedin.com/in/impostor/" })]],
      ["video", [post({ hasNativeVideo: false })]],
      ["vanity", [post({ vanityPermalink: "" })]],
      [
        "duplicate",
        [
          post(),
          post({
            activityUrl:
              "https://www.linkedin.com/feed/update/urn:li:activity:7482676445432107009/",
            vanityPermalink:
              "https://www.linkedin.com/posts/pavelvalentov_copy-activity-7482676445432107009-ZyxW",
          }),
        ],
      ],
    ] as const) {
      const evidenceDir = join(root, name);
      await expect(
        inspectLinkedInProfilePost(input(evidenceDir), options([candidates])),
      ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    }
  });

  it("contains no mutation controls", () => {
    const source = readFileSync(new URL("../src/inspect-profile.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /publishButton|clickPost|deleteMenu|commentSubmit|runPublish|runDelete/,
    );
  });
});
