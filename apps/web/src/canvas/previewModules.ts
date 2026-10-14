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
import { THREE_MODULE_FILES, type GeneratedModuleFile } from './previewModules.generated';
import { isImportMap, isModuleScript, readImportMap, resolveSpecifier, THREE_MODULES_BASE, THREE_MODULES_VERSION } from './previewImportMap';

export { applyModuleEntries, PREVIEW_IMPORT_MAP_KEY, resolveSpecifier, THREE_MODULES_BASE, THREE_MODULES_ID, THREE_MODULES_IMPORT_MAP, THREE_MODULES_LABEL } from './previewImportMap';
/** The hosts a page may name the supplied release on; every pinned file is known by its THREE_MODULES_BASE URL. */
const BASES = [
  THREE_MODULES_BASE,
  `https://fastly.jsdelivr.net/npm/three@${THREE_MODULES_VERSION}/`,
  `https://gcore.jsdelivr.net/npm/three@${THREE_MODULES_VERSION}/`,
  `https://unpkg.com/three@${THREE_MODULES_VERSION}/`,
];
const CORE = 'build/three.module.js';

/** A pinned file's entry by its own name, never an inherited property ('constructor', '__proto__'), else undefined. */
function fileEntry(file: string): GeneratedModuleFile | undefined {
  return Object.prototype.hasOwnProperty.call(THREE_MODULE_FILES, file) ? THREE_MODULE_FILES[file] : undefined;
}

/** The pinned file a URL names, or null. A `.min.js` URL names the same file (the CDN minifies it on request). */
export function pinnedModuleFile(url: string): string | null {
  const clean = url.trim().split(/[?#]/)[0];
  for (const base of BASES) {
    if (!clean.startsWith(base)) continue;
    const file = clean.slice(base.length);
    if (fileEntry(file)) return file;
    const unminified = file.replace(/\.min\.js$/, '.js');
    return fileEntry(unminified) ? unminified : null;
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

/** The pinned modules a page needs, or null when it imports none. `root` is a parsed document or template content. */
export function moduleNeeds(root: ParentNode): ModuleNeeds | null {
  const scripts = Array.from(root.querySelectorAll('script'));
  const modules = scripts.filter(isModuleScript);
  if (!modules.length) return null;
  const imports = readImportMap(scripts.find(isImportMap) ?? null)?.imports ?? {};
  const specifiers: Array<{ specifier: string; file: string }> = [];
  const blocked = new Set<string>();
  const wanted = new Set<string>();
  const report = (url: string) => {
    if (/^https?:\/\//i.test(url)) {
      try { blocked.add(new URL(url).host); } catch { blocked.add(url.slice(0, 60)); }
    } else blocked.add(url.slice(0, 60));
  };
  const named = (specifier: string, fromSrc = false) => {
    // A bare name (not ./, ../, / or a URL) only resolves through the import map; a relative one may be a canvas file
    // the live page inlines, so only bare names that end nowhere AwwO can supply are reported.
    const bareName = !/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier);
    const url = resolveSpecifier(specifier, imports);
    if (!url) {
      if (bareName && !fromSrc) report(specifier);
      return;
    }
    const file = pinnedModuleFile(url);
    if (file) {
      if (!specifiers.some(entry => entry.specifier === specifier)) specifiers.push({ specifier, file });
      wanted.add(file);
    } else if (!fromSrc && (/^https?:\/\//i.test(url) || (bareName && !/^data:/i.test(url)))) {
      // A module src that AwwO cannot supply is reported with the page's other external scripts.
      report(url);
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
  const ownsCore = own === undefined || ownFile === CORE;
  const files = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const entry = fileEntry(file)!;
    for (const dependency of entry.imports) visit(dependency.file);
    if (entry.bare && ownsCore) visit(CORE);
  };
  for (const file of wanted) visit(file);
  const importsBare = [...files].some(file => fileEntry(file)!.bare);
  // A pinned addon imports 'three' by name: where the page sends that name elsewhere, the addon loads it from there.
  if (importsBare && !ownsCore && !ownFile) report(typeof own === 'string' ? own : 'three');
  return { files: [...files].sort(), specifiers, bare: importsBare && ownsCore, blocked: [...blocked] };
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
    const entry = fileEntry(file);
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
    for (const dependency of fileEntry(file)!.imports) entries[THREE_MODULES_BASE + dependency.file] = urls.get(dependency.file)!;
  }
  if (needs.bare) entries.three = urls.get(CORE)!;
  for (const { specifier, file } of needs.specifiers) entries[specifier] = urls.get(file)!;
  return JSON.stringify(entries);
}
