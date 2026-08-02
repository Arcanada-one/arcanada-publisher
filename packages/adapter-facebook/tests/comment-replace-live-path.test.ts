import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { replaceCommentText } from "../src/comment.js";

const PARENT = "https://www.facebook.com/pavelvalentov/posts/pfbid-target";
const OLD_ID = "1326931196274132";
const AUTHOR_PROFILE = "https://www.facebook.com/pavelvalentov";

function profiles(): ProfileManager {
  const root = mkdtempSync(join(tmpdir(), "fb-comment-live-dom-"));
  mkdirSync(join(root, "facebook", "default"), { recursive: true });
  return new ProfileManager({ root });
}

describe("Facebook replace-comment live DOM path", () => {
  it("uses only the exact comment body/author/container and returns a novel post-submit id", async () => {
    const page = new FakePage();
    const result = await replaceCommentText(input(), {
      profileManager: profiles(),
      page: page.asPage(),
    });

    expect(result.commentId).toBe("9000000000000001");
    expect(page.outerActionClicks).toBe(1);
    expect(page.nestedActionClicks).toBe(0);
    expect(page.preSubmitIds).toEqual(["7000000000000001"]);
  });

  it("refuses before confirmation when an impostor comment has Pavel's timestamp permalink", async () => {
    const page = new FakePage({ oldAuthorProfileUrl: "https://www.facebook.com/impostor" });
    await expect(
      replaceCommentText(input(), { profileManager: profiles(), page: page.asPage() }),
    ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(page.confirmClicks).toBe(0);
  });

  it("returns UNKNOWN when a post-create impostor has Pavel's timestamp permalink", async () => {
    const page = new FakePage({ newAuthorProfileUrl: "https://www.facebook.com/impostor" });
    await expect(
      replaceCommentText(input(), { profileManager: profiles(), page: page.asPage() }),
    ).rejects.toMatchObject({
      details: {
        unknown: true,
        reconcileRequired: true,
        newCommentIds: ["9000000000000001"],
      },
    });
    expect(page.confirmClicks).toBe(1);
  });

  it("returns UNKNOWN after confirm when detach cannot be proven", async () => {
    const page = new FakePage({ detachFails: true });
    await expect(
      replaceCommentText(input(), { profileManager: profiles(), page: page.asPage() }),
    ).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
      details: {
        unknown: true,
        reconcileRequired: true,
        oldCommentId: OLD_ID,
        newCommentIds: [],
      },
    });
    expect(page.confirmClicks).toBe(1);
  });

  it("UNKNOWN evidence contains only hashes/lengths and never full comment content", async () => {
    const secretOld = "OLD_SECRET_DO_NOT_LEAK";
    const secretNew = "NEW_SECRET_DO_NOT_LEAK";
    const page = new FakePage({ detachFails: true, oldBody: secretOld });
    let error: unknown;
    try {
      await replaceCommentText(input({ oldText: secretOld, text: secretNew }), {
        profileManager: profiles(),
        page: page.asPage(),
      });
    } catch (caught) {
      error = caught;
    }
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(secretOld);
    expect(serialized).not.toContain(secretNew);
    expect(serialized).toMatch(/expectedOldTextSha256/);
    expect(serialized).toMatch(/replacementTextSha256/);
    expect(serialized).toMatch(/expectedOldTextLength/);
    expect(serialized).toMatch(/replacementTextLength/);
  });

  it("returns UNKNOWN and all observed novel ids when post-submit proof is ambiguous", async () => {
    const page = new FakePage({ newIds: ["9000000000000001", "9000000000000002"] });
    await expect(
      replaceCommentText(input(), { profileManager: profiles(), page: page.asPage() }),
    ).rejects.toMatchObject({
      code: ErrorCode.VERIFY_FAILED,
      details: {
        unknown: true,
        reconcileRequired: true,
        oldCommentId: OLD_ID,
        newCommentIds: ["9000000000000001", "9000000000000002"],
      },
    });
  });
});

function input(overrides: Partial<ReturnType<typeof baseInput>> = {}) {
  return { ...baseInput(), ...overrides };
}

function baseInput() {
  return {
    parentPostUrl: PARENT,
    commentId: OLD_ID,
    expectedAuthorProfileUrl: AUTHOR_PROFILE,
    oldText: "old exact body\nhttps://arcanada.ai/old",
    text: "new exact body\nhttps://arcanada.ai/new",
    profile: "default",
  };
}

interface FakePageOptions {
  oldAuthorProfileUrl?: string;
  newAuthorProfileUrl?: string;
  oldBody?: string;
  detachFails?: boolean;
  newIds?: string[];
}

class FakePage {
  readonly parent = PARENT;
  readonly options: FakePageOptions;
  articles: FakeArticle[];
  typed = "";
  outerActionClicks = 0;
  nestedActionClicks = 0;
  confirmClicks = 0;
  preSubmitIds: string[] = [];

  constructor(options: FakePageOptions = {}) {
    this.options = options;
    const nested = new FakeArticle(
      "8000000000000001",
      "https://www.facebook.com/nested-author",
      "old exact body\nhttps://arcanada.ai/old",
      "nested",
    );
    const old = new FakeArticle(
      OLD_ID,
      options.oldAuthorProfileUrl ?? AUTHOR_PROFILE,
      options.oldBody ?? "old exact body\nhttps://arcanada.ai/old",
      "outer",
      [nested],
    );
    const unrelated = new FakeArticle(
      "7000000000000001",
      AUTHOR_PROFILE,
      "unrelated existing comment",
      "unrelated",
    );
    this.articles = [old, unrelated];
  }

  asPage() {
    const self = this;
    return {
      goto: async () => {},
      url: () => self.parent,
      // PUB-0039: Facebook renders the kebab's entries as role="button" inside a
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
        if (role === "textbox") return new FakeLocator(self, [new FakeControl("composer")]);
        return new FakeLocator(self, []);
      },
      keyboard: {
        insertText: async (value: string) => {
          self.typed += value;
        },
        press: async (key: string) => {
          if (key === "Shift+Enter") self.typed += "\n";
          if (key === "Enter") {
            self.preSubmitIds = self.allArticles().map((article) => article.id);
            for (const id of self.options.newIds ?? ["9000000000000001"]) {
              self.articles.push(
                new FakeArticle(
                  id,
                  self.options.newAuthorProfileUrl ?? AUTHOR_PROFILE,
                  self.typed,
                  "new",
                ),
              );
            }
          }
        },
      },
      waitForTimeout: async () => {},
      isClosed: () => false,
      screenshot: async () => {},
    } as unknown as import("playwright").Page;
  }

  allArticles(): FakeArticle[] {
    return this.articles.flatMap((article) => [article, ...article.nested]);
  }

  removeOld(): void {
    if (!this.options.detachFails)
      this.articles = this.articles.filter((article) => article.id !== OLD_ID);
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
      this.page.removeOld();
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
  querySelector(selector: string): FakeNode | null {
    return selector === '[role="article"]' ? null : null;
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
