/**
 * Script libraries a RUNNING HTML preview can use although its sandbox reaches no network. When a page loads one
 * of these exact CDN files, the preview inlines AwwO's own pinned copy of the same release instead, so the preview
 * CSP stays inline-only and no host is ever allowed. A copy is the npm release byte for byte, but for the code three.js
 * r128 took from Shadertoy and Stack Exchange, which the builds cut out (scripts/three-cuts.mjs); its size and sha256
 * are pinned here and checked by tests/canvas-artifact-preview.test.tsx.
 */
import { FIGURE_KIT_BYTES, FIGURE_KIT_SHA256, FIGURE_KIT_URL } from './figureKit/figureKit';
import { previewFontFaces, previewFontNeeds, PREVIEW_FONTS_KEY, type PreviewFont } from './previewFonts';
import { moduleImportEntries, moduleNeeds, pinnedModuleFile, PREVIEW_IMPORT_MAP_KEY, THREE_MODULES_ID, THREE_MODULES_LABEL, type ModuleNeeds } from './previewModules';

export interface PreviewAddition {
  /** Shown to the user, e.g. "CapsuleGeometry". */
  readonly label: string;
  /** Whether a page uses it. */
  readonly used: RegExp;
  /** Run inline right after the library; must only add what the library lacks. */
  readonly code: string;
}

export interface PreviewLibrary {
  readonly id: string;
  /** Shown to the user, e.g. "three.js r128". */
  readonly label: string;
  /** The label in the Chinese interface, when it differs from `label`. */
  readonly labelZh?: string;
  /** The script URLs (compared after trimming) that name this release. */
  readonly urls: readonly string[];
  readonly bytes: number;
  readonly sha256: string;
  readonly load: () => Promise<string>;
  /** Later APIs generated pages call although they load this release. Supplied only to a page that uses them. */
  readonly additions?: readonly PreviewAddition[];
  /** ES modules supplied through the page's import map rather than a script tag (previewModules.ts): `urls` is empty. */
  readonly modules?: true;
  /** Brand fonts supplied as @font-face rules (previewFonts.ts): `urls` is empty. */
  readonly fonts?: true;
}

// three.js r139's CapsuleGeometry (src/geometries/CapsuleGeometry.js), which r128 does not have yet. Generated games
// often load r128 from a CDN and still build characters from capsules; without it they stop at the first one.
const CAPSULE_GEOMETRY = `(function () {
  if (typeof THREE === 'undefined' || THREE.CapsuleGeometry || !THREE.LatheGeometry || !THREE.Path) return;
  class CapsuleGeometry extends THREE.LatheGeometry {
    constructor(radius = 1, length = 1, capSegments = 4, radialSegments = 8) {
      const path = new THREE.Path();
      path.absarc(0, -length / 2, radius, Math.PI * 1.5, 0);
      path.absarc(0, length / 2, radius, 0, Math.PI * 0.5);
      super(path.getPoints(capSegments), radialSegments);
      this.type = 'CapsuleGeometry';
      this.parameters = { radius: radius, length: length, capSegments: capSegments, radialSegments: radialSegments };
    }
  }
  THREE.CapsuleGeometry = CapsuleGeometry;
})();`;

export const PREVIEW_LIBRARIES: readonly PreviewLibrary[] = [{
  id: 'three-r128',
  label: 'three.js r128',
  // r128 is the release generated games most often load. The minified build stands in for the readable one.
  urls: [
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.js',
    'https://unpkg.com/three@0.128.0/build/three.min.js',
    'https://unpkg.com/three@0.128.0/build/three.js',
  ],
  // npm three@0.128.0 build/three.min.js (package alias three-r128), which cdnjs serves byte for byte as r128
  // (SRI sha512-dLxUelApnYxpLt6K2iomGngnHO83iUvZytA3YjDUCjT0HDOHKXnVYdf3hU4JjM8uEhxf9nD1/ey98U3t2vZ0qQ==), as the
  // builds ship it: its dithering, from Shadertoy, its generateUUID() and Catmull-Rom code, from Stack Overflow, and
  // its DataUtils.toHalfFloat(), from Game Development Stack Exchange, cut out (scripts/three-cuts.mjs; the functions
  // are AwwO's own code). A page that names the CDN file with that SRI still runs it: the preview inlines a supplied
  // library and keeps no attribute of its script element but the type (htmlDeliverable.ts).
  bytes: 604160,
  sha256: 'c1f9a7fb7e1dba58ce1dad3b78d923c103c54c0a8fed2b698c869f357732eb2d',
  // A separate chunk, fetched only when a running page needs it.
  load: () => import('three-r128/build/three.min.js?raw').then(module => module.default),
  // Any mention counts: pages often reach the library through an alias (`const T = THREE`, then `new T.CapsuleGeometry`),
  // and the addition only defines what THREE lacks, so supplying it to a page that never builds one changes nothing.
  additions: [{ label: 'CapsuleGeometry', used: /\bCapsuleGeometry\b/, code: CAPSULE_GEOMETRY }],
}, {
  id: 'figure-kit-1',
  label: 'Figure kit',
  labelZh: '原理图解组件',
  // AwwO's own figure kit (figureKit/figureKit.ts): the anatomy kit (third_party/anatomy, MIT) as one classic script
  // that defines window.Anatomy. The hosted site serves these same bytes at the URL for downloaded pages.
  urls: [FIGURE_KIT_URL],
  bytes: FIGURE_KIT_BYTES,
  sha256: FIGURE_KIT_SHA256,
  load: () => import('./figureKit/anatomy-kit.js?raw').then(module => module.default),
}];

const BY_URL = new Map(PREVIEW_LIBRARIES.flatMap(library => library.urls.map(url => [url, library] as const)));
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** three.js as ES modules (previewModules.ts): listed with the libraries a page gets, loaded file by file. */
export const THREE_MODULES_LIBRARY: PreviewLibrary = {
  id: THREE_MODULES_ID,
  label: THREE_MODULES_LABEL,
  urls: [],
  bytes: 0,
  sha256: '',
  load: () => Promise.resolve(''),
  modules: true,
};

/** The brand fonts (previewFonts.ts): listed with the libraries a page gets, supplied as @font-face rules. */
export const PREVIEW_FONTS_LIBRARY: PreviewLibrary = {
  id: 'brand-fonts',
  label: 'Brand fonts',
  labelZh: '品牌字体',
  urls: [],
  bytes: 0,
  sha256: '',
  load: () => Promise.resolve(''),
  fonts: true,
};

export interface PreviewScriptNeeds {
  /** Libraries AwwO supplies for this page, in first-use order. */
  readonly libraries: readonly PreviewLibrary[];
  /** Additions of those libraries that this page uses. */
  readonly additions: readonly PreviewAddition[];
  /** Where the page's other external scripts come from. The preview never loads them. */
  readonly blocked: readonly string[];
  /** The ES modules AwwO supplies through the page's import map, when it imports any. */
  readonly modules?: ModuleNeeds;
  /** The brand fonts AwwO supplies because the page names them, when it names any. */
  readonly fonts?: readonly PreviewFont[];
}

export const NO_PREVIEW_SCRIPT_NEEDS: PreviewScriptNeeds = { libraries: [], additions: [], blocked: [] };

/**
 * The external scripts a page asks for, split into the ones AwwO can supply and the ones it cannot, and the brand fonts
 * it names. `inlined` are the import specifiers of modules the caller put into the page itself (the live page's canvas
 * JavaScript files); `texts` are the sources of canvas files it put there (scripts and stylesheets), which may name fonts.
 */
export function previewScriptNeeds(source: string, inlined: readonly string[] = [], texts: readonly string[] = []): PreviewScriptNeeds {
  const template = document.createElement('template');
  template.innerHTML = source;
  const libraries = new Set<PreviewLibrary>();
  const blocked = new Set<string>();
  for (const script of Array.from(template.content.querySelectorAll('script'))) {
    const reference = (script.getAttribute('src') ?? script.getAttribute('href') ?? script.getAttribute('xlink:href'))?.trim();
    if (reference === undefined) continue;
    // A module script naming a pinned module file is supplied through the import map (moduleNeeds, below).
    if ((script.getAttribute('type') || '').trim().toLowerCase() === 'module' && pinnedModuleFile(reference)) continue;
    const library = script.namespaceURI === HTML_NAMESPACE && script.hasAttribute('src') ? BY_URL.get(reference) : undefined;
    if (library) libraries.add(library);
    else blocked.add(scriptOrigin(reference));
  }
  const modules = moduleNeeds(template.content, inlined);
  if (modules?.files.length) libraries.add(THREE_MODULES_LIBRARY);
  for (const host of modules?.blocked ?? []) blocked.add(host);
  const fonts = previewFontNeeds(source, ...texts);
  if (fonts.length) libraries.add(PREVIEW_FONTS_LIBRARY);
  if (!libraries.size && !blocked.size) return NO_PREVIEW_SCRIPT_NEEDS;
  const additions = [...libraries].flatMap(library => (library.additions ?? []).filter(addition => addition.used.test(source)));
  return { libraries: [...libraries], additions, blocked: [...blocked], ...(modules?.files.length ? { modules } : {}), ...(fonts.length ? { fonts } : {}) };
}

function scriptOrigin(reference: string): string {
  try {
    const url = new URL(reference);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.host;
  } catch { /* a relative or malformed reference is shown as written */ }
  return reference.length > 60 ? `${reference.slice(0, 57)}...` : reference || '(empty)';
}

const loaded = new Map<string, Promise<string>>();

// Fonts are a finish, not a requirement: a font chunk still loading after this long is left out and the page runs in its
// fallback font.
const FONT_DEADLINE_MS = 20_000;
function withinDeadline<T>(promise: Promise<T | undefined>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })])
    .finally(() => clearTimeout(timer));
}

/** The inline code for each supplied library (its pinned copy, then the additions this page uses), keyed by every
 * URL that names it; for a page that imports pinned ES modules, their import-map entries as JSON under
 * PREVIEW_IMPORT_MAP_KEY (applyModuleEntries puts them in the page); for a page that names brand fonts, their
 * @font-face rules under PREVIEW_FONTS_KEY. Rejects when any library or module copy is unusable; a font that cannot be
 * loaded is left out, so the page still runs, in its fallback font. */
export async function loadPreviewLibraries(needs: Pick<PreviewScriptNeeds, 'libraries' | 'additions' | 'modules' | 'fonts'>): Promise<ReadonlyMap<string, string>> {
  const classic = needs.libraries.filter(library => !library.modules && !library.fonts);
  const [entries, modules, fonts] = await Promise.all([
    Promise.all(classic.map(async library => [library, await loadLibrary(library)] as const)),
    needs.modules?.files.length ? moduleImportEntries(needs.modules) : Promise.resolve(undefined),
    needs.fonts?.length ? withinDeadline(previewFontFaces(needs.fonts).catch(() => undefined), FONT_DEADLINE_MS) : Promise.resolve(undefined),
  ]);
  const code = new Map<string, string>();
  for (const [library, text] of entries) {
    const additions = (library.additions ?? []).filter(addition => needs.additions.includes(addition));
    const inline = additions.length ? `${text}\n;${additions.map(addition => addition.code).join('\n;')}` : text;
    for (const url of library.urls) code.set(url, inline);
  }
  if (modules !== undefined) code.set(PREVIEW_IMPORT_MAP_KEY, modules);
  if (fonts) code.set(PREVIEW_FONTS_KEY, fonts);
  return code;
}

function loadLibrary(library: PreviewLibrary): Promise<string> {
  let pending = loaded.get(library.id);
  if (!pending) {
    pending = library.load().then(text => {
      // The copy is inlined into an HTML document: it must be the pinned file and must not be able to end its
      // own <script> element or open an HTML comment there.
      if (new TextEncoder().encode(text).byteLength !== library.bytes || /<\/script|<!--/i.test(text)) throw new Error('preview_library_invalid');
      return text;
    });
    loaded.set(library.id, pending);
    pending.catch(() => { if (loaded.get(library.id) === pending) loaded.delete(library.id); });
  }
  return pending;
}
