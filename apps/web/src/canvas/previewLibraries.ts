/**
 * Script libraries a RUNNING HTML preview can use although its sandbox reaches no network. When a page loads one
 * of these exact CDN files, the preview inlines AwwO's own pinned copy of the same release instead, so the preview
 * CSP stays inline-only and no host is ever allowed. A copy is the npm release byte for byte; its size and sha256
 * are pinned here and checked by tests/canvas-artifact-preview.test.tsx.
 */
import { FIGURE_KIT_BYTES, FIGURE_KIT_SHA256, FIGURE_KIT_URL } from './figureKit/figureKit';

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
  // (SRI sha512-dLxUelApnYxpLt6K2iomGngnHO83iUvZytA3YjDUCjT0HDOHKXnVYdf3hU4JjM8uEhxf9nD1/ey98U3t2vZ0qQ==).
  bytes: 603445,
  sha256: '9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2',
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

export interface PreviewScriptNeeds {
  /** Libraries AwwO supplies for this page, in first-use order. */
  readonly libraries: readonly PreviewLibrary[];
  /** Additions of those libraries that this page uses. */
  readonly additions: readonly PreviewAddition[];
  /** Where the page's other external scripts come from. The preview never loads them. */
  readonly blocked: readonly string[];
}

export const NO_PREVIEW_SCRIPT_NEEDS: PreviewScriptNeeds = { libraries: [], additions: [], blocked: [] };

/** The external scripts a page asks for, split into the ones AwwO can supply and the ones it cannot. */
export function previewScriptNeeds(source: string): PreviewScriptNeeds {
  const template = document.createElement('template');
  template.innerHTML = source;
  const libraries = new Set<PreviewLibrary>();
  const blocked = new Set<string>();
  for (const script of Array.from(template.content.querySelectorAll('script'))) {
    const reference = (script.getAttribute('src') ?? script.getAttribute('href') ?? script.getAttribute('xlink:href'))?.trim();
    if (reference === undefined) continue;
    const library = script.namespaceURI === HTML_NAMESPACE && script.hasAttribute('src') ? BY_URL.get(reference) : undefined;
    if (library) libraries.add(library);
    else blocked.add(scriptOrigin(reference));
  }
  if (!libraries.size && !blocked.size) return NO_PREVIEW_SCRIPT_NEEDS;
  const additions = [...libraries].flatMap(library => (library.additions ?? []).filter(addition => addition.used.test(source)));
  return { libraries: [...libraries], additions, blocked: [...blocked] };
}

function scriptOrigin(reference: string): string {
  try {
    const url = new URL(reference);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.host;
  } catch { /* a relative or malformed reference is shown as written */ }
  return reference.length > 60 ? `${reference.slice(0, 57)}...` : reference || '(empty)';
}

const loaded = new Map<string, Promise<string>>();

/** The inline code for each supplied library (its pinned copy, then the additions this page uses), keyed by every
 * URL that names it. Rejects when any copy is unusable. */
export async function loadPreviewLibraries(needs: Pick<PreviewScriptNeeds, 'libraries' | 'additions'>): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(needs.libraries.map(async library => [library, await loadLibrary(library)] as const));
  const code = new Map<string, string>();
  for (const [library, text] of entries) {
    const additions = (library.additions ?? []).filter(addition => needs.additions.includes(addition));
    const inline = additions.length ? `${text}\n;${additions.map(addition => addition.code).join('\n;')}` : text;
    for (const url of library.urls) code.set(url, inline);
  }
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
