import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import {
  bodyTextWithoutDirectControls,
  clickExactActivityMenu,
  copyVanityFromActivityMenu,
  createMacPasteboardClipboard,
  expandMatchingLinkedInActivity,
  extractLinkedInVanityPermalink,
  extractLinkedInProfilePosts,
  inspectLinkedInProfilePost,
  type ObservedLinkedInProfilePost,
} from "../src/inspect-profile.js";

const PROFILE = "https://www.linkedin.com/in/pavelvalentov/";
const BODY = "Building the Binary Is Only the Beginning\n\nExact full campaign body.";
const ID = "7482676445432107008";

function post(overrides: Partial<ObservedLinkedInProfilePost> = {}): ObservedLinkedInProfilePost {
  return {
    activityUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`,
    vanityPermalink: `https://www.linkedin.com/posts/pavelvalentov_building-the-binary-activity-${ID}-AbCd`,
    authorProfileHref: PROFILE,
    body: BODY,
    hasNativeVideo: true,
    ...overrides,
  };
}

function options(batches: ObservedLinkedInProfilePost[][]) {
  let scan = 0;
  let clipboardValue = Buffer.from("original");
  return {
    page: {
      goto: async () => {},
      screenshot: async () => Buffer.from("png"),
      locator: () => ({ evaluate: async () => [] }),
      waitForTimeout: async () => {},
    } as never,
    skipTeardown: true,
    __recorder: {
      scanLoadedPosts: async () => batches[Math.min(scan++, batches.length - 1)] ?? [],
      scroll: async () => {},
    },
    __copyLinkRecorder: { copy: async () => {} },
    __clipboard: {
      snapshot: async () => Buffer.from(clipboardValue),
      readText: async () => clipboardValue.toString("utf8"),
      restore: async (value: Uint8Array) => {
        clipboardValue = Buffer.from(value);
      },
    },
  };
}

function input(evidenceDir: string) {
  return {
    profileUrl: PROFILE,
    expectedAuthorProfileUrl: PROFILE,
    expectedBody: BODY,
    evidenceDir,
    maxScrolls: 1,
    profile: "default",
  };
}

describe("LinkedIn read-only profile inspection", () => {
  it("binds exact body, author, native video, activity id, and vanity permalink", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "li-inspect-")), "evidence");
    const result = await inspectLinkedInProfilePost(
      input(evidenceDir),
      options([[post()], [post()]]),
    );
    expect(result).toMatchObject({
      canonicalParentPermalink: expect.stringContaining(`/posts/`),
      activityUrl: expect.stringContaining(`urn:li:activity:${ID}`),
      activityId: ID,
      authorProfileIdentity: "www.linkedin.com/in/pavelvalentov",
      postBodyLength: BODY.length,
      hasNativeVideo: true,
      coverage: { maxScrolls: 1, scrollsPerformed: 1, postsInspected: 1 },
    });
    expect(JSON.stringify(result)).not.toContain(BODY);
    expect(statSync(evidenceDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(evidenceDir, "post-body.txt")).mode & 0o777).toBe(0o600);
    expect(statSync(join(evidenceDir, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(evidenceDir, "readback.png")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(evidenceDir, "post-body.txt"), "utf8")).toBe(BODY);
  });

  it("fails closed for wrong author, missing video, missing vanity, or duplicates", async () => {
    const root = mkdtempSync(join(tmpdir(), "li-inspect-"));
    for (const [name, candidates] of [
      ["author", [post({ authorProfileHref: "https://www.linkedin.com/in/impostor/" })]],
      ["video", [post({ hasNativeVideo: false })]],
      ["vanity", [post({ vanityPermalink: "" })]],
      [
        "impostor-vanity",
        [
          post({
            vanityPermalink: `https://www.linkedin.com/posts/impostor_building-activity-${ID}-AbCd`,
          }),
        ],
      ],
      [
        "duplicate",
        [
          post(),
          post({
            activityUrl:
              "https://www.linkedin.com/feed/update/urn:li:activity:7482676445432107009/",
            vanityPermalink:
              "https://www.linkedin.com/posts/pavelvalentov_copy-activity-7482676445432107009-ZyxW",
          }),
        ],
      ],
    ] as const) {
      const evidenceDir = join(root, name);
      await expect(
        inspectLinkedInProfilePost(input(evidenceDir), options([candidates])),
      ).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
      expect(statSync(evidenceDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(evidenceDir, "failure-manifest.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(evidenceDir, "failure-readback.png")).mode & 0o777).toBe(0o600);
      expect(statSync(join(evidenceDir, `candidate-${ID}-body.txt`)).mode & 0o777).toBe(0o600);
      const manifest = JSON.parse(readFileSync(join(evidenceDir, "failure-manifest.json"), "utf8"));
      expect(manifest.candidates[0]).toMatchObject({
        activityId: ID,
        bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bodyLength: BODY.length,
      });
      expect(JSON.stringify(manifest)).not.toContain(BODY);
    }
  });

  it("contains no mutation controls", () => {
    const source = readFileSync(new URL("../src/inspect-profile.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /publishButton|clickPost|deleteMenu|commentSubmit|runPublish|runDelete/,
    );
  });

  it("rejects nested repost/comment ownership and profile mentions", () => {
    const outer = new FakeNode("", { "data-urn": `urn:li:activity:${ID}` });
    const outerBody = outer.child(
      "Building the Binary Is Only the Beginning",
      "update-components-text",
    );
    outer.child("Pavel", "update-components-actor__meta-link", PROFILE);
    outer.child(
      "time",
      "",
      undefined,
      `https://www.linkedin.com/posts/pavelvalentov_post-activity-${ID}-AbCd`,
    );
    outer.child("video", "video-player");
    const nested = outer.child("", "mini-update");
    nested.child(BODY, "update-components-text");
    nested.child(
      "Impostor",
      "update-components-actor__meta-link",
      "https://www.linkedin.com/in/impostor/",
    );
    nested.child("video", "video-player");
    const root = new FakeNode("");
    root.children.push(outer);

    const [observed] = extractLinkedInProfilePosts(root);
    expect(observed).toMatchObject({
      body: outerBody.innerText,
      authorProfileHref: PROFILE,
      hasNativeVideo: true,
      vanityPermalink: expect.stringContaining(ID),
    });
    expect(observed?.body).not.toBe(BODY);
  });

  it("runs the extractor from serialized source with no closure", () => {
    const outer = new FakeNode("", { "data-urn": `urn:li:activity:${ID}` });
    const body = outer.child(`${BODY}\n...more`, "update-components-text");
    body.child("...more", "button");
    outer.child("Pavel", "update-components-actor__meta-link", PROFILE);
    outer.child(
      "time",
      "",
      undefined,
      `https://www.linkedin.com/posts/pavelvalentov_post-activity-${ID}-AbCd`,
    );
    outer.child("video", "video-player");
    body.child("hostile", "custom-element");
    body.child("object", "network-object");
    const root = new FakeNode("");
    root.children.push(outer);
    let connectionSideEffects = 0;
    const previousDocument = (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        body: {
          appendChild: () => {
            connectionSideEffects += 1;
            throw new Error("extractor must never connect cloned content");
          },
        },
      },
    });
    try {
      const serialized = Function(
        `return (${extractLinkedInProfilePosts.toString()})`,
      )() as typeof extractLinkedInProfilePosts;
      expect(serialized(root)).toEqual([
        expect.objectContaining({ body: BODY, hasNativeVideo: true }),
      ]);
      expect(connectionSideEffects).toBe(0);
      expect(extractLinkedInProfilePosts.toString()).not.toContain("appendChild");
    } finally {
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: previousDocument,
        });
    }
  });

  it("clicks plain more only on the direct-owned expected author/title activity", () => {
    const outer = new FakeNode("", { "data-urn": `urn:li:activity:${ID}` });
    outer.child("Building the Binary Is Only the Beginning…", "update-components-text");
    outer.child("Pavel", "update-components-actor__meta-link", PROFILE);
    const ownMore = outer.child("more", "button");
    const nested = outer.child("", "mini-update");
    nested.child("more", "button");
    const other = new FakeNode("", { "data-urn": "urn:li:activity:999" });
    other.child("Building the Binary Is Only the Beginning…", "update-components-text");
    other.child(
      "Other",
      "update-components-actor__meta-link",
      "https://www.linkedin.com/in/other/",
    );
    other.child("more", "button");
    const root = new FakeNode("");
    root.children.push(outer, other);

    const clicked = expandMatchingLinkedInActivity(root, {
      expectedAuthorIdentity: "www.linkedin.com/in/pavelvalentov",
      expectedTitle: "Building the Binary Is Only the Beginning",
    });
    expect(clicked).toBe(1);
    expect(ownMore.clickCount).toBe(1);
    expect(nested.children[0]?.clickCount).toBe(0);
    expect(other.children[2]?.clickCount).toBe(0);
  });

  it("recognizes the exact live verbose see-more label only on the owned activity", () => {
    const outer = new FakeNode("", { "data-urn": `urn:li:activity:${ID}` });
    outer.child("Building the Binary Is Only the Beginning…", "update-components-text");
    outer.child("Pavel", "update-components-actor__meta-link", PROFILE);
    const live = outer.child("", "button", undefined, undefined, undefined, {
      "aria-label":
        "See more, visually reveals content which is already detected by screen readers",
    });
    const root = new FakeNode("");
    root.children.push(outer);
    expect(
      expandMatchingLinkedInActivity(root, {
        expectedAuthorIdentity: "www.linkedin.com/in/pavelvalentov",
        expectedTitle: "Building the Binary Is Only the Beginning",
      }),
    ).toBe(1);
    expect(live.clickCount).toBe(1);
  });

  it("does not accept unrelated see-more comma actions", () => {
    const outer = new FakeNode("", { "data-urn": `urn:li:activity:${ID}` });
    outer.child("Building the Binary Is Only the Beginning…", "update-components-text");
    outer.child("Pavel", "update-components-actor__meta-link", PROFILE);
    const unrelated = outer.child("", "button", undefined, undefined, undefined, {
      "aria-label": "See more, delete this item",
    });
    const root = new FakeNode("");
    root.children.push(outer);
    expect(
      expandMatchingLinkedInActivity(root, {
        expectedAuthorIdentity: "www.linkedin.com/in/pavelvalentov",
        expectedTitle: "Building the Binary Is Only the Beginning",
      }),
    ).toBe(0);
    expect(unrelated.clickCount).toBe(0);
  });

  it("removes the direct-owned live control before exact body normalization", () => {
    const paragraphs = Array.from({ length: 7 }, (_, index) => `Paragraph ${index + 1}.`).join(
      "\n\n",
    );
    const body = new FakeNode(`${paragraphs}\n...more`, {}, "update-components-text");
    body.child("...more", "button");
    expect(bodyTextWithoutDirectControls(body)).toBe(paragraphs);
    expect(bodyTextWithoutDirectControls(body).match(/\n\n/g)).toHaveLength(6);
  });

  it("does not strip legitimate or unowned terminal text", () => {
    const legitimateMore = new FakeNode(
      "A legitimate final line\nmore",
      {},
      "update-components-text",
    );
    legitimateMore.child("...more", "button");
    expect(bodyTextWithoutDirectControls(legitimateMore)).toBe("A legitimate final line\nmore");

    const anymore = new FakeNode("This matters anymore", {}, "update-components-text");
    anymore.child("more", "button");
    expect(bodyTextWithoutDirectControls(anymore)).toBe("This matters anymore");

    const ariaOnly = new FakeNode("Body\n...more", {}, "update-components-text");
    ariaOnly.child("", "button", undefined, undefined, undefined, {
      "aria-label":
        "See more, visually reveals content which is already detected by screen readers",
    });
    expect(bodyTextWithoutDirectControls(ariaOnly)).toBe("Body\n...more");

    const nestedBody = new FakeNode("Body\n...more", {}, "update-components-text");
    const nested = nestedBody.child("", "mini-update");
    nested.child("...more", "button");
    expect(bodyTextWithoutDirectControls(nestedBody)).toBe("Body\n...more");
  });

  it("opens only the exact direct-owned activity menu", () => {
    const outer = new FakeNode("", { "data-urn": `urn:li:activity:${ID}` });
    const exact = outer.child("", "button", undefined, undefined, undefined, {
      "aria-label": "Open control menu for post by Pavel Valentov",
    });
    const nested = outer.child("", "mini-update");
    const nestedMenu = nested.child("", "button", undefined, undefined, undefined, {
      "aria-label": "Open control menu for post by Pavel Valentov",
    });
    const root = new FakeNode("");
    root.children.push(outer);
    expect(clickExactActivityMenu(root, ID)).toBe(true);
    expect(exact.clickCount).toBe(1);
    expect(nestedMenu.clickCount).toBe(0);

    exact.attrsForTest["aria-label"] = "Delete post";
    expect(clickExactActivityMenu(root, ID)).toBe(false);
  });

  it("restores clipboard for valid, impostor, and failed copy-link flows", async () => {
    const valid = `https://www.linkedin.com/posts/pavelvalentov_post-activity-${ID}-AbCd`;
    const page = { waitForTimeout: async () => {} } as never;
    const originalSnapshot = Buffer.from(
      JSON.stringify({
        version: 1,
        items: [
          {
            flavors: [
              { type: "public.file-url", dataBase64: "ZmlsZTovLy90bXAvYS5tcDQ=" },
              { type: "NSFilenamesPboardType", dataBase64: "YnBsaXN0MDDUAQ==" },
            ],
          },
          {
            flavors: [
              { type: "public.png", dataBase64: "iVBORw0KGgoAAAANSUhEUg==" },
              { type: "public.rtf", dataBase64: "e1xydGYxIEJvbGR9" },
              { type: "public.utf8-plain-text", dataBase64: "cmljaCB0ZXh0" },
            ],
          },
        ],
        boardFlavors: [
          { type: "public.file-url", dataBase64: "ZmlsZTovLy90bXAvYS5tcDQ=" },
          { type: "NSFilenamesPboardType", dataBase64: "YnBsaXN0MDDUAQ==" },
          { type: "public.png", dataBase64: "iVBORw0KGgoAAAANSUhEUg==" },
          { type: "public.rtf", dataBase64: "e1xydGYxIEJvbGR9" },
        ],
      }),
    );
    const run = async (copied: string, throws = false) => {
      let state = Buffer.from(originalSnapshot);
      let copiedText = "";
      let restoreCalls = 0;
      const clipboard = {
        snapshot: async () => Buffer.from(state),
        readText: async () => copiedText,
        restore: async (snapshot: Uint8Array) => {
          restoreCalls += 1;
          state = Buffer.from(snapshot);
        },
        // Deliberately destructive legacy seam: the regression must prove the
        // production path no longer falls back to text-only read/write.
        read: async () => "ORIGINAL_CLIPBOARD_TEXT_ONLY",
        write: async (next: string) => {
          state = Buffer.from(next);
        },
      };
      const recorder = {
        copy: async () => {
          if (throws) throw new Error("wrong menu");
          copiedText = copied;
          state = Buffer.from("LINKEDIN_REPLACED_THE_CLIPBOARD");
        },
      };
      const promise = copyVanityFromActivityMenu(
        page,
        "www.linkedin.com/in/pavelvalentov",
        ID,
        recorder,
        clipboard as never,
      );
      if (throws) await expect(promise).rejects.toThrow("wrong menu");
      else expect(await promise).toBe(copied === valid ? valid : "");
      expect(restoreCalls).toBe(1);
      expect(state.equals(originalSnapshot)).toBe(true);
    };
    await run(valid);
    await run(`https://www.linkedin.com/posts/impostor_post-activity-${ID}-AbCd`);
    await run(valid, true);
  });

  it("moves the full pasteboard archive through memory and restore stdin only", async () => {
    const privateMarker = "PRIVATE_FILE_IMAGE_RTF_BYTES";
    const archive = Buffer.from(
      JSON.stringify({
        version: 1,
        items: [
          {
            flavors: [
              {
                type: "public.file-url",
                dataBase64: Buffer.from(privateMarker).toString("base64"),
              },
              { type: "NSFilenamesPboardType", dataBase64: "YnBsaXN0MDDUAQ==" },
            ],
          },
          {
            flavors: [
              { type: "public.png", dataBase64: "iVBORw0KGgoAAAANSUhEUg==" },
              { type: "public.rtf", dataBase64: "e1xydGYxIEJvbGR9" },
              { type: "public.utf8-plain-text", dataBase64: "cmljaCB0ZXh0" },
            ],
          },
        ],
        boardFlavors: [
          { type: "public.file-url", dataBase64: Buffer.from(privateMarker).toString("base64") },
          { type: "NSFilenamesPboardType", dataBase64: "YnBsaXN0MDDUAQ==" },
          { type: "public.png", dataBase64: "iVBORw0KGgoAAAANSUhEUg==" },
          { type: "public.rtf", dataBase64: "e1xydGYxIEJvbGR9" },
        ],
      }),
    );
    const valid = `https://www.linkedin.com/posts/pavelvalentov_post-activity-${ID}-AbCd`;
    const exec = vi.fn((_file: string, args: readonly string[], options: { input?: Buffer }) => {
      const script = args.join("\n");
      expect(args).not.toContain(privateMarker);
      expect(script).not.toContain(privateMarker);
      expect(script).not.toMatch(/pbcopy|pbpaste|writeFile|\/tmp\//);
      if (script.includes("readDataToEndOfFile")) {
        expect(options.input).toEqual(archive);
        expect(script).toContain("setDataForType");
        return Buffer.from("ok");
      }
      if (script.includes("stringForType")) return Buffer.from(valid);
      expect(script).toContain("pb.pasteboardItems");
      expect(script).toContain("dataForType");
      expect(script).toContain("base64EncodedStringWithOptions");
      return Buffer.from(archive);
    });
    const clipboard = createMacPasteboardClipboard({ platform: "darwin", exec: exec as never });

    const snapshot = await clipboard.snapshot();
    expect(Buffer.from(snapshot).equals(archive)).toBe(true);
    expect(await clipboard.readText()).toBe(valid);
    await clipboard.restore(snapshot);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it.runIf(process.platform === "darwin")(
    "round-trips ordered multi-item and multi-flavor bytes through a private NSPasteboard",
    async () => {
      const pasteboardName = `org.arcanada.publisher.tests.${process.pid}.${Date.now()}`;
      const seedScript = [
        "ObjC.import('AppKit');",
        "ObjC.import('Foundation');",
        "function data(value) {",
        "  return $.NSData.alloc.initWithBase64EncodedStringOptions($(value), 0);",
        "}",
        "function run(argv) {",
        "  const pb = $.NSPasteboard.pasteboardWithName($(ObjC.unwrap(argv[0])));",
        "  const first = $.NSPasteboardItem.alloc.init;",
        "  first.setDataForType(data('ZmlsZTovLy90bXAvdmlkZW8gY2xpcC5tcDQ='), $('public.file-url'));",
        "  const second = $.NSPasteboardItem.alloc.init;",
        "  second.setDataForType(data('AAEC/w=='), $('public.png'));",
        "  second.setDataForType(data('e1xydGYxXGIgQm9sZH0='), $('public.rtf'));",
        "  const items = $.NSMutableArray.array;",
        "  items.addObject(first);",
        "  items.addObject(second);",
        "  pb.clearContents;",
        "  if (!pb.writeObjects(items)) throw new Error('seed write failed');",
        "  return 'ok';",
        "}",
      ].join("\n");
      execFileSync("osascript", ["-l", "JavaScript", "-e", seedScript, "--", pasteboardName], {
        encoding: "utf8",
      });
      const emptyArchive = Buffer.from(JSON.stringify({ version: 1, items: [], boardFlavors: [] }));
      const clipboard = createMacPasteboardClipboard({
        platform: "darwin",
        exec: execFileSync,
        pasteboardName,
      });
      try {
        const archive = await clipboard.snapshot();
        const decoded = JSON.parse(Buffer.from(archive).toString("utf8"));
        expect(decoded.items).toHaveLength(2);
        expect(decoded.items[1].flavors.map((flavor: { type: string }) => flavor.type)).toEqual([
          "public.png",
          "public.rtf",
        ]);
        expect(
          decoded.boardFlavors.some(
            (flavor: { type: string }) => flavor.type === "NSFilenamesPboardType",
          ),
        ).toBe(true);
        await clipboard.restore(emptyArchive);
        await clipboard.restore(archive);
        const roundTrip = await clipboard.snapshot();
        expect(Buffer.from(roundTrip).equals(Buffer.from(archive))).toBe(true);
      } finally {
        await clipboard.restore(emptyArchive);
      }
    },
  );

  it("fails closed without exposing pasteboard content or invoking JXA off macOS", async () => {
    const privateMarker = "PRIVATE_CLIPBOARD_SECRET";
    const failingExec = vi.fn(() => {
      throw new Error(privateMarker);
    });
    const mac = createMacPasteboardClipboard({
      platform: "darwin",
      exec: failingExec as never,
    });
    try {
      await mac.snapshot();
      throw new Error("expected snapshot failure");
    } catch (error) {
      expect(String(error)).not.toContain(privateMarker);
      expect(error).toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    }

    const offMacExec = vi.fn();
    const offMac = createMacPasteboardClipboard({
      platform: "linux",
      exec: offMacExec as never,
    });
    await expect(offMac.snapshot()).rejects.toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    expect(offMacExec).not.toHaveBeenCalled();

    const archive = Buffer.from(
      JSON.stringify({
        version: 1,
        items: [{ flavors: [{ type: "public.rtf", dataBase64: privateMarker }] }],
        boardFlavors: [],
      }),
    );
    const mismatchExec = vi.fn((_file: string, args: readonly string[]) =>
      Buffer.from(
        args.join("\n").includes("readDataToEndOfFile")
          ? "ok"
          : JSON.stringify({ version: 1, items: [], boardFlavors: [] }),
      ),
    );
    const mismatch = createMacPasteboardClipboard({
      platform: "darwin",
      exec: mismatchExec as never,
    });
    try {
      await mismatch.restore(archive);
      throw new Error("expected restore verification failure");
    } catch (error) {
      expect(String(error)).not.toContain(privateMarker);
      expect(error).toMatchObject({ code: ErrorCode.VERIFY_FAILED });
    }
  });

  it("recovers only copied same-author same-activity vanity URLs", () => {
    const root = new FakeNode("");
    const canonical = new FakeNode(
      "",
      {
        rel: "canonical",
        href: `https://www.linkedin.com/posts/pavelvalentov_building-activity-${ID}-AbCd?utm_source=share`,
      },
      "",
      "link",
    );
    canonical.href = canonical.getAttribute("href") ?? undefined;
    root.children.push(canonical);
    expect(
      extractLinkedInVanityPermalink(root, {
        expectedAuthorIdentity: "www.linkedin.com/in/pavelvalentov",
        activityId: ID,
      }),
    ).toBe(`https://www.linkedin.com/posts/pavelvalentov_building-activity-${ID}-AbCd`);
    canonical.href = `https://www.linkedin.com/posts/impostor_building-activity-${ID}-AbCd`;
    expect(
      extractLinkedInVanityPermalink(root, {
        expectedAuthorIdentity: "www.linkedin.com/in/pavelvalentov",
        activityId: ID,
      }),
    ).toBe("");

    const prefixActivity = new FakeNode("", { "data-urn": `urn:li:activity:${ID}9` });
    prefixActivity.child(
      "Pavel",
      "update-components-actor__meta-link",
      "https://example.test/in/pavelvalentov/",
    );
    prefixActivity.child(
      "time",
      "",
      `https://www.linkedin.com/posts/pavelvalentov_building-activity-${ID}-AbCd`,
    );
    const adversarialRoot = new FakeNode("");
    adversarialRoot.children.push(prefixActivity);
    expect(
      extractLinkedInVanityPermalink(adversarialRoot, {
        expectedAuthorIdentity: "www.linkedin.com/in/pavelvalentov",
        activityId: ID,
      }),
    ).toBe("");

    prefixActivity.attrsForTest["data-urn"] = `urn:li:activity:${ID}`;
    expect(
      extractLinkedInVanityPermalink(adversarialRoot, {
        expectedAuthorIdentity: "www.linkedin.com/in/pavelvalentov",
        activityId: ID,
      }),
    ).toBe("");
  });

  it("rejects a foreign-host /in/ lookalike before clicking", () => {
    const outer = new FakeNode("", { "data-urn": `urn:li:activity:${ID}` });
    outer.child("Building the Binary Is Only the Beginning…", "update-components-text");
    outer.child(
      "Pavel",
      "update-components-actor__meta-link",
      "https://example.test/in/pavelvalentov/",
    );
    const more = outer.child("more", "button");
    const root = new FakeNode("");
    root.children.push(outer);
    expect(
      expandMatchingLinkedInActivity(root, {
        expectedAuthorIdentity: "www.linkedin.com/in/pavelvalentov",
        expectedTitle: "Building the Binary Is Only the Beginning",
      }),
    ).toBe(0);
    expect(more.clickCount).toBe(0);
  });

  it("exercises the production evaluator while excluding all nested boundary kinds", async () => {
    const evidenceDir = join(mkdtempSync(join(tmpdir(), "li-inspect-live-dom-")), "evidence");
    const outer = new FakeNode("", { "data-urn": `urn:li:activity:${ID}` });
    const body = outer.child(
      "Building the Binary Is Only the Beginning…",
      "update-components-text",
    );
    outer.child("Pavel", "update-components-actor__meta-link", PROFILE);
    outer.child(
      "time",
      "",
      undefined,
      `https://www.linkedin.com/posts/pavelvalentov_post-activity-${ID}-AbCd`,
    );
    outer.child("video", "video-player");
    outer.child("more", "button", undefined, undefined, () => {
      body.innerText = BODY;
    });
    const boundaries = [
      new FakeNode("", { "data-urn": "urn:li:activity:999" }),
      new FakeNode("", { "data-id": "urn:li:comment:(urn:li:activity:999,1)" }),
      new FakeNode("", {}, "", "article"),
      new FakeNode("", {}, "mini-update"),
    ];
    for (const boundary of boundaries) {
      boundary.parentElement = outer;
      outer.children.push(boundary);
      boundary.child(BODY, "update-components-text");
      boundary.child(
        "Impostor",
        "update-components-actor__meta-link",
        "https://www.linkedin.com/in/impostor/",
      );
      boundary.child("video", "video-player");
      boundary.child("more", "button");
    }
    const root = new FakeNode("");
    root.children.push(outer);
    const page = {
      goto: async () => {},
      locator: () => ({
        evaluate: async (fn: (node: FakeNode, arg?: unknown) => unknown, arg?: unknown) =>
          fn(root, arg),
      }),
      waitForTimeout: async () => {},
      evaluate: async () => {},
      screenshot: async () => Buffer.from("png"),
    } as never;

    const result = await inspectLinkedInProfilePost(input(evidenceDir), {
      page,
      skipTeardown: true,
    });
    expect(result).toMatchObject({
      activityId: ID,
      hasNativeVideo: true,
      postBodyLength: BODY.length,
    });
    for (const boundary of boundaries) expect(boundary.children[3]?.clickCount).toBe(0);
  });

  it("records default-recorder labels/counts and keeps overlapping runs isolated", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "li-inspect-overlap-"));
    const firstEvidence = join(rootDir, "first");
    const secondEvidence = join(rootDir, "second");
    const first = inspectLinkedInProfilePost(
      { ...input(firstEvidence), maxScrolls: 1 },
      { page: fakePage(failingRoot("more")), skipTeardown: true },
    );
    const second = inspectLinkedInProfilePost(
      { ...input(secondEvidence), maxScrolls: 1 },
      { page: fakePage(failingRoot("unrelated")), skipTeardown: true },
    );
    const settled = await Promise.allSettled([first, second]);
    expect(settled.map((item) => item.status)).toEqual(["rejected", "rejected"]);
    const firstManifest = JSON.parse(
      readFileSync(join(firstEvidence, "failure-manifest.json"), "utf8"),
    );
    const secondManifest = JSON.parse(
      readFileSync(join(secondEvidence, "failure-manifest.json"), "utf8"),
    );
    expect(firstManifest.expansionClickCounts).toEqual([1, 1]);
    expect(secondManifest.expansionClickCounts).toEqual([0, 0]);
    expect(firstManifest.expanders[0].labels).toContain("more");
    expect(secondManifest.expanders[0].labels).toContain("unrelated");
    expect(statSync(join(firstEvidence, `candidate-${ID}-body.txt`)).mode & 0o777).toBe(0o600);
  });
});

class FakeNode {
  parentElement: FakeNode | null = null;
  children: FakeNode[] = [];
  tagName = "div";
  href?: string;
  clickCount = 0;
  appendCount = 0;

  constructor(
    public innerText: string,
    private readonly attrs: Record<string, string> = {},
    readonly className = "",
    tagName = "div",
  ) {
    this.tagName = tagName;
  }

  child(
    text: string,
    className = "",
    href?: string,
    permalink?: string,
    onClick?: () => void,
    attrs: Record<string, string> = {},
  ): FakeNode {
    const node = new FakeNode(text, attrs, className);
    node.parentElement = this;
    if (href) node.href = href;
    if (permalink) node.href = permalink;
    node.onClick = onClick;
    this.children.push(node);
    return node;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  appendChild(node: FakeNode): void {
    node.parentElement = this;
    this.children.push(node);
    this.appendCount += 1;
  }

  get attrsForTest(): Record<string, string> {
    return this.attrs;
  }

  click(): void {
    this.clickCount += 1;
    this.onClick?.();
  }

  cloneNode(deep = false): FakeNode {
    const clone = new FakeNode(this.innerText, { ...this.attrs }, this.className, this.tagName);
    clone.href = this.href;
    if (deep) {
      for (const child of this.children) {
        const childClone = child.cloneNode(true);
        childClone.parentElement = clone;
        clone.children.push(childClone);
      }
    }
    return clone;
  }

  remove(): void {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    parent.children = parent.children.filter((child) => child !== this);
    if (this.className.includes("button") && parent.innerText.endsWith("\n...more")) {
      parent.innerText = parent.innerText.slice(0, -8);
    }
    this.parentElement = null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    const descendants = (node: FakeNode): FakeNode[] =>
      node.children.flatMap((child) => [child, ...descendants(child)]);
    return descendants(this).filter((node) => {
      if (selector.includes("urn:li:activity"))
        return /urn:li:activity:/.test(
          node.getAttribute("data-urn") ?? node.getAttribute("data-id") ?? "",
        );
      if (selector.includes("update-components-text"))
        return node.className.includes("update-components-text");
      if (selector.includes("update-components-actor"))
        return (
          node.className.includes("update-components-actor") && Boolean(node.href?.includes("/in/"))
        );
      if (selector === "a[href*='/posts/']") return Boolean(node.href?.includes("/posts/"));
      if (selector.startsWith("video")) return node.className.includes("video-player");
      if (selector === "button") return node.className.includes("button");
      if (selector.includes("button")) return node.className.includes("button");
      if (selector === "link[rel='canonical']")
        return node.tagName === "link" && node.getAttribute("rel") === "canonical";
      if (selector === "meta[property='og:url']")
        return node.tagName === "meta" && node.getAttribute("property") === "og:url";
      return false;
    });
  }

  private onClick?: () => void;
}

function failingRoot(label: string): FakeNode {
  const outer = new FakeNode("", { "data-urn": `urn:li:activity:${ID}` });
  outer.child(
    "Building the Binary Is Only the Beginning\n\nDifferent body",
    "update-components-text",
  );
  outer.child("Pavel", "update-components-actor__meta-link", PROFILE);
  outer.child(
    "time",
    "",
    undefined,
    `https://www.linkedin.com/posts/pavelvalentov_post-activity-${ID}-AbCd`,
  );
  outer.child("video", "video-player");
  outer.child(label, "button");
  const root = new FakeNode("");
  root.children.push(outer);
  return root;
}

function fakePage(root: FakeNode) {
  return {
    goto: async () => {},
    locator: () => ({
      evaluate: async (fn: (node: FakeNode, arg?: unknown) => unknown, arg?: unknown) =>
        fn(root, arg),
    }),
    waitForTimeout: async () => {},
    evaluate: async () => {},
    screenshot: async () => Buffer.from("png"),
  } as never;
}
