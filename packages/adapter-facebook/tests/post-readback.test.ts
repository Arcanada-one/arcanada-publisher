import { describe, expect, it } from "vitest";
import {
  canonicalFacebookPostUrl,
  facebookProfileIdentity,
  normalizeFacebookText,
  readFacebookPost,
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
    await expect(readFacebookPost(fakePage(true) as never, TARGET)).resolves.toMatchObject({
      canonicalPermalink: TARGET,
      normalizedBody: "Title\n\nFull body",
      authorProfileIdentity: "www.facebook.com/pavelvalentov",
      hasImage: true,
      mediaIdentity: "https://www.facebook.com/photo/?fbid=hero",
    });
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
  constructor(
    readonly innerText = "",
    href?: string,
    private readonly one: Record<string, FakeElement | undefined> = {},
    private readonly many: Record<string, FakeElement[]> = {},
  ) {
    if (href) this.href = href;
  }
  closest(selector: string): FakeElement | null {
    return selector === '[role="article"]' ? this.article : null;
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
}

function fakePage(withAttachment: boolean) {
  const articleOne: Record<string, FakeElement | undefined> = {};
  const articleMany: Record<string, FakeElement[]> = {};
  const article = new FakeElement("", undefined, articleOne, articleMany);
  article.article = article;
  const body = new FakeElement("Title\n\nFull body");
  body.article = article;
  const avatar = new FakeElement(
    "Pavel",
    "https://www.facebook.com/pavelvalentov",
    {},
    { img: [new FakeElement()] },
  );
  avatar.article = article;
  avatar.before = body;
  const permalink = new FakeElement("time", TARGET);
  permalink.article = article;
  const photo = new FakeElement(
    "",
    "https://www.facebook.com/photo/?fbid=hero",
    {},
    { img: [new FakeElement()] },
  );
  photo.article = article;
  articleOne['[data-ad-preview="message"], [data-ad-comet-preview="message"]'] = body;
  articleMany["a[href]"] = withAttachment ? [avatar, permalink, photo] : [avatar, permalink];
  const root = new FakeElement("", undefined, {}, { '[role="article"]': [article] });
  return {
    goto: async () => {},
    getByRole: () => ({ count: async () => 0 }),
    locator: () => ({
      evaluate: async (fn: (root: FakeElement, target: string) => unknown, target: string) => {
        const previous = (globalThis as { location?: unknown }).location;
        Object.defineProperty(globalThis, "location", {
          configurable: true,
          value: { href: TARGET },
        });
        try {
          return fn(root, target);
        } finally {
          if (previous === undefined) delete (globalThis as { location?: unknown }).location;
          else
            Object.defineProperty(globalThis, "location", { configurable: true, value: previous });
        }
      },
    }),
  };
}
