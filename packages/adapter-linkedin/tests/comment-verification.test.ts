import { describe, expect, it, vi } from "vitest";
import { readExactCommentMatches } from "../src/comment.js";
import { matchesElidedTextSource } from "../src/elided-text.js";

describe("LinkedIn comment verification browser boundary", () => {
  it("injects the canonical matcher source and retains broad DOM discovery", async () => {
    const evaluate = vi.fn(async (source: unknown, arg: unknown) => {
      expect(typeof source).toBe("function");
      const sourceText = String(source);
      expect(sourceText).toContain('querySelectorAll("*")');
      expect(sourceText).toContain("body");
      expect((arg as { matcherSource: string }).matcherSource).toBe(matchesElidedTextSource);
      return [{ text: "rendered", id: "9001" }];
    });
    const matches = await readExactCommentMatches({ evaluate } as never, "expected long URL body");
    expect(matches).toEqual([{ text: "rendered", id: "9001" }]);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("executes the page callback in a live-shaped DOM and keeps the elided target id", async () => {
    const matches = await readFromFakePage([
      commentNode("9001", "Pavel Valentov", RENDERED_BODY),
      commentNode("9002", "Another Person", FOREIGN_BODY),
      commentNode("9003", "Keeper Person", KEEPER_BODY),
    ]);

    expect(matches).toEqual([{ text: ORACLE_BODY, id: "9001" }]);
  });

  it("does not return a foreign-author comment when its rendered body is different", async () => {
    const matches = await readFromFakePage([
      commentNode("9001", "Pavel Valentov", RENDERED_BODY),
      commentNode("9002", "Another Person", FOREIGN_BODY),
    ]);

    expect(matches.map((match) => match.id)).toEqual(["9001"]);
    expect(matches.some((match) => match.id === "9002")).toBe(false);
  });

  it("rejects a keeper whose body only contains the oracle as a subsequence", async () => {
    const matches = await readFromFakePage([commentNode("9003", "Keeper Person", KEEPER_BODY)]);

    expect(matches).toEqual([]);
  });

  it("returns both exact matches so the caller can see ambiguity", async () => {
    const matches = await readFromFakePage([
      commentNode("9001", "Pavel Valentov", RENDERED_BODY),
      commentNode("9004", "Pavel Valentov", RENDERED_BODY),
    ]);

    expect(matches).toEqual([
      { text: ORACLE_BODY, id: "9001" },
      { text: ORACLE_BODY, id: "9004" },
    ]);
  });
});

const ORACLE_BODY = [
  "Article: https://host.example/very-long-path/tail",
  "Source: https://github.com/Arcanada-one/publisher",
].join("\n");

// LinkedIn's rendered text keeps the visible prefix and suffix while eliding
// the middle of a long URL. These nodes deliberately use generic rendered
// classes and a data-urn ancestor: the known comment selectors return zero on
// the live surface, while the broad `*` walk still sees this structure.
const RENDERED_BODY = [
  "Article: https://host.example/.../tail",
  "Source: https://github.com/Arcanada-one/publisher",
].join("\n");

const FOREIGN_BODY = [
  "Article: https://host.example/.../tail",
  "Source: https://github.com/another-account/publisher",
].join("\n");

const KEEPER_BODY = `${RENDERED_BODY}\nKeeper-only extra line`;

async function readFromFakePage(nodes: FakeNode[]): Promise<Array<{ text: string; id: string }>> {
  const document = new FakeDocument(nodes);
  const evaluate = vi.fn(async (source: unknown, arg: unknown) => {
    const callback = Function("document", `return ${String(source)};`)(document) as (
      value: unknown,
    ) => Array<{ text: string; id: string }>;
    return callback(arg);
  });
  return readExactCommentMatches({ evaluate } as never, ORACLE_BODY);
}

class FakeDocument {
  readonly body: FakeNode;

  constructor(nodes: FakeNode[]) {
    this.body = new FakeNode({ children: nodes });
  }

  querySelectorAll(selector: string): FakeNode[] {
    // The two selectors used by the old implementation intentionally find
    // nothing here. The test therefore exercises the broad live-DOM fallback.
    if (selector !== "*") return [];
    return [this.body, ...this.body.descendants()];
  }
}

class FakeNode {
  parentElement: FakeNode | null;
  readonly children: FakeNode[];
  private readonly ownText: string | undefined;
  private readonly attributes: Map<string, string>;
  readonly tagName: string;

  constructor(options: {
    text?: string;
    tagName?: string;
    className?: string;
    attributes?: Record<string, string>;
    children?: FakeNode[];
    parentElement?: FakeNode | null;
  }) {
    this.ownText = options.text;
    this.tagName = options.tagName ?? "DIV";
    this.attributes = new Map(Object.entries(options.attributes ?? {}));
    if (options.className) this.attributes.set("class", options.className);
    this.parentElement = options.parentElement ?? null;
    this.children = options.children ?? [];
    for (const child of this.children) child.parentElement = this;
  }

  get innerText(): string {
    if (this.ownText !== undefined) return this.ownText;
    return this.children
      .map((child) => child.innerText)
      .filter(Boolean)
      .join("\n");
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.descendants().filter((node) =>
      selector.split(",").some((part) => matchesSelector(node, part.trim())),
    );
  }

  descendants(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

function commentNode(id: string, author: string, body: string): FakeNode {
  return new FakeNode({
    className: "feed-shared-social-comment",
    attributes: { "data-urn": `urn:li:comment:(urn:li:activity:7462962260978642944,${id})` },
    children: [
      new FakeNode({ className: "feed-shared-actor__name", text: `${author} Author` }),
      new FakeNode({ className: "feed-shared-inline-show-more-text", text: body }),
    ],
  });
}

function matchesSelector(node: FakeNode, selector: string): boolean {
  if (selector === "*") return true;
  if (selector === "p") return node.tagName.toLowerCase() === "p";
  if (selector === ".comments-comment-item__main-content")
    return node.getAttribute("class")?.includes("comments-comment-item__main-content") ?? false;
  if (selector === ".comments-comment-item-content-body")
    return node.getAttribute("class")?.includes("comments-comment-item-content-body") ?? false;
  if (selector === ".update-components-text")
    return node.getAttribute("class")?.includes("update-components-text") ?? false;
  if (selector === "[data-testid='comment-content']")
    return node.getAttribute("data-testid") === "comment-content";
  if (selector === "span[dir='ltr']")
    return node.tagName.toLowerCase() === "span" && node.getAttribute("dir") === "ltr";
  if (selector === ".comments-comment-item")
    return node.getAttribute("class")?.includes("comments-comment-item") ?? false;
  if (selector === "[class*='comments-comment-item']")
    return node.getAttribute("class")?.includes("comments-comment-item") ?? false;
  if (selector === "[data-testid='expandable-text-box']")
    return node.getAttribute("data-testid") === "expandable-text-box";
  if (selector === "[data-id^='urn:li:comment']")
    return node.getAttribute("data-id")?.startsWith("urn:li:comment") ?? false;
  return false;
}
