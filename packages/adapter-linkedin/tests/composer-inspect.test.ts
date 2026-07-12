import { describe, expect, it } from "vitest";
import { composerDomProbeInvocationJs, composerDomProbeJs } from "../src/composer-inspect.js";

describe("LinkedIn composer DOM probe", () => {
  it("emits structural diagnostics without serialising page content", () => {
    const source = composerDomProbeJs();
    expect(source).toContain("editorAncestors");
    expect(source).toContain("postControls");
    expect(source).toContain("candidates");
    expect(source).not.toContain("textContent");
    expect(source).not.toContain("outerHTML");
    expect(source).not.toContain("innerHTML");
  });

  it("only exposes an allowlist of stable attributes", () => {
    const source = composerDomProbeJs();
    expect(source).toContain("dataTestModalPresent");
    expect(source).not.toContain("href");
    expect(source).not.toContain("value:");
  });

  it("does not serialize sensitive-looking DOM ids or data-test values", () => {
    const sensitive = "acct_session_9f8e7d6c5b4a";
    const editor = {
      tagName: "DIV",
      id: sensitive,
      classList: ["ql-editor", sensitive],
      parentElement: null,
      shadowRoot: null,
      offsetWidth: 10,
      offsetHeight: 10,
      getBoundingClientRect: () => ({ x: 1, y: 2, width: 300, height: 100 }),
      getAttribute: (name: string) =>
        name === "data-test-id" ? sensitive : name === "role" ? "textbox" : null,
      hasAttribute: (name: string) => name === "data-test-id",
      getRootNode: () => ({ host: null }),
    };
    const document = { querySelectorAll: () => [] };
    const probe = Function("document", `return ${composerDomProbeJs()};`)(document) as (
      element: typeof editor,
    ) => unknown;
    const output = JSON.stringify(probe(editor));
    expect(output).not.toContain(sensitive);
    expect(output).toContain('"idPresent":true');
    expect(output).toContain('"dataTestIdPresent":true');
  });

  it("invokes the probe with the exact locator element", () => {
    const editor = {
      tagName: "DIV",
      id: "",
      classList: [],
      parentElement: null,
      shadowRoot: null,
      offsetWidth: 10,
      offsetHeight: 10,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 50 }),
      getAttribute: () => null,
      hasAttribute: () => false,
      getRootNode: () => ({ host: null }),
    };
    const document = { querySelectorAll: () => [] };
    const invocation = Function(
      "document",
      `return ${composerDomProbeInvocationJs()};`,
    )(document) as (element: typeof editor) => { editorAncestors: unknown[] };
    expect(invocation(editor).editorAncestors).toHaveLength(1);
  });

  it("supports the actual callback-plus-source runtime contract", () => {
    const source = composerDomProbeJs();
    const callback = (element: object, probeSource: string) => {
      const probe = Function(`return ${probeSource}`)() as (node: object) => unknown;
      return probe(element);
    };
    const editor = {
      tagName: "DIV",
      id: "",
      classList: [],
      parentElement: null,
      shadowRoot: null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 50 }),
      getAttribute: () => null,
      hasAttribute: () => false,
      getRootNode: () => ({ host: null }),
    };
    const document = { querySelectorAll: () => [] };
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = globals["document"];
    globals["document"] = document;
    try {
      const result = callback(editor, source) as { editorAncestors: unknown[] };
      expect(result.editorAncestors).toHaveLength(1);
    } finally {
      if (previous === undefined) delete globals["document"];
      else globals["document"] = previous;
    }
  });
});
