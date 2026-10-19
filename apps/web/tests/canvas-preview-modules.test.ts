import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlPreviewDocument } from '../src/canvas/htmlDeliverable';
import { namesRelativeMedia } from '../src/canvas/ArtifactPreview';
import { loadPreviewLibraries, previewScriptNeeds, THREE_MODULES_LIBRARY } from '../src/canvas/previewLibraries';
import { moduleSpecifiers } from '../../../scripts/preview-modules.mjs';
import { moduleSourceUrl, pinnedModuleFile, PREVIEW_IMPORT_MAP_KEY, scriptSpecifiers, THREE_MODULES_BASE, THREE_MODULES_IMPORT_MAP } from '../src/canvas/previewModules';
import { THREE_MODULE_FILES, THREE_MODULES_VERSION } from '../src/canvas/previewModules.generated';
import { THREE_MODULES_VERSION as RELEASE_VERSION } from '../src/canvas/previewImportMap';
import { assetScript, buildLiveDocument } from '../src/canvas/studio/liveDocument';
import { shadertoyFile, shippedText } from '../scripts/three-shadertoy.mjs';

const THREE_DIR = path.resolve(__dirname, '../node_modules/three');
const decode = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8');
const importMapOf = (html: string) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const maps = Array.from(doc.querySelectorAll('script')).filter(script => script.getAttribute('type') === 'importmap');
  return { doc, maps, imports: maps.length ? JSON.parse(maps[0].textContent!).imports as Record<string, string> : {} };
};

// What a three.js page looks like today: an import map naming one exact release, the core and a post-processing chain.
const PAGE = `<!doctype html><html><head>${THREE_MODULES_IMPORT_MAP}</head><body><canvas></canvas>
<script type="module">
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
window.started = [THREE.REVISION, typeof EffectComposer, typeof UnrealBloomPass, typeof GLTFLoader];
</script></body></html>`;

describe('three.js as ES modules, supplied through the page import map', () => {
  it('pins every generated file to the npm release installed for the web app, as the builds ship it', () => {
    expect(JSON.parse(readFileSync(path.join(THREE_DIR, 'package.json'), 'utf8')).version).toBe(THREE_MODULES_VERSION);
    // The release node instructions and build scripts name (previewImportMap.ts) is the one the files pin.
    expect(RELEASE_VERSION).toBe(THREE_MODULES_VERSION);
    for (const [file, entry] of Object.entries(THREE_MODULE_FILES)) {
      // build/three.module.js ships without the shaders three.js took from Shadertoy (scripts/three-shadertoy.mjs).
      const absolute = path.join(THREE_DIR, file);
      const bytes = shadertoyFile(absolute) ? Buffer.from(shippedText(absolute)) : readFileSync(absolute);
      expect(bytes.length, file).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(entry.sha256);
      const imports = moduleSpecifiers(bytes.toString('utf8'));
      expect(imports.includes('three'), file).toBe(entry.bare);
      expect([...new Set(imports.filter((specifier: string) => specifier !== 'three'))].sort(), file).toEqual(entry.imports.map(dependency => dependency.specifier).sort());
      for (const dependency of entry.imports) expect(THREE_MODULE_FILES[dependency.file], `${file} → ${dependency.file}`).toBeDefined();
    }
    // The doc comments' `@three_import import … from 'three/addons/…'` lines are not imports.
    expect(THREE_MODULE_FILES['examples/jsm/postprocessing/UnrealBloomPass.js'].imports.map(dependency => dependency.file).sort())
      .toEqual(['examples/jsm/postprocessing/Pass.js', 'examples/jsm/shaders/CopyShader.js', 'examples/jsm/shaders/LuminosityHighPassShader.js']);
  });

  it('knows the release by its CDN URLs only, the .min.js form included', () => {
    expect(pinnedModuleFile(`${THREE_MODULES_BASE}build/three.module.js`)).toBe('build/three.module.js');
    expect(pinnedModuleFile(`https://unpkg.com/three@${THREE_MODULES_VERSION}/examples/jsm/controls/OrbitControls.js?module`)).toBe('examples/jsm/controls/OrbitControls.js');
    expect(pinnedModuleFile(`https://cdn.jsdelivr.net/npm/three@${THREE_MODULES_VERSION}/build/three.module.min.js`)).toBe('build/three.module.js');
    expect(pinnedModuleFile('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js')).toBeNull();
    expect(pinnedModuleFile(`https://esm.sh/three@${THREE_MODULES_VERSION}`)).toBeNull();
    expect(pinnedModuleFile(`${THREE_MODULES_BASE}examples/jsm/loaders/DRACOLoader.js`)).toBeNull();
    expect(scriptSpecifiers("import a from 'x';import 'y';const z=await import(\"z\");export { q } from './q.js'").sort()).toEqual(['./q.js', 'x', 'y', 'z']);
  });

  it('works out what a page loads, its imports\' imports included', () => {
    const needs = previewScriptNeeds(PAGE);
    expect(needs.libraries).toEqual([THREE_MODULES_LIBRARY]);
    expect(needs.blocked).toEqual([]);
    expect(needs.modules!.bare).toBe(true);
    expect(needs.modules!.specifiers.map(entry => entry.specifier)).toEqual(['three', 'three/addons/postprocessing/EffectComposer.js',
      'three/addons/postprocessing/UnrealBloomPass.js', 'three/addons/loaders/GLTFLoader.js']);
    expect(needs.modules!.files).toEqual(expect.arrayContaining(['build/three.core.js', 'build/three.module.js', 'examples/jsm/postprocessing/Pass.js',
      'examples/jsm/postprocessing/ShaderPass.js', 'examples/jsm/postprocessing/MaskPass.js', 'examples/jsm/shaders/CopyShader.js',
      'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js']));
    // Another release, or a host AwwO does not mirror, stays the page's own (and is reported).
    const other = previewScriptNeeds(`<script type="importmap">{"imports":{"three":"https://esm.sh/three@0.170.0"}}</script><script type="module">import * as T from 'three'</script>`);
    expect(other.libraries).toEqual([]);
    expect(other.blocked).toEqual(['esm.sh']);
  });

  it('gives each loaded file a data: URL whose relative imports name canonical URLs', async () => {
    const needs = previewScriptNeeds(PAGE);
    const code = await loadPreviewLibraries(needs);
    const entries = JSON.parse(code.get(PREVIEW_IMPORT_MAP_KEY)!) as Record<string, string>;
    expect(entries.three).toMatch(/^data:text\/javascript;base64,/);
    expect(entries['three/addons/postprocessing/EffectComposer.js']).toMatch(/^data:text\/javascript;base64,/);
    expect(entries[`${THREE_MODULES_BASE}build/three.core.js`]).toMatch(/^data:text\/javascript;base64,/);
    const core = decode(entries.three);
    expect(core).toContain(`from '${THREE_MODULES_BASE}build/three.core.js'`);
    expect(core).not.toContain("from './three.core.js'");
    const bloom = decode(entries['three/addons/postprocessing/UnrealBloomPass.js']);
    expect(bloom).toContain(`from '${THREE_MODULES_BASE}examples/jsm/postprocessing/Pass.js'`);
    expect(bloom).toContain("from 'three'");
    // Every file loaded is reachable by the name something imports it by.
    for (const file of needs.modules!.files) {
      const reachable = file === 'build/three.module.js' ? entries.three : entries[THREE_MODULES_BASE + file] ?? Object.entries(entries).find(([key]) => key.endsWith(file.replace('examples/jsm/', '')))?.[1];
      expect(reachable, file).toBeDefined();
    }
    // The bytes before rewriting are the pinned file's, named by its canonical URL: a stack trace or console message
    // from it names that, not the whole data: URL.
    const raw = await THREE_MODULE_FILES['build/three.core.js'].load();
    expect(decode(entries[`${THREE_MODULES_BASE}build/three.core.js`])).toBe(raw + moduleSourceUrl('build/three.core.js'));
    expect(moduleSourceUrl('build/three.core.js')).toBe(`\n//# sourceURL=${THREE_MODULES_BASE}build/three.core.js\n`);
    expect(bloom.endsWith(`\n//# sourceURL=${THREE_MODULES_BASE}examples/jsm/postprocessing/UnrealBloomPass.js\n`)).toBe(true);
  });

  it('runs the page in the interactive preview with its import map completed and data: modules allowed', async () => {
    const needs = previewScriptNeeds(PAGE);
    const code = await loadPreviewLibraries(needs);
    const { doc, maps, imports } = importMapOf(htmlPreviewDocument(PAGE, true, code));
    expect(maps).toHaveLength(1);
    const scripts = Array.from(doc.body.querySelectorAll('script'));
    expect(scripts.indexOf(maps[0])).toBeLessThan(scripts.findIndex(script => script.getAttribute('type') === 'module'));
    // The page's own entries stay; the exact entries AwwO adds win over its "three/addons/" prefix.
    expect(imports['three/addons/']).toBe(`${THREE_MODULES_BASE}examples/jsm/`);
    expect(imports['three/addons/loaders/GLTFLoader.js']).toMatch(/^data:/);
    expect(maps[0].textContent).not.toContain('<');
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
    expect(csp).toContain("script-src 'unsafe-inline' data:");
    expect(csp).toContain("connect-src 'none'");
    // Without the supplied entries nothing is added, and a static preview still runs no script.
    expect(importMapOf(htmlPreviewDocument(PAGE, true)).imports.three).toBe(`${THREE_MODULES_BASE}build/three.module.js`);
    expect(new DOMParser().parseFromString(htmlPreviewDocument(PAGE, false, code), 'text/html').querySelector('script')).toBeNull();
  });

  it('creates the import map for a page that imports the release by URL, and turns a pinned module src into an import', async () => {
    const page = `<html><body><script type="module" src="${THREE_MODULES_BASE}examples/jsm/libs/stats.module.js"></script><script type="module">
      import * as THREE from '${THREE_MODULES_BASE}build/three.module.js';
      import { OrbitControls } from '${THREE_MODULES_BASE}examples/jsm/controls/OrbitControls.js';
      </script></body></html>`;
    const needs = previewScriptNeeds(page);
    expect(needs.blocked).toEqual([]);
    const { doc, maps, imports } = importMapOf(htmlPreviewDocument(page, true, await loadPreviewLibraries(needs)));
    expect(maps).toHaveLength(1);
    // OrbitControls imports 'three', so the map gives it the pinned core under that name too.
    expect(imports.three).toBe(imports[`${THREE_MODULES_BASE}build/three.module.js`]);
    const stats = Array.from(doc.body.querySelectorAll('script[type="module"]')).find(script => script.textContent?.includes('stats.module.js'))!;
    expect(stats.getAttribute('src')).toBeNull();
    expect(stats.textContent).toBe(`import "${THREE_MODULES_BASE}examples/jsm/libs/stats.module.js";`);
    expect(imports[`${THREE_MODULES_BASE}examples/jsm/libs/stats.module.js`]).toMatch(/^data:/);
  });

  it('supplies the same modules to a live page', async () => {
    const { imports } = importMapOf(await buildLiveDocument(PAGE));
    expect(imports.three).toMatch(/^data:text\/javascript;base64,/);
    expect(imports['three/addons/postprocessing/UnrealBloomPass.js']).toMatch(/^data:/);
  });

  it('never takes an inherited property for a pinned file', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(pinnedModuleFile(`${THREE_MODULES_BASE}${name}`), name).toBeNull();
      const needs = previewScriptNeeds(`<script type="module">import '${THREE_MODULES_BASE}${name}';</script>`);
      expect(needs.modules, name).toBeUndefined();
    }
  });

  it('reports imports it cannot satisfy: a bare name mapped nowhere or to a file, and three sent elsewhere under pinned addons', () => {
    const relative = previewScriptNeeds(`<script type="importmap">{"imports":{"three":"./three.module.js"}}</script><script type="module">import * as THREE from 'three';</script>`);
    expect(relative.blocked).toEqual(['./three.module.js']);
    const unmapped = previewScriptNeeds(`<script type="module">import * as THREE from 'three';</script>`);
    expect(unmapped.blocked).toEqual(['three']);
    const elsewhere = previewScriptNeeds(`<script type="importmap">{"imports":{"three":"https://esm.sh/three@0.170.0","three/addons/":"${THREE_MODULES_BASE}examples/jsm/"}}</script>
      <script type="module">import { OrbitControls } from 'three/addons/controls/OrbitControls.js';</script>`);
    expect(elsewhere.libraries).toEqual([THREE_MODULES_LIBRARY]);
    expect(elsewhere.blocked).toEqual(['esm.sh']);
    // A relative module the live page may inline from the canvas files, and a page's own data: module, are not reported.
    expect(previewScriptNeeds(`<script type="module">import './game.js'; import 'data:text/javascript,export default 1';</script>`).blocked).toEqual([]);
  });

  it('keeps a page scope from sending the supplied modules\' own imports elsewhere', async () => {
    const page = `<!doctype html><html><head><script type="importmap">{"imports":{"three":"${THREE_MODULES_BASE}build/three.module.js","three/addons/":"${THREE_MODULES_BASE}examples/jsm/"},
      "scopes":{"data:text/":{"three":"https://unpkg.com/three@0.170.0/build/three.module.js"},"https://example.test/":{"x":"https://example.test/x.js"}}}</script></head>
      <body><script type="module">import { OrbitControls } from 'three/addons/controls/OrbitControls.js';</script></body></html>`;
    for (const html of [htmlPreviewDocument(page, true, await loadPreviewLibraries(previewScriptNeeds(page))), await buildLiveDocument(page)]) {
      const map = JSON.parse(importMapOf(html).maps[0].textContent!) as { scopes?: Record<string, unknown> };
      expect(map.scopes).toEqual({ 'https://example.test/': { x: 'https://example.test/x.js' } });
    }
  });

  it('drops a data: scope however the URL parser spells it, in every import map of the page', async () => {
    const scope = JSON.stringify({ three: 'https://unpkg.com/three@0.170.0/build/three.module.js' });
    const page = `<!doctype html><html><head>
      <script type="importmap">{"imports":{"three":"${THREE_MODULES_BASE}build/three.module.js","three/addons/":"${THREE_MODULES_BASE}examples/jsm/"},"scopes":{"da\\tta:text/":${scope}," DATA:":${scope}}}</script>
      <script type="importmap">{"scopes":{"data:text/":${scope},"https://example.test/":${scope}}}</script></head>
      <body><script type="module">import { OrbitControls } from 'three/addons/controls/OrbitControls.js';</script></body></html>`;
    const html = htmlPreviewDocument(page, true, await loadPreviewLibraries(previewScriptNeeds(page)));
    const maps = importMapOf(html).maps.map(map => JSON.parse(map.textContent!) as { scopes?: Record<string, unknown> });
    expect(maps).toHaveLength(2);
    expect(maps[0].scopes).toBeUndefined();
    expect(Object.keys(maps[1].scopes!)).toEqual(['https://example.test/']);
  });

  it('finds imports with comments before the specifier, and supplies three where the page maps it to another pinned file', async () => {
    expect(scriptSpecifiers("import * as THREE from /* the engine */ 'three';\nimport { A } from // addon\n  'three/addons/a.js';\nimport(/* lazy */ 'z');")
      .sort()).toEqual(['three', 'three/addons/a.js', 'z']);
    const core = `${THREE_MODULES_BASE}build/three.core.js`;
    const page = `<script type="importmap">{"imports":{"three":"${core}","three/addons/":"${THREE_MODULES_BASE}examples/jsm/"}}</script>
      <script type="module">import { OrbitControls } from 'three/addons/controls/OrbitControls.js';</script>`;
    const needs = previewScriptNeeds(page);
    expect(needs.blocked).toEqual([]);
    expect(needs.modules!.files).toContain('build/three.core.js');
    const entries = JSON.parse((await loadPreviewLibraries(needs)).get(PREVIEW_IMPORT_MAP_KEY)!) as Record<string, string>;
    expect(decode(entries.three)).toBe(await THREE_MODULE_FILES['build/three.core.js'].load() + moduleSourceUrl('build/three.core.js'));
  });

  it('keeps a module the page names "__proto__"', async () => {
    const page = `<script type="importmap">{"imports":{"__proto__":"${THREE_MODULES_BASE}build/three.module.js"}}</script>
      <script type="module">import * as THREE from '__proto__';</script>`;
    const needs = previewScriptNeeds(page);
    const json = (await loadPreviewLibraries(needs)).get(PREVIEW_IMPORT_MAP_KEY)!;
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(json), '__proto__')).toBe(true);
    const imports = importMapOf(htmlPreviewDocument(page, true, await loadPreviewLibraries(needs))).imports;
    expect(Object.prototype.hasOwnProperty.call(imports, '__proto__')).toBe(true);
    expect(imports['__proto__']).toMatch(/^data:text\/javascript;base64,/);
  });

  it('supplies lazy imports too: a template literal, and a classic script\'s import()', async () => {
    const lazy = `${THREE_MODULES_IMPORT_MAP}<script type="module">const THREE = await import(\`three\`);</script>`;
    const classic = `${THREE_MODULES_IMPORT_MAP}<script>import('three').then(THREE => { window.revision = THREE.REVISION; });</script>`;
    for (const page of [lazy, classic]) {
      const needs = previewScriptNeeds(page);
      expect(needs.libraries).toEqual([THREE_MODULES_LIBRARY]);
      expect(importMapOf(htmlPreviewDocument(page, true, await loadPreviewLibraries(needs))).imports.three).toMatch(/^data:text\/javascript;base64,/);
    }
    // A page with only a classic script and no import map gets one before that script.
    const bare = `<script>import('${THREE_MODULES_BASE}build/three.module.js');</script>`;
    const { doc, maps } = importMapOf(htmlPreviewDocument(bare, true, await loadPreviewLibraries(previewScriptNeeds(bare))));
    const scripts = Array.from(doc.body.querySelectorAll('script'));
    expect(maps).toHaveLength(1);
    expect(scripts.indexOf(maps[0])).toBe(0);
  });

  it('supplies the modules a live page\'s own canvas JavaScript files import', async () => {
    const page = `<!doctype html><html><head>${THREE_MODULES_IMPORT_MAP}</head><body><script type="module" src="./main.js"></script></body></html>`;
    const files: Record<string, string> = { 'main.js': "import { start } from './game.js'; start();", 'game.js': "import * as THREE from 'three'; export const start = () => THREE.REVISION;" };
    const resolve = async (target: string) => files[target] ? { bytes: new TextEncoder().encode(files[target]), name: target } : null;
    const { imports } = importMapOf(await buildLiveDocument(page, { resolve }));
    expect(imports.three).toMatch(/^data:text\/javascript;base64,/);
    // A classic canvas script that imports lazily is supplied too.
    const classic = `<!doctype html><html><head>${THREE_MODULES_IMPORT_MAP}</head><body><script src="./boot.js"></script></body></html>`;
    const boot = async (target: string) => target === 'boot.js' ? { bytes: new TextEncoder().encode("import('three').then(T => T.REVISION);"), name: target } : null;
    expect(importMapOf(await buildLiveDocument(classic, { resolve: boot })).imports.three).toMatch(/^data:text\/javascript;base64,/);
  });

  it('finds canvas files named inside the modules a live page imports, and behind a cache-busting suffix', async () => {
    const page = `<!doctype html><html><head>${THREE_MODULES_IMPORT_MAP}</head><body><script type="module">import './scene.js';</script>
      <script>const sky = new Image(); sky.src = 'sky/image-1.jpg?v=2';</script></body></html>`;
    const files: Record<string, Uint8Array> = {
      'scene.js': new TextEncoder().encode("import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'; new GLTFLoader().load('hero/model-1.glb', () => {});"),
      'hero/model-1.glb': new Uint8Array([0x67, 0x6c, 0x54, 0x46]), 'sky/image-1.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
    };
    const resolve = async (target: string) => files[target] ? { bytes: files[target], name: target.split('/').pop()! } : null;
    const live = await buildLiveDocument(page, { resolve });
    const guard = new DOMParser().parseFromString(live, 'text/html').head.querySelector('script')!.textContent!;
    expect(guard).toContain('"hero/model-1.glb":"data:model/gltf-binary;base64,');
    expect(guard).toContain('"sky/image-1.jpg":"data:image/jpeg;base64,');
    expect(namesRelativeMedia("<script>new GLTFLoader().load('hero/model.glb?v=1', show)</script>")).toBe(true);
    // A page that loads its own JavaScript files goes to the live preview, which inlines them; a CDN script or a bare
    // module name does not.
    expect(namesRelativeMedia(`${THREE_MODULES_IMPORT_MAP}<script type="module">import './scene.js';</script>`)).toBe(true);
    expect(namesRelativeMedia('<script type="module">import { start } from "../game/main.js";</script>')).toBe(true);
    expect(namesRelativeMedia('<script src="./boot.js"></script>')).toBe(true);
    expect(namesRelativeMedia(`${THREE_MODULES_IMPORT_MAP}<script type="module">import * as THREE from 'three';</script>`)).toBe(false);
    expect(namesRelativeMedia('<script src="https://cdn.example/lib.js"></script><script src="//cdn.example/x.js"></script>')).toBe(false);
    // A dashboard that fetches its data file from the canvas goes there too.
    expect(namesRelativeMedia("<script>fetch('data/metrics.json').then(r => r.json()).then(render);</script>")).toBe(true);
  });

  it('never lets a module src close the script element it is turned into', async () => {
    const src = `${THREE_MODULES_BASE}build/three.module.js?x=</script><div id=owned>owned</div><script>`;
    const page = `<html><body><script type="module" src="${src.replace(/</g, '&lt;').replace(/>/g, '&gt;')}"></script></body></html>`;
    const code = await loadPreviewLibraries(previewScriptNeeds(page));
    for (const html of [htmlPreviewDocument(page, true, code), await buildLiveDocument(page)]) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      expect(doc.getElementById('owned')).toBeNull();
      const module = Array.from(doc.querySelectorAll('script[type="module"]')).find(script => script.textContent?.startsWith('import '))!;
      expect(module.textContent).toContain('\\u003c/script>');
    }
  });
});

describe('canvas files a page script loads by path', () => {
  const page = `<!doctype html><html><head>${THREE_MODULES_IMPORT_MAP}</head><body><script type="module">
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    new GLTFLoader().load('hero/model-1.glb', gltf => {});
    const sky = new Image(); sky.src = "./sky/image-1.jpg"; const theme = new Audio('score/missing.mp3');
  </script></body></html>`;
  const files: Record<string, Uint8Array> = { 'hero/model-1.glb': new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]), 'sky/image-1.jpg': new Uint8Array([0xff, 0xd8, 0xff]) };
  const resolve = async (target: string) => files[target] ? { bytes: files[target], name: target.split('/').pop()! } : null;

  it('runs such a page in the live preview', () => {
    expect(namesRelativeMedia(page)).toBe(true);
    expect(namesRelativeMedia("<script>fetch('https://example.test/a/b.png')</script>")).toBe(false);
    expect(namesRelativeMedia('<script>const name = "image.png"</script>')).toBe(false);
  });

  it('hands the files to fetch, XMLHttpRequest and media elements by the path the script names', async () => {
    const live = await buildLiveDocument(page, { resolve });
    const doc = new DOMParser().parseFromString(live, 'text/html');
    const guard = doc.head.querySelector('script')!.textContent!;
    expect(guard).toContain('"hero/model-1.glb":"data:model/gltf-binary;base64,Z2xURgIAAAA="');
    expect(guard).toContain('"sky/image-1.jpg":"data:image/jpeg;base64,/9j/"');
    expect(guard).not.toContain('missing.mp3');
    // The page's own text is unchanged: the script still names its paths.
    expect(live).toContain("new GLTFLoader().load('hero/model-1.glb'");
  });

  it('maps a path as written, also when a Request is built from it, and leaves absolute and other URLs alone', async () => {
    const fetched: unknown[] = [];
    const sandbox = { fetch: (input: unknown) => { fetched.push(input); return Promise.resolve(input); } } as Record<string, unknown>;
    class Img { private value = ''; get src() { return this.value; } set src(next: string) { this.value = next; } }
    class Req { readonly url: string; constructor(input: unknown) { this.url = input instanceof Req ? input.url : String(input); } }
    const scope = { window: sandbox, XMLHttpRequest: class { open(..._args: unknown[]) { fetched.push(_args[1]); } }, Element: class { setAttribute() { /* noop */ } } };
    Object.assign(sandbox, { HTMLImageElement: Img, HTMLMediaElement: undefined, HTMLSourceElement: undefined, Audio: undefined, Request: Req });
    new Function('window', 'XMLHttpRequest', 'Element', assetScript({ 'hero/model-1.glb': 'data:model/gltf-binary;base64,AA==' }))(sandbox, scope.XMLHttpRequest, scope.Element);
    const fetch = sandbox.fetch as (input: unknown) => Promise<unknown>;
    await fetch('hero/model-1.glb');
    await fetch('https://awwo.example/w/1/canvas/hero/model-1.glb');
    await fetch('https://cdn.example/other.glb');
    expect(fetched).toEqual(['data:model/gltf-binary;base64,AA==', 'https://awwo.example/w/1/canvas/hero/model-1.glb', 'https://cdn.example/other.glb']);
    // three.js's FileLoader builds a Request from the path the page gave it.
    const Request = sandbox.Request as typeof Req;
    expect(new Request('hero/model-1.glb').url).toBe('data:model/gltf-binary;base64,AA==');
    expect(new Request('https://cdn.example/x/hero/model-1.glb').url).toBe('https://cdn.example/x/hero/model-1.glb');
    expect(new Request('hero/model-1.glb')).toBeInstanceOf(Request);
    const image = new (sandbox.HTMLImageElement as typeof Img)();
    image.src = './hero/model-1.glb';
    expect(image.src).toBe('data:model/gltf-binary;base64,AA==');
    image.src = 'https://cdn.example/a.png';
    expect(image.src).toBe('https://cdn.example/a.png');
  });

  it('resolves a root-relative path from the canvas root, and keeps it apart from the page-relative one', async () => {
    const nested = `<!doctype html><html><body><script>fetch("/hero/model-1.glb"); fetch("hero/model-1.glb");</script></body></html>`;
    const tree: Record<string, Uint8Array> = { 'hero/model-1.glb': new Uint8Array([1]), 'pages/hero/model-1.glb': new Uint8Array([2]) };
    const lookup = async (target: string) => tree[target] ? { bytes: tree[target], name: target.split('/').pop()! } : null;
    const guard = new DOMParser().parseFromString(await buildLiveDocument(nested, { path: 'pages/index.html', resolve: lookup }), 'text/html')
      .head.querySelector('script')!.textContent!;
    expect(guard).toContain('"/hero/model-1.glb":"data:model/gltf-binary;base64,AQ=="');
    expect(guard).toContain('"hero/model-1.glb":"data:model/gltf-binary;base64,Ag=="');
    const fetched: unknown[] = [];
    const sandbox = { fetch: (input: unknown) => { fetched.push(input); return Promise.resolve(input); } } as Record<string, unknown>;
    class Req { readonly url: string; constructor(input: unknown) { this.url = String(input); } }
    Object.assign(sandbox, { HTMLImageElement: undefined, HTMLMediaElement: undefined, HTMLSourceElement: undefined, Audio: undefined, Request: Req });
    new Function('window', 'XMLHttpRequest', 'Element', assetScript({ '/hero/model-1.glb': 'data:,root', 'hero/model-1.glb': 'data:,page' }))(
      sandbox, class { open() { /* noop */ } }, class { setAttribute() { /* noop */ } });
    const fetch = sandbox.fetch as (input: unknown) => Promise<unknown>;
    await fetch('/hero/model-1.glb');
    await fetch('./hero/model-1.glb');
    expect(fetched).toEqual(['data:,root', 'data:,page']);
    // The same through a Request, as three.js's FileLoader makes one: the path as the page wrote it decides.
    const Request = sandbox.Request as typeof Req;
    expect([new Request('/hero/model-1.glb').url, new Request('hero/model-1.glb').url]).toEqual(['data:,root', 'data:,page']);
  });
});
