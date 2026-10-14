// A delivered page, shown the way its author meant it to run.
//
// The older previews (htmlDeliverable.ts) rebuild a page from an allowlist of elements, which is right for a quick
// static look but takes away what most real pages need: canvas and WebGL until a click, <video>/<audio>, external
// libraries from a CDN, fonts, images by URL. Here the document keeps every element and runs as written, isolated by
// three independent guards instead:
//
//   1. the iframe sandbox has no allow-same-origin: the page runs in an opaque origin and cannot reach AwwO's cookies
//      (SameSite=Lax, never sent cross-site), storage, DOM or API with the session; no top navigation, no popups;
//   2. a Content-Security-Policy injected before anything else in <head>: scripts, styles and fonts only inline or
//      from well-known public CDNs, network requests only to those CDNs, forms never submit anywhere;
//   3. a link guard: following a link would navigate the preview itself away, so the click is stopped and handed to
//      the host (which may offer to open it in a new tab).
//
// Relative URLs (an archive's own files, or a canvas file named by the page) are inlined from bytes the studio has,
// so a multi-file site or a page that uses an image another node generated renders without a server.
import { htmlDocumentSource, PREVIEW_HOST_SCRIPT } from '../htmlDeliverable';
import { loadPreviewLibraries, previewScriptNeeds } from '../previewLibraries';
import { applyModuleEntries, PREVIEW_IMPORT_MAP_KEY } from '../previewImportMap';
import { dataUrl, decodeText, mimeOfName } from './studioData';

/** Public CDNs that pages commonly load libraries, styles and fonts from (including mainland-China mirrors). */
export const LIVE_CDNS = [
  'https://cdn.jsdelivr.net', 'https://fastly.jsdelivr.net', 'https://gcore.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com',
  'https://esm.sh', 'https://esm.run', 'https://cdn.skypack.dev', 'https://ga.jspm.io', 'https://cdn.tailwindcss.com', 'https://cdn.plot.ly',
  'https://d3js.org', 'https://threejs.org', 'https://cdn.babylonjs.com', 'https://aframe.io', 'https://code.jquery.com', 'https://cdn.bootcdn.net',
  'https://cdn.staticfile.net', 'https://cdn.staticfile.org', 'https://lib.baomitu.com', 'https://registry.npmmirror.com', 'https://npm.elemecdn.com',
  'https://unpkg.zhimg.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://fonts.loli.net', 'https://gstatic.loli.net',
] as const;

const CDN_LIST = LIVE_CDNS.join(' ');
export const LIVE_PAGE_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: data: ${CDN_LIST}`,
  `style-src 'unsafe-inline' data: ${CDN_LIST}`,
  `font-src data: blob: ${CDN_LIST}`,
  'img-src data: blob: https:',
  'media-src data: blob: https:',
  `connect-src data: blob: ${CDN_LIST}`,
  'worker-src blob: data:',
  'child-src blob: data:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "manifest-src 'none'",
].join('; ');

/** Sandbox flags of a live page: scripts, forms handled by its own script, dialogs, pointer lock and downloads. */
export const LIVE_PAGE_SANDBOX = 'allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads';
/** Feature policy of a live page's iframe. */
export const LIVE_PAGE_ALLOW = 'fullscreen; autoplay; clipboard-write; gamepad; accelerometer; gyroscope; xr-spatial-tracking';
export const LIVE_LINK_MESSAGE = 'awwo-live-link';

// Runs first in the page: links are handed to the host instead of navigating the preview; a page that asks to be
// printed or closed is left alone. The host checks event.source before acting on the message.
const LINK_GUARD = `(()=>{const send=h=>{try{parent.postMessage({type:'${LIVE_LINK_MESSAGE}',href:String(h).slice(0,2000)},'*')}catch(e){}};`
  + `addEventListener('click',e=>{const a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;const h=a.getAttribute('href')||'';`
  + `if(h.startsWith('#')||h.startsWith('javascript:'))return;e.preventDefault();send(a.href)},true);`
  + `try{window.open=function(u){send(u||'');return null}}catch(e){}})();`;

/** Something a page refers to by a relative URL, and the bytes the studio can put in its place. */
export type AssetResolver = (path: string) => Promise<{ bytes: Uint8Array; name: string } | null>;

const RELATIVE = /^(?![a-z][a-z0-9+.-]*:|\/\/|#|data:|blob:)/i;
const URL_ATTRIBUTES: ReadonlyArray<readonly [string, string]> = [
  ['img', 'src'], ['source', 'src'], ['video', 'src'], ['video', 'poster'], ['audio', 'src'], ['track', 'src'], ['input', 'src'],
  ['image', 'href'], ['use', 'href'], ['link', 'href'], ['script', 'src'], ['embed', 'src'],
];

/** Resolve `path` against `base` (both relative to an archive or canvas root); null for one that leaves the root. */
export function joinPath(base: string, path: string): string | null {
  const clean = path.split(/[?#]/)[0];
  if (!clean) return null;
  const parts = clean.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const segment of clean.replace(/^\/+/, '').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (!parts.length) return null; parts.pop(); continue; }
    try { parts.push(decodeURIComponent(segment)); } catch { parts.push(segment); }
  }
  return parts.join('/') || null;
}

async function inlineCss(css: string, cssPath: string, resolve: AssetResolver, budget: { left: number }): Promise<string> {
  const urls = [...new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map(match => match[2].trim()).filter(url => RELATIVE.test(url)))];
  let result = css;
  for (const url of urls) {
    const path = joinPath(cssPath, url);
    const asset = path ? await resolve(path) : null;
    if (!asset || asset.bytes.length > budget.left) continue;
    budget.left -= asset.bytes.length;
    result = result.split(url).join(dataUrl(asset.bytes, mimeOfName(asset.name)));
  }
  return result;
}

async function inlineModule(source: string, modulePath: string, resolve: AssetResolver, budget: { left: number }, depth: number): Promise<string> {
  if (depth > 6) return source;
  const specifiers = [...new Set([...source.matchAll(/(?:import|export)\s[^'"]*?from\s*(['"])([^'"]+)\1|import\s*\(\s*(['"])([^'"]+)\3\s*\)|import\s+(['"])([^'"]+)\5/g)]
    .map(match => match[2] ?? match[4] ?? match[6]).filter(specifier => specifier && /^\.{0,2}\//.test(specifier)))];
  let result = source;
  for (const specifier of specifiers) {
    const path = joinPath(modulePath, specifier);
    const asset = path ? await resolve(path) : null;
    const text = asset ? decodeText(asset.bytes) : null;
    if (!asset || text === null || asset.bytes.length > budget.left) continue;
    budget.left -= asset.bytes.length;
    const inlined = await inlineModule(text, path!, resolve, budget, depth + 1);
    result = result.split(`'${specifier}'`).join(`'${dataUrl(new TextEncoder().encode(inlined), 'text/javascript')}'`)
      .split(`"${specifier}"`).join(`"${dataUrl(new TextEncoder().encode(inlined), 'text/javascript')}"`);
  }
  return result;
}

// A canvas file a script names in a string literal: `<node id>/<file>` (after an optional ./ or /), of a kind a page
// loads at run time rather than shows from markup: a model, a texture or picture, a clip, a sound, an HDR or data file.
// A leading / names it from the canvas root, as a page served there would; ./ or nothing, from the page's own folder.
const SCRIPT_ASSET = /(['"`])(\.\/|\/)?([A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_.%-]+\.(?:glb|gltf|bin|png|jpe?g|webp|gif|avif|hdr|mp4|webm|mov|mp3|wav|ogg|m4a|json))\1/gi;

/**
 * The canvas files a page's own scripts name, each as a data: URL keyed by the path as the script wrote it (without a
 * leading ./, which names the same file; with a leading /, which may not).
 */
async function scriptAssets(parsed: Document, path: string, resolve: AssetResolver, budget: { left: number }): Promise<Record<string, string>> {
  const names = new Set<string>();
  for (const script of Array.from(parsed.querySelectorAll('script:not([src])'))) {
    const type = (script.getAttribute('type') || '').trim().toLowerCase();
    if (type && type !== 'module' && !/^(?:text|application)\/(?:java|ecma)script$/.test(type)) continue;
    for (const match of (script.textContent || '').matchAll(SCRIPT_ASSET)) names.add(match[2] === '/' ? `/${match[3]}` : match[3]);
  }
  const assets: Record<string, string> = {};
  for (const name of names) {
    const target = joinPath(path, name);
    const asset = target ? await resolve(target) : null;
    if (!asset || asset.bytes.length > budget.left) continue;
    budget.left -= asset.bytes.length;
    assets[name] = dataUrl(asset.bytes, mimeOfName(asset.name));
  }
  return assets;
}

/**
 * Run ahead of the page: fetch, XMLHttpRequest, `new Audio()` and the src of images, media and sources get the file
 * for a path the page names (as written, or as the page's own document resolves it: three.js's FileLoader hands fetch
 * a Request with the absolute URL). three.js's loaders go through these (GLTFLoader and FileLoader fetch,
 * TextureLoader sets an image's src), so a page loads a generated model or texture by its canvas path. Every other URL
 * passes through unchanged, under the page's policy.
 */
export function assetScript(assets: Readonly<Record<string, string>>): string {
  return ';(()=>{const F=' + JSON.stringify(assets).replace(/</g, '\\u003c') + ';'
    + "const H=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);const U=s=>{try{return new URL(s,document.baseURI).href.split(/[?#]/)[0]}catch(e){return''}};"
    + 'const B=Object.create(null);for(const n in F){const a=U(n);if(a&&!H(B,a))B[a]=F[n]}'
    + "const L=u=>{if(u==null)return;let s;try{s=typeof u==='string'?u:String(u.url||u)}catch(e){return}s=s.split(/[?#]/)[0];"
    + "if(H(F,s))return F[s];const k=s.replace(/^\\.?\\//,'');const R=/^\\/(?!\\/)/.test(s);if(!R&&H(F,k))return F[k];"
    + "const a=U(s);if(a&&H(B,a))return B[a];if(!R)for(const n in F)if(s.endsWith('/'+n.replace(/^\\//,'')))return F[n]};"
    + 'const f=window.fetch;if(f)window.fetch=function(i,o){const d=L(i);return f.call(this,d||i,o)};'
    + 'const x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){const d=L(u);if(d)arguments[1]=d;return x.apply(this,arguments)};'
    + 'const p=(C,n)=>{const s=C&&Object.getOwnPropertyDescriptor(C.prototype,n);if(!s||!s.set)return;'
    + 'Object.defineProperty(C.prototype,n,{configurable:true,enumerable:s.enumerable,get:s.get,set(v){s.set.call(this,L(v)||v)}})};'
    + "p(window.HTMLImageElement,'src');p(window.HTMLMediaElement,'src');p(window.HTMLSourceElement,'src');"
    + 'const a=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if(/^(?:src|href|poster)$/i.test(n)){const d=L(v);if(d)v=d}return a.call(this,n,v)};'
    + 'const A=window.Audio;if(A){const B=function(u){const e=new A();if(u!==undefined)e.src=u;return e};B.prototype=A.prototype;window.Audio=B}})();';
}

export interface LiveDocumentOptions {
  /** The page's own path (an archive member's path, or its file name) for resolving relative URLs. */
  path?: string;
  resolve?: AssetResolver;
  /** Bytes the inlined assets may add, in total. */
  inlineBudget?: number;
}

/**
 * The page as its author wrote it, plus the guards above. Parsed with DOMParser, which never runs scripts or loads
 * resources while the host inspects the document; only the serialized text reaches the sandboxed iframe.
 */
export async function buildLiveDocument(value: string, options: LiveDocumentOptions = {}): Promise<string> {
  const source = htmlDocumentSource(value);
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const path = options.path ?? 'index.html';
  const budget = { left: options.inlineBudget ?? 24 * 1024 * 1024 };
  // The preview cannot be sent elsewhere by the page's own metadata.
  parsed.querySelectorAll('meta[http-equiv="refresh" i], base').forEach(element => element.remove());
  if (options.resolve) {
    const resolve = options.resolve;
    for (const [tag, attribute] of URL_ATTRIBUTES) {
      for (const element of Array.from(parsed.querySelectorAll(`${tag}[${attribute}]`))) {
        const url = element.getAttribute(attribute)?.trim() ?? '';
        if (!url || !RELATIVE.test(url)) continue;
        const target = joinPath(path, url);
        const asset = target ? await resolve(target) : null;
        if (!asset || asset.bytes.length > budget.left) continue;
        budget.left -= asset.bytes.length;
        if (tag === 'script') {
          const text = decodeText(asset.bytes);
          if (text === null) continue;
          element.removeAttribute('src');
          element.textContent = element.getAttribute('type') === 'module' ? await inlineModule(text, target!, resolve, budget, 0) : text;
        } else if (tag === 'link' && /stylesheet/i.test(element.getAttribute('rel') ?? '')) {
          const text = decodeText(asset.bytes);
          if (text === null) continue;
          const style = parsed.createElement('style');
          style.textContent = await inlineCss(text, target!, resolve, budget);
          element.replaceWith(style);
        } else {
          element.setAttribute(attribute, dataUrl(asset.bytes, mimeOfName(asset.name)));
        }
      }
    }
    for (const element of Array.from(parsed.querySelectorAll('img[srcset], source[srcset]'))) element.removeAttribute('srcset');
    for (const style of Array.from(parsed.querySelectorAll('style'))) style.textContent = await inlineCss(style.textContent ?? '', path, resolve, budget);
    for (const script of Array.from(parsed.querySelectorAll('script[type="module"]:not([src])'))) {
      script.textContent = await inlineModule(script.textContent ?? '', path, resolve, budget, 0);
    }
  }
  // A library AwwO supplies (previewLibraries.ts, e.g. three.js r128) runs from its pinned copy, byte for byte the
  // CDN file: no network needed, and the additions a generated page calls although its release lacks them (r128 has
  // no CapsuleGeometry) come with it. If the copy cannot be loaded the page keeps its CDN script, which the CSP allows.
  // three.js as ES modules (previewModules.ts) comes the same way, through the page's import map.
  // Files a script loads by a canvas path (a model, a texture, a sound: `hero/model-1.glb`) come from the same bytes,
  // handed to fetch, XMLHttpRequest and media elements by that path (scriptAssets below); read before any library is
  // inlined, so only the page's own scripts are searched.
  const assets = options.resolve ? await scriptAssets(parsed, path, options.resolve, budget) : {};
  const needs = previewScriptNeeds(source);
  const supplied = needs.libraries.length ? await loadPreviewLibraries(needs).catch(() => null) : null;
  if (supplied) {
    for (const script of Array.from(parsed.querySelectorAll('script[src]'))) {
      const code = script.namespaceURI === 'http://www.w3.org/1999/xhtml' ? supplied.get((script.getAttribute('src') ?? '').trim()) : undefined;
      if (code === undefined) continue;
      for (const attribute of ['src', 'integrity', 'crossorigin', 'async', 'defer']) script.removeAttribute(attribute);
      script.textContent = code;
    }
    applyModuleEntries(parsed, supplied.get(PREVIEW_IMPORT_MAP_KEY), parsed);
  }
  const head = parsed.head;
  const guard = parsed.createElement('script');
  // With the link guard: a page that started in a 0×0 frame is told its real size, and a page that fails says so
  // (htmlDeliverable.ts, pageErrors.ts).
  guard.textContent = LINK_GUARD + PREVIEW_HOST_SCRIPT + (Object.keys(assets).length ? assetScript(assets) : '');
  const csp = parsed.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', LIVE_PAGE_CSP);
  const referrer = parsed.createElement('meta');
  referrer.setAttribute('name', 'referrer');
  referrer.setAttribute('content', 'no-referrer');
  const charset = parsed.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.prepend(charset, csp, referrer, guard);
  if (!head.querySelector('meta[name="viewport" i]')) {
    const viewport = parsed.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    viewport.setAttribute('content', 'width=device-width, initial-scale=1');
    head.append(viewport);
  }
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

/** A self-contained wrapper for opening a page in its own tab: the page still runs only inside the sandbox. */
export function standaloneWrapper(title: string, document: string): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>`
    + '<style>html,body{margin:0;height:100%;background:#0b1720}iframe{border:0;width:100%;height:100%;display:block;background:#fff}</style></head>'
    + `<body><iframe title="${escape(title)}" sandbox="${LIVE_PAGE_SANDBOX}" allow="${LIVE_PAGE_ALLOW}" referrerpolicy="no-referrer" srcdoc="${escape(document)}"></iframe></body></html>`;
}
