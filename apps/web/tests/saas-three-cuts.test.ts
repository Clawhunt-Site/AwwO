// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import * as NPM_THREE from 'three';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { CUT_FILES, CUT_MARKS, cutCode, cutFile, cutMark, shareAlikeLink, shippedText, strayFile, withoutCutCode } from '../scripts/three-cuts.mjs';
import { THREE_MODULE_FILES } from '../src/canvas/previewModules.generated';
import { CORE, GEOMETRY_UTILS, MODULE, R128, THREE_ENTRY, cutCore, expectSameThree, expectShipped, type OutputFile, type Three } from './three-cuts-checks';

const WEB = path.resolve(__dirname, '..');
const [MODULE_CUTS, CORE_CUTS, GEOMETRY_CUTS, R128_CUTS] = CUT_FILES.map(entry => entry.cuts);
const [DITHERING, BICUBIC] = MODULE_CUTS!;
const ORBIT_CONTROLS = path.join(path.dirname(path.dirname(MODULE)), 'examples', 'jsm', 'controls', 'OrbitControls.js');
// What the shader cuts leave, as the build files write it (inside a JS string: line breaks and tabs as \n and \t).
const KEPT_DITHERING = 'vec3 dithering( vec3 color ) {\\n\\t\\treturn color;\\n\\t}\\n#endif';
const KEPT_BICUBIC = '\\tvec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {\\n\\t\\treturn textureLod( sampler, uv, lod );\\n\\t}\\n\\tvec3 getVolumeTransmissionRay(';
const scratch = mkdtempSync(path.join(tmpdir(), 'awwo-three-cuts-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
type Hooks = { name: string; enforce: string; load: (this: unknown, id: string) => string | null; transform: (this: unknown, code: string, id: string) => null;
  generateBundle: { order: string; handler: (this: unknown, options: unknown, bundle: unknown) => void } };
type Cut = (typeof CUT_FILES)[number]['cuts'][number];
const plugin = withoutCutCode() as unknown as Hooks;
const context = { error(message: string): never { throw new Error(message); } };
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The text with a cut made, found here by plain index arithmetic (the plugin's own search is what is under test). */
function cutByHand(text: string, cut: Cut) {
  let end = 0;
  for (const marker of cut.after) end = text.indexOf(marker, end) + marker.length;
  return text.slice(0, end) + cut.put + text.slice(text.indexOf(cut.before, end));
}

describe('the code three.js took from Shadertoy, Stack Exchange sites and OpenProcessing, which the builds leave out', () => {
  it('is cut out of the files that hold it, each function kept under its name, and nothing else changes', () => {
    const npm = { module: readFileSync(MODULE, 'utf8'), core: readFileSync(CORE, 'utf8'), geometry: readFileSync(GEOMETRY_UTILS, 'utf8'), r128: readFileSync(R128, 'utf8') };
    // What npm's files hold: the shaders' names, and the links three.js gives where it took the rest.
    for (const mark of ['dither_shift_RGB', 'LodSizeInv']) expect(npm.module).toContain(mark);
    expect(npm.r128).toContain('dither_shift_RGB');
    expect(npm.core).toContain('stackoverflow.com/questions/105034');
    expect(npm.core).toContain('stackoverflow.com/questions/9489736');
    expect(npm.geometry).toContain('openprocessing.org/sketch/15493');
    expect(npm.geometry).toContain('openprocessing.org/user/5654');
    const shipped = { module: shippedText(MODULE), core: shippedText(CORE), geometry: shippedText(GEOMETRY_UTILS), r128: shippedText(R128) };
    expect(shipped.module).toBe(MODULE_CUTS!.reduce(cutByHand, npm.module));
    expect(shipped.core).toBe(CORE_CUTS!.reduce(cutByHand, npm.core));
    expect(shipped.geometry).toBe(GEOMETRY_CUTS!.reduce(cutByHand, npm.geometry));
    expect(shipped.r128).toBe(R128_CUTS!.reduce(cutByHand, npm.r128));
    for (const name of ['module', 'core', 'geometry', 'r128'] as const) {
      for (const mark of CUT_MARKS) expect(shipped[name], `${name} ${mark}`).not.toContain(mark);
    }
    // The license header each build starts with is untouched (GeometryUtils.js has none).
    for (const name of ['module', 'core', 'r128'] as const) expect(shipped[name].slice(0, 200), name).toBe(npm[name].slice(0, 200));
    for (const text of [shipped.module, shipped.r128]) {
      expect(text).toContain(KEPT_DITHERING);
      // The shader that calls it still does.
      expect(text).toContain('gl_FragColor.rgb = dithering( gl_FragColor.rgb );');
    }
    expect(shipped.module).toContain(KEPT_BICUBIC);
    expect(shipped.module).toContain('return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );');
    // three.core.js and r128: each function under its name with AwwO's code, and the table gone; what calls them as it was.
    expect(shipped.core).toContain("function generateUUID() {\n\n\t// AwwO's own code");
    expect(shipped.core).toContain("function CubicPoly() {\n\n\t// AwwO's own code");
    expect(shipped.core).not.toContain('_lut');
    expect(npm.core).toContain('safety check for repeated points');
    expect(shipped.core).toContain("\t\tif ( this.curveType === 'centripetal' || this.curveType === 'chordal' ) {\n\n\t\t\t// AwwO's own code");
    expect(shipped.core).toContain("\n\n\t\t} else if ( this.curveType === 'catmullrom' ) {\n\n\t\t\tpx.initCatmullRom( p0.x, p1.x, p2.x, p3.x, this.tension );");
    expect(shipped.r128).toContain("function ct(){/* AwwO's own code");
    expect(shipped.r128).toContain("function vl(){/* AwwO's own code");
    expect(shipped.r128).toContain(`"centripetal"===this.curveType||"chordal"===this.curveType){/* AwwO's own code`);
    expect(shipped.r128.split('st[').length - 1).toBe(0);
    // r128's DataUtils: a class made in a closure in place of the one that held the function from Stack Exchange.
    expect(npm.r128).toContain('t.DataUtils=class{static toHalfFloat(t){Lh[0]=t;');
    expect(shipped.r128).toContain("t.DataTextureLoader=dl,t.DataUtils=(()=>{/* AwwO's own code");
    expect(shipped.r128).not.toContain('Lh[0]=t');
    // GeometryUtils: both curves under their names, and gosper() and the rest as they were.
    expect(shipped.geometry).toContain('function hilbert2D() {');
    expect(shipped.geometry).toContain('function hilbert3D() {');
    const gosper = (text: string) => text.slice(text.indexOf('/**\n * Generates a Gosper curve'));
    expect(gosper(shipped.geometry)).toBe(gosper(npm.geometry));
  });

  it('leaves three.js doing what it did: UUIDs of its form, its Catmull-Rom curves, GeometryUtils but for the two Hilbert curves', async () => {
    expectSameThree(await cutCore(scratch), NPM_THREE, 'three.core.js');
    // r128 as a page's classic script runs it, in a realm of its own.
    const r128 = (text: string) => {
      const realm = vm.createContext({});
      vm.runInContext(text, realm);
      return { three: (realm as unknown as { THREE: Three }).THREE, math: vm.runInContext('Math', realm) as Math };
    };
    const cut = r128(shippedText(R128)), npm = r128(readFileSync(R128, 'utf8'));
    expectSameThree(cut.three, npm.three, 'r128', { upper: true, realm: cut.math });
    // r128's DataUtils.toHalfFloat(): the same half for every number in its range, on each half, the midpoints and
    // quarter points between neighbours and a seeded spread of float bit patterns, both signs; beyond the range,
    // infinity (r128 set the float's mantissa bits on infinity's), and for NaN, NaN (r128 gave infinity).
    const toHalf = { npm: npm.three.DataUtils.toHalfFloat, cut: cut.three.DataUtils.toHalfFloat };
    const half = (bits: number) => { const exponent = (bits >> 10) & 31, mantissa = bits & 1023;
      return (bits & 0x8000 ? -1 : 1) * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    const float = new Float32Array(1), floatBits = new Uint32Array(float.buffer);
    let state = 7;
    const values: number[] = [0, -0, 2 ** -24, 2 ** -25, 1.5 * 2 ** -25, 2 ** -14, 65504, 65519, 65519.99, 65520, 65536, 1e10, Infinity, -Infinity];
    for (let bits = 0; bits < 0x7c00; bits++) {
      const [low, high] = [half(bits), half(bits + 1)];
      values.push(low, (low + high) / 2, low + (high - low) / 4, low + 3 * (high - low) / 4);
    }
    for (let i = 0; i < 200_000; i++) { state = (Math.imul(state, 1103515245) + 12345) >>> 0; floatBits[0] = state; if (!Number.isNaN(float[0])) values.push(float[0]); }
    let inRange = 0;
    for (const value of [...values, ...values.map(value => -value)]) {
      const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
      if (Math.abs(Math.fround(value)) >= 65520) { expect(toHalf.cut(value), `${value}`).toBe(sign | 0x7c00); continue; }
      inRange += 1;
      if (toHalf.cut(value) !== toHalf.npm(value)) expect(toHalf.cut(value), `${value}`).toBe(toHalf.npm(value));
    }
    expect(inRange).toBeGreaterThan(200_000);
    expect([toHalf.npm(NaN), toHalf.cut(NaN), toHalf.npm(1e10), toHalf.cut(1e10)]).toEqual([0x7c00, 0x7e00, 0x157ef9, 0x7c00]);
    // GeometryUtils, with its import of 'three' pointing at npm's three.module.js.
    const load = async (text: string, name: string) => {
      const file = path.join(scratch, name);
      writeFileSync(file, text.replace("from 'three';", `from ${JSON.stringify(pathToFileURL(MODULE).href)};`));
      return import(pathToFileURL(file).href) as Promise<{ hilbert2D: (...args: unknown[]) => unknown[]; hilbert3D: (...args: unknown[]) => unknown[]; gosper: (size?: number) => number[] }>;
    };
    const [shippedGeometry, npmGeometry] = [await load(shippedText(GEOMETRY_UTILS), 'GeometryUtils.cut.mjs'), await load(readFileSync(GEOMETRY_UTILS, 'utf8'), 'GeometryUtils.npm.mjs')];
    expect(npmGeometry.hilbert3D(new NPM_THREE.Vector3(), 25, 1)).toHaveLength(64);
    expect(() => shippedGeometry.hilbert2D()).toThrow('GeometryUtils.hilbert2D() is not in the copy of three.js AwwO supplies: generate the points of the curve in the page itself.');
    expect(() => shippedGeometry.hilbert3D(new NPM_THREE.Vector3(), 25, 1, 0, 1, 2, 3, 4, 5, 6, 7)).toThrow('GeometryUtils.hilbert3D() is not in the copy of three.js AwwO supplies');
    expect(shippedGeometry.gosper(3)).toEqual(npmGeometry.gosper(3));
  });

  it('stop at a file, a piece of code or a way to ship them that they were not written for', () => {
    const module = readFileSync(MODULE, 'utf8');
    const first = DITHERING!.after[0]!;
    expect(() => cutCode(`${module}${first}`, DITHERING, 'm')).toThrow(/m: "vec3 dithering\( vec3 color \) \{" is not in it exactly once/);
    expect(() => cutCode(module.replace(first, ''), DITHERING, 'm')).toThrow(/is not in it exactly once/);
    expect(() => cutCode(module.split(DITHERING!.before).join(''), DITHERING, 'm'))
      .toThrow(/does not follow, so the dithering from https:\/\/www\.shadertoy\.com\/view\/MslGR8 cannot be found/);
    // Other chunks declare the same varying: only those after the transmission chunk's start count.
    const transmission = module.indexOf(BICUBIC!.after[0]!);
    expect(() => cutCode(module.slice(0, transmission) + module.slice(transmission).split(BICUBIC!.after[1]!).join(''), BICUBIC, 'm'))
      .toThrow(/"varying vec3 vWorldPosition;\\\\n" does not follow/);
    // A piece that is not the one known by its sha256: one more space in it.
    expect(() => cutCode(module.replace(first, `${first} `), DITHERING, 'm')).toThrow(/m: the code where the dithering .* is not that code any more \(sha256 [0-9a-f]{64}\)/);
    const core = readFileSync(CORE, 'utf8');
    expect(() => cutCode(core.replace('function generateUUID() {', 'function generateUUID() { '), CORE_CUTS![1]!, 'c'))
      .toThrow(/c: the code where generateUUID\(\), from a Stack Overflow answer was is not that code any more/);
    // Another release of the package.
    const later = path.join(scratch, 'node_modules', 'three');
    mkdirSync(path.join(later, 'build'), { recursive: true });
    writeFileSync(path.join(later, 'package.json'), JSON.stringify({ name: 'three', version: '0.187.0' }));
    writeFileSync(path.join(later, 'build', 'three.core.js'), core);
    expect(() => shippedText(path.join(later, 'build', 'three.core.js'))).toThrow(/node_modules\/three is 0\.187\.0, not the 0\.186\.1/);
    expect(() => shippedText(ORBIT_CONTROLS)).toThrow(/is none of the files/);
    expect(cutFile(ORBIT_CONTROLS)).toBeUndefined();

    // The load hook: as code, as ?raw text (the dev server adds &import), and nothing else.
    for (const file of [MODULE, CORE, GEOMETRY_UTILS]) {
      expect(plugin.load.call(context, file)).toBe(shippedText(file));
      expect(plugin.load.call(context, `${file}?raw`)).toBe(`export default ${JSON.stringify(shippedText(file))};`);
    }
    expect(plugin.load.call(context, `${R128}?raw&import`)).toBe(`export default ${JSON.stringify(shippedText(R128))};`);
    expect(plugin.load.call(context, CORE.replace(/\\/g, '/'))).toBe(shippedText(CORE));
    for (const query of ['url', 'inline', 'worker', 'raw&url']) {
      for (const file of [MODULE, CORE]) expect(() => plugin.load.call(context, `${file}?${query}`), query).toThrow(/would ship one of three\.js's files without the cuts/);
    }
    expect(plugin.load.call(context, ORBIT_CONTROLS)).toBeNull();
    expect(plugin.load.call(context, `\0${MODULE}`)).toBeNull();

    // The transform hook: a file of either package that credits a source of code under CC BY-SA, but for the
    // references, stops the build, as code or as ?raw text.
    expect(shareAlikeLink('see https://computergraphics.stackexchange.com/a/4765 and https://serverfault.com/questions/482875/why')).toBeUndefined();
    expect(shareAlikeLink('// http://stackoverflow.com/questions/105034/how-to-create')).toBe('stackoverflow.com/questions/105034/how-to-create');
    expect(shareAlikeLink(' * Based on work by: {@link https://openprocessing.org/user/5654}')).toBe('openprocessing.org/user/5654');
    expect(shareAlikeLink('// Source: http://gamedev.stackexchange.com/questions/17326/x/17410#17410')).toBe('gamedev.stackexchange.com/questions/17326/x/17410#17410');
    expect(shareAlikeLink('"https://superuser.com/a/1"')).toBe('superuser.com/a/1');
    // A reference is one whole post: a longer id is another; its own path, query or fragment is still it.
    for (const other of ['serverfault.com/questions/4828759', 'computergraphics.stackexchange.com/a/47651', 'math.stackexchange.com/questions/45441649']) {
      expect(shareAlikeLink(`see https://${other}`), other).toBe(other);
    }
    for (const same of ['math.stackexchange.com/questions/4544164/x', 'computergraphics.stackexchange.com/a/4765#y', 'serverfault.com/questions/482875?z']) {
      expect(shareAlikeLink(`see https://${same}`), same).toBeUndefined();
    }
    // A link in ?raw text, a JSON string, ends at the escape after it.
    expect(shareAlikeLink(JSON.stringify('// Visualization: https://computergraphics.stackexchange.com/a/4765\n\t\t *'))).toBeUndefined();
    // Inside a base64 data: URL too (a file Vite inlines).
    expect(shareAlikeLink(`export default "data:text/javascript;base64,${Buffer.from('// https://stackoverflow.com/a/4322940/1').toString('base64')}";`))
      .toBe('stackoverflow.com/a/4322940/1');
    const addon = (file: string) => path.join(path.dirname(path.dirname(MODULE)), 'examples', 'jsm', ...file.split('/'));
    for (const [file, link] of [['loaders/EXRLoader.js', 'stackoverflow.com/questions/5678432'], ['math/MeshSurfaceSampler.js', 'stackoverflow.com/a/4322940'],
      ['loaders/3DMLoader.js', 'stackoverflow.com/a/18499923']]) {
      const id = addon(file!);
      expect(() => plugin.transform.call(context, readFileSync(id, 'utf8'), id), file).toThrow(new RegExp(`${escapeRegExp(path.basename(file!))} credits ${escapeRegExp(link!)}`));
      expect(() => plugin.transform.call(context, `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`, `${id}?raw`), file).toThrow(/credits stackoverflow\.com/);
    }
    expect(() => plugin.transform.call(context, readFileSync(CORE, 'utf8'), CORE)).toThrow(/three\.core\.js credits stackoverflow\.com\/questions\/105034/);
    expect(plugin.transform.call(context, '// https://stackoverflow.com/questions/1', '/app/src/page.ts')).toBeNull();
    // Every file the builds take in, as they ship it, passes: the preview's files (the app's own imports among them)
    // and r128.
    for (const file of Object.keys(THREE_MODULE_FILES)) {
      const id = path.join(path.dirname(path.dirname(MODULE)), ...file.split('/'));
      expect(plugin.transform.call(context, cutFile(id) ? shippedText(id) : readFileSync(id, 'utf8'), id), file).toBeNull();
    }
    expect(plugin.transform.call(context, shippedText(R128), `${R128}?raw`)).toBeNull();
  });

  it('stop a build whose output still holds what they cut, or another file of three.js that would bring it back', () => {
    const chunk = (code: string, modules: string[] = []): OutputFile => ({ type: 'chunk', fileName: 'assets/a.js', code, modules: Object.fromEntries(modules.map(id => [id, {}])) });
    // The load hook first, the check of the output last, after the files other plugins emit (the HTML, the licenses).
    expect([plugin.enforce, plugin.generateBundle.order]).toEqual(['pre', 'post']);
    const run = (...files: OutputFile[]) => plugin.generateBundle.handler.call(context, {}, Object.fromEntries(files.map((file, index) => [`${index}`, file])));
    const shippable = ['/app/node_modules/three/build/three.module.js', '/app/node_modules/three/build/three.core.js', `${MODULE}?raw`, `${CORE}?raw`,
      ORBIT_CONTROLS, `${GEOMETRY_UTILS}?raw`, '/app/node_modules/three/examples/jsm/libs/stats.module.js', `${R128}?raw`, '/app/node_modules/other/index.js'];
    expect(() => run(chunk('const ok = 1;', shippable), { type: 'asset', fileName: 'assets/t.txt', source: new TextEncoder().encode('fine') })).not.toThrow();
    for (const id of shippable) expect(strayFile(id), id).toBeUndefined();
    for (const mark of CUT_MARKS) {
      expect(() => run(chunk(`var s="${mark}"`))).toThrow(new RegExp(`assets/a\\.js holds ${escapeRegExp(mark)}, from what scripts/three-cuts\\.mjs cuts out`));
      expect(() => run({ type: 'asset', fileName: 'assets/b.txt', source: new TextEncoder().encode(`x ${mark} y`) })).toThrow(/assets\/b\.txt holds/);
    }
    // three.js's sources and other builds (each repeats what is cut), its WebGPU and TSL code, any other file of r128, a
    // copy of three inside another package.
    for (const id of ['/app/node_modules/three/build/three.webgpu.js', '/app/node_modules/three/build/three.tsl.js?raw',
      'C:\\app\\node_modules\\three\\src\\nodes\\accessors\\TextureBicubic.js', '/app/node_modules/three/examples/jsm/tsl/display/hashBlur.js',
      '/app/node_modules/three/src/math/MathUtils.js', '/app/node_modules/three/build/three.cjs', '/app/node_modules/three/build/three.module.min.js',
      '/app/node_modules/three/package.json', '/app/node_modules/three-r128/build/three.module.js', '/app/node_modules/three-r128/examples/jsm/utils/GeometryUtils.js',
      '/app/node_modules/other/node_modules/three/build/three.cjs']) {
      expect(strayFile(id), id).toBe(id);
      expect(() => run(chunk('const ok = 1;', [id])), id).toThrow(/of three\.js the builds take in only its core and module builds and its add-ons but the TSL ones/);
    }
    expect(() => run({ type: 'asset', fileName: 'assets/w.js', source: 'x', originalFileNames: ['node_modules/three/build/three.webgpu.nodes.js'] }))
      .toThrow(/assets\/w\.js holds node_modules\/three\/build\/three\.webgpu\.nodes\.js/);
    // An add-on taken in as an asset (?url, new URL(...)), which no transform hook sees: its text is checked here. A
    // chunk is not (its modules were, one by one; it may hold other packages' strings).
    const sampler = { type: 'asset' as const, fileName: 'assets/MeshSurfaceSampler-x.js', source: '// {@link https://stackoverflow.com/a/4322940/1314762}',
      originalFileNames: ['node_modules/three/examples/jsm/math/MeshSurfaceSampler.js'] };
    expect(() => run(sampler)).toThrow(/assets\/MeshSurfaceSampler-x\.js, from node_modules\/three\/examples\/jsm\/math\/MeshSurfaceSampler\.js, credits stackoverflow\.com\/a\/4322940/);
    expect(() => run({ ...sampler, originalFileNames: ['src/notes.js'] })).not.toThrow();
    expect(() => run(chunk('const help = "https://stackoverflow.com/a/1";', ['/app/node_modules/three/build/three.module.js', '/app/node_modules/other/index.js']))).not.toThrow();
    // Inside a base64 data: URL too (an asset or a worker Vite inlines), in code or in a stylesheet.
    const base64 = (text: string) => Buffer.from(text).toString('base64');
    for (const mark of CUT_MARKS) {
      const padded = `x${mark}`; // base64 of a length that needs padding
      expect(cutMark(`const u="data:text/javascript;base64,${base64(padded)}";`)).toBe(mark);
      expect(() => run(chunk(`new Worker("data:text/javascript;base64,${base64(`self.s='${mark}'`)}")`))).toThrow(new RegExp(`holds ${escapeRegExp(mark)}`));
      expect(() => run({ type: 'asset', fileName: 'assets/c.css', source: `a{background:url(data:application/octet-stream;base64,${base64(mark)})}` }))
        .toThrow(/assets\/c\.css holds/);
    }
    expect(cutMark(`url(data:font/woff2;base64,${base64('just a font')})`)).toBeUndefined();
    expect(() => run(chunk(`const f="data:font/woff2;base64,${base64('just a font')}";`))).not.toThrow();
  });

  it('are made by the hosted config for the app and for its workers', async () => {
    const { default: config } = await import('../vite.saas.config.mjs');
    const names = (plugins: unknown) => [plugins].flat(Infinity as 1).map(plugin => (plugin as { name?: string } | null)?.name);
    expect(names(config.plugins)).toContain(plugin.name);
    expect(names(config.worker.plugins())).toEqual([plugin.name]);
  });

  it("leave it all out of a real hosted build: the app's own three.js and the copies a running preview loads", async () => {
    await expectShipped(await hostedBuild(THREE_ENTRY), 'hosted');
  }, 300_000);

  it("are made in the workspace image's copy as well, which the page check serves", () => {
    // The image's build step, run as the Dockerfile runs it, on a tools directory laid out as after its npm ci.
    const repo = path.resolve(WEB, '..', '..');
    const tools = path.join(repo, 'deploy', 'saas', 'workspace', 'tools');
    const copy = readFileSync(path.join(tools, 'three-cuts.mjs'), 'utf8');
    expect(copy).toBe(`// Copied by scripts/preview-modules.mjs from apps/web/scripts/three-cuts.mjs for the workspace image's build; do not edit by hand.\n`
      + readFileSync(path.join(WEB, 'scripts', 'three-cuts.mjs'), 'utf8'));
    expect(existsSync(path.join(tools, 'three-shadertoy.mjs'))).toBe(false);
    const dockerfile = readFileSync(path.join(repo, 'deploy', 'saas', 'workspace', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('tools/keep-preview-files.mjs tools/three-cuts.mjs /opt/awwo/tools/');
    expect(dockerfile).toContain('&& node /opt/awwo/tools/keep-preview-files.mjs && rm /opt/awwo/tools/keep-preview-files.mjs /opt/awwo/tools/three-cuts.mjs');
    const list = JSON.parse(readFileSync(path.join(tools, 'three-preview-files.json'), 'utf8')) as { files: Record<string, string> };
    const layout = (name: string, files: Record<string, string>) => {
      const dir = path.join(scratch, name), three = path.join(dir, 'node_modules', 'three');
      for (const file of ['keep-preview-files.mjs', 'three-cuts.mjs']) cpSync(path.join(tools, file), path.join(dir, file));
      writeFileSync(path.join(dir, 'three-preview-files.json'), JSON.stringify({ ...list, files }));
      for (const file of ['package.json', 'LICENSE', 'build/three.cjs', ...Object.keys(files)]) cpSync(path.join(path.dirname(path.dirname(MODULE)), file), path.join(three, file));
      return { dir, three };
    };
    const image = layout('image', list.files);
    expect(execFileSync(process.execPath, [path.join(image.dir, 'keep-preview-files.mjs')], { encoding: 'utf8' }))
      .toMatch(/kept 91 files .*removed 1; made the cuts of three-cuts\.mjs in build\/three\.module\.js, build\/three\.core\.js, examples\/jsm\/utils\/GeometryUtils\.js\n$/);
    for (const file of [MODULE, CORE, GEOMETRY_UTILS]) {
      const relative = path.relative(path.dirname(path.dirname(MODULE)), file);
      expect(readFileSync(path.join(image.three, relative), 'utf8') === shippedText(file), relative).toBe(true);
    }
    expect(existsSync(path.join(image.three, 'build', 'three.cjs'))).toBe(false);
    // A list that named an npm file as it is fails the build.
    for (const file of ['build/three.module.js', 'build/three.core.js']) {
      const npm = { ...list.files, [file]: createHash('sha256').update(readFileSync(path.join(path.dirname(path.dirname(MODULE)), file))).digest('hex') };
      expect(() => execFileSync(process.execPath, [path.join(layout(`uncut-${path.basename(file)}`, npm).dir, 'keep-preview-files.mjs')], { stdio: 'pipe' }), file)
        .toThrow(new RegExp(`${escapeRegExp(file)} is not the file the preview supplies`));
    }
    // So does a list that names an add-on holding code from Stack Overflow, as it is.
    const samplerFile = 'examples/jsm/math/MeshSurfaceSampler.js';
    const withSampler = { ...list.files, [samplerFile]: createHash('sha256').update(readFileSync(path.join(path.dirname(path.dirname(MODULE)), samplerFile))).digest('hex') };
    expect(() => execFileSync(process.execPath, [path.join(layout('sampler', withSampler).dir, 'keep-preview-files.mjs')], { stdio: 'pipe' }))
      .toThrow(/examples\/jsm\/math\/MeshSurfaceSampler\.js credits stackoverflow\.com\/a\/4322940/);
  });

  it('stop a real hosted build that would take in another file of three.js or an add-on with code from Stack Overflow, or inline what they cut as a base64 URL', async () => {
    // three's own source file of the dithering chunk, small enough for Vite to inline: the load hook leaves it alone
    // (none of the files it cuts), and the check of the output stops it as a file of three's sources.
    const chunk = 'three/src/renderers/shaders/ShaderChunk/dithering_pars_fragment.glsl.js';
    await expect(hostedBuild(`import u from '${chunk}?url&inline';\nglobalThis.awwoInlined = u;\n`))
      .rejects.toThrow(/holds \S*node_modules\/three\/src\/renderers\/shaders\/ShaderChunk\/dithering_pars_fragment\.glsl\.js\S*: of three\.js the builds take in only/);
    // A file of no package that holds the dithering's code, inlined: only the check of the output, base64 decoded,
    // stands between it and the bundle.
    const note = path.join(scratch, 'dithering-note.txt');
    writeFileSync(note, 'vec3 dither_shift_RGB = vec3( 0.25 );');
    await expect(hostedBuild(`import u from ${JSON.stringify(`${note}?url&inline`)};\nglobalThis.awwoInlined = u;\n`))
      .rejects.toThrow(/holds dither_shift_RGB, from what scripts\/three-cuts\.mjs cuts out of three\.js/);
    // An add-on that holds code from Stack Overflow (EXRLoader.js's half-float decoding), which the whitelist lets in:
    // as code, and as an asset, emitted (?url) or inlined (?url&inline).
    await expect(hostedBuild("import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';\nglobalThis.awwoLoader = EXRLoader;\n"))
      .rejects.toThrow(/EXRLoader\.js credits stackoverflow\.com\/questions\/5678432/);
    await expect(hostedBuild("import u from 'three/examples/jsm/math/MeshSurfaceSampler.js?url';\nglobalThis.awwoUrl = u;\n"))
      .rejects.toThrow(/from \S*node_modules\/three\/examples\/jsm\/math\/MeshSurfaceSampler\.js, credits stackoverflow\.com\/a\/4322940/);
    await expect(hostedBuild("import u from 'three/examples/jsm/math/MeshSurfaceSampler.js?url&inline';\nglobalThis.awwoUrl = u;\n"))
      .rejects.toThrow(/MeshSurfaceSampler\.js\?url&inline credits stackoverflow\.com\/a\/4322940/);
  }, 300_000);
});

/** A build with the hosted config of an entry made of these lines, nothing written; the release's NODE_ENV. With the
 * stylesheet that names the app's own fonts and with the preview fonts, which its font license plugins otherwise stop on. */
async function hostedBuild(lines: string): Promise<OutputFile[]> {
  const entry = 'virtual:awwo-three-cuts-hosted';
  const source = `import ${JSON.stringify(path.join(WEB, 'src', 'saas', 'design', 'tokens.css'))};\n`
    + `import { previewFontSource } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'previewFonts.ts'))};\nglobalThis.awwoPreviewFontSource = previewFontSource;\n`
    + lines;
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = await build({ configFile: path.join(WEB, 'vite.saas.config.mjs'), configLoader: 'runner', logLevel: 'silent', mode: 'production',
      plugins: [{ name: 'entry', resolveId: (id: string) => (id === entry ? `\0${entry}` : undefined), load: (id: string) => (id === `\0${entry}` ? source : undefined) }],
      build: { write: false, rollupOptions: { input: entry } } });
    return (Array.isArray(result) ? result : [result]).flatMap(output => (output as unknown as { output: OutputFile[] }).output);
  } finally { process.env.NODE_ENV = nodeEnv; }
}
