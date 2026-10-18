// What a build of either config (vite.saas.config.mjs, vite.config.mjs) must ship of three.js, given its output for an
// entry made with THREE_ENTRY: tests/saas-three-shadertoy.test.ts and native-three-shadertoy.test.ts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { SHADERTOY_MARKS, shippedText } from '../scripts/three-shadertoy.mjs';

const MODULES = path.resolve(__dirname, '..', 'node_modules');
export const MODULE = path.join(MODULES, 'three', 'build', 'three.module.js');
export const CORE = path.join(MODULES, 'three', 'build', 'three.core.js');
export const R128 = path.join(MODULES, 'three-r128', 'build', 'three.min.js');
export type OutputFile = { type: 'chunk' | 'asset'; fileName: string; isEntry?: boolean; code?: string; source?: string | Uint8Array; modules?: Record<string, unknown>; originalFileNames?: string[] };
type Loaders = [unknown, () => Promise<{ default: string }>, () => Promise<{ default: string }>, () => Promise<{ default: string }>];

/** Lines for an entry module: three.js in as code (its whole namespace kept), and three.module.js, three.core.js and
 * r128's three.min.js as ?raw text, each through a dynamic import, as a running preview loads them. */
export const THREE_ENTRY = "import * as THREE from 'three';\n"
  + `globalThis.awwoThree = [THREE, () => import(${JSON.stringify(`${MODULE}?raw`)}), () => import(${JSON.stringify(`${CORE}?raw`)}),`
  + " () => import('three-r128/build/three.min.js?raw')];\n";

export async function expectShipped(files: OutputFile[], label: string) {
  const text = (file: OutputFile) => (file.type === 'chunk' ? file.code! : Buffer.from(file.source ?? '').toString('latin1'));
  for (const file of files) for (const mark of SHADERTOY_MARKS) expect(text(file), `${label} ${file.fileName} ${mark}`).not.toContain(mark);
  const holding = (suffix: string) => files.filter(file => file.type === 'chunk' && Object.keys(file.modules ?? {}).some(id => id.replace(/\\/g, '/').endsWith(suffix)));
  // The app's own three.js: the renderer's shaders with the two functions as the cut leaves them (minified, a string
  // may write its line breaks as escapes or as they are).
  const app = holding('/node_modules/three/build/three.module.js');
  expect(app, label).toHaveLength(1);
  expect(app[0]!.code).toMatch(/vec3 dithering\( vec3 color \) \{(?:\\[nt]|\s)*return color;(?:\\[nt]|\s)*\}/);
  expect(app[0]!.code).toMatch(/vec4 textureBicubic\( sampler2D sampler, vec2 uv, float lod \) \{(?:\\[nt]|\s)*return textureLod\( sampler, uv, lod \);/);
  for (const suffix of ['/three/build/three.module.js?raw', '/three/build/three.core.js?raw', '/three-r128/build/three.min.js?raw']) expect(holding(suffix), `${label} ${suffix}`).toHaveLength(1);
  // Each ?raw copy as a page gets it: the whole output written out, its entry run, and each dynamic import awaited
  // (three.core.js comes unchanged).
  const dir = mkdtempSync(path.join(tmpdir(), `awwo-three-shadertoy-${label}-`));
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
    const [, module, core, r128] = (globalThis as unknown as { awwoThree: Loaders }).awwoThree;
    // Where a dynamic import's chunk needs others (the native build groups node_modules into one), Vite's preload
    // helper first adds a <link rel=modulepreload> for each: the little of a document it uses.
    const scope = globalThis as { document?: unknown };
    scope.document = { getElementsByTagName: () => [], querySelector: () => null, head: { appendChild: () => undefined },
      createElement: () => ({ setAttribute: () => undefined }) };
    try {
      expect((await module()).default === shippedText(MODULE), `${label} three.module.js`).toBe(true);
      expect((await core()).default === readFileSync(CORE, 'utf8'), `${label} three.core.js`).toBe(true);
      expect((await r128()).default === shippedText(R128), `${label} r128`).toBe(true);
    } finally { delete scope.document; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
