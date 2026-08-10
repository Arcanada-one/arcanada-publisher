import { describe, expect, it } from "vitest";
import {
  canonicalFacebookPostUrl,
  facebookProfileIdentity,
  normalizeFacebookText,
  readFacebookPost,
  dedupeFacebookPostReadbacks,
  resolveFacebookPostReadbacks,
} from "../src/post-readback.js";

const TARGET = "https://www.facebook.com/pavelvalentov/posts/pfbid123";

describe("Facebook exact post readback primitives", () => {
  it("normalizes only Unicode, CRLF, and terminal whitespace", () => {
    expect(normalizeFacebookText("  Title\r\n\r\nBody  \n")).toBe("Title\n\nBody");
  });

  it("canonicalizes a tracked permalink without accepting another surface", () => {
    expect(
      canonicalFacebookPostUrl(
        "https://www.facebook.com/pavelvalentov/posts/pfbid123?__cft__[0]=tracking",
      ),
    ).toBe("https://www.facebook.com/pavelvalentov/posts/pfbid123");
    expect(() => canonicalFacebookPostUrl("https://example.com/posts/1")).toThrow();
  });

  it("derives only stable Facebook author identities", () => {
    expect(facebookProfileIdentity("https://www.facebook.com/PavelValentov")).toBe(
      "www.facebook.com/pavelvalentov",
    );
    expect(facebookProfileIdentity("https://www.facebook.com/profile.php?id=123")).toBe(
      "www.facebook.com/profile.php?id=123",
    );
    expect(() => facebookProfileIdentity("https://www.facebook.com/a/posts/1")).toThrow();
  });

  it("rejects avatar-only DOM and accepts a post attachment container", async () => {
    await expect(readFacebookPost(fakePage(false) as never, TARGET)).rejects.toMatchObject({
      code: 6,
    });
    await expect(
      readFacebookPost(
        fakePageVariants([
          { media: null, headerPhoto: "https://www.facebook.com/photo/?fbid=avatar" },
        ]) as never,
        TARGET,
      ),
    ).rejects.toMatchObject({ code: 6 });
    await expect(readFacebookPost(fakePage(true) as never, TARGET)).resolves.toMatchObject({
      canonicalPermalink: TARGET,
      normalizedBody: "Title\n\nFull body",
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      hasImage: true,
      mediaIdentity: "https://www.facebook.com/photo/?fbid=hero",
    });
  });

  it("dedupes only fully identical render copies", () => {
    const base = {
      canonicalPermalink: TARGET,
      normalizedBody: "Title\n\nFull body",
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      hasImage: true,
      mediaIdentity: "https://www.facebook.com/photo/?fbid=hero",
    };
    expect(dedupeFacebookPostReadbacks([base, { ...base }])).toEqual(base);
    for (const changed of [
      { canonicalPermalink: `${TARGET}-other` },
      { normalizedBody: "different" },
      { authorProfileIdentity: "www.facebook.com/impostor" },
      { mediaIdentity: "https://www.facebook.com/photo/?fbid=other" },
    ]) {
      expect(() => dedupeFacebookPostReadbacks([base, { ...base, ...changed }])).toThrow(
        /ambiguous target evidence/,
      );
    }
  });

  it("accepts native video readback as media", () => {
    const video = {
      canonicalPermalink: TARGET,
      normalizedBody: "Title\n\nFull body",
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      hasImage: false,
      hasVideo: true,
      mediaIdentity: "https://video.facebook.com/native/123",
    };
    expect(resolveFacebookPostReadbacks([video])).toEqual(video);
  });

  it("dedupes identical multi-article DOM copies and rejects every divergent axis", async () => {
    const same = [{}, {}];
    await expect(readFacebookPost(fakePageVariants(same) as never, TARGET)).resolves.toMatchObject({
      canonicalPermalink: TARGET,
      normalizedBody: "Title\n\nFull body",
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      mediaIdentity: "https://www.facebook.com/photo/?fbid=hero",
    });
    for (const changed of [
      { body: "different" },
      { media: "https://www.facebook.com/photo/?fbid=other" },
      { extraPermalink: "https://www.facebook.com/pavelvalentov/posts/pfbid-other" },
      { media: null },
    ]) {
      await expect(
        readFacebookPost(fakePageVariants([{}, changed]) as never, TARGET),
      ).rejects.toThrow(/ambiguous target evidence/);
    }
  });

  it("selects one full modal over a title preview only when binding evidence matches", async () => {
    const page = fakePageVariants([{ body: "Title" }, { body: "Title\n\nFull body", modal: true }]);
    await expect(readFacebookPost(page as never, TARGET)).resolves.toMatchObject({
      normalizedBody: "Title\n\nFull body",
      canonicalPermalink: TARGET,
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      mediaIdentity: "https://www.facebook.com/photo/?fbid=hero",
    });
    expect(page.actions).toEqual(["expand:0", "expand:1"]);

    for (const mismatch of [
      { media: "https://www.facebook.com/photo/?fbid=other", modal: true },
      { extraPermalink: "https://www.facebook.com/pavelvalentov/posts/other", modal: true },
    ]) {
      await expect(
        readFacebookPost(fakePageVariants([{ body: "Title" }, mismatch]) as never, TARGET),
      ).rejects.toThrow(/modal target binding differs/);
    }
    await expect(
      readFacebookPost(
        fakePageVariants([
          { body: "one", modal: true },
          { body: "two", modal: true },
        ]) as never,
        TARGET,
      ),
    ).rejects.toThrow(/modal copies/);
  });

  it("rejects hidden stale modal and scopes expansion by exact canonical equality", async () => {
    const page = fakePageVariants([
      { body: "Title" },
      { body: "Title\n\nFull body", modal: true, hiddenModal: true },
      { permalink: `${TARGET}4` },
    ]);
    await expect(readFacebookPost(page as never, TARGET)).rejects.toThrow(
      /ambiguous target evidence/,
    );
    expect(page.actions).toEqual(["expand:0", "expand:1"]);
  });

  it("excludes target URLs inside unrelated body and nested comments", async () => {
    const page = fakePageVariants([
      {
        author: "https://www.facebook.com/pimenov",
        permalink: "https://www.facebook.com/pimenov/posts/unrelated-one",
        targetInBody: true,
      },
      {
        author: "https://www.facebook.com/pimenov",
        permalink: "https://www.facebook.com/pimenov/posts/unrelated-two",
        targetInNestedComment: true,
      },
      { body: "Title\n\nFull body", modal: true },
    ]);
    await expect(readFacebookPost(page as never, TARGET)).resolves.toMatchObject({
      canonicalPermalink: TARGET,
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      normalizedBody: "Title\n\nFull body",
    });
    expect(page.actions).toEqual(["expand:2"]);
  });

  it("excludes a shared-post wrapper whose header also links to the target", async () => {
    const page = fakePageVariants([
      {
        author: "https://www.facebook.com/veaceslav.cunev",
        permalink: "https://www.facebook.com/veaceslav.cunev/posts/shared-wrapper",
        extraPermalink: TARGET,
        body: "Outer shared-post commentary",
        media: null,
      },
      { body: "Title\n\nFull body", modal: true },
    ]);
    await expect(readFacebookPost(page as never, TARGET)).resolves.toMatchObject({
      canonicalPermalink: TARGET,
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      normalizedBody: "Title\n\nFull body",
      hasImage: true,
    });
    expect(page.actions).toEqual(["expand:1"]);
  });

  it("does not expand an outer article whose selected message belongs to a nested article", async () => {
    const page = fakePageVariants([
      { messageOwned: false },
      { body: "Title\n\nFull body", modal: true },
    ]);
    await expect(readFacebookPost(page as never, TARGET)).resolves.toMatchObject({
      canonicalPermalink: TARGET,
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      normalizedBody: "Title\n\nFull body",
    });
    expect(page.actions).toEqual(["expand:1"]);
  });
});

class FakeList<T> implements Iterable<T> {
  readonly length: number;
  constructor(private readonly values: T[]) {
    this.length = values.length;
  }
  [Symbol.iterator](): Iterator<T> {
    return this.values[Symbol.iterator]();
  }
}

class FakeElement {
  href?: string;
  article: FakeElement | null = null;
  before: FakeElement | null = null;
  dialog: FakeElement | null = null;
  isConnected = true;
  rect = { width: 100, height: 100 };
  style = { display: "block", visibility: "visible", opacity: "1" };
  attributes: Record<string, string> = {};
  contained = new Set<FakeElement>();
  constructor(
    readonly innerText = "",
    href?: string,
    private readonly one: Record<string, FakeElement | undefined> = {},
    private readonly many: Record<string, FakeElement[]> = {},
  ) {
    if (href) this.href = href;
  }
  closest(selector: string): FakeElement | null {
    if (selector === '[role="article"]') return this.article;
    if (selector === '[role="dialog"]') return this.dialog;
    return null;
  }
  querySelector(selector: string): FakeElement | null {
    return this.one[selector] ?? null;
  }
  querySelectorAll(selector: string): FakeList<FakeElement> {
    return new FakeList(this.many[selector] ?? []);
  }
  compareDocumentPosition(other: FakeElement): number {
    return this.before === other ? 4 : 0;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  contains(child: FakeElement): boolean {
    return this.contained.has(child);
  }
}

function fakePage(withAttachment: boolean) {
  return fakePageVariants([{ media: withAttachment ? undefined : null }]);
}

type ArticleVariant = {
  body?: string;
  author?: string;
  media?: string | null;
  extraPermalink?: string;
  modal?: boolean;
  hiddenModal?: boolean;
  permalink?: string;
  targetInBody?: boolean;
  targetInNestedComment?: boolean;
  messageOwned?: boolean;
  headerPhoto?: string;
};

function fakePageVariants(variants: ArticleVariant[]) {
  const articles = variants.map((variant) => makeArticle(variant));
  const root = new FakeElement("", undefined, {}, { '[role="article"]': articles });
  const actions: string[] = [];
  const withGlobals = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const previousLocation = (globalThis as { location?: unknown }).location;
    const previousStyle = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    Object.defineProperty(globalThis, "location", { configurable: true, value: { href: TARGET } });
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: (node: FakeElement) => node.style,
    });
    try {
      return await fn();
    } finally {
      if (previousLocation === undefined) delete (globalThis as { location?: unknown }).location;
      else
        Object.defineProperty(globalThis, "location", {
          configurable: true,
          value: previousLocation,
        });
      if (previousStyle === undefined)
        delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
      else
        Object.defineProperty(globalThis, "getComputedStyle", {
          configurable: true,
          value: previousStyle,
        });
    }
  };
  const page = {
    actions,
    goto: async () => {},
    locator: (selector: string) =>
      selector === "body"
        ? {
            evaluate: async (fn: (root: FakeElement, target: string) => unknown, target: string) =>
              withGlobals(() => fn(root, target)),
          }
        : {
            count: async () => articles.length,
            nth: (index: number) => ({
              evaluate: async (
                fn: (article: FakeElement, target: string) => unknown,
                target: string,
              ) => withGlobals(() => fn(articles[index]!, target)),
              getByRole: () => ({
                count: async () => 1,
                nth: () => ({
                  click: async () => {
                    actions.push(`expand:${index}`);
                  },
                }),
              }),
            }),
          },
  };
  return page;
}

function makeArticle(variant: ArticleVariant): FakeElement {
  const articleOne: Record<string, FakeElement | undefined> = {};
  const articleMany: Record<string, FakeElement[]> = {};
  const article = new FakeElement("", undefined, articleOne, articleMany);
  article.article = article;
  if (variant.modal) {
    article.dialog = new FakeElement();
    if (variant.hiddenModal) article.dialog.style.display = "none";
  }
  const body = new FakeElement(variant.body ?? "Title\n\nFull body");
  body.article =
    variant.messageOwned === false
      ? Object.assign(new FakeElement(), { article: new FakeElement() })
      : article;
  const avatar = new FakeElement(
    "Pavel",
    variant.author ?? "https://www.facebook.com/pavelvalentov",
    {},
    { img: [new FakeElement()] },
  );
  avatar.article = article;
  avatar.before = body;
  const permalink = new FakeElement("time", variant.permalink ?? TARGET);
  permalink.article = article;
  permalink.before = body;
  const mediaHref =
    variant.media === undefined ? "https://www.facebook.com/photo/?fbid=hero" : variant.media;
  const photo = new FakeElement("", mediaHref ?? undefined, {}, { img: [new FakeElement()] });
  photo.article = article;
  articleOne['[data-ad-preview="message"], [data-ad-comet-preview="message"]'] = body;
  const anchors = [avatar, permalink];
  if (variant.headerPhoto) {
    const headerPhoto = new FakeElement("", variant.headerPhoto, {}, { img: [new FakeElement()] });
    headerPhoto.article = article;
    headerPhoto.before = body;
    anchors.push(headerPhoto);
  }
  if (variant.extraPermalink) {
    const extra = new FakeElement("other", variant.extraPermalink);
    extra.article = article;
    extra.before = body;
    anchors.push(extra);
  }
  if (variant.targetInBody) {
    const bodyLink = new FakeElement("target in body", TARGET);
    bodyLink.article = article;
    body.contained.add(bodyLink);
    anchors.push(bodyLink);
  }
  if (variant.targetInNestedComment) {
    const nestedArticle = new FakeElement();
    nestedArticle.article = nestedArticle;
    const nestedLink = new FakeElement("target in comment", TARGET);
    nestedLink.article = nestedArticle;
    anchors.push(nestedLink);
  }
  if (mediaHref) anchors.push(photo);
  articleMany["a[href]"] = anchors;
  return article;
}
