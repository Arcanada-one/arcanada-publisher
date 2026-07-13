import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { AdapterError, ErrorCode, ProfileManager } from "@arcanada/publisher-core";
import { launchSession } from "./context.js";
import { selectors } from "./selectors.js";

const MAX_SCROLL_LIMIT = 50;

export const DETAIL_CONTROL_MENU_PATTERN_SOURCES = [
  selectors.editPostActionEn.source,
  selectors.editPostActionRu.source,
] as const;

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
  __copyLinkRecorder?: CopyLinkRecorder;
  __clipboard?: ClipboardPort;
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
  if (options.page)
    return runInspection(
      options.page,
      input,
      expectedIdentity,
      options.__recorder,
      options.__copyLinkRecorder,
      options.__clipboard,
    );

  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", input.profile);
  const session = await launchSession({
    profileDir,
    ...(options.headed !== undefined ? { headed: options.headed } : {}),
  });
  try {
    return await runInspection(
      session.page,
      input,
      expectedIdentity,
      options.__recorder,
      options.__copyLinkRecorder,
      options.__clipboard,
    );
  } finally {
    if (!options.skipTeardown) await session.close();
  }
}

async function runInspection(
  page: Page,
  input: InspectLinkedInProfilePostInput,
  expectedIdentity: string,
  recorder?: InspectLinkedInProfileRecorder,
  copyLinkRecorder: CopyLinkRecorder = defaultCopyLinkRecorder,
  clipboard: ClipboardPort = defaultClipboard,
): Promise<InspectLinkedInProfilePostResult> {
  const activeRecorder = recorder ?? createDefaultRecorder();
  const activitySurface = `${input.profileUrl.replace(/\/$/, "")}/recent-activity/all/`;
  await page.goto(activitySurface, { waitUntil: "domcontentloaded" });
  const observed = new Map<string, ObservedLinkedInProfilePost>();
  const expected = normalizeExact(input.expectedBody ?? input.contentExcerpt!);
  let scrollsPerformed = 0;
  for (let pass = 0; pass <= input.maxScrolls; pass += 1) {
    for (const candidate of await activeRecorder.scanLoadedPosts(
      page,
      expectedIdentity,
      expected.split("\n", 1)[0]!,
    )) {
      if (!activityId(candidate.activityUrl)) continue;
      observed.set(candidate.activityUrl, candidate);
    }
    if (pass < input.maxScrolls) {
      await activeRecorder.scroll(page, pass + 1);
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
  const captureFailure = async (): Promise<void> => {
    const expansionClickCounts = isDiagnosticRecorder(activeRecorder)
      ? [...activeRecorder.expansionClickCounts]
      : [];
    await writeFailureEvidence(
      page,
      input.evidenceDir,
      [...observed.values()],
      expansionClickCounts,
    );
  };
  const fail = async (message: string): Promise<never> => {
    await captureFailure();
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
  const matchedBody = normalizeExact(matched.body);
  const matchedBodySha256 = createHash("sha256").update(matchedBody, "utf8").digest("hex");
  let vanityPermalink: string;
  try {
    vanityPermalink = isVanityPermalink(matched.vanityPermalink, id, expectedIdentity)
      ? matched.vanityPermalink
      : await recoverVanityPermalink(
          page,
          matched.activityUrl,
          expectedIdentity,
          id,
          copyLinkRecorder,
          clipboard,
          input.evidenceDir,
          matchedBodySha256,
          matchedBody.length,
        );
  } catch (error) {
    await captureFailure();
    throw error;
  }
  if (!isVanityPermalink(vanityPermalink, id, expectedIdentity)) {
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
          canonicalParentPermalink: vanityPermalink,
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
  const body = matchedBody;
  return {
    canonicalParentPermalink: vanityPermalink,
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

export function linkedInActivityIdFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!/^(www\.)?linkedin\.com$/i.test(parsed.hostname)) return null;
    const path = decodeURIComponent(parsed.pathname);
    const feed = /^\/feed\/update\/urn:li:activity:(\d+)\/?$/.exec(path);
    if (feed) return feed[1] ?? null;
    if (!path.startsWith("/posts/")) return null;
    const canonical = [...path.matchAll(/-activity-(\d+)-/g)];
    return canonical.length === 1 ? (canonical[0]?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

function activityId(rawUrl: string): string | null {
  return linkedInActivityIdFromUrl(rawUrl);
}

function isVanityPermalink(rawUrl: string, id: string, expectedAuthorIdentity: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const authorSlug = expectedAuthorIdentity.split("/in/")[1]?.toLowerCase() ?? "";
    const activityComponents = [...parsed.pathname.matchAll(/-activity-(\d+)-/g)];
    return (
      /^(www\.)?linkedin\.com$/i.test(parsed.hostname) &&
      parsed.pathname.toLowerCase().startsWith(`/posts/${authorSlug}_`) &&
      activityComponents.length === 1 &&
      activityComponents[0]?.[1] === id
    );
  } catch {
    return false;
  }
}

async function recoverVanityPermalink(
  page: Page,
  activityUrl: string,
  expectedAuthorIdentity: string,
  id: string,
  copyLinkRecorder: CopyLinkRecorder,
  clipboard: ClipboardPort,
  evidenceDir: string,
  expectedBodySha256: string,
  expectedBodyLength: number,
): Promise<string> {
  await page.goto(activityUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_000);
  const copiedFromDom = await page.locator("html").evaluate(extractLinkedInVanityPermalink, {
    expectedAuthorIdentity,
    activityId: id,
  });
  if (copiedFromDom) return copiedFromDom;
  if (linkedInActivityIdFromUrl(page.url()) !== id) {
    throw verifyError("detail page activity id does not match pre-navigation oracle");
  }
  const detailOracle: DetailPostMenuOracle = {
    expectedAuthorIdentity,
    expectedBodySha256,
    expectedBodyLength,
    controlMenuPatternSources: DETAIL_CONTROL_MENU_PATTERN_SOURCES,
    click: false,
  };
  const diagnostic = await writeMenuLookupDiagnostic(page, evidenceDir, id, detailOracle);
  const target: CopyLinkTarget =
    diagnostic.activityContainerCount > 0
      ? { activityId: id, mode: "activity-container" }
      : { activityId: id, mode: "detail-card", detailOracle };
  return copyVanityFromActivityMenu(
    page,
    expectedAuthorIdentity,
    target,
    copyLinkRecorder,
    clipboard,
  );
}

export interface ClipboardPort {
  snapshot(): Promise<Uint8Array>;
  readText(): Promise<string>;
  restore(snapshot: Uint8Array): Promise<void>;
}

export interface CopyLinkRecorder {
  copy(page: Page, target: CopyLinkTarget): Promise<void>;
}

export type CopyLinkTarget =
  | { activityId: string; mode: "activity-container" }
  | { activityId: string; mode: "detail-card"; detailOracle: DetailPostMenuOracle };

export interface DetailPostMenuOracle {
  expectedAuthorIdentity: string;
  expectedBodySha256: string;
  expectedBodyLength: number;
  controlMenuPatternSources: readonly string[];
  click: boolean;
}

export async function copyVanityFromActivityMenu(
  page: Page,
  expectedAuthorIdentity: string,
  targetOrId: CopyLinkTarget | string,
  recorder: CopyLinkRecorder = defaultCopyLinkRecorder,
  clipboard: ClipboardPort = defaultClipboard,
): Promise<string> {
  const target: CopyLinkTarget =
    typeof targetOrId === "string"
      ? { activityId: targetOrId, mode: "activity-container" }
      : targetOrId;
  const snapshot = await clipboard.snapshot();
  try {
    await recorder.copy(page, target);
    await page.waitForTimeout(500);
    const copied = (await clipboard.readText()).trim();
    return isVanityPermalink(copied, target.activityId, expectedAuthorIdentity) ? copied : "";
  } finally {
    await clipboard.restore(snapshot);
  }
}

interface MacPasteboardDeps {
  platform: NodeJS.Platform;
  exec: typeof execFileSync;
  pasteboardName?: string;
  __failAfterClearOnce?: boolean;
}

const MAX_PASTEBOARD_ARCHIVE_BYTES = 512 * 1024 * 1024;

const SNAPSHOT_PASTEBOARD_JXA = [
  "ObjC.import('AppKit');",
  "function encode(data, stage) {",
  "  if (!data || typeof data.base64EncodedStringWithOptions !== 'function')",
  "    throw new Error(stage);",
  "  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));",
  "}",
  "function run(argv) {",
  "  const pb = argv.length > 0",
  "    ? $.NSPasteboard.pasteboardWithName($(ObjC.unwrap(argv[0])))",
  "    : $.NSPasteboard.generalPasteboard;",
  "  // Force board-level promised conversions before enumerating item types.",
  "  // Some AppKit providers add item representations lazily when read.",
  "  const sourceBoardTypes = pb.types;",
  "  const boardFlavors = [];",
  "  for (let typeIndex = 0; typeIndex < Number(sourceBoardTypes.count); typeIndex += 1) {",
  "    const nativeType = sourceBoardTypes.objectAtIndex(typeIndex);",
  "    const data = pb.dataForType(nativeType);",
  "    boardFlavors.push({",
  "      type: ObjC.unwrap(nativeType),",
  "      dataBase64: encode(data, 'pasteboard board flavor unavailable'),",
  "    });",
  "  }",
  "  const sourceItems = pb.pasteboardItems;",
  "  const items = [];",
  "  for (let itemIndex = 0; itemIndex < Number(sourceItems.count); itemIndex += 1) {",
  "    const sourceItem = sourceItems.objectAtIndex(itemIndex);",
  "    const sourceTypes = sourceItem.types;",
  "    const flavors = [];",
  "    for (let typeIndex = 0; typeIndex < Number(sourceTypes.count); typeIndex += 1) {",
  "      const nativeType = sourceTypes.objectAtIndex(typeIndex);",
  "      const data = sourceItem.dataForType(nativeType);",
  "      flavors.push({",
  "        type: ObjC.unwrap(nativeType),",
  "        dataBase64: encode(data, `pasteboard item flavor unavailable ${itemIndex}:${typeIndex}`),",
  "      });",
  "    }",
  "    items.push({ flavors });",
  "  }",
  "  return JSON.stringify({ version: 1, items, boardFlavors });",
  "}",
].join("\n");

const READ_PASTEBOARD_TEXT_JXA = [
  "ObjC.import('AppKit');",
  "function run(argv) {",
  "  const pb = argv.length > 0",
  "    ? $.NSPasteboard.pasteboardWithName($(ObjC.unwrap(argv[0])))",
  "    : $.NSPasteboard.generalPasteboard;",
  "  const value = pb.stringForType($.NSPasteboardTypeString);",
  "  return value ? ObjC.unwrap(value) : '';",
  "}",
].join("\n");

const RESTORE_PASTEBOARD_JXA = [
  "ObjC.import('AppKit');",
  "ObjC.import('Foundation');",
  "function run(argv) {",
  "  const stdin = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;",
  "  const source = $.NSString.alloc.initWithDataEncoding(stdin, $.NSUTF8StringEncoding);",
  "  if (!source) throw new Error('invalid pasteboard archive');",
  "  const archive = JSON.parse(ObjC.unwrap(source));",
  "  if (!archive || archive.version !== 1 || !Array.isArray(archive.items) ||",
  "      !Array.isArray(archive.boardFlavors))",
  "    throw new Error('invalid pasteboard archive');",
  "  const restoredItems = $.NSMutableArray.array;",
  "  for (const archivedItem of archive.items) {",
  "    if (!archivedItem || !Array.isArray(archivedItem.flavors))",
  "      throw new Error('invalid pasteboard item');",
  "    const item = $.NSPasteboardItem.alloc.init;",
  "    for (const flavor of archivedItem.flavors) {",
  "      if (!flavor || typeof flavor.type !== 'string' || typeof flavor.dataBase64 !== 'string')",
  "        throw new Error('invalid pasteboard flavor');",
  "      const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(flavor.dataBase64), 0);",
  "      if (!data || !item.setDataForType(data, $(flavor.type)))",
  "        throw new Error('invalid pasteboard flavor data');",
  "    }",
  "    restoredItems.addObject(item);",
  "  }",
  "  const pb = argv.length > 0",
  "    ? $.NSPasteboard.pasteboardWithName($(ObjC.unwrap(argv[0])))",
  "    : $.NSPasteboard.generalPasteboard;",
  "  pb.clearContents;",
  "  if (archive.items.length > 0 && !pb.writeObjects(restoredItems))",
  "    throw new Error('pasteboard restore failed');",
  "  for (const flavor of archive.boardFlavors) {",
  "    if (!flavor || typeof flavor.type !== 'string' || typeof flavor.dataBase64 !== 'string')",
  "      throw new Error('invalid pasteboard board flavor');",
  "    const currentTypes = ObjC.deepUnwrap(pb.types);",
  "    if (currentTypes.indexOf(flavor.type) >= 0) continue;",
  "    const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(flavor.dataBase64), 0);",
  "    if (!data || !pb.setDataForType(data, $(flavor.type)))",
  "      throw new Error('invalid pasteboard board flavor data');",
  "  }",
  "  return 'ok';",
  "}",
].join("\n");

export function createMacPasteboardClipboard(
  deps: MacPasteboardDeps = { platform: process.platform, exec: execFileSync },
): ClipboardPort {
  const run = (script: string, input?: Uint8Array): Buffer => {
    if (deps.platform !== "darwin") {
      throw verifyError("macOS pasteboard is unavailable on this platform");
    }
    try {
      const args = [
        "-l",
        "JavaScript",
        "-e",
        script,
        ...(deps.pasteboardName ? ["--", deps.pasteboardName] : []),
      ];
      const output = deps.exec("osascript", args, {
        ...(input ? { input: Buffer.from(input) } : {}),
        maxBuffer: MAX_PASTEBOARD_ARCHIVE_BYTES,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return Buffer.from(output);
    } catch {
      throw verifyError("macOS pasteboard operation failed");
    }
  };
  return {
    async snapshot() {
      return Buffer.from(run(SNAPSHOT_PASTEBOARD_JXA).toString("utf8").trim(), "utf8");
    },
    async readText() {
      return run(READ_PASTEBOARD_TEXT_JXA).toString("utf8");
    },
    async restore(snapshot) {
      const backup = Buffer.from(snapshot);
      let injectPostClearFailure = deps.__failAfterClearOnce === true;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const restoreScript = injectPostClearFailure
            ? RESTORE_PASTEBOARD_JXA.replace(
                "  pb.clearContents;",
                "  pb.clearContents;\n  throw new Error('injected post-clear failure');",
              )
            : RESTORE_PASTEBOARD_JXA;
          injectPostClearFailure = false;
          run(restoreScript, backup);
          const restored = Buffer.from(
            run(SNAPSHOT_PASTEBOARD_JXA).toString("utf8").trim(),
            "utf8",
          );
          if (restored.equals(backup)) return;
        } catch {
          injectPostClearFailure = false;
        }
      }
      throw pasteboardRestoreError();
    },
  };
}

const defaultClipboard = createMacPasteboardClipboard();

const defaultCopyLinkRecorder: CopyLinkRecorder = {
  async copy(page, target) {
    const clicked =
      target.mode === "activity-container"
        ? await page.locator("body").evaluate(clickExactActivityMenu, target.activityId)
        : (
            await page.locator("body").evaluate(inspectExactDetailPostMenu, {
              ...target.detailOracle,
              click: true,
            })
          ).clicked;
    if (!clicked) {
      throw verifyError(
        target.mode === "activity-container"
          ? "exact direct-owned activity menu was not found"
          : "exact proven detail-card menu was not found",
      );
    }
    const item = page.getByRole("menuitem", { name: "Copy link to post", exact: true });
    if ((await item.count()) !== 1)
      throw verifyError("exact Copy link to post menu item was not unique");
    await item.click();
  },
};

function normalizeExact(value: string): string {
  return value.normalize("NFKC").replace(/\r\n/g, "\n").trim();
}

function verifyError(message: string): AdapterError {
  return new AdapterError(ErrorCode.VERIFY_FAILED, `inspect-profile-post: ${message}`);
}

function pasteboardRestoreError(): AdapterError {
  return new AdapterError(
    ErrorCode.VERIFY_FAILED,
    "inspect-profile-post: macOS pasteboard restore failed; clipboard state is unverified",
    { stage: "macos_pasteboard_restore", clipboardState: "unverified" },
  );
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

async function writeMenuLookupDiagnostic(
  page: Page,
  rawEvidenceDir: string,
  expectedId: string,
  detailOracle: DetailPostMenuOracle,
): Promise<ActivityMenuLookupDiagnostic & { detailCardFallback?: DetailPostMenuDiagnostic }> {
  const evidenceDir = resolve(rawEvidenceDir);
  try {
    const activityDiagnostic = await page
      .locator("body")
      .evaluate(inspectExactActivityMenuLookup, expectedId);
    const diagnostic =
      activityDiagnostic.activityContainerCount === 0
        ? {
            ...activityDiagnostic,
            detailCardFallback: await page
              .locator("body")
              .evaluate(inspectExactDetailPostMenu, { ...detailOracle, click: false }),
          }
        : activityDiagnostic;
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await chmod(evidenceDir, 0o700);
    await writePrivate(
      join(evidenceDir, "menu-lookup-diagnostic.json"),
      `${JSON.stringify(diagnostic, null, 2)}\n`,
    );
    return diagnostic;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw verifyError("failed to write private menu lookup diagnostic");
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

interface DiagnosticRecorder extends InspectLinkedInProfileRecorder {
  expansionClickCounts: number[];
}

function isDiagnosticRecorder(
  recorder: InspectLinkedInProfileRecorder,
): recorder is DiagnosticRecorder {
  return "expansionClickCounts" in recorder && Array.isArray(recorder.expansionClickCounts);
}

function createDefaultRecorder(): DiagnosticRecorder {
  const expansionClickCounts: number[] = [];
  return {
    expansionClickCounts,
    async scanLoadedPosts(page, expectedAuthorIdentity, expectedTitle) {
      const expanded = await page.locator("body").evaluate(expandMatchingLinkedInActivity, {
        expectedAuthorIdentity,
        expectedTitle,
      });
      expansionClickCounts.push(expanded);
      if (expanded > 0) await page.waitForTimeout(500);
      return page.locator("body").evaluate(extractLinkedInProfilePosts);
    },
    async scroll(page) {
      await page.evaluate("window.scrollBy(0, Math.max(window.innerHeight, 900))");
      await page.waitForTimeout(1_500);
    },
  };
}

interface BrowserNode {
  innerText: string;
  href?: string;
  parentElement: BrowserNode | null;
  tagName: string;
  className: string;
  textContent?: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<BrowserNode>;
  cloneNode?(deep?: boolean): BrowserNode;
  remove?(): void;
  click?(): void;
}

type ActivityBoundaryKind = "activity" | "comment" | "article" | "mini-update";

export interface ActivityMenuLookupDiagnostic {
  version: 1;
  expectedActivityId: string;
  activityContainerCount: number;
  exactCandidateCount: number;
  exactCandidates: Array<{
    ancestorBoundaries: ActivityBoundaryKind[];
    buttonCount: number;
    matchingMenuButtonCount: number;
    directOwnedMatchingMenuButtonCount: number;
  }>;
}

/**
 * Return structural menu-ownership facts only. This deliberately excludes DOM
 * text, author labels, URLs, attributes, and clipboard data so a failure
 * artifact cannot leak post or local pasteboard content.
 */
export function inspectExactActivityMenuLookup(
  root: BrowserNode,
  expectedId: string,
): ActivityMenuLookupDiagnostic {
  const boundaryKind = (node: BrowserNode): ActivityBoundaryKind | null => {
    const raw = node.getAttribute("data-urn") ?? node.getAttribute("data-id") ?? "";
    if (/urn:li:activity:\d+/.test(raw)) return "activity";
    if (/^urn:li:comment/.test(raw)) return "comment";
    if (node.tagName.toLowerCase() === "article") return "article";
    if (/comments-comment-item|mini-update/i.test(node.className ?? "")) return "mini-update";
    return null;
  };
  const isMenu = (node: BrowserNode): boolean =>
    /^open control menu for post by .+$/i.test(
      (node.getAttribute("aria-label") ?? "").normalize("NFKC").trim(),
    );
  const containers = Array.from(
    root.querySelectorAll("[data-urn*='urn:li:activity'], [data-id*='urn:li:activity']"),
  );
  const exact = containers.filter((container) => {
    const raw = container.getAttribute("data-urn") ?? container.getAttribute("data-id") ?? "";
    return /urn:li:activity:(\d+)/.exec(raw)?.[1] === expectedId;
  });
  return {
    version: 1,
    expectedActivityId: expectedId,
    activityContainerCount: containers.length,
    exactCandidateCount: exact.length,
    exactCandidates: exact.map((container) => {
      const ancestorBoundaries: ActivityBoundaryKind[] = [];
      let owner = container.parentElement;
      while (owner && owner !== root) {
        const kind = boundaryKind(owner);
        if (kind) ancestorBoundaries.push(kind);
        owner = owner.parentElement;
      }
      const buttons = Array.from(container.querySelectorAll("button"));
      const matchingMenus = buttons.filter(isMenu);
      const directOwnedMatchingMenus = matchingMenus.filter((button) => {
        let buttonOwner = button.parentElement;
        while (buttonOwner && buttonOwner !== container) {
          if (boundaryKind(buttonOwner)) return false;
          buttonOwner = buttonOwner.parentElement;
        }
        return buttonOwner === container;
      });
      return {
        ancestorBoundaries,
        buttonCount: buttons.length,
        matchingMenuButtonCount: matchingMenus.length,
        directOwnedMatchingMenuButtonCount: directOwnedMatchingMenus.length,
      };
    }),
  };
}

export interface DetailPostMenuDiagnostic {
  version: 1;
  topLevelCardCount: number;
  exactBodyCardCount: number;
  exactAuthorCardCount: number;
  nativeVideoCardCount: number;
  provenCardCount: number;
  directOwnedMenuCounts: number[];
  clicked: boolean;
}

/**
 * Browser-serializable fallback for LinkedIn activity detail pages that omit
 * activity URNs. It clicks only when one top-level card is proven by the
 * pre-navigation full-body hash/length, author identity, and native video.
 * Returned diagnostics contain counts only—never content, labels, URLs, or
 * clipboard state.
 */
export async function inspectExactDetailPostMenu(
  root: BrowserNode,
  expected: DetailPostMenuOracle,
): Promise<DetailPostMenuDiagnostic> {
  const isCard = (node: BrowserNode): boolean =>
    node.tagName.toLowerCase() === "article" ||
    /(?:^|\s)feed-shared-update-v2(?:\s|$)/.test(node.className ?? "");
  const isBoundary = (node: BrowserNode): boolean => {
    const raw = node.getAttribute("data-urn") ?? node.getAttribute("data-id") ?? "";
    return (
      /urn:li:activity:\d+/.test(raw) ||
      /^urn:li:comment/.test(raw) ||
      node.tagName.toLowerCase() === "article" ||
      /comments-comment-item|mini-update/i.test(node.className ?? "")
    );
  };
  const isOwned = (node: BrowserNode, card: BrowserNode): boolean => {
    let owner = node.parentElement;
    while (owner && owner !== card) {
      if (isBoundary(owner)) return false;
      owner = owner.parentElement;
    }
    return owner === card;
  };
  const owned = (card: BrowserNode, selector: string): BrowserNode[] =>
    Array.from(card.querySelectorAll(selector)).filter((node) => isOwned(node, card));
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
  const bodyText = (node: BrowserNode): string => {
    let text = node.innerText ?? "";
    for (const control of Array.from(
      node.querySelectorAll(
        "button, [role='button'], .feed-shared-inline-show-more-text__see-more-less-toggle",
      ),
    )) {
      if (!isOwned(control, node)) continue;
      const aria = (control.getAttribute("aria-label") ?? "").normalize("NFKC").trim();
      const visual = (control.innerText ?? control.textContent ?? "").normalize("NFKC").trim();
      if (
        !/^(more|\.\.\.more|see more|see more, visually reveals content which is already detected by screen readers|…more)$/i.test(
          aria || visual,
        ) ||
        !visual
      )
        continue;
      const endTrimmed = text.trimEnd();
      const terminalUiLine = `\n${visual}`;
      if (endTrimmed.endsWith(terminalUiLine))
        text = endTrimmed.slice(0, -terminalUiLine.length).trimEnd();
    }
    return text.normalize("NFKC").replace(/\r\n/g, "\n").trim();
  };
  const sha256 = async (value: string): Promise<string> => {
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  };
  const menuPatterns = expected.controlMenuPatternSources.map((source) => new RegExp(source, "i"));
  const allCards = Array.from(root.querySelectorAll("article, .feed-shared-update-v2"));
  const topLevelCards = allCards.filter((card) => {
    let owner = card.parentElement;
    while (owner && owner !== root) {
      if (isCard(owner)) return false;
      owner = owner.parentElement;
    }
    return owner === root;
  });
  const exactBodyCards: BrowserNode[] = [];
  for (const card of topLevelCards) {
    const body =
      owned(
        card,
        ".update-components-text, [data-testid='main-feed-activity-card__commentary'], .feed-shared-update-v2__description",
      )
        .map(bodyText)
        .sort((a, b) => b.length - a.length)[0] ?? "";
    if (
      body.length === expected.expectedBodyLength &&
      (await sha256(body)) === expected.expectedBodySha256
    ) {
      exactBodyCards.push(card);
    }
  }
  const exactAuthorCards = exactBodyCards.filter((card) => {
    const identities = owned(
      card,
      ".update-components-actor__meta-link[href*='/in/'], .update-components-actor__container-link[href*='/in/']",
    )
      .map((author) => identity(author.href ?? ""))
      .filter(Boolean);
    return (
      identities.length > 0 &&
      identities.every((authorIdentity) => authorIdentity === expected.expectedAuthorIdentity)
    );
  });
  const nativeVideoCards = exactAuthorCards.filter(
    (card) =>
      owned(
        card,
        "video, [data-test-native-video], .video-js, [class*='video-player'], [data-vjs-player]",
      ).length > 0,
  );
  const provenCards = nativeVideoCards;
  const menus = provenCards.map((card) =>
    owned(card, "button, [role='button']").filter((button) => {
      const label = (button.getAttribute("aria-label") ?? "").normalize("NFKC").trim();
      return label !== "" && menuPatterns.some((pattern) => pattern.test(label));
    }),
  );
  const clicked = expected.click && provenCards.length === 1 && menus[0]?.length === 1;
  if (clicked) menus[0]![0]!.click?.();
  return {
    version: 1,
    topLevelCardCount: topLevelCards.length,
    exactBodyCardCount: exactBodyCards.length,
    exactAuthorCardCount: exactAuthorCards.length,
    nativeVideoCardCount: nativeVideoCards.length,
    provenCardCount: provenCards.length,
    directOwnedMenuCounts: menus.map((items) => items.length),
    clicked,
  };
}

export function clickExactActivityMenu(root: BrowserNode, expectedId: string): boolean {
  const isBoundary = (node: BrowserNode): boolean => {
    const raw = node.getAttribute("data-urn") ?? node.getAttribute("data-id") ?? "";
    return (
      /urn:li:activity:\d+/.test(raw) ||
      /^urn:li:comment/.test(raw) ||
      node.tagName.toLowerCase() === "article" ||
      /comments-comment-item|mini-update/i.test(node.className ?? "")
    );
  };
  const isNestedActivity = (container: BrowserNode): boolean => {
    let owner = container.parentElement;
    while (owner && owner !== root) {
      if (isBoundary(owner)) return true;
      owner = owner.parentElement;
    }
    return false;
  };
  const containers = Array.from(
    root.querySelectorAll("[data-urn*='urn:li:activity'], [data-id*='urn:li:activity']"),
  ).filter((container) => {
    const raw = container.getAttribute("data-urn") ?? container.getAttribute("data-id") ?? "";
    return /urn:li:activity:(\d+)/.exec(raw)?.[1] === expectedId && !isNestedActivity(container);
  });
  if (containers.length !== 1) return false;
  const container = containers[0]!;
  const directOwned = (node: BrowserNode): boolean => {
    let owner = node.parentElement;
    while (owner && owner !== container) {
      if (isBoundary(owner)) return false;
      owner = owner.parentElement;
    }
    return owner === container;
  };
  const menus = Array.from(container.querySelectorAll("button"))
    .filter(directOwned)
    .filter((button) =>
      /^open control menu for post by .+$/i.test(
        (button.getAttribute("aria-label") ?? "").normalize("NFKC").trim(),
      ),
    );
  if (menus.length !== 1) return false;
  menus[0]!.click?.();
  return true;
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
      if (
        !/^(more|see more|see more, visually reveals content which is already detected by screen readers|…more|näytä lisää|показать ещё)$/.test(
          label,
        )
      )
        continue;
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
        .map((node) => {
          let text = node.innerText ?? "";
          for (const control of Array.from(
            node.querySelectorAll(
              "button, [role='button'], .feed-shared-inline-show-more-text__see-more-less-toggle",
            ),
          )) {
            let owner = control.parentElement;
            let directOwned = false;
            while (owner) {
              if (owner === node) {
                directOwned = true;
                break;
              }
              if (isBoundary(owner)) break;
              owner = owner.parentElement;
            }
            if (!directOwned) continue;
            const aria = (control.getAttribute("aria-label") ?? "").normalize("NFKC").trim();
            const visual = (control.innerText ?? control.textContent ?? "")
              .normalize("NFKC")
              .trim();
            if (
              !/^(more|\.\.\.more|see more|see more, visually reveals content which is already detected by screen readers|…more)$/i.test(
                aria || visual,
              )
            )
              continue;
            if (!visual) continue;
            const endTrimmed = text.trimEnd();
            const terminalUiLine = `\n${visual}`;
            if (endTrimmed.endsWith(terminalUiLine))
              text = endTrimmed.slice(0, -terminalUiLine.length).trimEnd();
          }
          return text;
        })
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

export function bodyTextWithoutDirectControls(node: BrowserNode): string {
  let text = node.innerText ?? "";
  const isBoundary = (candidate: BrowserNode): boolean => {
    const raw = candidate.getAttribute("data-urn") ?? candidate.getAttribute("data-id") ?? "";
    return (
      /urn:li:activity:\d+/.test(raw) ||
      /^urn:li:comment/.test(raw) ||
      candidate.tagName.toLowerCase() === "article" ||
      /comments-comment-item|mini-update/i.test(candidate.className ?? "")
    );
  };
  for (const control of Array.from(
    node.querySelectorAll(
      "button, [role='button'], .feed-shared-inline-show-more-text__see-more-less-toggle",
    ),
  )) {
    let owner = control.parentElement;
    let directOwned = false;
    while (owner) {
      if (owner === node) {
        directOwned = true;
        break;
      }
      if (isBoundary(owner)) break;
      owner = owner.parentElement;
    }
    if (!directOwned) continue;
    const aria = (control.getAttribute("aria-label") ?? "").normalize("NFKC").trim();
    const visual = (control.innerText ?? control.textContent ?? "").normalize("NFKC").trim();
    if (
      !/^(more|\.\.\.more|see more|see more, visually reveals content which is already detected by screen readers|…more)$/i.test(
        aria || visual,
      )
    )
      continue;
    if (!visual) continue;
    const endTrimmed = text.trimEnd();
    const terminalUiLine = `\n${visual}`;
    if (endTrimmed.endsWith(terminalUiLine))
      text = endTrimmed.slice(0, -terminalUiLine.length).trimEnd();
  }
  return text;
}

export function extractLinkedInVanityPermalink(
  root: BrowserNode,
  expected: { expectedAuthorIdentity: string; activityId: string },
): string {
  const authorSlug = expected.expectedAuthorIdentity.split("/in/")[1]?.toLowerCase() ?? "";
  const valid = (raw: string): string => {
    try {
      const parsed = new URL(raw, "https://www.linkedin.com");
      if (!/^(www\.)?linkedin\.com$/i.test(parsed.hostname)) return "";
      const path = decodeURIComponent(parsed.pathname);
      const activityComponents = [...path.matchAll(/-activity-(\d+)-/g)];
      if (
        !path.startsWith(`/posts/${authorSlug}_`) ||
        activityComponents.length !== 1 ||
        activityComponents[0]?.[1] !== expected.activityId
      )
        return "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "";
    }
  };
  for (const link of Array.from(root.querySelectorAll("link[rel='canonical']"))) {
    const value = valid(link.href ?? link.getAttribute("href") ?? "");
    if (value) return value;
  }
  for (const meta of Array.from(root.querySelectorAll("meta[property='og:url']"))) {
    const value = valid(meta.getAttribute("content") ?? "");
    if (value) return value;
  }
  const activitySelector = "[data-urn*='urn:li:activity'], [data-id*='urn:li:activity']";
  const isBoundary = (node: BrowserNode): boolean => {
    const raw = node.getAttribute("data-urn") ?? node.getAttribute("data-id") ?? "";
    return (
      /urn:li:activity:\d+/.test(raw) ||
      /^urn:li:comment/.test(raw) ||
      node.tagName.toLowerCase() === "article" ||
      /comments-comment-item|mini-update/i.test(node.className ?? "")
    );
  };
  const isNestedActivity = (container: BrowserNode): boolean => {
    let owner = container.parentElement;
    while (owner && owner !== root) {
      if (isBoundary(owner)) return true;
      owner = owner.parentElement;
    }
    return false;
  };
  for (const container of Array.from(root.querySelectorAll(activitySelector))) {
    const raw = container.getAttribute("data-urn") ?? container.getAttribute("data-id") ?? "";
    if (
      /urn:li:activity:(\d+)/.exec(raw)?.[1] !== expected.activityId ||
      isNestedActivity(container)
    )
      continue;
    const author = Array.from(
      container.querySelectorAll(
        ".update-components-actor__meta-link[href*='/in/'], .update-components-actor__container-link[href*='/in/']",
      ),
    )[0];
    let authorIdentity = "";
    try {
      const parsed = new URL(author?.href ?? "", "https://www.linkedin.com");
      const match = /^\/in\/([^/]+)\/?$/.exec(parsed.pathname);
      if (/^(www\.)?linkedin\.com$/i.test(parsed.hostname) && match) {
        authorIdentity = `www.linkedin.com/in/${match[1]!.toLowerCase()}`;
      }
    } catch {
      authorIdentity = "";
    }
    if (authorIdentity !== expected.expectedAuthorIdentity) continue;
    for (const anchor of Array.from(container.querySelectorAll("a[href*='/posts/']"))) {
      const value = valid(anchor.href ?? "");
      if (value) return value;
    }
  }
  return "";
}
