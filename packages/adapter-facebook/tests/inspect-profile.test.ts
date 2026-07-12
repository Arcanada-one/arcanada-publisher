import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import {
  inspectFacebookProfilePost,
  type ObservedFacebookProfilePost,
} from "../src/inspect-profile.js";

const PROFILE_URL = "https://www.facebook.com/pavelvalentov";
const BODY = "Exact CONTENT-0377 body\nwith a unique release-engineering paragraph.";

function post(overrides: Partial<ObservedFacebookProfilePost> = {}): ObservedFacebookProfilePost {
  return {
    canonicalPermalink: "https://www.facebook.com/pavelvalentov/posts/pfbid-content-0377",
    authorProfileHref: PROFILE_URL,
    body: BODY,
    comments: [
      {
        id: "1326931196274132",
        authorProfileHref: PROFILE_URL,
        body: "Current first comment body",
      },
    ],
    ...overrides,
  };
}

function options(batches: ObservedFacebookProfilePost[][]) {
  let scan = 0;
  return {
    page: {
      goto: async () => {},
      screenshot: async ({ path }: { path: string }) => {
        await import("node:fs/promises").then((fs) => fs.writeFile(path, "png"));
      },
      isClosed: () => false,
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
    profileUrl: PROFILE_URL,
    expectedAuthorProfileUrl: PROFILE_URL,
    expectedBody: BODY,
    evidenceDir,
    maxScrolls: 1,
    profile: "default",
  };
}

describe("Facebook read-only profile inspection", () => {
  it("returns hash-only evidence for one exact body match and writes private raw evidence", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-")), "evidence");

    const result = await inspectFacebookProfilePost(
      input(evidenceDir),
      options([[post()], [post()]]),
    );

    expect(result.canonicalParentPermalink).toBe(
      "https://www.facebook.com/pavelvalentov/posts/pfbid-content-0377",
    );
    expect(result.authorProfileIdentity).toBe("www.facebook.com/pavelvalentov");
    expect(result.postBodyLength).toBe(BODY.length);
    expect(result.postBodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.comments).toEqual([
      expect.objectContaining({
        id: "1326931196274132",
        authorProfileIdentity: "www.facebook.com/pavelvalentov",
        bodyLength: "Current first comment body".length,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(BODY);
    expect(JSON.stringify(result)).not.toContain("Current first comment body");
    expect(statSync(evidenceDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(evidenceDir, "post-body.txt")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(evidenceDir, "post-body.txt"), "utf8")).toBe(BODY);
    expect(statSync(join(evidenceDir, "comment-1326931196274132.txt")).mode & 0o777).toBe(0o600);
    expect(statSync(join(evidenceDir, "readback.png")).mode & 0o777).toBe(0o600);
    expect(result.coverage).toEqual({ maxScrolls: 1, scrollsPerformed: 1, postsInspected: 1 });
  });

  it("fails closed when content matches a different header profile without leaking the body", async () => {
    const secret = "SECRET_CONTENT_MUST_NOT_LEAK";
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-")), "evidence");
    let error: unknown;
    try {
      await inspectFacebookProfilePost(
        { ...input(evidenceDir), expectedBody: secret },
        options([[post({ body: secret, authorProfileHref: "https://www.facebook.com/impostor" })]]),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("fails closed on zero or multiple exact matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "fb-inspect-"));
    await expect(
      inspectFacebookProfilePost(input(join(root, "zero")), options([[]])),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    await expect(
      inspectFacebookProfilePost(
        input(join(root, "many")),
        options([
          [
            post(),
            post({
              canonicalPermalink: "https://www.facebook.com/pavelvalentov/posts/pfbid-duplicate",
            }),
          ],
        ]),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
  });

  it("uses an explicitly supplied excerpt only when it is unique", async () => {
    const root = mkdtempSync(join(tmpdir(), "fb-inspect-"));
    const base = {
      ...input(join(root, "unique")),
      expectedBody: undefined,
      contentExcerpt: "unique release-engineering paragraph",
    };
    const result = await inspectFacebookProfilePost(
      base,
      options([
        [post(), post({ canonicalPermalink: `${PROFILE_URL}/posts/other`, body: "other" })],
      ]),
    );
    expect(result.canonicalParentPermalink).toContain("pfbid-content-0377");

    await expect(
      inspectFacebookProfilePost(
        { ...base, evidenceDir: join(root, "many") },
        options([
          [post(), post({ canonicalPermalink: `${PROFILE_URL}/posts/duplicate`, body: BODY })],
        ]),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
  });

  it("keeps the inspection module free of mutation controls", () => {
    const source = readFileSync(new URL("../src/inspect-profile.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /commentActionsMenu|deleteMenuItem|confirmDelete|composerButton|publishButton|runPublish|runDelete/,
    );
  });
});
