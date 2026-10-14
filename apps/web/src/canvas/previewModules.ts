/**
 * three.js ES modules a RUNNING preview supplies to a delivered page, so a page written the way three.js is used today
 * (an import map, `import * as THREE from 'three'`, addons from 'three/addons/…') runs with no network, the same in
 * every country and every time. The page names one exact npm release by its CDN URLs:
 *
 *   <script type="importmap">{"imports": {
 *     "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
 *     "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/" }}</script>
 *
 * and the preview gives every file it imports, and every file those import, AwwO's pinned copy of that release as a
 * data: URL in the same import map. A copy is the npm file byte for byte (previewModules.generated.ts pins its size and
 * sha256) except that its relative imports name the canonical CDN URL of the file they mean, which the import map then
 * supplies too: a data: module cannot resolve a relative path. Anything else the page imports is left as it wrote it.
 */
import { THREE_MODULE_FILES, THREE_MODULES_VERSION } from './previewModules.generated';

/** The URL every pinned file is known by inside a preview; a page may also name the same release on these hosts. */
export const THREE_MODULES_BASE = `https://cdn.jsdelivr.net/npm/three@${THREE_MODULES_VERSION}/`;
const BASES = [
  THREE_MODULES_BASE,
  `https://fastly.jsdelivr.net/npm/three@${THREE_MODULES_VERSION}/`,
  `https://gcore.jsdelivr.net/npm/three@${THREE_MODULES_VERSION}/`,
  `https://unpkg.com/three@${THREE_MODULES_VERSION}/`,
];
/** The import map a page uses to load the supplied release (what node instructions tell a page to write). */
export const THREE_MODULES_IMPORT_MAP = `<script type="importmap">{"imports":{"three":"${THREE_MODULES_BASE}build/three.module.js","three/addons/":"${THREE_MODULES_BASE}examples/jsm/"}}</script>`;
export const THREE_MODULES_LABEL = `three.js r${THREE_MODULES_VERSION.split('.')[1]}`;
export const THREE_MODULES_ID = `three-modules-${THREE_MODULES_VERSION}`;
/** The key under which loadPreviewLibraries hands the import-map entries to the document builders. */
export const PREVIEW_IMPORT_MAP_KEY = 'awwo:importmap';
const CORE = 'build/three.module.js';

/** The pinned file a URL names, or null. A `.min.js` URL names the same file (the CDN minifies it on request). */
export function pinnedModuleFile(url: string): string | null {
  const clean = url.trim().split(/[?#]/)[0];
  for (const base of BASES) {
    if (!clean.startsWith(base)) continue;
    const file = clean.slice(base.length);
    if (THREE_MODULE_FILES[file]) return file;
    const unminified = file.replace(/\.min\.js$/, '.js');
    return THREE_MODULE_FILES[unminified] ? unminified : null;
  }
  return null;
}

export interface ModuleNeeds {
  /** Every pinned file the page loads, in a stable order (its imports' imports included). */
  readonly files: readonly string[];
  /** What the page itself names (a bare specifier through its import map, or a URL) and the file each one is. */
  readonly specifiers: ReadonlyArray<{ readonly specifier: string; readonly file: string }>;
  /** Whether the import map must give the bare specifier 'three' the pinned core (the addons import it by that name). */
  readonly bare: boolean;
  /** Module URLs the page imports that AwwO cannot supply (shown, never fetched by the stricter preview). */
  readonly blocked: readonly string[];
}

/** The specifiers a module script names: static imports and exports, side-effect imports, and literal dynamic imports. */
export function scriptSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s*(['"])([^'"\n]+)\1|\bimport\s*\(\s*(['"])([^'"\n]+)\3\s*\)|\bimport\s*(['"])([^'"\n]+)\5/g)) {
    found.add(match[2] ?? match[4] ?? match[6]);
  }
  return [...found];
}

type ImportMap = { imports?: Record<string, unknown>; scopes?: unknown; integrity?: unknown; [key: string]: unknown };

function readImportMap(element: Element | null): ImportMap | null {
  if (!element) return null;
  try {
    const value = JSON.parse(element.textContent || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as ImportMap : null;
  } catch { return null; }
}

/** Where an import map sends a specifier: an exact entry, else the longest "prefix/" entry; URLs stand for themselves. */
export function resolveSpecifier(specifier: string, imports: Record<string, unknown>): string | null {
  if (/^https?:\/\//i.test(specifier)) return specifier;
  const exact = imports[specifier];
  if (typeof exact === 'string') return exact;
  let best = '';
  for (const key of Object.keys(imports)) if (key.endsWith('/') && specifier.startsWith(key) && key.length > best.length) best = key;
  const prefix = best ? imports[best] : undefined;
  return typeof prefix === 'string' ? prefix + specifier.slice(best.length) : null;
}

const isModuleScript = (element: Element) => (element.getAttribute('type') || '').trim().toLowerCase() === 'module';
const isImportMap = (element: Element) => (element.getAttribute('type') || '').trim().toLowerCase() === 'importmap';

/** The pinned modules a page needs, or null when it imports none. `root` is a parsed document or template content. */
export function moduleNeeds(root: ParentNode): ModuleNeeds | null {
  const scripts = Array.from(root.querySelectorAll('script'));
  const modules = scripts.filter(isModuleScript);
  if (!modules.length) return null;
  const imports = readImportMap(scripts.find(isImportMap) ?? null)?.imports ?? {};
  const specifiers: Array<{ specifier: string; file: string }> = [];
  const blocked = new Set<string>();
  const wanted = new Set<string>();
  const named = (specifier: string, fromSrc = false) => {
    const url = resolveSpecifier(specifier, imports);
    if (!url) return;
    const file = pinnedModuleFile(url);
    if (file) {
      if (!specifiers.some(entry => entry.specifier === specifier)) specifiers.push({ specifier, file });
      wanted.add(file);
    } else if (!fromSrc && /^https?:\/\//i.test(url)) {
      // A module src that AwwO cannot supply is reported with the page's other external scripts.
      try { blocked.add(new URL(url).host); } catch { blocked.add(url.slice(0, 60)); }
    }
  };
  for (const script of modules) {
    const src = script.getAttribute('src');
    if (src !== null) named(src.trim(), true);
    else for (const specifier of scriptSpecifiers(script.textContent || '')) named(specifier);
  }
  if (!wanted.size) return blocked.size ? { files: [], specifiers: [], bare: false, blocked: [...blocked] } : null;
  // 'three' must be the pinned core when anything loaded imports it by name, unless the page sends it elsewhere.
  const own = imports.three;
  const ownFile = typeof own === 'string' ? pinnedModuleFile(own) : null;
  const files = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const entry = THREE_MODULE_FILES[file];
    for (const dependency of entry.imports) visit(dependency.file);
    if (entry.bare && (own === undefined || ownFile === CORE)) visit(CORE);
  };
  for (const file of wanted) visit(file);
  const bare = [...files].some(file => THREE_MODULE_FILES[file].bare) && (own === undefined || ownFile === CORE);
  return { files: [...files].sort(), specifiers, bare, blocked: [...blocked] };
}

const loaded = new Map<string, Promise<string>>();

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** A pinned file as the data: URL a preview's import map gives it: its relative imports name canonical URLs. */
export function moduleDataUrl(file: string): Promise<string> {
  let pending = loaded.get(file);
  if (!pending) {
    const entry = THREE_MODULE_FILES[file];
    if (!entry) return Promise.reject(new Error('preview_module_unknown'));
    pending = entry.load().then(text => {
      if (new TextEncoder().encode(text).byteLength !== entry.bytes) throw new Error('preview_module_invalid');
      let source = text;
      for (const dependency of entry.imports) {
        const target = THREE_MODULES_BASE + dependency.file;
        source = source.split(`'${dependency.specifier}'`).join(`'${target}'`).split(`"${dependency.specifier}"`).join(`"${target}"`);
      }
      return `data:text/javascript;base64,${base64(source)}`;
    });
    loaded.set(file, pending);
    pending.catch(() => { if (loaded.get(file) === pending) loaded.delete(file); });
  }
  return pending;
}

/** The import-map entries a page needs (JSON), for loadPreviewLibraries to hand to the document builders. */
export async function moduleImportEntries(needs: ModuleNeeds): Promise<string> {
  const urls = new Map(await Promise.all(needs.files.map(async file => [file, await moduleDataUrl(file)] as const)));
  const entries: Record<string, string> = {};
  // A file another pinned file imports is named by its canonical URL; the core is named 'three' by the addons.
  for (const file of needs.files) {
    for (const dependency of THREE_MODULE_FILES[file].imports) entries[THREE_MODULES_BASE + dependency.file] = urls.get(dependency.file)!;
  }
  if (needs.bare) entries.three = urls.get(CORE)!;
  for (const { specifier, file } of needs.specifiers) entries[specifier] = urls.get(file)!;
  return JSON.stringify(entries);
}

/** Serialize an import map so nothing in it can close the script element that holds it. */
function importMapText(map: ImportMap): string {
  return JSON.stringify(map).replace(/</g, '\\u003c');
}

/**
 * Put the supplied modules into a page: its import map (created before its first module script when it has none) gains
 * an exact entry for every pinned file it loads, which wins over any "prefix/" entry, and a module script that names a
 * pinned file by its src imports it through that entry instead. The page's other entries, scopes and scripts stay.
 */
export function applyModuleEntries(root: ParentNode, entriesJson: string | undefined, documentRef: Document): void {
  if (!entriesJson) return;
  let entries: Record<string, string>;
  try { entries = JSON.parse(entriesJson) as Record<string, string>; } catch { return; }
  if (!Object.keys(entries).length) return;
  const scripts = Array.from(root.querySelectorAll('script'));
  const firstModule = scripts.find(isModuleScript);
  if (!firstModule) return;
  let mapElement = scripts.find(isImportMap) ?? null;
  const map = readImportMap(mapElement) ?? {};
  const imports = map.imports && typeof map.imports === 'object' && !Array.isArray(map.imports) ? map.imports : {};
  map.imports = { ...imports, ...entries };
  if (!mapElement) {
    mapElement = documentRef.createElement('script');
    mapElement.setAttribute('type', 'importmap');
    firstModule.parentNode!.insertBefore(mapElement, firstModule);
  }
  mapElement.textContent = importMapText(map);
  for (const script of scripts.filter(isModuleScript)) {
    const src = script.getAttribute('src')?.trim();
    if (!src || entries[src] === undefined) continue;
    script.removeAttribute('src');
    for (const attribute of ['integrity', 'crossorigin', 'async', 'defer']) script.removeAttribute(attribute);
    script.textContent = `import ${JSON.stringify(src)};`;
  }
}
