// R13: delete an X tweet or reply with a mandatory read-before-delete oracle.
// Read the rendered target → compare against expectedContent → only then delete
// (caret → Delete → confirm). A mismatch fails closed with no DOM mutation.

import { type Locator, type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  DeleteResultSchema,
  type DeleteInput,
  type DeleteResult,
} from "@arcanada/publisher-core";
import { selectors } from "./selectors.js";
import { launchSession, withScreenshotOnFail } from "./context.js";

const X_HOSTNAMES = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

export interface DeleteOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Test seam: read the rendered target text (defaults to tweet-body read). */
  __readContent?: (page: Page, input: DeleteInput) => Promise<string>;
  __readBinding?: (page: Page, input: DeleteInput) => Promise<TargetBinding>;
  /** Test seam: perform the destructive caret → Delete → confirm flow. */
  __performDelete?: (page: Page, input: DeleteInput, article?: Locator) => Promise<void>;
  skipTeardown?: boolean;
}

export async function del(input: DeleteInput, options: DeleteOptions = {}): Promise<DeleteResult> {
  assertTargetHost(input.targetUrl);
  if (!input.expectedContent || input.expectedContent.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "delete: 'expectedContent' is required (read-before-delete oracle)",
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("x", input.profile);

  if (options.page) {
    return runDeleteFlow(options.page, input, options);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runDeleteFlow(session.page, input, options);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runDeleteFlow(
  page: Page,
  input: DeleteInput,
  options: DeleteOptions,
): Promise<DeleteResult> {
  return withScreenshotOnFail(page, "delete", async () => {
    const binding = options.__readContent
      ? null
      : await (options.__readBinding ?? readTargetBinding)(page, input);
    const seen = options.__readContent
      ? await options.__readContent(page, input)
      : binding!.content;
    if (normalizeExact(seen) !== normalizeExact(input.expectedContent)) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "delete: rendered content does not match expectedContent — aborting without deletion",
        { targetUrl: input.targetUrl, kind: input.kind, xErrorType: "verify_mismatch" },
      );
    }

    const performDelete = options.__performDelete ?? defaultPerformDelete;
    await performDelete(page, input, binding?.article);

    return DeleteResultSchema.parse({
      ok: true,
      platform: "x",
      account: "self",
      deleted: true,
      targetUrl: input.targetUrl,
    });
  });
}

/**
 * PUB-0033: extract the numeric status id from an X status URL
 * (https://x.com/<handle>/status/<id>) so the oracle can target the EXACT
 * tweet, not whichever article renders first.
 */
export function statusIdFromUrl(targetUrl: string): string | null {
  const m = /\/status\/(\d+)/.exec(targetUrl);
  return m ? m[1] : null;
}

/**
 * PUB-0033: locate the article element for the target tweet on a permalink
 * page. A reply permalink renders the PARENT post first, so `.first()` reads the
 * wrong tweet — the read-before-delete oracle then mismatches (fail-closed) or,
 * worse, the caret/Delete acts on the parent. Match the article that contains an
 * anchor to the target status id; fall back to `.first()` only when the id is
 * unknown (e.g. a non-status URL) so existing single-tweet behaviour is kept.
 */
export function locateTargetArticle(page: Page, input: DeleteInput) {
  const id = statusIdFromUrl(input.targetUrl);
  if (id) {
    return page.locator(`article:has(a[href*="/status/${id}"])`).first();
  }
  return page.locator("article").first();
}

export interface TargetBinding {
  article: Locator;
  content: string;
}

async function readTargetBinding(page: Page, input: DeleteInput): Promise<TargetBinding> {
  await page.goto(input.targetUrl);
  const id = statusIdFromUrl(input.targetUrl);
  const target = new URL(input.targetUrl);
  if (!id) throw new AdapterError(ErrorCode.VERIFY_FAILED, "delete: numeric status id missing");
  const expectedHandle = target.pathname.split("/").filter(Boolean)[0]!.toLowerCase();
  const loadState = await waitForExactStatusState(page, id, expectedHandle);
  if (loadState !== "present") {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "delete: target status is definitively absent",
      {
        targetUrl: input.targetUrl,
        xErrorType: "verify_mismatch",
      },
    );
  }
  const bindings = await page.locator("article").evaluateAll(
    (articles, expected) => {
      const browserLocation = (globalThis as unknown as { location: { href: string } }).location;
      return articles.flatMap((article, index) => {
        const time = [...article.querySelectorAll("time[datetime]")].find(
          (candidate) => candidate.closest("article") === article,
        );
        const anchor = time?.closest("a[href]");
        const href = anchor?.getAttribute("href");
        if (!href || anchor?.closest("article") !== article) return [];
        const match = /^\/([^/]+)\/status\/(\d+)/.exec(
          new URL(href, browserLocation.href).pathname,
        );
        if (!match || match[2] !== expected.id || match[1]!.toLowerCase() !== expected.handle)
          return [];
        const isReply = [...article.querySelectorAll("div, span")].some(
          (candidate) =>
            candidate.closest("article") === article &&
            /^(Replying to|В ответ)/i.test(
              ((candidate as unknown as { innerText?: string }).innerText ?? "").trim(),
            ),
        );
        return [{ index, isReply }];
      });
    },
    { id, handle: expectedHandle },
  );
  const bindingIndex = assertSafeTargetBinding(bindings, input.kind, input.targetUrl);
  const article = page.locator("article").nth(bindingIndex);
  await article.waitFor({ state: "visible", timeout: 10_000 });
  const content = await article.evaluate((articleNode) => {
    const bodies = [...articleNode.querySelectorAll('[data-testid="tweetText"]')].filter(
      (candidate) => candidate.closest("article") === articleNode,
    );
    return bodies.length === 1 ? (bodies[0] as unknown as { innerText: string }).innerText : null;
  });
  if (content === null)
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "delete: expected one owned tweet body");
  return { article, content };
}

export function assertSafeTargetBinding(
  bindings: Array<{ index: number; isReply: boolean }>,
  kind: DeleteInput["kind"],
  targetUrl: string,
): number {
  if (bindings.length !== 1 || (kind === "post" && bindings[0]!.isReply)) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "delete: exact status/author/parent-post binding mismatch — aborting",
      { targetUrl, bindings, xErrorType: "verify_mismatch" },
    );
  }
  return bindings[0]!.index;
}

async function defaultPerformDelete(
  page: Page,
  input: DeleteInput,
  verifiedArticle?: Locator,
): Promise<void> {
  // PUB-0033: open the caret WITHIN the target article so a reply permalink
  // does not act on the parent post's menu.
  if (!verifiedArticle)
    throw new AdapterError(ErrorCode.VERIFY_FAILED, "delete: verified article binding missing");
  const article = verifiedArticle;
  const caret = article.locator(selectors.caret).first();
  await caret.waitFor({ state: "visible", timeout: 10_000 });
  await caret.click();
  const deleteItem = page.getByRole("menuitem", { name: /^(Delete|Удалить)$/ }).first();
  await deleteItem.waitFor({ state: "visible", timeout: 5_000 });
  await deleteItem.click();
  const confirm = page.getByRole("button", { name: /^(Delete|Удалить)$/, exact: true });
  await confirm.first().waitFor({ state: "visible", timeout: 5_000 });
  await confirm.first().click();
  await page.goto(input.targetUrl);
  const id = statusIdFromUrl(input.targetUrl);
  if (!id) throw new AdapterError(ErrorCode.VERIFY_FAILED, "delete: numeric status id missing");
  const target = new URL(input.targetUrl);
  const expectedHandle = target.pathname.split("/").filter(Boolean)[0]!.toLowerCase();
  const outcome = await waitForExactStatusState(page, id, expectedHandle);
  if (outcome !== "absent") {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "delete: target status still renders after delete",
      { targetUrl: input.targetUrl, xErrorType: "verify_mismatch" },
    );
  }
}

export async function waitForExactStatusState(
  page: Page,
  statusId: string,
  expectedHandle: string,
): Promise<"present" | "absent"> {
  try {
    const result = await page.waitForFunction(
      (expected) => {
        type DomElement = {
          innerText: string;
          querySelectorAll(selector: string): DomElement[];
          closest(selector: string): DomElement | null;
          getAttribute(name: string): string | null;
        };
        const browser = globalThis as unknown as {
          document: { querySelectorAll(selector: string): DomElement[]; body: DomElement };
        };
        const exactPrimary = [...browser.document.querySelectorAll("article")].some((article) => {
          const time = [...article.querySelectorAll("time[datetime]")].find(
            (candidate) => candidate.closest("article") === article,
          );
          const href = time?.closest("a[href]")?.getAttribute("href") ?? "";
          const match = /^\/([^/]+)\/status\/(\d+)/.exec(new URL(href, "https://x.com").pathname);
          return match?.[1]?.toLowerCase() === expected.handle && match?.[2] === expected.statusId;
        });
        if (exactPrimary) return "present";
        return /(This Post was deleted|Hmm.*page doesn.t exist|Этот пост удален|(?:Такой\s+)?страниц[аы]\s+не\s+существует)/i.test(
          browser.document.body.innerText,
        )
          ? "absent"
          : null;
      },
      { statusId, handle: expectedHandle.toLowerCase() },
      { timeout: 15_000 },
    );
    return (await result.jsonValue()) as "present" | "absent";
  } catch {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "delete: status load state remained inconclusive",
      { statusId, expectedHandle, xErrorType: "verify_mismatch" },
    );
  }
}

function normalizeExact(value: string): string {
  return value.normalize("NFKC").replace(/\r\n/g, "\n").trim();
}

function assertTargetHost(targetUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch (cause) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `delete: targetUrl is not a valid URL: ${targetUrl}`,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (!X_HOSTNAMES.has(parsed.hostname)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `delete: targetUrl host '${parsed.hostname}' is not an X (Twitter) host`,
      { targetUrl },
    );
  }
}
