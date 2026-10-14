/**
 * The three.js release AwwO's previews supply as ES modules, the import map a page writes to load it, and the pure
 * helpers that read and write a page's import map. Kept apart from previewModules.ts, whose generated file loaders
 * import the npm files as raw text (a Vite `?raw` import): code that only names the release or puts entries into a page
 * (node instructions, the document builders, and scripts bundled outside Vite such as scripts/showcase/publish-run.mjs)
 * never pulls those loaders in. previewModules.generated.ts pins the same version (tests/canvas-preview-modules.test.ts
 * checks that they agree).
 */
export const THREE_MODULES_VERSION = '0.186.1';
/** The URL every pinned file is known by inside a preview; a page may also name the same release on other CDN hosts. */
export const THREE_MODULES_BASE = `https://cdn.jsdelivr.net/npm/three@${THREE_MODULES_VERSION}/`;
/** The import map a page uses to load the supplied release (what node instructions tell a page to write). */
export const THREE_MODULES_IMPORT_MAP = `<script type="importmap">{"imports":{"three":"${THREE_MODULES_BASE}build/three.module.js","three/addons/":"${THREE_MODULES_BASE}examples/jsm/"}}</script>`;
export const THREE_MODULES_LABEL = `three.js r${THREE_MODULES_VERSION.split('.')[1]}`;
export const THREE_MODULES_ID = `three-modules-${THREE_MODULES_VERSION}`;
/** The key under which loadPreviewLibraries hands the import-map entries to the document builders. */
export const PREVIEW_IMPORT_MAP_KEY = 'awwo:importmap';

export type ImportMap = { imports?: Record<string, unknown>; scopes?: unknown; integrity?: unknown; [key: string]: unknown };

export function readImportMap(element: Element | null): ImportMap | null {
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

export const isModuleScript = (element: Element) => (element.getAttribute('type') || '').trim().toLowerCase() === 'module';
export const isImportMap = (element: Element) => (element.getAttribute('type') || '').trim().toLowerCase() === 'importmap';

/** Serialize an import map so nothing in it can close the script element that holds it. */
function importMapText(map: ImportMap): string {
  return JSON.stringify(map).replace(/</g, '\\u003c');
}

/** A module script's body that imports `src`, with '<' escaped so the specifier can never close the script element. */
export function moduleImport(src: string): string {
  return `import ${JSON.stringify(src).replace(/</g, '\\u003c')};`;
}

/**
 * Put the supplied modules into a page: its import map (created before its first module script when it has none) gains
 * an exact entry for every pinned file it loads, which wins over any "prefix/" entry, and a module script that names a
 * pinned file by its src imports it through that entry instead. The page's other entries, scopes and scripts stay,
 * except scopes whose prefix is a data: URL: the supplied modules are data: URLs, so such a scope would send the
 * pinned files' own imports (their 'three') somewhere else.
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
  if (map.scopes && typeof map.scopes === 'object' && !Array.isArray(map.scopes)) {
    // URL parsing drops leading C0 controls and spaces, so " data:" is a data: prefix too.
    const isDataPrefix = (prefix: string) => {
      let start = 0;
      while (start < prefix.length && prefix.charCodeAt(start) <= 0x20) start++;
      return /^data:/i.test(prefix.slice(start));
    };
    const scopes = Object.fromEntries(Object.entries(map.scopes as Record<string, unknown>).filter(([prefix]) => !isDataPrefix(prefix)));
    if (Object.keys(scopes).length) map.scopes = scopes;
    else delete map.scopes;
  }
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
    script.textContent = moduleImport(src);
  }
}
