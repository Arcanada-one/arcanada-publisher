// PUB-0031 / PUB-0032: shared shadow-DOM walkers for the 2026 LinkedIn UI.
//
// LinkedIn mounts much of its composer / post-menu chrome inside an open shadow
// root (`<div id="interop-outlet">`). A Playwright pointer-click on a control
// inside that tree is intercepted ("interop-outlet intercepts pointer events"),
// and a plain `document.querySelector` does not pierce the shadow boundary. The
// reliable approach is to walk every shadow root from `document` down and either
// `.click()` the matching control from INSIDE the tree (via `evaluate`) or count
// matching nodes for a fail-closed presence assertion.
//
// These were originally a private closure inside `publish.ts`. PUB-0032 needs the
// same locale-tolerant DOM-click for the post control-menu (delete) and the
// comment composer, so the walkers live here as a single source of truth. The
// builders return JS *source strings* meant for `page.evaluate(...)` — they take
// no Node-side closures and run wholly in the browser context.

/**
 * Build a `page.evaluate` source that walks all shadow roots and clicks the first
 * visible, enabled `button` / `[role=button]` whose accessible name or inner text
 * matches `patternSrc` (a JS regex literal source, e.g. `"/^(Post|Posten)$/i"`).
 * Returns `true` when a control was clicked, `false` when none matched — so the
 * caller can poll while a control is still disabled / not yet rendered.
 */
export function shadowClickButtonJs(patternSrc: string): string {
  return `(function(){
    function walk(root, visit){ visit(root); var e=root.querySelectorAll?root.querySelectorAll('*'):[]; for(var i=0;i<e.length;i++) if(e[i].shadowRoot) walk(e[i].shadowRoot, visit); }
    var RE = ${patternSrc};
    var hit=null;
    walk(document, function(r){
      if(hit) return;
      var btns=r.querySelectorAll('button, [role=button], [role=menuitem]');
      for(var i=0;i<btns.length;i++){
        var b=btns[i];
        var vis=b.offsetWidth+b.offsetHeight>0; if(!vis||b.disabled||b.getAttribute('aria-disabled')==='true') continue;
        var lbl=(b.getAttribute('aria-label')||'').trim();
        var txt=(b.innerText||'').trim();
        if(RE.test(lbl)||RE.test(txt)){ hit=b; return; }
      }
    });
    if(!hit) return false;
    hit.click();
    return true;
  })()`;
}

/**
 * Build a `page.evaluate` source that counts elements matching `cssSelector`
 * across every shadow root (shadow-aware `querySelectorAll().length`). Use for a
 * fail-closed presence assertion (e.g. "a `<video>` exists *inside the composer*"
 * — see `scopedCountJs` for the scoped variant).
 */
export function shadowCountJs(cssSelector: string): string {
  return `(function(){
    function walk(root, visit){ visit(root); var e=root.querySelectorAll?root.querySelectorAll('*'):[]; for(var i=0;i<e.length;i++) if(e[i].shadowRoot) walk(e[i].shadowRoot, visit); }
    var n=0;
    walk(document, function(r){
      try { n += r.querySelectorAll(${JSON.stringify(cssSelector)}).length; } catch(e){}
    });
    return n;
  })()`;
}

/**
 * PUB-0031 (fail-closed video detection): count `<video>` elements that live
 * INSIDE a composer / media-editor container, NOT anywhere on the page. The old
 * detector matched `video` page-wide, so an unrelated `<video>` (feed ad, profile
 * hero, suggested post) produced a FALSE positive and the post published
 * text-only. This walker descends shadow roots, finds the media-editor / composer
 * scope, and counts only `<video>` nodes within it. Returns 0 when no scoped
 * video exists — the caller treats 0 as "not attached" and aborts.
 */
export function scopedVideoCountJs(): string {
  // Containers observed in the 2026 composer media sub-modal. Structural hooks
  // first (locale-independent); we only count <video> that descends from one.
  const SCOPES = [
    "[data-test-media-preview]",
    ".media-editor",
    ".image-selector",
    ".share-creation-state",
    "[role='dialog']",
    ".share-box",
  ];
  return `(function(){
    function walk(root, visit){ visit(root); var e=root.querySelectorAll?root.querySelectorAll('*'):[]; for(var i=0;i<e.length;i++) if(e[i].shadowRoot) walk(e[i].shadowRoot, visit); }
    var scopeSels = ${JSON.stringify(SCOPES)};
    var n=0;
    walk(document, function(r){
      for(var s=0;s<scopeSels.length;s++){
        var scopes;
        try { scopes = r.querySelectorAll(scopeSels[s]); } catch(e){ continue; }
        for(var i=0;i<scopes.length;i++){
          try { n += scopes[i].querySelectorAll('video').length; } catch(e){}
        }
      }
    });
    return n;
  })()`;
}

/**
 * Build a `page.evaluate` source that resolves the LinkedIn activity container in
 * the current DOM, walking shadow roots and preferring structural `data-urn` /
 * `data-id` hooks over a localized `<article>`. Returns the activity URN string
 * (`urn:li:activity:<id>`) when found, else "". PUB-0032: the delete-target
 * container selector drifted; this structural resolver replaces the brittle
 * `[data-urn*="urn:li:activity"], article` Playwright locator.
 */
export function shadowFindActivityUrnJs(): string {
  return `(function(){
    function walk(root, visit){ visit(root); var e=root.querySelectorAll?root.querySelectorAll('*'):[]; for(var i=0;i<e.length;i++) if(e[i].shadowRoot) walk(e[i].shadowRoot, visit); }
    var found="";
    walk(document, function(r){
      if(found) return;
      var sel="[data-urn*='urn:li:activity'], [data-id*='urn:li:activity']";
      var nodes;
      try { nodes = r.querySelectorAll(sel); } catch(e){ return; }
      for(var i=0;i<nodes.length;i++){
        var raw=(nodes[i].getAttribute('data-urn')||nodes[i].getAttribute('data-id')||'');
        var m=/urn:li:activity:\\d+/.exec(raw);
        if(m){ found=m[0]; return; }
      }
    });
    return found;
  })()`;
}
