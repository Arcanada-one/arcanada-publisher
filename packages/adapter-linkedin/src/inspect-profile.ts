import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { launchSession } from "./context.js";

const MAX_SCROLL_LIMIT = 50;

export interface ObservedLinkedInProfilePost {
  activityUrl: string;
  vanityPermalink: string;
  authorProfileHref: string;
  body: string;
  hasNativeVideo: boolean;
}

export interface InspectLinkedInProfilePostInput {
  profileUrl: string;
  expectedAuthorProfileUrl: string;
  expectedBody?: string;
  contentExcerpt?: string;
  evidenceDir: string;
  maxScrolls: number;
  profile: string;
}

export interface InspectLinkedInProfilePostResult {
  canonicalParentPermalink: string;
  activityUrl: string;
  activityId: string;
  authorProfileIdentity: string;
  postBodySha256: string;
  postBodyLength: number;
  hasNativeVideo: true;
  coverage: { maxScrolls: number; scrollsPerformed: number; postsInspected: number };
}

export interface InspectLinkedInProfileRecorder {
  scanLoadedPosts(
    page: Page,
    expectedAuthorIdentity: string,
    expectedTitle: string,
  ): Promise<ObservedLinkedInProfilePost[]>;
  scroll(page: Page, index: number): Promise<void>;
}

export interface InspectLinkedInProfilePostOptions {
  page?: Page;
  profileManager?: ProfileManager;
  headed?: boolean;
  skipTeardown?: boolean;
  __recorder?: InspectLinkedInProfileRecorder;
}

export async function inspectLinkedInProfilePost(
  input: InspectLinkedInProfilePostInput,
  options: InspectLinkedInProfilePostOptions = {},
): Promise<InspectLinkedInProfilePostResult> {
  validateInput(input);
  const expectedIdentity = linkedInProfileIdentity(input.expectedAuthorProfileUrl);
  if (linkedInProfileIdentity(input.profileUrl) !== expectedIdentity) {
    throw verifyError("profile surface does not match expected author identity");
  }
  if (options.page) return runInspection(options.page, input, expectedIdentity, options.__recorder);

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);
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
  input: InspectLinkedInProfilePostInput,
  expectedIdentity: string,
  recorder: InspectLinkedInProfileRecorder = defaultRecorder,
): Promise<InspectLinkedInProfilePostResult> {
  const activitySurface = `${input.profileUrl.replace(/\/$/, "")}/recent-activity/all/`;
  await page.goto(activitySurface, { waitUntil: "domcontentloaded" });
  const observed = new Map<string, ObservedLinkedInProfilePost>();
  const expected = normalizeExact(input.expectedBody ?? input.contentExcerpt!);
  if (recorder === defaultRecorder) defaultRecorder.expansionClickCounts.length = 0;
  let scrollsPerformed = 0;
  for (let pass = 0; pass <= input.maxScrolls; pass += 1) {
    for (const candidate of await recorder.scanLoadedPosts(
      page,
      expectedIdentity,
      expected.split("\n", 1)[0]!,
    )) {
      if (!activityId(candidate.activityUrl)) continue;
      observed.set(candidate.activityUrl, candidate);
    }
    if (pass < input.maxScrolls) {
      await recorder.scroll(page, pass + 1);
      scrollsPerformed += 1;
    }
  }
  const matches = [...observed.values()].filter((candidate) => {
    const body = normalizeExact(candidate.body);
    return input.expectedBody !== undefined ? body === expected : body.includes(expected);
  });
  const coverage = {
    maxScrolls: input.maxScrolls,
    scrollsPerformed,
    postsInspected: observed.size,
  };
  const fail = async (message: string): Promise<never> => {
    await writeFailureEvidence(
      page,
      input.evidenceDir,
      [...observed.values()],
      recorder === defaultRecorder ? defaultRecorder.expansionClickCounts : [],
    );
    throw verifyError(message);
  };
  if (matches.length === 0) {
    return fail(
      `no matching post found after ${coverage.scrollsPerformed} scrolls and ${coverage.postsInspected} inspected posts`,
    );
  }
  if (
    matches.some(
      (candidate) => safeLinkedInProfileIdentity(candidate.authorProfileHref) !== expectedIdentity,
    )
  ) {
    return fail("matching content belongs to a different author identity");
  }
  if (matches.length !== 1) return fail(`expected one matching post, found ${matches.length}`);
  const matched = matches[0]!;
  if (!matched.hasNativeVideo) return fail("exact post match has no native video");
  const id = activityId(matched.activityUrl);
  if (!id) return fail("exact post match has no activity id");
  if (!isVanityPermalink(matched.vanityPermalink, id)) {
    return fail("exact post match has no bound vanity permalink");
  }

  const evidenceDir = resolve(input.evidenceDir);
  const bodyPath = join(evidenceDir, "post-body.txt");
  const screenshotPath = join(evidenceDir, "readback.png");
  try {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await chmod(evidenceDir, 0o700);
    await writePrivate(bodyPath, matched.body);
    const screenshot = await page.screenshot({ fullPage: true });
    await writePrivate(screenshotPath, screenshot);
    await writePrivate(
      join(evidenceDir, "manifest.json"),
      `${JSON.stringify(
        {
          version: 1,
          canonicalParentPermalink: matched.vanityPermalink,
          activityUrl: matched.activityUrl,
          activityId: id,
          authorProfileIdentity: expectedIdentity,
          hasNativeVideo: true,
          postBodyEvidencePath: bodyPath,
          screenshotPath,
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
    canonicalParentPermalink: matched.vanityPermalink,
    activityUrl: matched.activityUrl,
    activityId: id,
    authorProfileIdentity: expectedIdentity,
    postBodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    postBodyLength: body.length,
    hasNativeVideo: true,
    coverage,
  };
}

function validateInput(input: InspectLinkedInProfilePostInput): void {
  const hasBody = input.expectedBody !== undefined && input.expectedBody !== "";
  const hasExcerpt = input.contentExcerpt !== undefined && input.contentExcerpt !== "";
  if (hasBody === hasExcerpt) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "inspect-profile-post requires one content oracle",
    );
  }
  if (
    !Number.isInteger(input.maxScrolls) ||
    input.maxScrolls < 1 ||
    input.maxScrolls > MAX_SCROLL_LIMIT
  ) {
    throw new AdapterError(ErrorCode.INVALID_ARGS, "inspect-profile-post maxScrolls must be 1..50");
  }
  if (!input.evidenceDir)
    throw new AdapterError(ErrorCode.MISSING_INPUT, "inspect-profile-post requires evidenceDir");
}

function linkedInProfileIdentity(rawUrl: string): string {
  const parsed = new URL(rawUrl, "https://www.linkedin.com");
  if (!/^(www\.)?linkedin\.com$/i.test(parsed.hostname)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "inspect-profile-post requires a LinkedIn profile URL",
    );
  }
  const match = /^\/in\/([^/]+)\/?$/.exec(parsed.pathname);
  if (!match)
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "inspect-profile-post requires a stable /in/ profile URL",
    );
  return `www.linkedin.com/in/${match[1]!.toLowerCase()}`;
}

function safeLinkedInProfileIdentity(rawUrl: string): string {
  try {
    return linkedInProfileIdentity(rawUrl);
  } catch {
    return "invalid";
  }
}

function activityId(rawUrl: string): string | null {
  return (
    /^https:\/\/(?:www\.)?linkedin\.com\/feed\/update\/urn:li:activity:(\d+)\/?$/.exec(
      rawUrl,
    )?.[1] ?? null
  );
}

function isVanityPermalink(rawUrl: string, id: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      /^(www\.)?linkedin\.com$/i.test(parsed.hostname) &&
      parsed.pathname.startsWith("/posts/") &&
      parsed.pathname.includes(`-${id}-`)
    );
  } catch {
    return false;
  }
}

function normalizeExact(value: string): string {
  return value.normalize("NFKC").replace(/\r\n/g, "\n").trim();
}

function verifyError(message: string): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, `inspect-profile-post: ${message}`);
}

async function writePrivate(path: string, content: string | Uint8Array): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function writeFailureEvidence(
  page: Page,
  rawEvidenceDir: string,
  candidates: ObservedLinkedInProfilePost[],
  expansionClickCounts: number[],
): Promise<void> {
  const evidenceDir = resolve(rawEvidenceDir);
  try {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await chmod(evidenceDir, 0o700);
    const summaries = [];
    for (const candidate of candidates) {
      const id = activityId(candidate.activityUrl) ?? "unknown";
      const body = normalizeExact(candidate.body);
      await writePrivate(join(evidenceDir, `candidate-${id}-body.txt`), candidate.body);
      summaries.push({
        activityId: id,
        bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
        bodyLength: body.length,
        authorProfileIdentity: safeLinkedInProfileIdentity(candidate.authorProfileHref),
        hasNativeVideo: candidate.hasNativeVideo,
        vanityPermalink: candidate.vanityPermalink,
      });
    }
    const expanders = await page.locator("body").evaluate(inspectLinkedInExpanders);
    const screenshot = await page.screenshot({ fullPage: true });
    await writePrivate(join(evidenceDir, "failure-readback.png"), screenshot);
    await writePrivate(
      join(evidenceDir, "failure-manifest.json"),
      `${JSON.stringify(
        { version: 1, candidates: summaries, expanders, expansionClickCounts },
        null,
        2,
      )}\n`,
    );
  } catch {
    throw verifyError("failed to write private failure evidence");
  }
}

const defaultRecorder: InspectLinkedInProfileRecorder & { expansionClickCounts: number[] } = {
  expansionClickCounts: [],
  async scanLoadedPosts(page, expectedAuthorIdentity, expectedTitle) {
    const expanded = await page.locator("body").evaluate(expandMatchingLinkedInActivity, {
      expectedAuthorIdentity,
      expectedTitle,
    });
    defaultRecorder.expansionClickCounts.push(expanded);
    if (expanded > 0) await page.waitForTimeout(500);
    return page.locator("body").evaluate(extractLinkedInProfilePosts);
  },
  async scroll(page) {
    await page.evaluate("window.scrollBy(0, Math.max(window.innerHeight, 900))");
    await page.waitForTimeout(1_500);
  },
};

interface BrowserNode {
  innerText: string;
  href?: string;
  parentElement: BrowserNode | null;
  tagName: string;
  className: string;
  textContent?: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<BrowserNode>;
  click?(): void;
}

export function inspectLinkedInExpanders(
  root: BrowserNode,
): Array<{ activityId: string; labels: string[] }> {
  const containers = Array.from(
    root.querySelectorAll("[data-urn*='urn:li:activity'], [data-id*='urn:li:activity']"),
  );
  return containers.map((container) => {
    const raw = container.getAttribute("data-urn") ?? container.getAttribute("data-id") ?? "";
    const id = /urn:li:activity:(\d+)/.exec(raw)?.[1] ?? "unknown";
    const labels = Array.from(container.querySelectorAll("button")).map((button) =>
      (button.getAttribute("aria-label") ?? button.innerText ?? button.textContent ?? "")
        .normalize("NFKC")
        .trim()
        .toLowerCase(),
    );
    return { activityId: id, labels };
  });
}

/** Expand only the direct-owned collapse control of the expected author/title
 * activity. Plain `more` is the live 2026 LinkedIn label; broad page-level
 * button clicks are forbidden because they can mutate unrelated feed items. */
export function expandMatchingLinkedInActivity(
  root: BrowserNode,
  expected: { expectedAuthorIdentity: string; expectedTitle: string },
): number {
  const containers = Array.from(
    root.querySelectorAll("[data-urn*='urn:li:activity'], [data-id*='urn:li:activity']"),
  );
  const isBoundary = (node: BrowserNode): boolean => {
    const raw = node.getAttribute("data-urn") ?? node.getAttribute("data-id") ?? "";
    return (
      /urn:li:activity:\d+/.test(raw) ||
      /^urn:li:comment/.test(raw) ||
      node.tagName.toLowerCase() === "article" ||
      /comments-comment-item|mini-update/i.test(node.className ?? "")
    );
  };
  const isOwned = (node: BrowserNode, container: BrowserNode): boolean => {
    let current = node.parentElement;
    while (current && current !== container) {
      if (isBoundary(current)) return false;
      current = current.parentElement;
    }
    return current === container;
  };
  const identity = (href: string): string => {
    try {
      const parsed = new URL(href, "https://www.linkedin.com");
      if (!/^(www\.)?linkedin\.com$/i.test(parsed.hostname)) return "";
      const match = /^\/in\/([^/]+)\/?$/.exec(parsed.pathname);
      return match ? `www.linkedin.com/in/${match[1]!.toLowerCase()}` : "";
    } catch {
      return "";
    }
  };
  let clicked = 0;
  for (const container of containers) {
    let ancestor = container.parentElement;
    let nestedActivity = false;
    while (ancestor && ancestor !== root) {
      const raw = ancestor.getAttribute("data-urn") ?? ancestor.getAttribute("data-id") ?? "";
      if (/urn:li:activity:\d+/.test(raw)) {
        nestedActivity = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (nestedActivity) continue;
    const owned = (selector: string): BrowserNode[] =>
      Array.from(container.querySelectorAll(selector)).filter((node) => isOwned(node, container));
    const author = owned(
      ".update-components-actor__meta-link[href*='/in/'], .update-components-actor__container-link[href*='/in/']",
    )[0];
    if (identity(author?.href ?? "") !== expected.expectedAuthorIdentity) continue;
    const bodies = owned(
      ".update-components-text, [data-testid='main-feed-activity-card__commentary'], .feed-shared-update-v2__description",
    );
    if (!bodies.some((node) => (node.innerText ?? "").trim().startsWith(expected.expectedTitle)))
      continue;
    for (const button of owned("button")) {
      const label = (
        button.getAttribute("aria-label") ??
        button.innerText ??
        button.textContent ??
        ""
      )
        .normalize("NFKC")
        .trim()
        .toLowerCase();
      if (!/^(more|see more|…more|näytä lisää|показать ещё)$/.test(label)) continue;
      button.click?.();
      clicked += 1;
    }
  }
  return clicked;
}

/** Browser-serializable extractor. Every accepted node must belong directly to
 * one activity container; nested activities, comments, articles, and mini
 * updates are rejected before body/author/media/permalink binding. */
export function extractLinkedInProfilePosts(root: BrowserNode): ObservedLinkedInProfilePost[] {
  const activitySelector = "[data-urn*='urn:li:activity'], [data-id*='urn:li:activity']";
  const containers = Array.from(root.querySelectorAll(activitySelector));
  const seen = new Set<string>();
  const out: ObservedLinkedInProfilePost[] = [];
  const isBoundary = (node: BrowserNode): boolean => {
    const raw = node.getAttribute("data-urn") ?? node.getAttribute("data-id") ?? "";
    return (
      /urn:li:activity:\d+/.test(raw) ||
      /^urn:li:comment/.test(raw) ||
      node.tagName.toLowerCase() === "article" ||
      /comments-comment-item|mini-update/i.test(node.className ?? "")
    );
  };
  const isOwned = (node: BrowserNode, container: BrowserNode): boolean => {
    let current = node.parentElement;
    while (current && current !== container) {
      if (isBoundary(current)) return false;
      current = current.parentElement;
    }
    return current === container;
  };
  for (const container of containers) {
    let ancestor = container.parentElement;
    let nestedActivity = false;
    while (ancestor && ancestor !== root) {
      const raw = ancestor.getAttribute("data-urn") ?? ancestor.getAttribute("data-id") ?? "";
      if (/urn:li:activity:\d+/.test(raw)) {
        nestedActivity = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (nestedActivity) continue;
    const raw = container.getAttribute("data-urn") ?? container.getAttribute("data-id") ?? "";
    const id = /urn:li:activity:(\d+)/.exec(raw)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const owned = (selector: string): BrowserNode[] =>
      Array.from(container.querySelectorAll(selector)).filter((node) => isOwned(node, container));
    const body =
      owned(
        ".update-components-text, [data-testid='main-feed-activity-card__commentary'], .feed-shared-update-v2__description",
      )
        .map((node) => node.innerText ?? "")
        .sort((a, b) => b.length - a.length)[0] ?? "";
    const author = owned(
      ".update-components-actor__meta-link[href*='/in/'], .update-components-actor__container-link[href*='/in/']",
    )[0];
    const vanity =
      owned("a[href*='/posts/']")
        .map((anchor) => (anchor.href ?? "").split("?")[0] ?? "")
        .find((href) => href.includes(`-${id}-`)) ?? "";
    const hasNativeVideo =
      owned(
        "video, [data-test-native-video], .video-js, [class*='video-player'], [data-vjs-player]",
      ).length > 0;
    out.push({
      activityUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
      vanityPermalink: vanity,
      authorProfileHref: author?.href?.split("?")[0] ?? "",
      body,
      hasNativeVideo,
    });
  }
  return out;
}
