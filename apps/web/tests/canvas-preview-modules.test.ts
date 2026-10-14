import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlPreviewDocument } from '../src/canvas/htmlDeliverable';
import { namesRelativeMedia } from '../src/canvas/ArtifactPreview';
import { loadPreviewLibraries, previewScriptNeeds, THREE_MODULES_LIBRARY } from '../src/canvas/previewLibraries';
import { moduleSpecifiers } from '../../../scripts/preview-modules.mjs';
import { pinnedModuleFile, PREVIEW_IMPORT_MAP_KEY, scriptSpecifiers, THREE_MODULES_BASE, THREE_MODULES_IMPORT_MAP } from '../src/canvas/previewModules';
import { THREE_MODULE_FILES, THREE_MODULES_VERSION } from '../src/canvas/previewModules.generated';
import { assetScript, buildLiveDocument } from '../src/canvas/studio/liveDocument';

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
  it('pins every generated file to the npm release installed for the web app', () => {
    expect(JSON.parse(readFileSync(path.join(THREE_DIR, 'package.json'), 'utf8')).version).toBe(THREE_MODULES_VERSION);
    for (const [file, entry] of Object.entries(THREE_MODULE_FILES)) {
      const bytes = readFileSync(path.join(THREE_DIR, file));
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
    // The bytes before rewriting are the pinned file's.
    const raw = await THREE_MODULE_FILES['build/three.core.js'].load();
    expect(decode(entries[`${THREE_MODULES_BASE}build/three.core.js`])).toBe(raw);
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

  it('maps a path as written or resolved to an absolute URL, and leaves every other URL alone', async () => {
    const fetched: unknown[] = [];
    const sandbox = { fetch: (input: unknown) => { fetched.push(input); return Promise.resolve(input); } } as Record<string, unknown>;
    class Img { private value = ''; get src() { return this.value; } set src(next: string) { this.value = next; } }
    const scope = { window: sandbox, XMLHttpRequest: class { open(..._args: unknown[]) { fetched.push(_args[1]); } }, Element: class { setAttribute() { /* noop */ } } };
    Object.assign(sandbox, { HTMLImageElement: Img, HTMLMediaElement: undefined, HTMLSourceElement: undefined, Audio: undefined });
    new Function('window', 'XMLHttpRequest', 'Element', assetScript({ 'hero/model-1.glb': 'data:model/gltf-binary;base64,AA==' }))(sandbox, scope.XMLHttpRequest, scope.Element);
    const fetch = sandbox.fetch as (input: unknown) => Promise<unknown>;
    await fetch('hero/model-1.glb');
    await fetch({ url: 'https://awwo.example/w/1/canvas/hero/model-1.glb' });
    await fetch('https://cdn.example/other.glb');
    expect(fetched).toEqual(['data:model/gltf-binary;base64,AA==', 'data:model/gltf-binary;base64,AA==', 'https://cdn.example/other.glb']);
    const image = new (sandbox.HTMLImageElement as typeof Img)();
    image.src = './hero/model-1.glb';
    expect(image.src).toBe('data:model/gltf-binary;base64,AA==');
    image.src = 'https://cdn.example/a.png';
    expect(image.src).toBe('https://cdn.example/a.png');
  });
});
