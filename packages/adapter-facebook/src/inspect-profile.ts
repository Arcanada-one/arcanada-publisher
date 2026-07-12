import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { launchSession } from "./context.js";

const MAX_SCROLL_LIMIT = 50;

export interface ObservedFacebookComment {
  id: string;
  authorProfileHref: string;
  body: string;
}

export interface ObservedFacebookProfilePost {
  canonicalPermalink: string;
  authorProfileHref: string;
  body: string;
  comments: ObservedFacebookComment[];
}

export interface InspectFacebookProfilePostInput {
  profileUrl: string;
  expectedAuthorProfileUrl: string;
  expectedBody?: string;
  contentExcerpt?: string;
  evidenceDir: string;
  maxScrolls: number;
  profile: string;
}

export interface InspectFacebookCommentSummary {
  id: string;
  authorProfileIdentity: string;
  bodySha256: string;
  bodyLength: number;
}

export interface InspectFacebookProfilePostResult {
  canonicalParentPermalink: string;
  authorProfileIdentity: string;
  postBodySha256: string;
  postBodyLength: number;
  comments: InspectFacebookCommentSummary[];
  coverage: {
    maxScrolls: number;
    scrollsPerformed: number;
    postsInspected: number;
  };
}

export interface InspectFacebookProfileRecorder {
  scanLoadedPosts(page: Page): Promise<ObservedFacebookProfilePost[]>;
  scroll(page: Page, index: number): Promise<void>;
}

export interface InspectFacebookProfileOptions {
  page?: Page;
  profileManager?: ProfileManager;
  headed?: boolean;
  skipTeardown?: boolean;
  __recorder?: InspectFacebookProfileRecorder;
}

export async function inspectFacebookProfilePost(
  input: InspectFacebookProfilePostInput,
  options: InspectFacebookProfileOptions = {},
): Promise<InspectFacebookProfilePostResult> {
  validateInput(input);
  const expectedIdentity = facebookProfileIdentity(input.expectedAuthorProfileUrl);
  if (facebookProfileIdentity(input.profileUrl) !== expectedIdentity) {
    throw verifyError("profile surface does not match expected stable author identity");
  }
  const page = options.page;
  if (page) return runInspection(page, input, expectedIdentity, options.__recorder);

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("facebook", input.profile);
  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runInspection(session.page, input, expectedIdentity, options.__recorder);
  } finally {
    if (!options.skipTeardown) await session.close();
  }
}

async function runInspection(
  page: Page,
  input: InspectFacebookProfilePostInput,
  expectedIdentity: string,
  recorder: InspectFacebookProfileRecorder = defaultRecorder,
): Promise<InspectFacebookProfilePostResult> {
  await page.goto(input.profileUrl);
  const observed = new Map<string, ObservedFacebookProfilePost>();
  let scrollsPerformed = 0;
  for (let pass = 0; pass <= input.maxScrolls; pass += 1) {
    for (const candidate of await recorder.scanLoadedPosts(page)) {
      if (!isStablePostPermalink(candidate.canonicalPermalink)) continue;
      observed.set(candidate.canonicalPermalink, candidate);
    }
    if (pass < input.maxScrolls) {
      await recorder.scroll(page, pass + 1);
      scrollsPerformed += 1;
    }
  }

  const expected = normalizeExact(input.expectedBody ?? input.contentExcerpt!);
  const contentMatches = [...observed.values()].filter((candidate) => {
    const body = normalizeExact(candidate.body);
    return input.expectedBody !== undefined ? body === expected : body.includes(expected);
  });
  const coverage = {
    maxScrolls: input.maxScrolls,
    scrollsPerformed,
    postsInspected: observed.size,
  };
  if (contentMatches.length === 0) {
    throw verifyError(
      `no matching post found after ${coverage.scrollsPerformed} scrolls and ${coverage.postsInspected} inspected posts`,
    );
  }
  const wrongAuthor = contentMatches.some(
    (candidate) => facebookProfileIdentity(candidate.authorProfileHref) !== expectedIdentity,
  );
  if (wrongAuthor) {
    throw verifyError("matching content belongs to a different stable header profile identity");
  }
  if (contentMatches.length !== 1) {
    throw verifyError(
      `expected one matching post, found ${contentMatches.length} after ${coverage.scrollsPerformed} scrolls and ${coverage.postsInspected} inspected posts`,
    );
  }

  const matched = contentMatches[0]!;
  const evidenceDir = resolve(input.evidenceDir);
  const postBodyEvidencePath = join(evidenceDir, "post-body.txt");
  const screenshotPath = join(evidenceDir, "readback.png");
  const comments: InspectFacebookCommentSummary[] = [];
  try {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await chmod(evidenceDir, 0o700);
    await writePrivate(postBodyEvidencePath, matched.body);
    for (const comment of matched.comments) {
      if (!/^\d+$/.test(comment.id)) throw verifyError("observed comment has no numeric id");
      const body = normalizeExact(comment.body);
      const bodyEvidencePath = join(evidenceDir, `comment-${comment.id}.txt`);
      await writePrivate(bodyEvidencePath, comment.body);
      comments.push({
        id: comment.id,
        authorProfileIdentity: facebookProfileIdentity(comment.authorProfileHref),
        bodySha256: sha256(body),
        bodyLength: body.length,
      });
    }
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await chmod(screenshotPath, 0o600);
    await writePrivate(
      join(evidenceDir, "manifest.json"),
      `${JSON.stringify(
        {
          version: 1,
          canonicalParentPermalink: matched.canonicalPermalink,
          authorProfileIdentity: expectedIdentity,
          postBodyEvidencePath,
          screenshotPath,
          comments: matched.comments.map((comment) => ({
            id: comment.id,
            bodyEvidencePath: join(evidenceDir, `comment-${comment.id}.txt`),
          })),
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw verifyError("failed to write private inspection evidence");
  }

  const body = normalizeExact(matched.body);
  return {
    canonicalParentPermalink: matched.canonicalPermalink,
    authorProfileIdentity: expectedIdentity,
    postBodySha256: sha256(body),
    postBodyLength: body.length,
    comments,
    coverage,
  };
}

function validateInput(input: InspectFacebookProfilePostInput): void {
  const hasBody = input.expectedBody !== undefined && input.expectedBody !== "";
  const hasExcerpt = input.contentExcerpt !== undefined && input.contentExcerpt !== "";
  if (hasBody === hasExcerpt) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "inspect-profile-post requires exactly one exact body or explicit content excerpt",
    );
  }
  if (
    !Number.isInteger(input.maxScrolls) ||
    input.maxScrolls < 1 ||
    input.maxScrolls > MAX_SCROLL_LIMIT
  ) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `inspect-profile-post maxScrolls must be an integer from 1 to ${MAX_SCROLL_LIMIT}`,
    );
  }
  if (!input.evidenceDir) {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "inspect-profile-post requires evidenceDir");
  }
}

function normalizeExact(value: string): string {
  return value.normalize("NFKC").replace(/\r\n/g, "\n").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function verifyError(message: string): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, `inspect-profile-post: ${message}`);
}

function facebookProfileIdentity(rawUrl: string): string {
  const parsed = new URL(rawUrl, "https://www.facebook.com");
  if (!/^((www|m)\.)?facebook\.com$/i.test(parsed.hostname)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "inspect-profile-post requires a Facebook profile URL",
    );
  }
  if (parsed.pathname === "/profile.php") {
    const id = parsed.searchParams.get("id");
    if (!id) throw new AdapterError(ErrorCode.INVALID_ARGS, "profile.php requires a stable id");
    return `www.facebook.com/profile.php?id=${id}`;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "inspect-profile-post requires a stable profile URL",
    );
  }
  return `www.facebook.com/${segments[0]!.toLowerCase()}`;
}

function isStablePostPermalink(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!/^((www|m)\.)?facebook\.com$/i.test(parsed.hostname)) return false;
    if (parsed.searchParams.has("comment_id")) return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length >= 3 && segments[1] === "posts" && segments[2] !== "";
  } catch {
    return false;
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

const defaultRecorder: InspectFacebookProfileRecorder = {
  async scanLoadedPosts(page) {
    const expanders = page.getByRole("button", {
      name: /^(See more|Показать ещё|Näytä lisää)$/i,
    });
    const expanderCount = await expanders.count().catch(() => 0);
    for (let index = 0; index < expanderCount; index += 1) {
      await expanders
        .nth(index)
        .click()
        .catch(() => undefined);
    }
    if (expanderCount > 0) await page.waitForTimeout(250);
    return page.locator("body").evaluate((root) => {
      type DomElement = {
        innerText: string;
        href?: string;
        parentElement: DomElement | null;
        closest(selector: string): DomElement | null;
        querySelector(selector: string): DomElement | null;
        querySelectorAll(selector: string): ArrayLike<DomElement> & Iterable<DomElement>;
        compareDocumentPosition(other: DomElement): number;
        getAttribute(name: string): string | null;
      };
      const bodyRoot = root as unknown as DomElement;
      const browserLocation = (globalThis as unknown as { location: { href: string } }).location;
      const isProfileHref = (raw: string | null): boolean => {
        if (!raw) return false;
        try {
          const parsed = new URL(raw, browserLocation.href);
          const segments = parsed.pathname.split("/").filter(Boolean);
          return parsed.pathname === "/profile.php"
            ? parsed.searchParams.has("id")
            : segments.length === 1;
        } catch {
          return false;
        }
      };
      const terminalText = (article: DomElement): DomElement | null => {
        const preferred = article.querySelector(
          '[data-ad-preview="message"], [data-ad-comet-preview="message"]',
        );
        if (preferred && preferred.closest('[role="article"]') === article) return preferred;
        const candidates = Array.from(article.querySelectorAll('[dir="auto"]')).filter(
          (node) =>
            node.closest('[role="article"]') === article &&
            !node.closest('a[role="link"], strong') &&
            !Array.from(node.querySelectorAll('[dir="auto"]')).some(
              (child) => child !== node && child.closest('[role="article"]') === article,
            ) &&
            node.innerText.trim() !== "",
        );
        return candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0] ?? null;
      };
      const authorHref = (article: DomElement, body: DomElement): string | null => {
        for (const anchor of Array.from(article.querySelectorAll('a[role="link"][href]'))) {
          if (anchor.closest('[role="article"]') !== article) continue;
          if ((anchor.compareDocumentPosition(body) & 4) === 0) continue;
          if (!anchor.innerText.trim() && !anchor.getAttribute("aria-label")?.trim()) continue;
          if (anchor.href && isProfileHref(anchor.href)) return anchor.href;
        }
        return null;
      };
      const posts: ObservedFacebookProfilePost[] = [];
      for (const article of Array.from(bodyRoot.querySelectorAll('[role="article"]'))) {
        const permalinkAnchor = Array.from(article.querySelectorAll("a[href]")).find((anchor) => {
          if (anchor.closest('[role="article"]') !== article) return false;
          try {
            if (!anchor.href) return false;
            const parsed = new URL(anchor.href, browserLocation.href);
            const segments = parsed.pathname.split("/").filter(Boolean);
            return (
              !parsed.searchParams.has("comment_id") &&
              segments.length >= 3 &&
              segments[1] === "posts"
            );
          } catch {
            return false;
          }
        });
        if (!permalinkAnchor) continue;
        const body = terminalText(article);
        if (!body) continue;
        const headerHref = authorHref(article, body);
        if (!headerHref) continue;
        const comments = new Map<string, ObservedFacebookComment>();
        for (const anchor of Array.from(article.querySelectorAll('a[href*="comment_id="]'))) {
          const commentArticle = anchor.closest('[role="article"]');
          if (!commentArticle || commentArticle === article) continue;
          if (commentArticle.parentElement?.closest('[role="article"]') !== article) continue;
          if (!anchor.href) continue;
          const id = new URL(anchor.href, browserLocation.href).searchParams.get("comment_id");
          if (!id || comments.has(id)) continue;
          const commentBody = terminalText(commentArticle);
          if (!commentBody) continue;
          const commentAuthor = authorHref(commentArticle, commentBody);
          if (!commentAuthor) continue;
          comments.set(id, {
            id,
            authorProfileHref: commentAuthor,
            body: commentBody.innerText,
          });
        }
        posts.push({
          canonicalPermalink: permalinkAnchor.href!,
          authorProfileHref: headerHref,
          body: body.innerText,
          comments: [...comments.values()],
        });
      }
      return posts;
    });
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
