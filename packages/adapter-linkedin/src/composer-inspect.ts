import { type Page } from "playwright";
import { ProfileManager } from "@arcanada/publisher-core";
import { launchSession } from "./context.js";
import { cssSelectors, selectors } from "./selectors.js";

const LINKEDIN_FEED = "https://www.linkedin.com/feed/";

export interface ComposerInspectOptions {
  profileManager?: ProfileManager;
  page?: Page;
}

export interface ComposerDiagnostics {
  editorAncestors: unknown[];
  postControls: unknown[];
  candidates: unknown[];
}

export async function inspectComposer(
  profile: string,
  options: ComposerInspectOptions = {},
): Promise<ComposerDiagnostics> {
  const profiles = options.profileManager ?? new ProfileManager();
  const profileDir = profiles.ensureProfileExists("linkedin", profile);
  if (options.page) return runInspect(options.page);
  const session = await launchSession({ profileDir });
  try {
    return await runInspect(session.page);
  } finally {
    await session.close();
  }
}

async function runInspect(page: Page): Promise<ComposerDiagnostics> {
  await page.goto(LINKEDIN_FEED, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_500);
  const css = page.locator(cssSelectors.startPostButton).first();
  const named = page.getByRole("button", { name: selectors.startPostButton }).first();
  let trigger = css;
  try {
    await css.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    await named.waitFor({ state: "visible", timeout: 10_000 });
    trigger = named;
  }
  await trigger.click();
  const editorCss = page.locator(cssSelectors.editor).first();
  const editor =
    (await editorCss.count()) > 0
      ? editorCss
      : page.getByRole("textbox", { name: selectors.editor }).first();
  await editor.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(1_000);
  return (await editor.evaluate(composerDomProbeInvocationJs())) as ComposerDiagnostics;
}

export function composerDomProbeInvocationJs(): string {
  return `element => (${composerDomProbeJs()})(element)`;
}

export function composerDomProbeJs(): string {
  return `(editor => {
    var POST=/^(Post|Posten|Veröffentlichen|Опубликовать|Julkaise|Teilen)$/i;
    function rect(el){ var r=el.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}; }
    function desc(el){
      var rawRole=(el.getAttribute&&el.getAttribute('role')||'').toLowerCase();
      var knownRoles=['dialog','textbox','button','main','application','presentation'];
      var safeClasses=['ql-editor','share-box','share-creation-state','artdeco-modal','tiptap','ProseMirror','media-editor'];
      var classes=Array.from(el.classList||[]).filter(function(v){return safeClasses.indexOf(v)>=0;});
      return {tag:(el.tagName||'').toLowerCase(),idPresent:!!el.id,classes:classes,classCount:(el.classList||[]).length,attrs:{role:knownRoles.indexOf(rawRole)>=0?rawRole:(rawRole?'other':null),ariaModal:(el.getAttribute&&el.getAttribute('aria-modal'))==='true',contenteditable:(el.getAttribute&&el.getAttribute('contenteditable'))==='true',dataTestModalPresent:!!(el.hasAttribute&&el.hasAttribute('data-test-modal')),dataTestIdPresent:!!(el.hasAttribute&&el.hasAttribute('data-test-id'))},rect:rect(el),shadowHost:!!el.shadowRoot};
    }
    function chain(el){ var out=[]; var cur=el; while(cur&&out.length<40){ out.push(cur); if(cur.parentElement){cur=cur.parentElement;}else{var root=cur.getRootNode&&cur.getRootNode();cur=root&&root.host?root.host:null;} } return out; }
    function walk(root, out){ var nodes=[]; try{nodes=root.querySelectorAll('button, [role=button]');}catch(e){}; for(var i=0;i<nodes.length;i++) out.add(nodes[i]); var all=[]; try{all=root.querySelectorAll('*');}catch(e){}; for(var j=0;j<all.length;j++) if(all[j].shadowRoot) walk(all[j].shadowRoot,out); }
    var editorChain=chain(editor); var buttons=new Set(); walk(document,buttons); var posts=[];
    buttons.forEach(function(button){ var label=(button.getAttribute('aria-label')||button.innerText||'').trim(); var visible=button.offsetWidth+button.offsetHeight>0; if(visible&&POST.test(label)) posts.push(button); });
    var candidates=posts.map(function(post,index){ var pc=chain(post); var lca=null,ed=-1,pd=-1; for(var i=0;i<editorChain.length&&!lca;i++){ var j=pc.indexOf(editorChain[i]); if(j>=0){lca=editorChain[i];ed=i;pd=j;} } return {postIndex:index,editorDepth:ed,postDepth:pd,lca:lca?desc(lca):null}; });
    return {editorAncestors:editorChain.map(desc),postControls:posts.map(function(p,i){return {index:i,node:desc(p),ancestors:chain(p).map(desc)};}),candidates:candidates};
  })`;
}
