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
    expect(JSON.stringify(result)).not.toContain(evidenceDir);
    expect(statSync(evidenceDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(evidenceDir, "post-body.txt")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(evidenceDir, "post-body.txt"), "utf8")).toBe(BODY);
    expect(statSync(join(evidenceDir, "comment-1326931196274132.txt")).mode & 0o777).toBe(0o600);
    expect(statSync(join(evidenceDir, "readback.png")).mode & 0o777).toBe(0o600);
    expect(statSync(join(evidenceDir, "manifest.json")).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(join(evidenceDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      postBodyEvidencePath: join(evidenceDir, "post-body.txt"),
      screenshotPath: join(evidenceDir, "readback.png"),
      comments: [
        {
          id: "1326931196274132",
          bodyEvidencePath: join(evidenceDir, "comment-1326931196274132.txt"),
        },
      ],
    });
    expect(result.coverage).toEqual({ maxScrolls: 1, scrollsPerformed: 1, postsInspected: 1 });
  });

  it("executes the default scanner against browser-like NodeLists", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-dom-")), "evidence");
    const page = fakeDomPage(evidenceDir);

    const result = await inspectFacebookProfilePost(input(evidenceDir), {
      page: page as never,
      skipTeardown: true,
    });

    expect(result).toMatchObject({
      canonicalParentPermalink: "https://www.facebook.com/pavelvalentov/posts/pfbid-content-0377",
      postBodyLength: BODY.length,
      comments: [
        {
          id: "1326931196274132",
          authorProfileIdentity: "www.facebook.com/pavelvalentov",
          bodyLength: "Current first comment body".length,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(evidenceDir);
    expect(readFileSync(join(evidenceDir, "post-body.txt"), "utf8")).toBe(BODY);
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

type FakeSelectorMap = Record<string, FakeNode[]>;

class FakeNodeList<T> implements Iterable<T> {
  readonly length: number;

  constructor(private readonly nodes: T[]) {
    this.length = nodes.length;
    nodes.forEach((node, index) => {
      Object.defineProperty(this, index, { value: node, enumerable: true });
    });
  }

  item(index: number): T | null {
    return this.nodes[index] ?? null;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.nodes[Symbol.iterator]();
  }
}

class FakeNode {
  href?: string;
  parentElement: FakeNode | null = null;
  article: FakeNode | null = null;
  before: FakeNode | null = null;

  constructor(
    readonly innerText: string,
    href?: string,
    private readonly selectors: FakeSelectorMap = {},
    private readonly attributes: Record<string, string> = {},
  ) {
    if (href !== undefined) this.href = href;
  }

  closest(selector: string): FakeNode | null {
    if (selector === '[role="article"]') return this.article;
    if (selector === 'a[role="link"], strong') return null;
    return null;
  }

  querySelector(selector: string): FakeNode | null {
    return this.selectors[selector]?.[0] ?? null;
  }

  querySelectorAll(selector: string): FakeNodeList<FakeNode> {
    return new FakeNodeList(this.selectors[selector] ?? []);
  }

  compareDocumentPosition(other: FakeNode): number {
    return this.before === other ? 4 : 0;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}

function fakeDomPage(evidenceDir: string) {
  const postSelectors: FakeSelectorMap = {};
  const commentSelectors: FakeSelectorMap = {};
  const rootSelectors: FakeSelectorMap = {};
  const post = new FakeNode("", undefined, postSelectors);
  const comment = new FakeNode("", undefined, commentSelectors);
  post.article = post;
  comment.article = comment;

  const body = new FakeNode(BODY);
  body.article = post;
  const commentBody = new FakeNode("Current first comment body");
  commentBody.article = comment;
  const author = new FakeNode("Pavel Valentov", PROFILE_URL);
  author.article = post;
  author.before = body;
  const commentAuthor = new FakeNode("Pavel Valentov", PROFILE_URL);
  commentAuthor.article = comment;
  commentAuthor.before = commentBody;
  const permalink = new FakeNode(
    "2h",
    "https://www.facebook.com/pavelvalentov/posts/pfbid-content-0377",
  );
  permalink.article = post;
  const commentPermalink = new FakeNode(
    "1h",
    "https://www.facebook.com/pavelvalentov/posts/pfbid-content-0377?comment_id=1326931196274132",
  );
  commentPermalink.article = comment;
  const commentWrapper = new FakeNode("");
  commentWrapper.article = post;
  comment.parentElement = commentWrapper;

  postSelectors['[data-ad-preview="message"], [data-ad-comet-preview="message"]'] = [body];
  postSelectors['a[role="link"][href]'] = [author];
  postSelectors["a[href]"] = [author, permalink, commentPermalink];
  postSelectors['a[href*="comment_id="]'] = [commentPermalink];
  commentSelectors['[data-ad-preview="message"], [data-ad-comet-preview="message"]'] = [
    commentBody,
  ];
  commentSelectors['a[role="link"][href]'] = [commentAuthor];
  commentSelectors["a[href]"] = [commentAuthor, commentPermalink];
  commentSelectors['a[href*="comment_id="]'] = [commentPermalink];
  rootSelectors['[role="article"]'] = [post, comment];
  const root = new FakeNode("", undefined, rootSelectors);

  return {
    goto: async () => {},
    getByRole: () => ({ count: async () => 0 }),
    locator: () => ({
      evaluate: async (callback: (node: FakeNode) => unknown) => {
        const previousLocation = (globalThis as { location?: unknown }).location;
        Object.defineProperty(globalThis, "location", {
          configurable: true,
          value: { href: PROFILE_URL },
        });
        try {
          return callback(root);
        } finally {
          if (previousLocation === undefined)
            delete (globalThis as { location?: unknown }).location;
          else
            Object.defineProperty(globalThis, "location", {
              configurable: true,
              value: previousLocation,
            });
        }
      },
    }),
    evaluate: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => {
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(join(evidenceDir, "readback.png"), "png"),
      );
    },
  };
}
