import { describe, it, expect } from "vitest";
import {
  shadowClickButtonJs,
  shadowCountJs,
  scopedVideoCountJs,
  shadowFindActivityUrnJs,
} from "../src/dom-shadow.js";

// The walkers are JS *source strings* run via page.evaluate in the browser. We
// prove their logic here by executing the source against a hand-built fake DOM
// (no Playwright / no real browser). The fakes mimic just enough of the DOM
// surface the walkers touch: querySelectorAll, getAttribute, innerText,
// offsetWidth/Height, shadowRoot, disabled.

/** Minimal fake element. */
function el(opts: {
  tag?: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  visible?: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  dataUrn?: string;
  children?: FakeEl[];
  shadow?: FakeEl[];
  clicks?: { n: number };
}): FakeEl {
  return new FakeEl(opts);
}

interface ElOpts {
  tag?: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  visible?: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  dataUrn?: string;
  children?: FakeEl[];
  shadow?: FakeEl[];
  clicks?: { n: number };
}

class FakeEl {
  tag: string;
  role?: string;
  ariaLabel?: string;
  innerText: string;
  offsetWidth: number;
  offsetHeight: number;
  disabled: boolean;
  ariaDisabled: boolean;
  dataUrn?: string;
  children: FakeEl[];
  shadowRoot: FakeRoot | null;
  clicks: { n: number };

  constructor(o: ElOpts) {
    this.tag = (o.tag ?? "div").toLowerCase();
    this.role = o.role;
    this.ariaLabel = o.ariaLabel;
    this.innerText = o.text ?? "";
    const vis = o.visible !== false;
    this.offsetWidth = vis ? 10 : 0;
    this.offsetHeight = vis ? 10 : 0;
    this.disabled = o.disabled ?? false;
    this.ariaDisabled = o.ariaDisabled ?? false;
    this.dataUrn = o.dataUrn;
    this.children = o.children ?? [];
    this.shadowRoot = o.shadow ? new FakeRoot(o.shadow) : null;
    this.clicks = o.clicks ?? { n: 0 };
  }

  getAttribute(name: string): string | null {
    if (name === "aria-label") return this.ariaLabel ?? null;
    if (name === "aria-disabled") return this.ariaDisabled ? "true" : null;
    if (name === "data-urn") return this.dataUrn ?? null;
    if (name === "data-id") return null;
    return null;
  }

  click(): void {
    this.clicks.n += 1;
  }

  /** depth-first descendants (this excluded), used to build root query results. */
  descendants(): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      out.push(c, ...c.descendants());
    }
    return out;
  }

  /** Element-scoped query (real DOM elements expose this) — scopedVideoCountJs
   *  calls `scopeEl.querySelectorAll('video')` to count only nested videos. */
  querySelectorAll(sel: string): FakeEl[] {
    return this.descendants().filter((n) => n.matches(sel));
  }

  matches(sel: string): boolean {
    // Tiny matcher: supports tag, [role=button], [data-urn*='...'], 'video',
    // and the comma-separated scope selectors used by scopedVideoCountJs.
    return sel.split(",").some((part) => this.matchesOne(part.trim()));
  }

  private matchesOne(sel: string): boolean {
    if (sel === "*") return true;
    if (sel === this.tag) return true;
    if (sel === "button" && this.tag === "button") return true;
    if (sel === "[role=button]" && this.role === "button") return true;
    if (sel === "[role=menuitem]" && this.role === "menuitem") return true;
    const urn = /\[data-urn\*='([^']+)'\]/.exec(sel) || /\[data-id\*='([^']+)'\]/.exec(sel);
    if (urn) return !!this.dataUrn && this.dataUrn.includes(urn[1]);
    // class scope selectors (.media-editor etc.) — match via role hint we stash
    // in innerText sentinel "scope:<class>" for test purposes.
    if (sel.startsWith(".") || sel.startsWith("[")) {
      return this.innerText.includes(`scope:${sel}`);
    }
    return false;
  }
}

class FakeRoot {
  private nodes: FakeEl[];
  constructor(top: FakeEl[]) {
    // a root's queryable set = the top-level nodes plus all their descendants.
    this.nodes = [];
    for (const t of top) this.nodes.push(t, ...t.descendants());
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.nodes.filter((n) => n.matches(sel));
  }
  // a root iterating "*" must expose every node so the walker can find shadowRoots
  forEachNode(): FakeEl[] {
    return this.nodes;
  }
}

/** Run a walker source against a fake `document` whose top-level is `top`. */
function run(source: string, top: FakeEl[]): unknown {
  const root = new FakeRoot(top);
  // The walker references `document`. We provide a document-shaped object whose
  // querySelectorAll delegates to the root, and whose '*' yields nodes so the
  // walker can descend into shadowRoot-bearing elements.
  const documentShim = {
    querySelectorAll: (sel: string) => {
      if (sel === "*") return root.forEachNode();
      return root.querySelectorAll(sel);
    },
  };
  // FakeEl already exposes querySelectorAll? No — the walker calls
  // r.querySelectorAll on roots only (document + shadowRoot). Each FakeEl with a
  // shadowRoot exposes `.shadowRoot` which is a FakeRoot. Give FakeRoot the '*'
  // behaviour too.
  patchRootStar(root);
  const fn = new Function("document", `return (${source});`);
  return fn(documentShim);
}

function patchRootStar(_root: FakeRoot): void {
  // FakeRoot.querySelectorAll already handles '*'? It filters by matches('*')
  // which returns true for all — good. Shadow roots are FakeRoot too. No-op.
}

describe("dom-shadow — shadowClickButtonJs", () => {
  it("clicks the first visible enabled button whose text matches the regex", () => {
    const clicks = { n: 0 };
    const target = el({ tag: "button", text: "Posten", clicks });
    const top = [el({ tag: "button", text: "Cancel" }), target];
    const r = run(shadowClickButtonJs("/^(Post|Posten)$/i"), top);
    expect(r).toBe(true);
    expect(clicks.n).toBe(1);
  });

  it("skips disabled buttons and returns false when none enabled match", () => {
    const clicks = { n: 0 };
    const disabled = el({ tag: "button", text: "Post", disabled: true, clicks });
    const r = run(shadowClickButtonJs("/^Post$/"), [disabled]);
    expect(r).toBe(false);
    expect(clicks.n).toBe(0);
  });

  it("matches a control by aria-label across a shadow root", () => {
    const clicks = { n: 0 };
    const inShadow = el({ tag: "button", ariaLabel: "Mehr Aktionen", clicks });
    const host = el({ tag: "div", shadow: [inShadow] });
    const r = run(shadowClickButtonJs("/(More actions|Mehr Aktionen)/i"), [host]);
    expect(r).toBe(true);
    expect(clicks.n).toBe(1);
  });

  it("matches a role=menuitem (Delete menu item) — not just buttons", () => {
    const clicks = { n: 0 };
    const item = el({ tag: "li", role: "menuitem", text: "Löschen", clicks });
    const r = run(shadowClickButtonJs("/^(Delete|Löschen|Удалить)$/"), [item]);
    expect(r).toBe(true);
    expect(clicks.n).toBe(1);
  });
});

describe("dom-shadow — shadowFindActivityUrnJs", () => {
  it("extracts the activity URN from a data-urn attribute across shadow roots", () => {
    const node = el({
      tag: "div",
      dataUrn: "urn:li:activity:7462962260978642944",
    });
    const host = el({ tag: "section", shadow: [node] });
    const r = run(shadowFindActivityUrnJs(), [host]);
    expect(r).toBe("urn:li:activity:7462962260978642944");
  });

  it("returns empty string when no activity container exists", () => {
    const r = run(shadowFindActivityUrnJs(), [el({ tag: "div", text: "no urn here" })]);
    expect(r).toBe("");
  });
});

describe("dom-shadow — scopedVideoCountJs (fail-closed video detection)", () => {
  it("counts a <video> INSIDE a media-editor scope", () => {
    const video = el({ tag: "video" });
    const scope = el({
      tag: "div",
      text: "scope:.media-editor",
      children: [video],
    });
    const r = run(scopedVideoCountJs(), [scope]);
    expect(r).toBe(1);
  });

  it("does NOT count a <video> OUTSIDE any composer scope (false-positive guard)", () => {
    // An unrelated feed/profile video must not be counted — the old detector
    // matched page-wide and published text-only on a false positive.
    const strayVideo = el({ tag: "video", text: "feed ad player" });
    const r = run(scopedVideoCountJs(), [strayVideo]);
    expect(r).toBe(0);
  });

  it("counts a <video> nested inside a dialog scope across a shadow root", () => {
    const video = el({ tag: "video" });
    const dialog = el({ tag: "div", text: "scope:[role='dialog']", children: [video] });
    const host = el({ tag: "div", shadow: [dialog] });
    const r = run(scopedVideoCountJs(), [host]);
    expect(r).toBe(1);
  });
});

describe("dom-shadow — shadowCountJs", () => {
  it("counts matching elements across the tree", () => {
    const r = run(shadowCountJs("video"), [el({ tag: "video" }), el({ tag: "video" })]);
    expect(r).toBe(2);
  });
});
