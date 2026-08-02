// PUB-0031: standalone comment deletion. Facebook comment deletion existed only
// inside `replaceCommentText` (delete + add), so removing a comment outright was
// impossible — the gap that left duplicate link-comments to be cleaned by hand.
//
// These tests pin the safety contract of the new surface:
//   1. it deletes the ONE comment bound to the exact numeric id;
//   2. it refuses BEFORE any destructive click on author/body/id mismatch;
//   3. `delete --kind comment` never falls through to the post-delete menu
//      (which would delete the whole parent post);
//   4. UNKNOWN evidence carries hashes, never comment text.

import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ErrorCode, ProfileManager, type DeleteInput } from "@arcanada/publisher-core";
import { deleteCommentById } from "../src/comment.js";
import { del, type FacebookDeleteInput } from "../src/delete.js";

const PARENT = "https://www.facebook.com/pavelvalentov/posts/pfbid-target";
const TARGET_ID = "1326931196274132";
const AUTHOR_PROFILE = "https://www.facebook.com/pavelvalentov";
const BODY = "Плагин в Chrome Web Store:\nhttps://chromewebstore.google.com/detail/x";

function profiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "fb-comment-delete-"));
  mkdirSync(join(root, "facebook", "default"), { recursive: true });
  return new ProfileManager({ root });
}

function input(overrides: Partial<ReturnType<typeof baseInput>> = {}) {
  return { ...baseInput(), ...overrides };
}

function baseInput() {
  return {
    parentPostUrl: PARENT,
    commentId: TARGET_ID,
    expectedAuthorProfileUrl: AUTHOR_PROFILE,
    expectedContent: BODY,
    profile: "default",
  };
}

describe("Facebook deleteCommentById — input validation (no browser, fails closed)", () => {
  it("requires the read-before-delete oracle", async () => {
    await expect(
      deleteCommentById(input({ expectedContent: "  " }), { profileManager: profiles() }),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("requires a numeric comment id", async () => {
    await expect(
      deleteCommentById(input({ commentId: "pfbid-not-numeric" }), {
        profileManager: profiles(),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("requires the author ownership oracle", async () => {
    await expect(
      deleteCommentById(input({ expectedAuthorProfileUrl: "" }), { profileManager: profiles() }),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("rejects a comment permalink passed as the author profile URL", async () => {
    await expect(
      deleteCommentById(input({ expectedAuthorProfileUrl: `${PARENT}?comment_id=${TARGET_ID}` }), {
        profileManager: profiles(),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("rejects an off-host parent", async () => {
    await expect(
      deleteCommentById(input({ parentPostUrl: "https://evil.example.com/posts/1" }), {
        profileManager: profiles(),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });
});

describe("Facebook deleteCommentById — live DOM path", () => {
  it("deletes exactly the bound comment and reports its permalink", async () => {
    const page = new FakePage();
    const result = await deleteCommentById(input(), {
      profileManager: profiles(),
      page: page.asPage(),
    });

    expect(result.deleted).toBe(true);
    expect(result.platform).toBe("facebook");
    expect(result.targetUrl).toContain(`comment_id=${TARGET_ID}`);
    // The kebab menu of the target comment — never the nested reply's.
    expect(page.outerActionClicks).toBe(1);
    expect(page.nestedActionClicks).toBe(0);
    expect(page.confirmClicks).toBe(1);
    // Unrelated comments survive.
    expect(page.remainingIds()).toContain("7000000000000001");
    expect(page.remainingIds()).not.toContain(TARGET_ID);
  });

  it("refuses without clicking confirm when the author is an impostor", async () => {
    const page = new FakePage({ authorProfileUrl: "https://www.facebook.com/impostor" });
    await expect(
      deleteCommentById(input(), { profileManager: profiles(), page: page.asPage() }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(page.confirmClicks).toBe(0);
    expect(page.remainingIds()).toContain(TARGET_ID);
  });

  it("refuses without clicking confirm when the rendered body differs from the oracle", async () => {
    const page = new FakePage({ body: "some other comment entirely" });
    await expect(
      deleteCommentById(input(), { profileManager: profiles(), page: page.asPage() }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(page.confirmClicks).toBe(0);
    expect(page.remainingIds()).toContain(TARGET_ID);
  });

  it("refuses when the exact comment id is absent from the parent", async () => {
    const page = new FakePage();
    await expect(
      deleteCommentById(input({ commentId: "9999999999999999" }), {
        profileManager: profiles(),
        page: page.asPage(),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(page.confirmClicks).toBe(0);
  });

  it("reports UNKNOWN with hashes only — never comment text — when detach cannot be proven", async () => {
    const secret = "SECRET_COMMENT_DO_NOT_LEAK";
    const page = new FakePage({ detachFails: true, body: secret });
    let error: unknown;
    try {
      await deleteCommentById(input({ expectedContent: secret }), {
        profileManager: profiles(),
        page: page.asPage(),
      });
    } catch (caught) {
      error = caught;
    }
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(secret);
    expect(serialized).toMatch(/expectedOldTextSha256/);
    expect(serialized).toMatch(/reconcileRequired/);
  });
});

describe("delete --kind comment routing (must never delete the parent post)", () => {
  it("routes a comment permalink to the comment arm, not the post choreography", async () => {
    let postDeleteAttempted = false;
    let received: unknown;
    const result = await del(
      {
        targetUrl: `${PARENT}?comment_id=${TARGET_ID}`,
        kind: "comment",
        expectedContent: BODY,
        expectedAuthorProfileUrl: AUTHOR_PROFILE,
        profile: "default",
      } satisfies FacebookDeleteInput,
      {
        profileManager: profiles(),
        // If routing regressed, the post arm would run these seams.
        __readContent: async () => {
          postDeleteAttempted = true;
          return BODY;
        },
        __performDelete: async () => {
          postDeleteAttempted = true;
        },
        __deleteComment: async (commentInput) => {
          received = commentInput;
          return {
            ok: true as const,
            platform: "facebook" as const,
            account: "pavelvalentov",
            deleted: true,
            targetUrl: `${PARENT}?comment_id=${TARGET_ID}`,
          };
        },
      },
    );

    expect(postDeleteAttempted).toBe(false);
    expect(result.deleted).toBe(true);
    // The parent URL handed to the comment arm carries no comment_id.
    expect(received).toMatchObject({
      commentId: TARGET_ID,
      expectedAuthorProfileUrl: AUTHOR_PROFILE,
      expectedContent: BODY,
    });
    expect((received as { parentPostUrl: string }).parentPostUrl).not.toContain("comment_id");
  });

  it("refuses a comment delete whose target URL carries no comment_id", async () => {
    await expect(
      del(
        {
          targetUrl: PARENT,
          kind: "comment",
          expectedContent: BODY,
          expectedAuthorProfileUrl: AUTHOR_PROFILE,
          profile: "default",
        } satisfies FacebookDeleteInput,
        { profileManager: profiles() },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGS });
  });

  it("refuses a comment delete with no author oracle", async () => {
    await expect(
      del(
        {
          targetUrl: `${PARENT}?comment_id=${TARGET_ID}`,
          kind: "comment",
          expectedContent: BODY,
          profile: "default",
        } satisfies FacebookDeleteInput,
        { profileManager: profiles() },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_INPUT });
  });

  it("still routes kind=post through the post choreography", async () => {
    let performed = false;
    const result = await del(
      {
        targetUrl: PARENT,
        kind: "post",
        expectedContent: BODY,
        profile: "default",
      } satisfies DeleteInput,
      {
        profileManager: profiles(),
        __readContent: async () => BODY,
        __performDelete: async () => {
          performed = true;
        },
        __deleteComment: async () => {
          throw new Error("comment arm must not run for kind=post");
        },
      },
    );
    expect(performed).toBe(true);
    expect(result.deleted).toBe(true);
  });
});

// --- Fake DOM ---------------------------------------------------------------
// Mirrors the shape `comment.ts` walks: nested [role=article] blocks, each with
// a comment_id anchor, an author link, a [dir=auto] body and a kebab menu.

interface FakePageOptions {
  authorProfileUrl?: string;
  body?: string;
  detachFails?: boolean;
}

class FakePage {
  readonly parent = PARENT;
  readonly options: FakePageOptions;
  articles: FakeArticle[];
  outerActionClicks = 0;
  nestedActionClicks = 0;
  confirmClicks = 0;

  constructor(options: FakePageOptions = {}) {
    this.options = options;
    const nested = new FakeArticle(
      "8000000000000001",
      "https://www.facebook.com/nested-author",
      options.body ?? BODY,
      "nested",
    );
    const target = new FakeArticle(
      TARGET_ID,
      options.authorProfileUrl ?? AUTHOR_PROFILE,
      options.body ?? BODY,
      "outer",
      [nested],
    );
    const unrelated = new FakeArticle(
      "7000000000000001",
      AUTHOR_PROFILE,
      "unrelated existing comment",
      "unrelated",
    );
    this.articles = [target, unrelated];
  }

  asPage() {
    const self = this;
    return {
      goto: async () => {},
      url: () => self.parent,
      // PUB-0031: Facebook renders the kebab's entries as role="button" inside a
      // role="menu" container, and the delete confirmation inside role="dialog".
      // The fake DOM must expose those containers or it stops modelling the real
      // page (the adapter now scopes its lookups to them).
      locator: (selector: string) => {
        if (selector.includes("comment_id"))
          return new FakeLocator(
            self,
            self.allArticles().map((article) => article.anchor),
          );
        if (selector.includes('[role="menu"]'))
          return new FakeLocator(self, [new FakeControl("menu-container")]);
        if (selector.includes('[role="dialog"]'))
          return new FakeLocator(self, [new FakeControl("dialog-container")]);
        return new FakeLocator(self, []);
      },
      getByRole: (role: string) => {
        if (role === "menuitem") return new FakeLocator(self, [new FakeControl("delete-item")]);
        if (role === "button") return new FakeLocator(self, [new FakeControl("confirm")]);
        return new FakeLocator(self, []);
      },
      keyboard: { insertText: async () => {}, press: async () => {} },
      waitForTimeout: async () => {},
      isClosed: () => false,
      screenshot: async () => {},
    } as unknown as import("playwright").Page;
  }

  allArticles(): FakeArticle[] {
    return this.articles.flatMap((article) => [article, ...article.nested]);
  }

  remainingIds(): string[] {
    return this.allArticles().map((article) => article.id);
  }

  removeTarget(): void {
    if (!this.options.detachFails)
      this.articles = this.articles.filter((article) => article.id !== TARGET_ID);
  }
}

class FakeLocator {
  constructor(
    readonly page: FakePage,
    readonly nodes: FakeNode[],
  ) {}

  async count(): Promise<number> {
    return this.nodes.length;
  }
  nth(index: number): FakeLocator {
    return new FakeLocator(this.page, this.nodes[index] ? [this.nodes[index]!] : []);
  }
  first(): FakeLocator {
    return this.nth(0);
  }
  last(): FakeLocator {
    return this.nth(this.nodes.length - 1);
  }
  async getAttribute(name: string): Promise<string | null> {
    return this.nodes[0]?.getAttribute(name) ?? null;
  }
  locator(selector: string): FakeLocator {
    const node = this.nodes[0];
    if (node instanceof FakeAnchor && selector.includes("ancestor")) {
      return new FakeLocator(this.page, [node.article]);
    }
    if (node instanceof FakeArticle) {
      if (selector === '[dir="auto"]')
        return new FakeLocator(this.page, node.descendantTextNodes());
      if (selector.includes('a[role="link"]'))
        return new FakeLocator(this.page, node.descendantAuthorNodes());
    }
    return new FakeLocator(this.page, []);
  }
  getByRole(role: string): FakeLocator {
    const node = this.nodes[0];
    // A menu container yields its delete entry (role="button" in the real DOM);
    // a dialog container yields the confirm button. Anything else yields nothing,
    // so an unscoped lookup cannot silently succeed.
    if (node instanceof FakeControl && node.kind === "menu-container")
      return new FakeLocator(this.page, role === "button" ? [new FakeControl("delete-item")] : []);
    if (node instanceof FakeControl && node.kind === "dialog-container")
      return new FakeLocator(this.page, role === "button" ? [new FakeControl("confirm")] : []);
    return new FakeLocator(this.page, []);
  }
  or(other: FakeLocator): FakeLocator {
    return new FakeLocator(this.page, [...this.nodes, ...other.nodes]);
  }
  getByLabel(): FakeLocator {
    const node = this.nodes[0];
    return node instanceof FakeArticle
      ? new FakeLocator(this.page, node.descendantActions())
      : new FakeLocator(this.page, []);
  }
  async waitFor(options: { state: string }): Promise<void> {
    const node = this.nodes[0];
    // Menu/dialog containers and controls count as visible once queried; only
    // article detachment carries real meaning in this fake.
    if (options.state === "visible" && node === undefined) throw new Error("not visible");
    if (options.state === "detached" && node instanceof FakeArticle) {
      if (this.page.allArticles().some((article) => article.id === node.id))
        throw new Error("still attached");
    }
  }
  async click(): Promise<void> {
    const node = this.nodes[0];
    if (node instanceof FakeAction) {
      if (node.article.label === "outer") this.page.outerActionClicks += 1;
      else if (node.article.label === "nested") this.page.nestedActionClicks += 1;
    }
    if (node instanceof FakeControl && node.kind === "confirm") {
      this.page.confirmClicks += 1;
      this.page.removeTarget();
    }
  }
  async evaluate<T, A>(fn: (element: never, arg: A) => T, arg: A): Promise<T> {
    return fn(this.nodes[0] as never, arg);
  }
}

abstract class FakeNode {
  abstract closest(selector: string): FakeNode | null;
  abstract querySelector(selector: string): FakeNode | null;
  abstract querySelectorAll(selector: string): FakeNode[];
  abstract getAttribute(name: string): string | null;
  contains(other: FakeNode): boolean {
    return this === other;
  }
  compareDocumentPosition(_other: FakeNode): number {
    return 0;
  }
}

class FakeArticle extends FakeNode {
  readonly anchor: FakeAnchor;
  readonly timestamp: FakeTimestamp;
  readonly body: FakeBody;
  readonly author: FakeAuthor;
  readonly action: FakeAction;

  constructor(
    readonly id: string,
    authorProfileUrl: string,
    body: string,
    readonly label: string,
    readonly nested: FakeArticle[] = [],
  ) {
    super();
    this.anchor = new FakeAnchor(this);
    this.timestamp = new FakeTimestamp(this);
    this.body = new FakeBody(this, body, AUTHOR_PROFILE);
    this.author = new FakeAuthor(this, "Actual Author", authorProfileUrl);
    this.action = new FakeAction(this);
  }
  closest(selector: string): FakeArticle | null {
    return selector === '[role="article"]' ? this : null;
  }
  querySelector(selector: string): FakeNode | null {
    if (selector === '[role="article"]') return this.nested[0] ?? null;
    return null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    if (selector.includes("comment_id")) return [this.anchor, ...this.nested.map((n) => n.anchor)];
    if (selector === '[dir="auto"]') return this.descendantTextNodes();
    return [];
  }
  getAttribute(): null {
    return null;
  }
  descendantTextNodes(): FakeNode[] {
    return [this.body, this.author, ...this.nested.flatMap((n) => n.descendantTextNodes())];
  }
  descendantAuthorNodes(): FakeNode[] {
    return [
      this.author,
      this.timestamp,
      this.body.mention,
      ...this.nested.flatMap((n) => n.descendantAuthorNodes()),
    ];
  }
  descendantActions(): FakeNode[] {
    return [this.action, ...this.nested.flatMap((n) => n.descendantActions())];
  }
}

class FakeAnchor extends FakeNode {
  constructor(readonly article: FakeArticle) {
    super();
  }
  closest(selector: string): FakeArticle | null {
    return selector === '[role="article"]' ? this.article : null;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  getAttribute(name: string): string | null {
    return name === "href" ? `${PARENT}?comment_id=${this.article.id}` : null;
  }
}

class FakeTimestamp extends FakeNode {
  readonly innerText = "1h";
  constructor(readonly article: FakeArticle) {
    super();
  }
  closest(selector: string): FakeArticle | FakeTimestamp | null {
    if (selector === '[role="article"]') return this.article;
    if (selector.includes('a[role="link"]')) return this;
    return null;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  getAttribute(name: string): string | null {
    return name === "href" ? `${PARENT}?comment_id=${this.article.id}` : null;
  }
  override compareDocumentPosition(other: FakeNode): number {
    return other === this.article.body ? 4 : 0;
  }
}

class FakeBody extends FakeNode {
  readonly mention: FakeMention;
  constructor(
    readonly article: FakeArticle,
    readonly innerText: string,
    mentionHref: string,
  ) {
    super();
    this.mention = new FakeMention(article, this, mentionHref);
  }
  closest(selector: string): FakeArticle | FakeAuthor | null {
    if (selector === '[role="article"]') return this.article;
    return null;
  }
  querySelector(): FakeNode | null {
    return null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return selector.includes('a[role="link"]') ? [this.mention] : [];
  }
  getAttribute(): null {
    return null;
  }
  override contains(other: FakeNode): boolean {
    return other === this || other === this.mention;
  }
}

class FakeAuthor extends FakeBody {
  constructor(
    article: FakeArticle,
    innerText: string,
    readonly href: string,
  ) {
    super(article, innerText, href);
  }
  closest(selector: string): FakeArticle | FakeAuthor | null {
    if (selector.includes("a[role=")) return this;
    return super.closest(selector);
  }
  override getAttribute(name: string): string | null {
    return name === "href" ? this.href : null;
  }
  override compareDocumentPosition(other: FakeNode): number {
    return other === this.article.body ? 4 : 0;
  }
}

class FakeMention extends FakeNode {
  constructor(
    readonly article: FakeArticle,
    readonly body: FakeBody,
    readonly href: string,
  ) {
    super();
  }
  closest(selector: string): FakeArticle | FakeMention | null {
    if (selector === '[role="article"]') return this.article;
    if (selector.includes('a[role="link"]')) return this;
    return null;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  getAttribute(name: string): string | null {
    return name === "href" ? this.href : null;
  }
}

class FakeAction extends FakeNode {
  constructor(readonly article: FakeArticle) {
    super();
  }
  closest(selector: string): FakeArticle | null {
    return selector === '[role="article"]' ? this.article : null;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  getAttribute(): null {
    return null;
  }
}

class FakeControl extends FakeNode {
  constructor(readonly kind: string) {
    super();
  }
  closest(): null {
    return null;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  getAttribute(): null {
    return null;
  }
}
