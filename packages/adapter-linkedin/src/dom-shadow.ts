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
  // `publish.ts` marks the exact composer container resolved from its editor.
  // Counting only below that marker avoids false positives from feed players,
  // messaging dialogs, or unrelated media modals.
  const SCOPE = "[data-arcanada-publish-composer='true']";
  return `(function(){
    function walk(root, visit){ visit(root); var e=root.querySelectorAll?root.querySelectorAll('*'):[]; for(var i=0;i<e.length;i++) if(e[i].shadowRoot) walk(e[i].shadowRoot, visit); }
    function collectDeep(root, selector, found){
      try { var matches=root.querySelectorAll(selector); for(var m=0;m<matches.length;m++) found.add(matches[m]); } catch(e){}
      if(root.shadowRoot) collectDeep(root.shadowRoot, selector, found);
      var elements=[];
      try { elements=root.querySelectorAll('*'); } catch(e){}
      for(var i=0;i<elements.length;i++){
        if(elements[i].shadowRoot) collectDeep(elements[i].shadowRoot, selector, found);
      }
    }
    var scopeSel = ${JSON.stringify(SCOPE)};
    var videos=new Set();
    walk(document, function(r){
      var scopes=[];
      try { scopes=r.querySelectorAll(scopeSel); } catch(e){}
      for(var i=0;i<scopes.length;i++){
        collectDeep(scopes[i], 'video', videos);
      }
    });
    return videos.size;
  })()`;
}

/**
 * Count an exact pre-publish media attachment inside the marked composer.
 * LinkedIn's 2026 video composer commonly renders a filename/size card before
 * upload rather than a <video> element. At this stage the editor is still empty,
 * so an exact validated basename inside the unique marked composer is a bounded
 * attachment oracle. A real <video> preview remains accepted when present.
 */
export function scopedMediaAttachmentCountJs(expectedBasename: string): string {
  const SCOPE = "[data-arcanada-publish-composer='true']";
  return `(function(){
    function walk(root, visit){ visit(root); var e=root.querySelectorAll?root.querySelectorAll('*'):[]; for(var i=0;i<e.length;i++) if(e[i].shadowRoot) walk(e[i].shadowRoot, visit); }
    function collectDeep(root, found){
      var elements=[]; try { elements=root.querySelectorAll('*'); } catch(e){}
      for(var i=0;i<elements.length;i++){
        found.add(elements[i]);
        if(elements[i].shadowRoot) collectDeep(elements[i].shadowRoot, found);
      }
      if(root.shadowRoot) collectDeep(root.shadowRoot, found);
    }
    var scopes=new Set();
    walk(document, function(root){
      var found=[]; try { found=root.querySelectorAll(${JSON.stringify(SCOPE)}); } catch(e){}
      for(var i=0;i<found.length;i++) scopes.add(found[i]);
    });
    if(scopes.size!==1) return 0;
    var nodes=new Set(); collectDeep(Array.from(scopes)[0], nodes);
    var expected=${JSON.stringify(expectedBasename)};
    var hasVideo=false, hasImagePreview=false, hasExactName=false;
    nodes.forEach(function(node){
      var tag=(node.tagName||node.tag||'').toLowerCase();
      if(tag==='video') hasVideo=true;
      if(tag==='img'){
        var src=(node.getAttribute&&node.getAttribute('src'))||node.currentSrc||node.src||'';
        var cls=(node.getAttribute&&node.getAttribute('class'))||'';
        if(
          /^blob:/i.test(src)||
          (src.toLowerCase().indexOf('data:image/')===0&&/update-components-image__image/i.test(cls))||
          /media|share-image|image-preview/i.test(src+' '+cls)
        ) hasImagePreview=true;
      }
      var text=(node.textContent||node.innerText||'').trim();
      var lines=text.split(/\\r?\\n/).map(function(line){ return line.trim(); });
      if(lines.indexOf(expected)!==-1) hasExactName=true;
    });
    return hasVideo||hasImagePreview||hasExactName ? 1 : 0;
  })()`;
}

/** Read-only, path-free diagnostic for attachment-oracle drift. */
export function scopedMediaAttachmentDiagnosticsJs(expectedBasename: string): string {
  const SCOPE = "[data-arcanada-publish-composer='true']";
  return `(function(){
    function walk(root, visit){ visit(root); var e=root.querySelectorAll?root.querySelectorAll('*'):[]; for(var i=0;i<e.length;i++) if(e[i].shadowRoot) walk(e[i].shadowRoot, visit); }
    var scopes=new Set();
    walk(document, function(root){
      var found=[]; try { found=root.querySelectorAll(${JSON.stringify(SCOPE)}); } catch(e){}
      for(var i=0;i<found.length;i++) scopes.add(found[i]);
    });
    var expected=${JSON.stringify(expectedBasename)};
    var hits=[];
    scopes.forEach(function(scope){
      walk(scope, function(root){
        var nodes=[]; try { nodes=root.querySelectorAll('*'); } catch(e){}
        for(var i=0;i<nodes.length;i++){
          var text=(nodes[i].textContent||nodes[i].innerText||'').trim();
          if(text.indexOf(expected)!==-1 && hits.length<20){
            hits.push({
              tag:(nodes[i].tagName||'').toLowerCase(),
              text:text.slice(0,200),
              childCount:nodes[i].children?nodes[i].children.length:0,
              shadow:!!nodes[i].shadowRoot
            });
          }
        }
      });
    });
    return {scopeCount:scopes.size, hitCount:hits.length, hits:hits};
  })()`;
}

/** Mark the exact post composer by walking upward from its resolved editor. */
export function markComposerScopeJs(): string {
  return `(element => {
    var POST=/^(Post|Posten|Veröffentlichen|Опубликовать|Julkaise|Teilen)$/i;
    function collectButtons(root, found){
      var buttons=[];
      try { buttons=root.querySelectorAll('button, [role=button]'); } catch(e){}
      for(var b=0;b<buttons.length;b++){
        var label=(buttons[b].getAttribute('aria-label')||buttons[b].innerText||'').trim();
        var visible=typeof buttons[b].offsetWidth!=='number'||typeof buttons[b].offsetHeight!=='number'||buttons[b].offsetWidth+buttons[b].offsetHeight>0;
        if(visible&&POST.test(label)) found.add(buttons[b]);
      }
      if(root.shadowRoot) collectButtons(root.shadowRoot, found);
      var elements=[];
      try { elements=root.querySelectorAll('*'); } catch(e){}
      for(var i=0;i<elements.length;i++) if(elements[i].shadowRoot) collectButtons(elements[i].shadowRoot, found);
    }
    var current=element;
    var inShadow=!!(element.getRootNode && element.getRootNode().host);
    var stopAfterCurrent=false;
    while(current){
      var controls=new Set();
      collectButtons(current, controls);
      var semantic=!!(current.matches && current.matches("[role='dialog'], .share-creation-state, .share-box"));
      var tag=(current.tagName||'').toUpperCase();
      var role=(current.getAttribute&&current.getAttribute('role')||'').toLowerCase();
      var broad=tag==='BODY'||tag==='HTML'||tag==='MAIN'||role==='application'||role==='main';
      if(!broad&&typeof window!=='undefined'&&current.getBoundingClientRect){
        var rect=current.getBoundingClientRect();
        broad=rect.width>=window.innerWidth*0.95&&rect.height>=window.innerHeight*0.95;
      }
      if(controls.size===1 && broad) return false;
      if(controls.size===1 && (inShadow || semantic)){
        current.setAttribute("data-arcanada-publish-composer", "true");
        return true;
      }
      if(controls.size>1) return false;
      if(stopAfterCurrent) return false;
      if(current.parentElement){
        current=current.parentElement;
        continue;
      }
      var root=current.getRootNode ? current.getRootNode() : null;
      if(!root || !root.host) return false;
      current=root.host;
      inShadow=true;
      var hostRoot=current.getRootNode ? current.getRootNode() : null;
      stopAfterCurrent=!(hostRoot && hostRoot.host);
    }
    return false;
  })`;
}

/** Click the unique enabled Post control inside the exact marked composer. */
export function shadowClickComposerButtonJs(patternSrc: string): string {
  return `(function(){
    function walk(root, visit){ visit(root); var e=root.querySelectorAll?root.querySelectorAll('*'):[]; for(var i=0;i<e.length;i++) if(e[i].shadowRoot) walk(e[i].shadowRoot, visit); }
    function collectDeep(root, found){
      var buttons=[]; try { buttons=root.querySelectorAll('button, [role=button]'); } catch(e){}
      var RE=${patternSrc};
      for(var b=0;b<buttons.length;b++){
        var button=buttons[b];
        var label=(button.getAttribute('aria-label')||button.innerText||'').trim();
        var visible=typeof button.offsetWidth!=='number'||typeof button.offsetHeight!=='number'||button.offsetWidth+button.offsetHeight>0;
        if(visible && RE.test(label) && !button.disabled && button.getAttribute('aria-disabled')!=='true') found.add(button);
      }
      if(root.shadowRoot) collectDeep(root.shadowRoot, found);
      var elements=[]; try { elements=root.querySelectorAll('*'); } catch(e){}
      for(var i=0;i<elements.length;i++) if(elements[i].shadowRoot) collectDeep(elements[i].shadowRoot, found);
    }
    var scopes=[];
    walk(document, function(root){
      var found=[]; try { found=root.querySelectorAll("[data-arcanada-publish-composer='true']"); } catch(e){}
      for(var i=0;i<found.length;i++) scopes.push(found[i]);
    });
    if(scopes.length!==1) return false;
    var controls=new Set(); collectDeep(scopes[0], controls);
    if(controls.size!==1) return false;
    var hit=Array.from(controls)[0]; hit.click(); return true;
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
