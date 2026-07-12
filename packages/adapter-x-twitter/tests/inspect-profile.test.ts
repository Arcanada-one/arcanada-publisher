import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import {
  extractObservedXPostsFromDom,
  inspectXProfilePosts,
  type InspectXProfileRecorder,
  type ObservedXProfilePost,
} from "../src/inspect-profile.js";

const BODY = "Exact campaign body";
const canonical = (
  id: string,
  overrides: Partial<ObservedXProfilePost> = {},
): ObservedXProfilePost => ({
  statusId: id,
  canonicalUrl: `https://x.com/VeritasArcanaAI/status/${id}`,
  authorHandle: "veritasarcanaai",
  body: BODY,
  createdAt: "2026-07-12T01:00:00.000Z",
  articleIndex: 0,
  isReply: false,
  relatedStatusIds: [],
  mediaIdentifiers: [`https://video.twimg.com/${id}.mp4`],
  ...overrides,
});

function page() {
  return {
    goto: async () => {},
    screenshot: async ({ path }: { path: string }) => writeFileSync(path, ""),
  } as never;
}

function recorder(posts: ObservedXProfilePost[]): InspectXProfileRecorder {
  return { scanLoadedPosts: async () => posts, scroll: async () => {} };
}

describe("X profile duplicate inventory", () => {
  it("uses the production recorder to expand only the own direct article before collecting its oracle", async () => {
    const fullBody = "Title\n\nFull body that was hidden behind Show more";
    const browser = await chromium.launch({ headless: true });
    try {
      const browserPage = await browser.newPage();
      await browserPage.route("https://x.com/**", async (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `
            <article id="own">
              <a href="/VeritasArcanaAI/status/123"><time datetime="2026-07-12T01:00:00.000Z"></time></a>
              <div data-testid="tweetText" id="own-text">Title\n\nFull body…</div>
              <button id="own-more" data-testid="tweet-text-show-more-link"
                onclick='this.dataset.clicked="yes"; document.querySelector("#own-text").innerText=${JSON.stringify(fullBody)}'>
                Show more
              </button>
              <article id="nested">
                <a href="/VeritasArcanaAI/status/999"><time datetime="2026-07-11T01:00:00.000Z"></time></a>
                <div data-testid="tweetText">Nested truncated…</div>
                <button id="nested-more" data-testid="tweet-text-show-more-link"
                  onclick="this.dataset.clicked='yes'">Show more</button>
              </article>
            </article>
            <article id="foreign">
              <a href="/Other/status/456"><time datetime="2026-07-10T01:00:00.000Z"></time></a>
              <div data-testid="tweetText">Foreign truncated…</div>
              <button id="foreign-more" data-testid="tweet-text-show-more-link"
                onclick="this.dataset.clicked='yes'">Show more</button>
            </article>`,
        }),
      );
      const result = await inspectXProfilePosts(
        {
          profileUrl: "https://x.com/VeritasArcanaAI",
          expectedAuthorProfileUrl: "https://x.com/VeritasArcanaAI",
          expectedBody: fullBody,
          evidenceDir: mkdtempSync(join(tmpdir(), "x-inspect-expanded-")),
          maxScrolls: 1,
          profile: "default",
        },
        { page: browserPage },
      );
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({ statusId: "123", bodyLength: fullBody.length });
      expect(await browserPage.locator("#own-more").getAttribute("data-clicked")).toBe("yes");
      expect(await browserPage.locator("#nested-more").getAttribute("data-clicked")).toBeNull();
      expect(await browserPage.locator("#foreign-more").getAttribute("data-clicked")).toBeNull();
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("extracts only direct article body/media and drops blob/nested quote evidence", () => {
    const outer = new FakeNode();
    outer.article = outer;
    const nested = new FakeNode();
    nested.article = nested;
    nested.parentElement = outer;
    const permalink = new FakeNode({ href: "/VeritasArcanaAI/status/123" });
    permalink.article = outer;
    const time = new FakeNode({ datetime: "2026-07-12T01:00:00.000Z" });
    time.article = outer;
    time.parentLink = permalink;
    const nestedTime = new FakeNode({ datetime: "old" });
    nestedTime.article = nested;
    const nestedPermalink = new FakeNode({ href: "/VeritasArcanaAI/status/999" });
    nestedPermalink.article = nested;
    nestedTime.parentLink = nestedPermalink;
    const body = new FakeNode({}, "Exact campaign body");
    body.article = outer;
    const nestedBody = new FakeNode({}, "Exact campaign body");
    nestedBody.article = nested;
    const mediaLink = new FakeNode({ href: "/VeritasArcanaAI/status/123/video/1" });
    mediaLink.article = outer;
    const outerImage = new FakeNode({ src: "https://pbs.twimg.com/media/outer.jpg?format=jpg" });
    outerImage.article = outer;
    const nestedImage = new FakeNode({ src: "https://pbs.twimg.com/media/nested.jpg" });
    nestedImage.article = nested;
    const blobVideo = new FakeNode({ src: "blob:https://x.com/unstable" });
    blobVideo.article = outer;
    outer.many = {
      "time[datetime]": [nestedTime, time],
      '[data-testid="tweetText"]': [nestedBody, body],
      'a[href*="/status/"]': [permalink, mediaLink, nestedPermalink],
      'a[href*="/photo/"], a[href*="/video/"]': [mediaLink],
      video: [blobVideo],
      'img[src*="/media/"], img[src*="/ext_tw_video_thumb/"]': [nestedImage, outerImage],
      "div, span": [],
    };

    nested.many = {
      "time[datetime]": [nestedTime],
      '[data-testid="tweetText"]': [nestedBody],
      'a[href*="/status/"]': [nestedPermalink],
      'a[href*="/photo/"], a[href*="/video/"]': [],
      video: [],
      'img[src*="/media/"], img[src*="/ext_tw_video_thumb/"]': [nestedImage],
      "div, span": [],
    };
    const posts = extractObservedXPostsFromDom([outer, nested] as never, "https://x.com/profile");
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post).toMatchObject({ statusId: "123", body: "Exact campaign body" });
    expect(post?.relatedStatusIds).toEqual(["999"]);
    expect(post?.mediaIdentifiers).toEqual([
      "https://x.com/VeritasArcanaAI/status/123/video/1",
      "https://pbs.twimg.com/media/outer.jpg",
    ]);
  });

  it("returns every exact own-body match with stable status/time/media/relation metadata", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "x-inspect-"));
    const result = await inspectXProfilePosts(
      {
        profileUrl: "https://x.com/VeritasArcanaAI",
        expectedAuthorProfileUrl: "https://x.com/VeritasArcanaAI",
        expectedBody: BODY,
        evidenceDir,
        maxScrolls: 1,
        profile: "default",
      },
      {
        page: page(),
        __recorder: recorder([
          canonical("2076136745746272281"),
          canonical("2076136799106224156", {
            articleIndex: 1,
            isReply: true,
            relatedStatusIds: ["2076136745746272281"],
          }),
          canonical("2076137000000000000"),
          canonical("999", { body: "other cycle" }),
        ]),
      },
    );
    expect(result.matches.map((post) => post.statusId)).toEqual([
      "2076136745746272281",
      "2076136799106224156",
      "2076137000000000000",
    ]);
    expect(result.posts.map((post) => post.statusId)).toEqual([
      "2076136745746272281",
      "2076136799106224156",
      "2076137000000000000",
      "999",
    ]);
    expect(result.matches[1]).toMatchObject({
      articleIndex: 1,
      isReply: true,
      relatedStatusIds: ["2076136745746272281"],
      mediaIdentifierCount: 1,
    });
  });

  it("fails closed when matching content is attributed to another handle", async () => {
    await expect(
      inspectXProfilePosts(
        {
          profileUrl: "https://x.com/VeritasArcanaAI",
          expectedAuthorProfileUrl: "https://x.com/VeritasArcanaAI",
          expectedBody: BODY,
          evidenceDir: mkdtempSync(join(tmpdir(), "x-inspect-")),
          maxScrolls: 1,
          profile: "default",
        },
        { page: page(), __recorder: recorder([canonical("1", { authorHandle: "impostor" })]) },
      ),
    ).rejects.toThrow(/another author/);
  });
});

class FakeNode {
  article: FakeNode | null = null;
  parentLink: FakeNode | null = null;
  parentElement: FakeNode | null = null;
  many: Record<string, FakeNode[]> = {};
  textContent: string;
  innerText: string;
  constructor(
    private readonly attributes: Record<string, string> = {},
    text = "",
  ) {
    this.textContent = text;
    this.innerText = text;
  }
  closest(selector: string): FakeNode | null {
    if (selector === "article") return this.article;
    if (selector.includes("a[href")) return this.parentLink;
    return null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.many[selector] ?? [];
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}
