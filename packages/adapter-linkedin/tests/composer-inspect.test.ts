import { describe, expect, it } from "vitest";
import { composerDomProbeJs } from "../src/composer-inspect.js";

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
});
