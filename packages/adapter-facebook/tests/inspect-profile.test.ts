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

  it("expands a Russian collapsed post without clicking comment expanders", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-dom-")), "evidence");
    const page = fakeDomPage(evidenceDir, true);

    const result = await inspectFacebookProfilePost(input(evidenceDir), {
      page: page as never,
      skipTeardown: true,
    });

    expect(result.postBodyLength).toBe(BODY.length);
    expect(page.postExpander.clickCount).toBe(1);
    expect(page.commentExpander.clickCount).toBe(0);
  });

  it("uses stable bounded expander handles across profile rerenders", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-dom-")), "evidence");
    const page = fakeDomPage(evidenceDir, true, true);

    const result = await inspectFacebookProfilePost(input(evidenceDir), {
      page: page as never,
      skipTeardown: true,
    });

    expect(result.postBodyLength).toBe(BODY.length);
    expect(page.unrelatedPostExpander.clickCount).toBeGreaterThan(0);
    expect(page.postExpander.clickCount).toBe(1);
    expect(page.postExpander.lastClickTimeout).toBeGreaterThan(0);
    expect(page.postExpander.lastClickTimeout).toBeLessThanOrEqual(2_000);
    expect(page.commentExpander.clickCount).toBe(0);
  });

  it("finds a stable post owner above a permalink-free body article wrapper", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-dom-")), "evidence");
    const page = fakeDomPage(evidenceDir, true, false, "nested-body");

    const result = await inspectFacebookProfilePost(input(evidenceDir), {
      page: page as never,
      skipTeardown: true,
    });

    expect(result.postBodyLength).toBe(BODY.length);
    expect(page.postExpander.clickCount).toBe(1);
    expect(page.commentExpander.clickCount).toBe(0);
  });

  it("rejects an expander inside nested shared post content", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-dom-")), "evidence");
    const page = fakeDomPage(evidenceDir, true, false, "shared-post");

    await expect(
      inspectFacebookProfilePost(input(evidenceDir), {
        page: page as never,
        skipTeardown: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(page.postExpander.clickCount).toBe(0);
  });

  it("fails closed when multiple post ancestors could own an expander", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-dom-")), "evidence");
    const page = fakeDomPage(evidenceDir, true, false, "ambiguous-posts");

    await expect(
      inspectFacebookProfilePost(input(evidenceDir), {
        page: page as never,
        skipTeardown: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(page.postExpander.clickCount).toBe(0);
  });

  it("accepts the longest direct-owned terminal dir-auto body fallback", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-dom-")), "evidence");
    const page = fakeDomPage(evidenceDir, true, false, "nested-body", "dir-auto");

    const result = await inspectFacebookProfilePost(input(evidenceDir), {
      page: page as never,
      skipTeardown: true,
    });

    expect(result.postBodyLength).toBe(BODY.length);
    expect(page.postExpander.clickCount).toBe(1);
  });

  it("rejects a menu expander inside a non-terminal dir-auto node", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-dom-")), "evidence");
    const page = fakeDomPage(evidenceDir, true, false, "direct", "dir-auto-menu");

    await expect(
      inspectFacebookProfilePost(input(evidenceDir), {
        page: page as never,
        skipTeardown: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(page.postExpander.clickCount).toBe(0);
  });

  it("writes private hash-only diagnostics when exact matching fails", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-failure-")), "evidence");
    const page = fakeDomPage(evidenceDir, true, false, "direct", "dir-auto-menu");

    await expect(
      inspectFacebookProfilePost(input(evidenceDir), {
        page: page as never,
        skipTeardown: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });

    const manifestPath = join(evidenceDir, "failure-manifest.json");
    const manifestText = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest).toMatchObject({
      version: 1,
      status: "verify-failed",
      reason: "no-matching-post",
      posts: [
        {
          permalinkId: "pfbid-content-0377",
          permalinkSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          authorProfileIdentity: "www.facebook.com/pavelvalentov",
          bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          bodyLength: expect.any(Number),
          expanderDiagnostics: {
            labels: { more_ru: expect.any(Number) },
            reasons: { terminal_body_mismatch: expect.any(Number) },
            clicked: 0,
            clickFailed: 0,
          },
        },
      ],
    });
    expect(manifest.posts).toHaveLength(1);
    expect(manifest.posts[0].expanderDiagnostics.labels.more_ru).toBeGreaterThan(0);
    expect(manifest.posts[0].expanderDiagnostics.reasons.terminal_body_mismatch).toBeGreaterThan(0);
    expect(manifestText).not.toContain(BODY);
    expect(manifestText).not.toContain(PROFILE_URL);
    expect(manifestText).not.toContain("canonicalPermalink");
    expect(statSync(evidenceDir).mode & 0o777).toBe(0o700);
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(evidenceDir, "failure-readback.png")).mode & 0o777).toBe(0o600);
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

  it("matches an exact body when Facebook collapses paragraph blank lines", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-")), "evidence");
    const expectedBody = "Paragraph one.\n\nParagraph two.";
    const observedBody = "Paragraph one.\nParagraph two.";

    const result = await inspectFacebookProfilePost(
      { ...input(evidenceDir), expectedBody },
      options([[post({ body: observedBody })]]),
    );

    expect(result.canonicalParentPermalink).toContain("pfbid-content-0377");
    expect(result.postBodyLength).toBe(observedBody.length);
    expect(readFileSync(join(evidenceDir, "post-body.txt"), "utf8")).toBe(observedBody);
  });

  it("ignores non-comment DOM noise without a numeric id", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-")), "evidence");
    const result = await inspectFacebookProfilePost(
      input(evidenceDir),
      options([
        [
          post({
            comments: [
              {
                id: "not-a-comment-id",
                authorProfileHref: "https://www.facebook.com/facebook",
                body: "Unrelated nested UI text",
              },
              {
                id: "1326931196274132",
                authorProfileHref: PROFILE_URL,
                body: "Current first comment body",
              },
            ],
          }),
        ],
      ]),
    );

    expect(result.comments).toEqual([expect.objectContaining({ id: "1326931196274132" })]);
    expect(readFileSync(join(evidenceDir, "manifest.json"), "utf8")).not.toContain(
      "not-a-comment-id",
    );
  });

  it("fails closed when an expected-author comment has no numeric id", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "fb-inspect-")), "evidence");

    await expect(
      inspectFacebookProfilePost(
        input(evidenceDir),
        options([
          [
            post({
              comments: [
                {
                  id: "not-a-comment-id",
                  authorProfileHref: PROFILE_URL,
                  body: "Current first comment body",
                },
              ],
            }),
          ],
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
  messageBody: FakeNode | null = null;
  clickCount = 0;
  lastClickTimeout?: number;
  readonly containedNodes = new Set<FakeNode>();

  constructor(
    public innerText: string,
    href?: string,
    private readonly selectors: FakeSelectorMap = {},
    private readonly attributes: Record<string, string> = {},
  ) {
    if (href !== undefined) this.href = href;
  }

  closest(selector: string): FakeNode | null {
    if (selector === '[role="article"]') return this.article;
    if (selector === '[data-ad-preview="message"], [data-ad-comet-preview="message"]')
      return this.messageBody;
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

  contains(other: FakeNode): boolean {
    return this === other || this.containedNodes.has(other);
  }
}

function fakeDomPage(
  evidenceDir: string,
  collapsed = false,
  virtualized = false,
  topology: "direct" | "nested-body" | "shared-post" | "ambiguous-posts" = "direct",
  bodyMode: "preferred" | "dir-auto" | "dir-auto-menu" = "preferred",
) {
  const postSelectors: FakeSelectorMap = {};
  const commentSelectors: FakeSelectorMap = {};
  const unrelatedPostSelectors: FakeSelectorMap = {};
  const rootSelectors: FakeSelectorMap = {};
  const post = new FakeNode("", undefined, postSelectors);
  const comment = new FakeNode("", undefined, commentSelectors);
  post.article = post;
  comment.article = comment;

  const body = new FakeNode(collapsed ? `${BODY.slice(0, 40)}\nЕщё` : BODY);
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
  const postExpander = new FakeNode("Ещё");
  if (bodyMode === "preferred") postExpander.messageBody = body;
  const menuTerminal = new FakeNode("Menu");
  menuTerminal.article = post;
  if (bodyMode === "dir-auto-menu") menuTerminal.containedNodes.add(postExpander);
  else body.containedNodes.add(postExpander);
  const commentExpander = new FakeNode("Ещё");
  commentExpander.article = comment;
  commentExpander.messageBody = commentBody;
  const nestedArticles: FakeNode[] = [];
  if (topology === "direct") {
    postExpander.article = post;
  } else {
    const nestedSelectors: FakeSelectorMap = {};
    const nested = new FakeNode("", undefined, nestedSelectors);
    nested.article = nested;
    nested.parentElement = post;
    nestedSelectors["a[href]"] = [];
    nestedArticles.push(nested);
    postExpander.article = nested;
    if (topology === "shared-post" || topology === "ambiguous-posts") {
      const sharedPermalink = new FakeNode(
        "shared",
        "https://www.facebook.com/pavelvalentov/posts/pfbid-shared",
      );
      sharedPermalink.article = nested;
      nestedSelectors["a[href]"] = [sharedPermalink];
    }
    if (topology === "ambiguous-posts") {
      const innerSelectors: FakeSelectorMap = {};
      const inner = new FakeNode("", undefined, innerSelectors);
      inner.article = inner;
      inner.parentElement = nested;
      const innerPermalink = new FakeNode(
        "inner",
        "https://www.facebook.com/pavelvalentov/posts/pfbid-inner",
      );
      innerPermalink.article = inner;
      innerSelectors["a[href]"] = [innerPermalink];
      nestedArticles.push(inner);
      postExpander.article = inner;
    }
  }
  const unrelatedPost = new FakeNode("", undefined, unrelatedPostSelectors);
  unrelatedPost.article = unrelatedPost;
  const unrelatedBody = new FakeNode("Unrelated collapsed post\nЕщё");
  unrelatedBody.article = unrelatedPost;
  const unrelatedAuthor = new FakeNode("Pavel Valentov", PROFILE_URL);
  unrelatedAuthor.article = unrelatedPost;
  unrelatedAuthor.before = unrelatedBody;
  const unrelatedPermalink = new FakeNode(
    "3h",
    "https://www.facebook.com/pavelvalentov/posts/pfbid-unrelated",
  );
  unrelatedPermalink.article = unrelatedPost;
  const unrelatedPostExpander = new FakeNode("Ещё");
  unrelatedPostExpander.article = unrelatedPost;
  unrelatedPostExpander.messageBody = unrelatedBody;
  unrelatedBody.containedNodes.add(unrelatedPostExpander);

  postSelectors['[data-ad-preview="message"], [data-ad-comet-preview="message"]'] =
    bodyMode === "preferred" ? [body] : [];
  postSelectors['[dir="auto"]'] = bodyMode === "dir-auto-menu" ? [body, menuTerminal] : [body];
  postSelectors['a[role="link"][href]'] = [author];
  postSelectors["a[href]"] = [author, permalink, commentPermalink];
  postSelectors['a[href*="comment_id="]'] = [commentPermalink];
  commentSelectors['[data-ad-preview="message"], [data-ad-comet-preview="message"]'] = [
    commentBody,
  ];
  commentSelectors['a[role="link"][href]'] = [commentAuthor];
  commentSelectors["a[href]"] = [commentAuthor, commentPermalink];
  commentSelectors['a[href*="comment_id="]'] = [commentPermalink];
  unrelatedPostSelectors['[data-ad-preview="message"], [data-ad-comet-preview="message"]'] = [
    unrelatedBody,
  ];
  unrelatedPostSelectors['a[role="link"][href]'] = [unrelatedAuthor];
  unrelatedPostSelectors["a[href]"] = [unrelatedAuthor, unrelatedPermalink];
  unrelatedPostSelectors['a[href*="comment_id="]'] = [];
  rootSelectors['[role="article"]'] = virtualized
    ? [unrelatedPost, post, ...nestedArticles, comment]
    : [post, ...nestedArticles, comment];
  const root = new FakeNode("", undefined, rootSelectors);

  const activeExpanders = (unrelatedVisible: boolean) =>
    collapsed
      ? [
          ...(unrelatedVisible ? [unrelatedPostExpander] : []),
          postExpander,
          commentExpander,
        ].filter((expander) => expander === unrelatedPostExpander || expander.clickCount === 0)
      : [];
  const handleFor = (expander: FakeNode) => ({
    evaluate: async (callback: (node: FakeNode) => unknown) => callback(expander),
    click: async (options?: { timeout?: number }) => {
      expander.clickCount += 1;
      expander.lastClickTimeout = options?.timeout;
      if (expander === postExpander) body.innerText = BODY;
      if (expander === unrelatedPostExpander) unrelatedBody.innerText = "Unrelated expanded post";
    },
  });

  return {
    goto: async () => {},
    getByRole: (_role: string, options: { name: RegExp }) => {
      let unrelatedVisible = virtualized;
      const matchingExpanders = () =>
        options.name.test("Ещё") ? activeExpanders(unrelatedVisible) : [];
      const dynamicHandle = (index: number) => ({
        evaluate: async (callback: (node: FakeNode) => unknown) =>
          callback(matchingExpanders()[index]!),
        click: async (clickOptions?: { timeout?: number }) => {
          const expander = matchingExpanders()[index]!;
          await handleFor(expander).click(clickOptions);
          if (expander === unrelatedPostExpander) unrelatedVisible = false;
        },
      });
      return {
        count: async () => matchingExpanders().length,
        nth: dynamicHandle,
        elementHandles: async () =>
          matchingExpanders().map((expander) => {
            const handle = handleFor(expander);
            return {
              ...handle,
              click: async (clickOptions?: { timeout?: number }) => {
                await handle.click(clickOptions);
                if (expander === unrelatedPostExpander) unrelatedVisible = false;
              },
            };
          }),
      };
    },
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
    screenshot: async ({ path }: { path: string }) => {
      await import("node:fs/promises").then((fs) => fs.writeFile(path, "png"));
    },
    postExpander,
    commentExpander,
    unrelatedPostExpander,
  };
}
