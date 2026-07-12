import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@arcanada/publisher-core";
import {
  expandMatchingLinkedInActivity,
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
  return {
    page: {
      goto: async () => {},
      screenshot: async () => Buffer.from("png"),
    } as never,
    skipTeardown: true,
    __recorder: {
      scanLoadedPosts: async () => batches[Math.min(scan++, batches.length - 1)] ?? [],
      scroll: async () => {},
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
      `https://www.linkedin.com/posts/pavel_post-activity-${ID}-AbCd`,
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
});

class FakeNode {
  parentElement: FakeNode | null = null;
  children: FakeNode[] = [];
  tagName = "div";
  href?: string;
  clickCount = 0;

  constructor(
    readonly innerText: string,
    private readonly attrs: Record<string, string> = {},
    readonly className = "",
  ) {}

  child(text: string, className = "", href?: string, permalink?: string): FakeNode {
    const node = new FakeNode(text, {}, className);
    node.parentElement = this;
    if (href) node.href = href;
    if (permalink) node.href = permalink;
    this.children.push(node);
    return node;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  click(): void {
    this.clickCount += 1;
  }

  querySelectorAll(selector: string): FakeNode[] {
    const descendants = (node: FakeNode): FakeNode[] =>
      node.children.flatMap((child) => [child, ...descendants(child)]);
    return descendants(this).filter((node) => {
      if (selector.includes("urn:li:activity"))
        return /urn:li:activity:/.test(node.getAttribute("data-urn") ?? "");
      if (selector.includes("update-components-text"))
        return node.className.includes("update-components-text");
      if (selector.includes("update-components-actor"))
        return (
          node.className.includes("update-components-actor") && Boolean(node.href?.includes("/in/"))
        );
      if (selector === "a[href*='/posts/']") return Boolean(node.href?.includes("/posts/"));
      if (selector.startsWith("video")) return node.className.includes("video-player");
      if (selector === "button") return node.className.includes("button");
      return false;
    });
  }
}
