import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { launchSession } from "./context.js";

const MAX_SCROLL_LIMIT = 50;

export interface ObservedXProfilePost {
  statusId: string;
  canonicalUrl: string;
  authorHandle: string;
  body: string;
  createdAt: string;
  articleIndex: number;
  isReply: boolean;
  relatedStatusIds: string[];
  mediaIdentifiers: string[];
}

export interface InspectXProfilePostInput {
  profileUrl: string;
  expectedAuthorProfileUrl: string;
  expectedBody?: string;
  contentExcerpt?: string;
  evidenceDir: string;
  maxScrolls: number;
  profile: string;
}

export interface InspectXProfilePostResult {
  authorHandle: string;
  posts: InspectXPostSummary[];
  matches: InspectXPostSummary[];
  coverage: { maxScrolls: number; scrollsPerformed: number; postsInspected: number };
}

export interface InspectXPostSummary {
  statusId: string;
  canonicalUrl: string;
  createdAt: string;
  articleIndex: number;
  isReply: boolean;
  bodySha256: string;
  bodyLength: number;
  relatedStatusIds: string[];
  mediaIdentitySha256: string;
  mediaIdentifierCount: number;
}

export interface InspectXProfileRecorder {
  expandOwnPosts?(page: Page, expectedHandle: string): Promise<void>;
  scanLoadedPosts(page: Page): Promise<ObservedXProfilePost[]>;
  scroll(page: Page, index: number): Promise<void>;
}

export interface InspectXProfileOptions {
  page?: Page;
  profileManager?: ProfileManager;
  headed?: boolean;
  skipTeardown?: boolean;
  __recorder?: InspectXProfileRecorder;
}

export async function inspectXProfilePosts(
  input: InspectXProfilePostInput,
  options: InspectXProfileOptions = {},
): Promise<InspectXProfilePostResult> {
  validateInput(input);
  const profileHandle = handleFromProfileUrl(input.profileUrl);
  const expectedHandle = handleFromProfileUrl(input.expectedAuthorProfileUrl);
  if (profileHandle !== expectedHandle) throw verifyError("profile URL and author oracle differ");
  if (options.page)
    return runInspection(
      options.page,
      input,
      expectedHandle,
      options.__recorder ?? defaultRecorder,
    );
  const profiles = options.profileManager ?? new ProfileManager();
  const session = await launchSession({
    profileDir: profiles.ensureProfileExists("x", input.profile),
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runInspection(
      session.page,
      input,
      expectedHandle,
      options.__recorder ?? defaultRecorder,
    );
  } finally {
    if (!options.skipTeardown) await session.close();
  }
}

async function runInspection(
  page: Page,
  input: InspectXProfilePostInput,
  expectedHandle: string,
  recorder: InspectXProfileRecorder,
): Promise<InspectXProfilePostResult> {
  await page.goto(input.profileUrl);
  const observed = new Map<string, ObservedXProfilePost>();
  let scrollsPerformed = 0;
  for (let pass = 0; pass <= input.maxScrolls; pass += 1) {
    await recorder.expandOwnPosts?.(page, expectedHandle);
    for (const post of await recorder.scanLoadedPosts(page)) observed.set(post.statusId, post);
    if (pass < input.maxScrolls) {
      await recorder.scroll(page, pass + 1);
      scrollsPerformed += 1;
    }
  }
  const expected = normalize(input.expectedBody ?? input.contentExcerpt!);
  const matches = [...observed.values()].filter((post) => {
    const body = normalize(post.body);
    return input.expectedBody !== undefined ? body === expected : body.includes(expected);
  });
  if (matches.some((post) => post.authorHandle.toLowerCase() !== expectedHandle))
    throw verifyError("matching content belongs to another author handle");

  const evidenceDir = resolve(input.evidenceDir);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await chmod(evidenceDir, 0o700);
  for (const post of matches)
    await writePrivate(join(evidenceDir, `status-${post.statusId}.txt`), post.body);
  const screenshotPath = join(evidenceDir, "readback.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await chmod(screenshotPath, 0o600);
  const posts = [...observed.values()];
  await writePrivate(
    join(evidenceDir, "manifest.json"),
    `${JSON.stringify({ version: 2, profileHandle: expectedHandle, posts, matches, screenshotPath }, null, 2)}\n`,
  );
  const summarize = (post: ObservedXProfilePost): InspectXPostSummary => ({
    statusId: post.statusId,
    canonicalUrl: post.canonicalUrl,
    createdAt: post.createdAt,
    articleIndex: post.articleIndex,
    isReply: post.isReply,
    bodySha256: sha256(normalize(post.body)),
    bodyLength: normalize(post.body).length,
    relatedStatusIds: post.relatedStatusIds,
    mediaIdentitySha256: sha256([...post.mediaIdentifiers].sort().join("\n")),
    mediaIdentifierCount: post.mediaIdentifiers.length,
  });
  return {
    authorHandle: expectedHandle,
    posts: posts.map(summarize),
    matches: matches.map(summarize),
    coverage: { maxScrolls: input.maxScrolls, scrollsPerformed, postsInspected: observed.size },
  };
}

export function extractObservedXPostsFromDom(
  rawArticles: unknown[],
  baseHref: string,
): ObservedXProfilePost[] {
  type DomNode = {
    innerText?: string;
    textContent?: string | null;
    closest(selector: string): DomNode | null;
    querySelectorAll(selector: string): DomNode[];
    getAttribute(name: string): string | null;
    parentElement?: DomNode | null;
  };
  const articles = (rawArticles as DomNode[]).filter((article) => {
    const ancestorArticle = article.parentElement?.closest("article");
    return ancestorArticle === null || ancestorArticle === undefined;
  });
  return articles.flatMap((article, articleIndex) => {
    const time = [...article.querySelectorAll("time[datetime]")].find(
      (candidate) => candidate.closest("article") === article,
    );
    const permalink = time?.closest('a[href*="/status/"]');
    const href = permalink?.getAttribute("href");
    if (!time || !href || permalink?.closest("article") !== article) return [];
    const absolute = new URL(href, baseHref);
    const match = /^\/([^/]+)\/status\/(\d+)/.exec(absolute.pathname);
    if (!match) return [];
    const bodyNode = [...article.querySelectorAll('[data-testid="tweetText"]')].find(
      (candidate) => candidate.closest("article") === article,
    );
    const body =
      (bodyNode as unknown as { innerText?: string } | null)?.innerText ??
      bodyNode?.textContent ??
      "";
    const relatedStatusIds = [...article.querySelectorAll('a[href*="/status/"]')].flatMap(
      (anchor) => {
        const candidate = /\/status\/(\d+)/.exec(anchor.getAttribute("href") ?? "");
        return candidate?.[1] && candidate[1] !== match[2] ? [candidate[1]] : [];
      },
    );
    const stableMediaUrl = (raw: string): string => {
      if (!raw || raw.startsWith("blob:")) return "";
      try {
        const url = new URL(raw, baseHref);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "";
      }
    };
    const mediaIdentifiers = [
      ...[...article.querySelectorAll('a[href*="/photo/"], a[href*="/video/"]')]
        .filter((anchor) => anchor.closest("article") === article)
        .map((anchor) => stableMediaUrl(anchor.getAttribute("href") ?? "")),
      ...[...article.querySelectorAll("video")]
        .filter((video) => video.closest("article") === article)
        .map((video) => stableMediaUrl(video.getAttribute("poster") ?? "")),
      ...[...article.querySelectorAll('img[src*="/media/"], img[src*="/ext_tw_video_thumb/"]')]
        .filter((image) => image.closest("article") === article)
        .map((image) => stableMediaUrl(image.getAttribute("src") ?? "")),
    ].filter(Boolean);
    return [
      {
        statusId: match[2],
        canonicalUrl: `https://x.com/${match[1]}/status/${match[2]}`,
        authorHandle: match[1],
        body,
        createdAt: time.getAttribute("datetime") ?? "",
        articleIndex,
        isReply: [...article.querySelectorAll("div, span")].some(
          (candidate) =>
            candidate.closest("article") === article &&
            /^(Replying to|В ответ)/i.test(
              ((candidate as unknown as { innerText?: string }).innerText ?? "").trim(),
            ),
        ),
        relatedStatusIds: [...new Set(relatedStatusIds)],
        mediaIdentifiers: [...new Set(mediaIdentifiers)],
      },
    ];
  });
}

export const defaultRecorder: InspectXProfileRecorder = {
  async expandOwnPosts(page, expectedHandle) {
    const articles = page.locator("article");
    for (let index = 0, count = await articles.count(); index < count; index += 1) {
      const article = articles.nth(index);
      const owned = await article.evaluate((articleNode, handle) => {
        if (articleNode.parentElement?.closest("article")) return false;
        const time = [...articleNode.querySelectorAll("time[datetime]")].find(
          (candidate) => candidate.closest("article") === articleNode,
        );
        const href = time?.closest("a[href]")?.getAttribute("href");
        if (!href) return false;
        const match = /^\/([^/]+)\/status\/\d+/.exec(
          new URL(href, (globalThis as unknown as { location: { href: string } }).location.href)
            .pathname,
        );
        return match?.[1]?.toLowerCase() === handle;
      }, expectedHandle);
      if (!owned) continue;
      let expanders = article.locator('[data-testid="tweet-text-show-more-link"]');
      if ((await expanders.count()) === 0) {
        expanders = article.getByText(/^(Show more|Показать ещё|Показать больше)$/i, {
          exact: true,
        });
      }
      for (let button = 0, count = await expanders.count(); button < count; button += 1) {
        const expander = expanders.nth(button);
        const belongsToTopLevelArticle = await expander.evaluate((node) => {
          const owner = node.closest("article");
          return owner !== null && !owner.parentElement?.closest("article");
        });
        if (belongsToTopLevelArticle)
          await expander.click({ force: true, timeout: 2_000 }).catch(() => undefined);
      }
    }
  },
  async scanLoadedPosts(page) {
    return page.locator("article").evaluateAll(extractObservedXPostsFromDom, page.url());
  },
  async scroll(page) {
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        scrollTo(x: number, y: number): void;
        document: { body: { scrollHeight: number } };
      };
      browser.scrollTo(0, browser.document.body.scrollHeight);
    });
    await page.waitForTimeout(1_000);
  },
};

function validateInput(input: InspectXProfilePostInput): void {
  const hasBody = Boolean(input.expectedBody);
  const hasExcerpt = Boolean(input.contentExcerpt);
  if (hasBody === hasExcerpt)
    throw new AdapterError(ErrorCode.INVALID_ARGS, "x inspect requires exact body or excerpt");
  if (
    !Number.isInteger(input.maxScrolls) ||
    input.maxScrolls < 1 ||
    input.maxScrolls > MAX_SCROLL_LIMIT
  )
    throw new AdapterError(ErrorCode.INVALID_ARGS, "x inspect maxScrolls must be 1..50");
}

function handleFromProfileUrl(raw: string): string {
  const url = new URL(raw);
  if (!new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]).has(url.hostname))
    throw new AdapterError(ErrorCode.INVALID_ARGS, "x inspect requires an X profile URL");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) throw new AdapterError(ErrorCode.INVALID_ARGS, "invalid X profile URL");
  return parts[0]!.toLowerCase();
}
function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\r\n/g, "\n").trim();
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function verifyError(message: string): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, `x inspect-profile-post: ${message}`);
}
async function writePrivate(path: string, body: string): Promise<void> {
  const file = await open(path, "w", 0o600);
  try {
    await file.writeFile(body, "utf8");
  } finally {
    await file.close();
  }
  await chmod(path, 0o600);
}
