// Migrated from Arcanada-one/li-publish@7ddadf81a1662abd66d7f04ea2b7acf737d6afe2 on 2026-05-21
// Source: bin/li-comment.sh (first-comment publish flow).
//
// Memory reference: [[playwright-submit-vs-trigger]] — LinkedIn renders TWO
// buttons under the same logical «comment» label: a *trigger* (opens the
// reply composer; identified by `aria-label`) and a *submit* (sends the
// composed text; no aria-label, just an inner-text «Comment»). The legacy
// bash li-comment.sh:144-178 disambiguates by querying the submit button
// inside the open composer scope. We preserve that semantics: locate the
// editable textbox, type, then submit through the enabled localized button in
// the 2026 TipTap composer. Ctrl+Enter remains only for the legacy Quill UI.

import { createHash } from "node:crypto";
import { type Locator, type Page } from "playwright";
import {
  AdapterError,
  ErrorCode,
  ProfileManager,
  CommentResultSchema,
  DeleteResultSchema,
  type CommentInput,
  type CommentResult,
  type DeleteResult,
} from "@arcanada/publisher-core";
import { launchSession, withScreenshotOnFail } from "./context.js";
import { cssSelectors, selectors } from "./selectors.js";
import { ACTIVITY_URN_RE, extractActivityId } from "./url-extraction.js";
import { matchesElidedText, matchesElidedTextSource } from "./elided-text.js";

// The adapter package intentionally does not include the DOM library. This
// ambient name is erased from the Node bundle; the serialized page callback
// resolves it against the browser (or a document-shaped boundary fixture).
declare const document: unknown;

const LINKEDIN_HOSTNAME = "www.linkedin.com";

export interface CommentOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Optional verifier — defaults to `fetch HEAD` against the parent URL. */
  verifyParent?: (parentPostUrl: string) => Promise<boolean>;
  skipTeardown?: boolean;
}

export async function comment(
  input: CommentInput,
  options: CommentOptions = {},
): Promise<CommentResult> {
  assertParentActivityUrl(input.parentPostUrl);
  if (!input.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "comment: 'text' is required");
  }

  const verifyParent = options.verifyParent ?? defaultVerifyParent;
  const parentOk = await verifyParent(input.parentPostUrl);
  if (!parentOk) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      `comment: parent post is not reachable: ${input.parentPostUrl}`,
      { parentPostUrl: input.parentPostUrl, liErrorType: "verify_mismatch" },
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);

  if (options.page) {
    return runCommentFlow(options.page, input);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runCommentFlow(session.page, input);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runCommentFlow(page: Page, input: CommentInput): Promise<CommentResult> {
  return withScreenshotOnFail(page, "comment", async () => {
    await page.goto(input.parentPostUrl);
    const resolved = await resolveCommentEditor(page);
    const baseline = await readExactCommentMatches(page, input.text);
    if (baseline.length > 0) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "comment: exact text already exists before submit; refusing ambiguous duplicate",
        { parentPostUrl: input.parentPostUrl, liErrorType: "verify_mismatch" },
      );
    }

    await resolved.editor.click();
    await page.keyboard.insertText(input.text);

    // Re-scan immediately before the submit action. A virtualized thread can
    // finish hydrating while the composer is being filled; treating a late old
    // match as the newly submitted comment would be a false positive.
    const preSubmit = await readExactCommentMatches(page, input.text);
    if (preSubmit.length > 0) {
      throw new AdapterError(
        ErrorCode.VERIFY_FAILED,
        "comment: exact text appeared before submit; refusing ambiguous duplicate",
        { parentPostUrl: input.parentPostUrl, liErrorType: "verify_mismatch" },
      );
    }

    if (resolved.kind === "tiptap") await submitTipTapComment(page, resolved.editor);
    else await page.keyboard.press("Control+Enter");

    const rendered = await waitForExactComment(page, input.text);
    const activityId = extractActivityId(input.parentPostUrl);
    const commentId = rendered.id || verifiedEvidenceId(activityId, input.text);
    const account = `urn:li:activity:${activityId}`;
    return CommentResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account,
      commentId,
      parentPostUrl: input.parentPostUrl,
    });
  });
}

interface ResolvedCommentEditor {
  editor: Locator;
  kind: "tiptap" | "legacy";
}

/**
 * PUB-0032: resolve the comment composer textbox tolerant to UI drift. The 2026
 * LinkedIn UI localizes the accessible name and now uses TipTap in its 2026
 * composer. Resolve TipTap structurally first so its button-submit contract is
 * unambiguous; only an absent TipTap editor may fall back to legacy Quill role
 * and structural locators.
 */
async function resolveCommentEditor(page: Page): Promise<ResolvedCommentEditor> {
  const tiptap = page.locator(cssSelectors.commentTipTapEditor).first();
  try {
    await tiptap.waitFor({ state: "visible", timeout: 4_000 });
    return { editor: tiptap, kind: "tiptap" };
  } catch {
    // Continue to legacy Quill locators only when TipTap is absent.
  }
  const byName = page.getByRole("textbox", { name: selectors.commentBox }).first();
  try {
    await byName.waitFor({ state: "visible", timeout: 4_000 });
    return { editor: byName, kind: "legacy" };
  } catch {
    const byCss = page.locator(cssSelectors.commentLegacyEditor).first();
    await byCss.waitFor({ state: "visible", timeout: 8_000 });
    return { editor: byCss, kind: "legacy" };
  }
}

async function submitTipTapComment(page: Page, editor: Locator): Promise<void> {
  const submit = await findNearestTipTapSubmit(editor);
  if (!submit) {
    throw new AdapterError(
      ErrorCode.PUBLISH_BUTTON_ABSENT,
      "comment: enabled TipTap submit button was not found in the composer",
      { liErrorType: "publish_button_absent" },
    );
  }
  try {
    await submit.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    throw new AdapterError(
      ErrorCode.PUBLISH_BUTTON_ABSENT,
      "comment: enabled TipTap submit button was not found in the composer",
      { liErrorType: "publish_button_absent" },
    );
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const enabled = await submit.isEnabled().catch(() => false);
    if (enabled) {
      try {
        await submit.click({ timeout: 5_000 });
        return;
      } catch {
        break;
      }
    }
    if (attempt < 19) await page.waitForTimeout(250);
  }

  throw new AdapterError(
    ErrorCode.PUBLISH_BUTTON_ABSENT,
    "comment: enabled TipTap submit button was not found in the composer",
    { liErrorType: "publish_button_absent" },
  );
}

async function findNearestTipTapSubmit(editor: Locator): Promise<Locator | null> {
  let scope = editor.locator("xpath=..");
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = scope
      .getByRole("button", { name: selectors.commentSubmitButton, exact: true })
      .first();
    const count = await candidate.count().catch(() => 0);
    if (count > 0) return candidate;
    scope = scope.locator("xpath=..");
  }
  return null;
}

interface RenderedCommentMatch {
  text: string;
  id: string;
}

export const commentContainerSelector =
  "[data-id^='urn:li:comment'], .comments-comment-item, [class*='comments-comment-item'], [data-testid='expandable-text-box']";

export function normalizeRenderedCommentText(value: string): string {
  return value.replace(/\n\s*(?:…|\.\.\.)\s*more\s*$/i, "").trim();
}

async function waitForExactComment(page: Page, text: string): Promise<RenderedCommentMatch> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const matches = await readExactCommentMatches(page, text);
    if (matches[0]) return matches.find((match) => match.id) ?? matches[0];
    await page.waitForTimeout(250);
  }
  throw new AdapterError(
    ErrorCode.VERIFY_FAILED,
    "comment: exact submitted text did not appear newly in the comment thread",
    { liErrorType: "verify_mismatch" },
  );
}

export async function readExactCommentMatches(
  page: Page,
  expectedText: string,
): Promise<RenderedCommentMatch[]> {
  return page.evaluate(
    ({ expected, containerSelector, normalizerSource, matcherSource }) => {
      interface BrowserElement {
        innerText: string;
        parentElement: BrowserElement | null;
        getAttribute(name: string): string | null;
        querySelectorAll(selector: string): ArrayLike<BrowserElement>;
      }
      // Keep `document` as a lexical page-callback dependency. Besides being
      // the browser-native surface, this lets the serialized callback be
      // executed against a document-shaped fixture in boundary tests.
      const browserDocument = document as unknown as {
        querySelectorAll(selector: string): ArrayLike<BrowserElement>;
      };
      const normalize = new Function(`return (${normalizerSource})`)() as (value: string) => string;
      const bodyMatches = new Function(`return (${matcherSource})`)() as (
        rendered: string,
        expected: string,
      ) => boolean;
      // The known LinkedIn comment selectors returned zero on the live 2026
      // surface. Keep them as a fast path, but always add broad text-bearing
      // elements so verification is not selector-dependent.
      const containers = [
        ...new Set([
          ...Array.from(browserDocument.querySelectorAll(containerSelector)),
          ...Array.from(browserDocument.querySelectorAll("*")),
        ]),
      ];
      const seen = new Set<BrowserElement>();
      const matches = new Map<string, { text: string; id: string }>();
      const commentIdFrom = (container: BrowserElement): string => {
        let current: BrowserElement | null = container;
        while (current) {
          const rawValues = [
            current.getAttribute("data-id"),
            current.getAttribute("data-urn"),
            current.getAttribute("data-comment-urn"),
          ].filter((value): value is string => Boolean(value));
          for (const raw of rawValues) {
            const nested = /urn:li:comment:\(.*?,(\d+)\)/.exec(raw);
            if (nested?.[1]) return nested[1];
            const simple = /^urn:li:comment:(\d+)$/.exec(raw);
            if (simple?.[1]) return simple[1];
          }
          current = current.parentElement;
        }
        return "";
      };
      for (const container of containers) {
        if (seen.has(container)) continue;
        seen.add(container);
        const bodies = [
          container,
          ...Array.from(
            container.querySelectorAll(
              ".comments-comment-item__main-content, .comments-comment-item-content-body, .update-components-text, [data-testid='comment-content'], span[dir='ltr'], p",
            ),
          ),
        ];
        const matchingBodies = bodies.filter((body) =>
          bodyMatches(normalize(body.innerText), expected),
        );
        if (matchingBodies.length === 0) continue;
        const id = commentIdFrom(container);
        const key = id || `text:${normalize(matchingBodies[0]!.innerText)}`;
        matches.set(key, { text: expected, id });
      }
      return [...matches.values()];
    },
    {
      expected: normalizeCommentBody(expectedText),
      containerSelector: commentContainerSelector,
      normalizerSource: normalizeRenderedCommentText.toString(),
      matcherSource: matchesElidedTextSource,
    },
  );
}

// --- R13: exact LinkedIn comment deletion ----------------------------------

/** The marker is applied only after the exact URN/author/body candidate wins. */
export const LINKEDIN_COMMENT_DELETE_TARGET_ATTR = "data-arcanada-delete-comment-target";

export interface LinkedInDeleteCommentInput {
  targetUrl: string;
  parentPostUrl: string;
  /** Exact LinkedIn comment URN, not a post/activity URN. */
  commentUrn: string;
  /** Stable `/in/<slug>` ownership oracle. */
  expectedAuthorProfileUrl: string;
  /** Read-before-delete body oracle. */
  expectedContent: string;
  profile: string;
}

export interface LinkedInDeleteCommentEvidence {
  preDeleteCommentUrns: readonly string[];
}

export interface LinkedInCommentBindingEvidence {
  commentUrn: string;
  renderedBodyCandidates: readonly string[];
  renderedAuthorProfileHrefs: readonly string[];
  /** Live LinkedIn fallback: visible `<Name> Author` lines. */
  renderedAuthorLines: readonly string[];
}

export interface LinkedInDeleteCommentOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  /** Test seam for the complete exact bind → confirm → detach step. */
  __deleteStep?: (
    page: Page,
    input: LinkedInDeleteCommentInput,
  ) => Promise<LinkedInDeleteCommentEvidence>;
  skipTeardown?: boolean;
}

/**
 * Delete exactly one LinkedIn comment. The post-delete path in delete.ts calls
 * this function rather than reusing the post menu choreography, which keeps a
 * comment target from ever becoming a whole-post deletion.
 */
export async function deleteCommentByUrn(
  input: LinkedInDeleteCommentInput,
  options: LinkedInDeleteCommentOptions = {},
): Promise<DeleteResult> {
  assertParentActivityUrl(input.parentPostUrl);
  assertExactLinkedInMutationTarget("deleteCommentByUrn", input);

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);
  if (options.page) return runDeleteCommentFlow(options.page, input, options);

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runDeleteCommentFlow(session.page, input, options);
  } finally {
    if (!options.skipTeardown) await session.close();
  }
}

/** Compatibility alias: LinkedIn's stable comment target is an URN. */
export const deleteCommentById = deleteCommentByUrn;

async function runDeleteCommentFlow(
  page: Page,
  input: LinkedInDeleteCommentInput,
  options: LinkedInDeleteCommentOptions,
): Promise<DeleteResult> {
  return withScreenshotOnFail(page, "comment-delete", async () => {
    const step = options.__deleteStep ?? defaultDeleteCommentStep;
    await step(page, input);
    return DeleteResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account: `urn:li:activity:${extractActivityId(input.parentPostUrl)}`,
      deleted: true,
      targetUrl: input.targetUrl,
    });
  });
}

async function defaultDeleteCommentStep(
  page: Page,
  input: LinkedInDeleteCommentInput,
): Promise<LinkedInDeleteCommentEvidence> {
  await page.goto(input.parentPostUrl, { waitUntil: "domcontentloaded" });
  return deleteExactComment(page, input);
}

/**
 * The single LinkedIn comment deletion choreography: exact target binding,
 * author/body verification, scoped menu and confirmation, and detached proof.
 * Nothing after the confirmation click is retried; uncertainty is UNKNOWN.
 */
export async function deleteExactComment(
  page: Page,
  input: LinkedInDeleteCommentInput,
): Promise<LinkedInDeleteCommentEvidence> {
  const candidates = (await readAndMarkExactLinkedInComments(page, input)).map((candidate) => ({
    ...candidate,
    renderedBodyCandidates: [...candidate.renderedBodyCandidates],
    renderedAuthorProfileHrefs: [...candidate.renderedAuthorProfileHrefs],
    renderedAuthorLines: [...candidate.renderedAuthorLines],
  }));
  if (candidates.length !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "deleteCommentByUrn: exact LinkedIn comment target is missing or ambiguous; refusing delete",
      {
        parentPostUrl: input.parentPostUrl,
        commentUrn: input.commentUrn,
        liErrorType: "verify_mismatch",
        candidateCount: candidates.length,
      },
    );
  }

  const binding = candidates[0]!;
  assertExactCommentBinding(input, binding, "deleteCommentByUrn");

  const target = page.locator(`[${LINKEDIN_COMMENT_DELETE_TARGET_ATTR}="true"]`);
  if ((await target.count()) !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "deleteCommentByUrn: exact comment marker is missing or ambiguous; refusing delete",
      { commentUrn: input.commentUrn, liErrorType: "verify_mismatch" },
    );
  }

  const menus = target.getByRole("button", { name: selectors.commentOptionsMenu });
  if ((await menus.count()) !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "deleteCommentByUrn: exact comment action menu is ambiguous; refusing delete",
      {
        commentUrn: input.commentUrn,
        liErrorType: "verify_mismatch",
        menuCount: await menus.count(),
      },
    );
  }
  await menus.first().waitFor({ state: "visible", timeout: 5_000 });
  await menus.first().click();

  await page.waitForTimeout(800);
  const openMenu = page.locator('[role="menu"]').last();
  const openMenuCount = await openMenu.count();
  if (openMenuCount !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "deleteCommentByUrn: opened comment menu is missing or ambiguous; refusing delete",
      { commentUrn: input.commentUrn, liErrorType: "verify_mismatch", menuCount: openMenuCount },
    );
  }
  const deleteItems = openMenu
    .getByRole("menuitem", { name: selectors.deleteMenuItem, exact: true })
    .or(openMenu.getByRole("button", { name: selectors.deleteMenuItem, exact: true }));
  const deleteItemCount = await deleteItems.count();
  if (deleteItemCount !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "deleteCommentByUrn: exact delete item is ambiguous; refusing delete",
      {
        commentUrn: input.commentUrn,
        liErrorType: "verify_mismatch",
        deleteItemCount,
      },
    );
  }
  await deleteItems.first().waitFor({ state: "visible", timeout: 5_000 });
  await deleteItems.first().click();

  await page.waitForTimeout(800);
  const dialog = page.locator('[role="dialog"]').last();
  const dialogCount = await dialog.count();
  if (dialogCount > 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "deleteCommentByUrn: confirmation dialogs are ambiguous; refusing delete",
      { commentUrn: input.commentUrn, liErrorType: "verify_mismatch", dialogCount },
    );
  }
  const confirmationScope = dialogCount === 1 ? dialog : page;
  const confirms = confirmationScope.getByRole("button", {
    name: selectors.confirmDelete,
    exact: true,
  });
  const confirmCount = await confirms.count();
  if (confirmCount !== 1) {
    throw new AdapterError(
      ErrorCode.VERIFY_FAILED,
      "deleteCommentByUrn: exact confirmation is ambiguous; refusing delete",
      {
        commentUrn: input.commentUrn,
        liErrorType: "verify_mismatch",
        confirmCount,
        scopedToDialog: dialogCount === 1,
      },
    );
  }

  const preDeleteCommentUrns = [input.commentUrn];
  try {
    await confirms.first().click();
    await page.waitForTimeout(3_000);
    await target.waitFor({ state: "detached", timeout: 10_000 });
  } catch (cause) {
    throw asUnknownLinkedInDeleteState("confirm-or-detach", input, cause, {
      preDeleteCandidateCount: 1,
    });
  }
  return { preDeleteCommentUrns };
}

/** Pure fail-closed binding assertion used by the browser path and tests. */
export function assertExactCommentBinding(
  input: LinkedInDeleteCommentInput,
  evidence: LinkedInCommentBindingEvidence,
  label = "deleteCommentByUrn",
): void {
  if (normalizeCommentUrn(evidence.commentUrn) !== normalizeCommentUrn(input.commentUrn)) {
    throw linkedInBindingError("comment URN mismatch", input, label);
  }
  const expected = normalizeCommentBody(input.expectedContent);
  if (
    !evidence.renderedBodyCandidates.some((candidate) =>
      matchesElidedText(normalizeRenderedCommentText(candidate), expected),
    )
  ) {
    throw linkedInBindingError("exact comment body mismatch", input, label);
  }
  const expectedIdentity = linkedInProfileIdentity(input.expectedAuthorProfileUrl);
  const hrefMatches = evidence.renderedAuthorProfileHrefs.some(
    (href) => safeLinkedInProfileIdentity(href) === expectedIdentity,
  );
  const expectedSlug = expectedIdentity.split("/in/")[1]!;
  const lineMatches = evidence.renderedAuthorLines.some((line) =>
    authorLineMatches(line, expectedSlug),
  );
  if (!hrefMatches && !lineMatches) {
    throw linkedInBindingError("expected comment author mismatch", input, label);
  }
}

async function readAndMarkExactLinkedInComments(
  page: Page,
  input: LinkedInDeleteCommentInput,
): Promise<LinkedInCommentBindingEvidence[]> {
  return page.evaluate(
    ({ expectedUrn, expectedBody, expectedAuthorSlug, matcherSource, markerAttr }) => {
      interface BrowserElement {
        innerText?: string;
        textContent?: string | null;
        tagName?: string;
        parentElement: BrowserElement | null;
        getAttribute(name: string): string | null;
        querySelectorAll(selector: string): ArrayLike<BrowserElement>;
        contains(other: BrowserElement): boolean;
        setAttribute(name: string, value: string): void;
        removeAttribute(name: string): void;
      }
      const browserDocument = (
        globalThis as unknown as {
          document: {
            body?: BrowserElement;
            querySelectorAll(selector: string): ArrayLike<BrowserElement>;
            location?: { href?: string };
          };
          location?: { href?: string };
        }
      ).document;
      const all = [
        ...(browserDocument.body ? [browserDocument.body] : []),
        ...Array.from(browserDocument.querySelectorAll("*")),
      ];
      const normalize = (value: string): string =>
        value
          .replace(/\r\n/g, "\n")
          .replace(/\n\s*(?:…|\.\.\.)\s*more\s*$/i, "")
          .trim();
      const matcher = new Function(`return (${matcherSource})`)() as (
        rendered: string,
        expected: string,
      ) => boolean;
      const decode = (value: string): string => {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      const textOf = (node: BrowserElement): string =>
        String(node.innerText ?? node.textContent ?? "");
      const rawIdentityValues = (node: BrowserElement): string[] =>
        [
          node.getAttribute("data-id"),
          node.getAttribute("data-urn"),
          node.getAttribute("data-comment-urn"),
          node.getAttribute("href"),
        ].filter((value): value is string => Boolean(value));
      const ownsExpectedUrn = (node: BrowserElement): boolean =>
        rawIdentityValues(node).some((value) => {
          const decodedValue = decode(value).trim();
          if (decodedValue === expectedUrn) return true;
          try {
            const parsed = new URL(
              value,
              browserDocument.location?.href ?? "https://www.linkedin.com",
            );
            return [
              parsed.searchParams.get("commentUrn"),
              parsed.searchParams.get("comment_urn"),
              parsed.searchParams.get("comment-urn"),
            ].some((candidate) => decode(candidate ?? "").trim() === expectedUrn);
          } catch {
            return false;
          }
        });
      const descendants = (node: BrowserElement): BrowserElement[] => [
        node,
        ...Array.from(node.querySelectorAll("*")),
      ];
      const hrefIdentity = (raw: string): string => {
        try {
          const parsed = new URL(raw, browserDocument.location?.href ?? "https://www.linkedin.com");
          if (!/^(www\.)?linkedin\.com$/i.test(parsed.hostname)) return "";
          const match = /^\/in\/([^/]+)\/?$/.exec(parsed.pathname);
          return match ? `www.linkedin.com/in/${match[1]!.toLowerCase()}` : "";
        } catch {
          return "";
        }
      };
      const authorData = (owner: BrowserElement) => {
        const hrefs = descendants(owner)
          .map((node) => hrefIdentity(node.getAttribute("href") ?? ""))
          .filter(Boolean);
        const lines = textOf(owner)
          .split(/\n+/)
          .map((line) => line.normalize("NFKC").trim())
          .filter((line) => /\bAuthor\s*$/i.test(line));
        const expectedSlug = expectedAuthorSlug.replace(/[^a-z0-9]/gi, "").toLowerCase();
        const lineMatches = lines.some((line) => {
          const name = line.replace(/\s+Author\s*$/i, "").replace(/[^a-z0-9]/gi, "");
          return name.toLowerCase() === expectedSlug;
        });
        return { hrefs: [...new Set(hrefs)], lines: [...new Set(lines)], lineMatches };
      };
      const bodyMatches = (node: BrowserElement): boolean =>
        matcher(normalize(textOf(node)), expectedBody);
      const bodyNodes = all
        .filter(bodyMatches)
        .filter(
          (node) =>
            !all.some((other) => other !== node && node.contains(other) && bodyMatches(other)),
        );
      const ownerFor = (body: BrowserElement): BrowserElement | null => {
        const chain: BrowserElement[] = [];
        let current: BrowserElement | null = body;
        while (current) {
          chain.push(current);
          current = current.parentElement;
        }
        for (const owner of chain) {
          if (!descendants(owner).some(ownsExpectedUrn)) continue;
          const authors = authorData(owner);
          if (
            authors.hrefs.includes(`www.linkedin.com/in/${expectedAuthorSlug.toLowerCase()}`) ||
            authors.lineMatches
          )
            return owner;
        }
        return null;
      };
      for (const node of all) node.removeAttribute(markerAttr);
      const unique = new Map<BrowserElement, LinkedInCommentBindingEvidence>();
      for (const body of bodyNodes) {
        const owner = ownerFor(body);
        if (!owner || owner === browserDocument.body) continue;
        const authors = authorData(owner);
        unique.set(owner, {
          commentUrn: expectedUrn,
          renderedBodyCandidates: [textOf(body)],
          renderedAuthorProfileHrefs: authors.hrefs,
          renderedAuthorLines: authors.lines,
        });
      }
      const result = [...unique.entries()];
      if (result.length === 1) result[0]![0].setAttribute(markerAttr, "true");
      else for (const [owner] of result) owner.removeAttribute(markerAttr);
      return result.map(([, evidence]) => evidence);
    },
    {
      expectedUrn: input.commentUrn,
      expectedBody: normalizeCommentBody(input.expectedContent),
      expectedAuthorSlug: linkedInProfileIdentity(input.expectedAuthorProfileUrl).split("/in/")[1]!,
      matcherSource: matchesElidedTextSource,
      markerAttr: LINKEDIN_COMMENT_DELETE_TARGET_ATTR,
    },
  );
}

function assertExactLinkedInMutationTarget(label: string, input: LinkedInDeleteCommentInput): void {
  if (!input.expectedContent || input.expectedContent.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `${label}: 'expectedContent' is required (read-before-delete oracle)`,
    );
  }
  if (!input.commentUrn || !isLinkedInCommentUrn(input.commentUrn)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `${label}: 'commentUrn' must be an exact LinkedIn comment URN`,
      { commentUrn: input.commentUrn },
    );
  }
  if (!input.expectedAuthorProfileUrl || input.expectedAuthorProfileUrl.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      `${label}: 'expectedAuthorProfileUrl' is required (stable ownership oracle)`,
    );
  }
  linkedInProfileIdentity(input.expectedAuthorProfileUrl);
}

function linkedInBindingError(
  reason: string,
  input: LinkedInDeleteCommentInput,
  label: string,
): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, `${label}: ${reason}; refusing delete`, {
    parentPostUrl: input.parentPostUrl,
    commentUrn: input.commentUrn,
    liErrorType: "verify_mismatch",
  });
}

function asUnknownLinkedInDeleteState(
  stage: string,
  input: LinkedInDeleteCommentInput,
  cause: unknown,
  evidence: Record<string, unknown>,
): AdapterError {
  const causeDetails = cause instanceof AdapterError ? cause.details : undefined;
  return new AdapterError(
    ErrorCode.VERIFY_FAILED,
    `deleteCommentByUrn: LinkedIn state UNKNOWN after irreversible confirmation; do not retry blindly (${stage})`,
    {
      unknown: true,
      reconcileRequired: true,
      stage,
      targetUrl: input.targetUrl,
      parentPostUrl: input.parentPostUrl,
      commentUrn: input.commentUrn,
      expectedAuthorIdentity: safeLinkedInProfileIdentity(input.expectedAuthorProfileUrl),
      expectedContentSha256: sha256(input.expectedContent),
      expectedContentLength: input.expectedContent.length,
      evidence,
      causeName: cause instanceof Error ? cause.name : typeof cause,
      causeCode: cause instanceof AdapterError ? cause.code : causeDetails?.["code"],
      liErrorType: "verify_mismatch",
    },
  );
}

function isLinkedInCommentUrn(value: string): boolean {
  return /^urn:li:comment:\(urn:li:activity:\d+,\d+\)$/.test(normalizeCommentUrn(value));
}

function normalizeCommentUrn(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

function normalizeCommentBody(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function linkedInProfileIdentity(rawUrl: string): string {
  const parsed = new URL(rawUrl, "https://www.linkedin.com");
  if (!/^(www\.)?linkedin\.com$/i.test(parsed.hostname)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "deleteCommentByUrn requires a LinkedIn author profile URL",
    );
  }
  const match = /^\/in\/([^/]+)\/?$/.exec(parsed.pathname);
  if (!match) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "deleteCommentByUrn requires a stable /in/ author profile URL",
    );
  }
  return `www.linkedin.com/in/${match[1]!.toLowerCase()}`;
}

function safeLinkedInProfileIdentity(rawUrl: string): string {
  try {
    return linkedInProfileIdentity(rawUrl);
  } catch {
    return "";
  }
}

function authorLineMatches(line: string, expectedSlug: string): boolean {
  const name = line.replace(/\s+Author\s*$/i, "").replace(/[^a-z0-9]/gi, "");
  return name.toLowerCase() === expectedSlug.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function verifiedEvidenceId(activityId: string, text: string): string {
  const digest = createHash("sha256")
    .update(`${activityId}\0${text}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `verified:${activityId}:${digest}`;
}

function assertParentActivityUrl(parentPostUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(parentPostUrl);
  } catch (cause) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `comment: parentPostUrl is not a valid URL: ${parentPostUrl}`,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (parsed.hostname !== LINKEDIN_HOSTNAME) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      `comment: parentPostUrl host '${parsed.hostname}' is not '${LINKEDIN_HOSTNAME}'`,
      { parentPostUrl },
    );
  }
  if (!ACTIVITY_URN_RE.test(parentPostUrl)) {
    throw new AdapterError(
      ErrorCode.INVALID_ARGS,
      "comment: parentPostUrl must match the strict activity URN pattern",
      { parentPostUrl, pattern: ACTIVITY_URN_RE.source },
    );
  }
}

async function defaultVerifyParent(parentPostUrl: string): Promise<boolean> {
  try {
    const response = await fetch(parentPostUrl, { method: "HEAD", redirect: "follow" });
    return response.ok;
  } catch {
    return false;
  }
}

// --- R10: edit a LinkedIn comment in place (menu → Edit → Save changes) -----
//
// Unlike Facebook (where in-place comment edit is broken and we delete+add),
// LinkedIn supports editing a comment's text: open the comment kebab («View
// more options for <Name>'s comment»), click «Edit», replace the body, and
// commit with «Save changes» (NOT «Save», which is a different control).

export interface EditCommentInput {
  parentPostUrl: string;
  /** Read-before-edit oracle: the current text of the comment to edit. */
  oldText: string;
  /** The replacement comment body. */
  text: string;
  profile: string;
}

/** Injectable choreography (test seam): open menu → edit → save changes. */
export interface EditCommentRecorder {
  openCommentMenu(page: Page, input: EditCommentInput): Promise<void>;
  clickEditItem(page: Page): Promise<void>;
  replaceText(page: Page, text: string): Promise<void>;
  clickSaveChanges(page: Page): Promise<void>;
}

export interface EditCommentOptions {
  headed?: boolean;
  profileManager?: ProfileManager;
  page?: Page;
  __recorder?: EditCommentRecorder;
  skipTeardown?: boolean;
}

export async function editComment(
  input: EditCommentInput,
  options: EditCommentOptions = {},
): Promise<CommentResult> {
  assertParentActivityUrl(input.parentPostUrl);
  if (!input.text || input.text.trim() === "") {
    throw new AdapterError(ErrorCode.MISSING_INPUT, "editComment: 'text' is required");
  }
  if (!input.oldText || input.oldText.trim() === "") {
    throw new AdapterError(
      ErrorCode.MISSING_INPUT,
      "editComment: 'oldText' is required (read-before-edit oracle)",
    );
  }

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);

  if (options.page) {
    return runEditCommentFlow(options.page, input, options.__recorder);
  }

  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runEditCommentFlow(session.page, input, options.__recorder);
  } finally {
    if (!options.skipTeardown) {
      await session.close();
    }
  }
}

async function runEditCommentFlow(
  page: Page,
  input: EditCommentInput,
  recorder?: EditCommentRecorder,
): Promise<CommentResult> {
  const steps = recorder ?? defaultEditCommentSteps;
  return withScreenshotOnFail(page, "comment-edit", async () => {
    await steps.openCommentMenu(page, input);
    await steps.clickEditItem(page);
    await steps.replaceText(page, input.text);
    await steps.clickSaveChanges(page);
    const account = `urn:li:activity:${extractActivityId(input.parentPostUrl)}`;
    return CommentResultSchema.parse({
      ok: true,
      platform: "linkedin",
      account,
      commentId: "edited",
      parentPostUrl: input.parentPostUrl,
    });
  });
}

const defaultEditCommentSteps: EditCommentRecorder = {
  async openCommentMenu(page: Page, input: EditCommentInput): Promise<void> {
    await page.goto(input.parentPostUrl);
    // Read-before-edit: scope the kebab to the comment block whose rendered text
    // matches `oldText`, so we never edit the wrong comment.
    const block = page
      .locator("article, [data-id^='urn:li:comment']")
      .filter({ hasText: input.oldText })
      .first();
    await block.waitFor({ state: "visible", timeout: 10_000 });
    await block.scrollIntoViewIfNeeded();
    const menu = block.getByRole("button", { name: selectors.commentOptionsMenu }).first();
    await menu.click();
  },

  async clickEditItem(page: Page): Promise<void> {
    const editItem = page.getByRole("menuitem", { name: selectors.commentEditMenuItem }).first();
    await editItem.waitFor({ state: "visible", timeout: 5_000 });
    await editItem.click();
  },

  async replaceText(page: Page, text: string): Promise<void> {
    // PUB-0032: same drift-tolerant resolver as the publish-comment flow.
    const { editor } = await resolveCommentEditor(page);
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await page.keyboard.insertText(text);
  },

  async clickSaveChanges(page: Page): Promise<void> {
    // R10: the commit control is «Save changes», NOT «Save».
    const save = page.getByRole("button", { name: selectors.commentSaveChanges, exact: true });
    await save.first().waitFor({ state: "visible", timeout: 5_000 });
    await save.first().click();
    await page.waitForTimeout(3_000);
  },
};
