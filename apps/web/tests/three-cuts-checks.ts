// What a build of either config (vite.saas.config.mjs, vite.config.mjs) must ship of three.js, given its output for an
// entry made with THREE_ENTRY (tests/saas-three-cuts.test.ts and native-three-cuts.test.ts), and what the functions
// the cuts put in must do next to npm's (expectSameThree, also run on the cut files themselves).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as NPM_THREE from 'three';
import { expect } from 'vitest';
import { CUT_MARKS, shippedText } from '../scripts/three-cuts.mjs';

const MODULES = path.resolve(__dirname, '..', 'node_modules');
export const MODULE = path.join(MODULES, 'three', 'build', 'three.module.js');
export const CORE = path.join(MODULES, 'three', 'build', 'three.core.js');
export const GEOMETRY_UTILS = path.join(MODULES, 'three', 'examples', 'jsm', 'utils', 'GeometryUtils.js');
export const R128 = path.join(MODULES, 'three-r128', 'build', 'three.min.js');
export type OutputFile = { type: 'chunk' | 'asset'; fileName: string; isEntry?: boolean; code?: string; source?: string | Uint8Array; modules?: Record<string, unknown>; originalFileNames?: string[] };
export type Three = typeof NPM_THREE;
type Loaders = [Three, ...Array<() => Promise<{ default: string }>>];

/** Lines for an entry module: three.js in as code (its whole namespace kept), and three.module.js, three.core.js,
 * GeometryUtils.js and r128's three.min.js as ?raw text, each through a dynamic import, as a running preview loads them. */
export const THREE_ENTRY = "import * as THREE from 'three';\n"
  + `globalThis.awwoThree = [THREE, ${[MODULE, CORE, GEOMETRY_UTILS].map(file => `() => import(${JSON.stringify(`${file}?raw`)})`).join(', ')},`
  + " () => import('three-r128/build/three.min.js?raw')];\n";

/** three.core.js as the builds ship it, run as a module from this directory (Node runs npm's as it is). */
export async function cutCore(dir: string): Promise<Three> {
  const file = path.join(dir, 'three.core.cut.mjs');
  writeFileSync(file, shippedText(CORE));
  return import(pathToFileURL(file).href);
}

export async function expectShipped(files: OutputFile[], label: string) {
  const text = (file: OutputFile) => (file.type === 'chunk' ? file.code! : Buffer.from(file.source ?? '').toString('latin1'));
  for (const file of files) for (const mark of CUT_MARKS) expect(text(file), `${label} ${file.fileName} ${mark}`).not.toContain(mark);
  const holding = (suffix: string) => files.filter(file => file.type === 'chunk' && Object.keys(file.modules ?? {}).some(id => id.replace(/\\/g, '/').endsWith(suffix)));
  // The app's own three.js: the renderer's shaders with the two functions as the cut leaves them (minified, a string
  // may write its line breaks as escapes or as they are).
  const app = holding('/node_modules/three/build/three.module.js');
  expect(app, label).toHaveLength(1);
  expect(app[0]!.code).toMatch(/vec3 dithering\( vec3 color \) \{(?:\\[nt]|\s)*return color;(?:\\[nt]|\s)*\}/);
  expect(app[0]!.code).toMatch(/vec4 textureBicubic\( sampler2D sampler, vec2 uv, float lod \) \{(?:\\[nt]|\s)*return textureLod\( sampler, uv, lod \);/);
  expect(holding('/node_modules/three/build/three.core.js'), label).toHaveLength(1);
  for (const suffix of ['/three/build/three.module.js?raw', '/three/build/three.core.js?raw', '/three/examples/jsm/utils/GeometryUtils.js?raw',
    '/three-r128/build/three.min.js?raw']) expect(holding(suffix), `${label} ${suffix}`).toHaveLength(1);
  // Each ?raw copy as a page gets it: the whole output written out, its entry run, and each dynamic import awaited.
  const dir = mkdtempSync(path.join(tmpdir(), `awwo-three-cuts-${label}-`));
  try {
    writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
    for (const file of files) {
      mkdirSync(path.dirname(path.join(dir, file.fileName)), { recursive: true });
      writeFileSync(path.join(dir, file.fileName), file.type === 'chunk' ? file.code! : file.source ?? '');
    }
    const entries = files.filter(file => file.type === 'chunk' && file.isEntry);
    expect(entries, label).toHaveLength(1);
    delete (globalThis as { awwoThree?: unknown }).awwoThree;
    await import(pathToFileURL(path.join(dir, entries[0]!.fileName)).href);
    const [THREE, module, core, geometry, r128] = (globalThis as unknown as { awwoThree: Loaders }).awwoThree;
    // Where a dynamic import's chunk needs others (the native build groups node_modules into one), Vite's preload
    // helper first adds a <link rel=modulepreload> for each: the little of a document it uses.
    const scope = globalThis as { document?: unknown };
    scope.document = { getElementsByTagName: () => [], querySelector: () => null, head: { appendChild: () => undefined },
      createElement: () => ({ setAttribute: () => undefined }) };
    try {
      expect((await module!()).default === shippedText(MODULE), `${label} three.module.js`).toBe(true);
      expect((await core!()).default === shippedText(CORE), `${label} three.core.js`).toBe(true);
      expect((await geometry!()).default === shippedText(GEOMETRY_UTILS), `${label} GeometryUtils.js`).toBe(true);
      expect((await r128!()).default === shippedText(R128), `${label} r128`).toBe(true);
    } finally { delete scope.document; }
    // The app's own three.js runs the code the cuts put in, minified as it is (the same numbers to the last bit as the
    // cut file run as it is), and does what npm's does.
    expect(curveNumbers(THREE), label).toEqual(curveNumbers(await cutCore(dir)));
    expectSameThree(THREE, NPM_THREE, `${label} app`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A seeded Math.random, so that two three.js see the same numbers. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The UUIDs a three.js's generateUUID() gives while Math.random (of `realm`) gives a seeded sequence. */
function seededUUIDs(three: Three, realm: Math) {
  const random = realm.random;
  realm.random = seeded(5);
  try { return Array.from({ length: 50 }, () => three.MathUtils.generateUUID()); } finally { realm.random = random; }
}

/** The same UUIDs, worked out as the code the cuts put in makes them: four random 32-bit words as hex digits, the 13th
 * made the version and the 17th the variant. */
function awwoUUIDs(upper: boolean) {
  const random = seeded(5);
  return Array.from({ length: 50 }, () => {
    const hex = [0, 1, 2, 3].map(() => Math.floor(random() * 2 ** 32).toString(16).padStart(8, '0')).join('');
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16]!, 16) & 3]}${hex.slice(17, 20)}-${hex.slice(20)}`;
    return upper ? uuid.toUpperCase() : uuid;
  });
}

/** Points (and lengths) along CatmullRomCurve3s of every type, open and closed, through a seeded set of control points
 * (some with a point repeated, which leaves two knots no spacing), and tangents where no point repeats: a tangent is a
 * finite difference, which turns a last-bit difference along a segment of no length into noise. */
function curveNumbers(three: Three) {
  const random = seeded(11);
  const points: number[] = [], tangents: number[] = [];
  for (let set = 0; set < 24; set++) {
    const at = Array.from({ length: 2 + Math.floor(random() * 7) }, () => new three.Vector3((random() - 0.5) * 200, (random() - 0.5) * 200, (random() - 0.5) * 200));
    if (set % 6 === 0 && at.length > 2) at[1]!.copy(at[0]!);
    for (const [type, tension] of [['centripetal', 0.5], ['chordal', 0.5], ['catmullrom', 0.5], ['catmullrom', 0], ['catmullrom', 1.3]] as const) {
      for (const closed of [false, true]) {
        const curve = new three.CatmullRomCurve3(at, closed, type, tension);
        for (let i = 0; i <= 40; i++) points.push(...curve.getPoint(i / 40).toArray());
        points.push(curve.getLength());
        if (set % 6 !== 0) tangents.push(...curve.getTangent(0.37).toArray());
      }
    }
  }
  return { points, tangents };
}

/** The UUIDs and Catmull-Rom curves of a three.js the builds cut, next to npm's. UUIDs made by the code the cuts put in,
 * of npm's form (lower case, or upper as r128 writes them), from four calls to Math.random() each, as many as npm's
 * makes, so that a page that seeds Math.random draws the same numbers after them; and the same curves, to rounding.
 * `realm` is the Math the cut code reads (a vm context has its own). */
export function expectSameThree(cut: Three, npm: Three, label: string, { upper = false, realm = Math }: { upper?: boolean; realm?: Math } = {}) {
  expect(seededUUIDs(cut, realm), label).toEqual(awwoUUIDs(upper));
  const random = realm.random;
  let calls = 0;
  realm.random = () => { calls += 1; return random(); };
  let uuids: string[];
  try { uuids = Array.from({ length: 4000 }, () => cut.MathUtils.generateUUID()); } finally { realm.random = random; }
  expect(calls, label).toBe(4 * uuids.length);
  const form = upper ? /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/ : /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(uuids.filter(uuid => !form.test(uuid)), label).toEqual([]);
  expect(new Set(uuids).size, label).toBe(uuids.length);
  // No bit stuck: each digit the form leaves free takes all 16 values, the variant's all 4.
  const values = [...uuids[0]!].map((_, at) => new Set(uuids.map(uuid => uuid[at])).size);
  expect(values.join(' '), label).toBe([...'ffffffff-ffff-4fff-vfff-ffffffffffff'].map(c => ({ f: 16, v: 4 })[c as 'f' | 'v'] ?? 1).join(' '));
  const [want, got] = [curveNumbers(npm), curveNumbers(cut)];
  expect([got.points.length, got.tangents.length], label).toEqual([want.points.length, want.tangents.length]);
  const worst = want.points.reduce((most, value, at) => Math.max(most, Math.abs(value - got.points[at]!) / Math.max(1, Math.abs(value))), 0);
  expect(worst, `${label}: points`).toBeLessThan(1e-12);
  const worstTangent = want.tangents.reduce((most, value, at) => Math.max(most, Math.abs(value - got.tangents[at]!)), 0);
  expect(worstTangent, `${label}: tangents`).toBeLessThan(1e-9);
  // Exact where it should be: a coordinate every control point shares stays exactly that along the curve, as npm's does
  // (a path at one height stays at it), and an open curve is exactly at its first and last points.
  for (const type of ['centripetal', 'chordal', 'catmullrom'] as const) {
    for (const three of [npm, cut]) {
      const flat = new three.CatmullRomCurve3([[0, 1.7, -3.3], [4, 1.7, -3.3], [4.00001, 1.7, -3.3], [9, 1.7, -3.3]].map(([x, y, z]) => new three.Vector3(x, y, z)), false, type);
      const off = Array.from({ length: 65 }, (_, i) => flat.getPoint(i / 64)).filter(point => point.y !== 1.7 || point.z !== -3.3);
      expect(off.length, `${label} ${three === npm ? 'npm' : 'cut'} ${type}: points off the plane`).toBe(0);
    }
    const ends = [[-2.5, 0.1, 7], [1.2, -3.4, 0.3], [5.75, 2.2, -1.1], [9.1, 0.7, 4.4]];
    const open = new cut.CatmullRomCurve3(ends.map(([x, y, z]) => new cut.Vector3(x, y, z)), false, type);
    expect([open.getPoint(0).toArray(), open.getPoint(1).toArray()], `${label} ${type}: ends`).toEqual([ends[0], ends[3]]);
  }
}
