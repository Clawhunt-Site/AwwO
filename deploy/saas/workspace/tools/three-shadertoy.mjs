// Copied by scripts/preview-modules.mjs from apps/web/scripts/three-shadertoy.mjs for the workspace image's build; do not edit by hand.
// Leaves out of the app's builds the two shaders the three.js they ship took from Shadertoy, where a shader is under
// CC BY-NC-SA unless its author says otherwise: non-commercial terms, so the owner had them taken out (2026-10-18).
// - the dithering of three.js's WebGL renderer (https://www.shadertoy.com/view/MslGR8), in 0.186.1 and in r128:
//   dithering() returns the color it gets, so a material with dithering on draws as one with it off;
// - N8's bicubic filtering of the transmission buffer (https://www.shadertoy.com/view/Dl2SDW), in 0.186.1:
//   textureBicubic() samples the buffer's mip levels with textureLod, as three.js did before it took N8's filter, so a
//   rough transmissive material looks a little less smooth.
// The files that hold them ship as code (the app's own 3D views) and as text (?raw: the modules and the r128 library a
// running preview loads, whose size and sha256 src/canvas/previewModules.generated.ts and previewLibraries.ts pin).
// Both build configs, for the app and for its workers, read them through this plugin's load hook, with each shader's
// body cut out and the function kept under its own name and signature, so the shaders that call it still compile. The
// dev server and the test configs cut their ?raw imports too, so a preview there checks the same pinned sizes; a code
// import of three goes there uncut (to Vite's dependency pre-bundling, or to Node), and neither ships. This file holds
// no line of either shader's body: it finds a body between markers (the function's own header and three.js's code
// around it) and knows it by its sha256.
// The build fails when one of the files is not the release this was written for, when a body is not exactly the one
// expected, when one of the files would ship by another way (any other ?query), when the bundle takes in three.js's
// WebGPU or TSL code (which holds more code from Shadertoy, none of it cut out), and when any file it emits, once the
// other plugins have emitted theirs, still holds either shader, also inside a base64 data: URL.
// tests/saas-three-shadertoy.test.ts runs the hosted build config, tests/native-three-shadertoy.test.ts the native one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A shader body to cut: the text between the end of the last of `after` (each found after the one before it, the
 * first exactly once in the file) and the first `before` that follows, as the build file writes it (inside a JS
 * string, so its line breaks and tabs are the escapes \n and \t); it must hash to `sha256`, and `put` replaces it.
 */
const DITHERING = {
  shader: 'the dithering from https://www.shadertoy.com/view/MslGR8',
  after: ['vec3 dithering( vec3 color ) {'], before: '\\n\\t}\\n#endif',
  sha256: '7507a4fe67025e8375586cf1ef02614c403360130fb2c3d9f3a091cb105e7590',
  put: '\\n\\t\\treturn color;',
};
const BICUBIC = {
  shader: "N8's bicubic filtering from https://www.shadertoy.com/view/Dl2SDW",
  // transmission_pars_fragment, from its declarations to getVolumeTransmissionRay(): the filter's weight functions,
  // bicubic() and textureBicubic().
  after: ['var transmission_pars_fragment = "', 'varying vec3 vWorldPosition;\\n'], before: '\\tvec3 getVolumeTransmissionRay(',
  sha256: 'a5f5676ab4b59b6c094cff2e3ee7cbe12bd3eb3be397d4e05287791b9333e4c3',
  put: '\\tvec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {\\n\\t\\treturn textureLod( sampler, uv, lod );\\n\\t}\\n',
};
/** The files that hold them, by package directory under node_modules and the release each was written for. */
export const SHADERTOY_FILES = [
  { pkg: 'three', version: '0.186.1', file: 'build/three.module.js', cuts: [DITHERING, BICUBIC] },
  { pkg: 'three-r128', version: '0.128.0', file: 'build/three.min.js', cuts: [DITHERING] },
];
/** Names in either shader's code, which no file a build emits may hold. */
export const SHADERTOY_MARKS = ['dither_shift_RGB', 'LodSizeInv'];
/** three.js's WebGPU and TSL code, which takes more from Shadertoy (TextureBicubic.js, Hash.js, WGSLNodeBuilder.js and
 * TSL add-ons): the builds do not ship it. A chunk names its modules by absolute id, an asset its file from the root. */
const WEBGPU = /(?:^|\/)node_modules\/three\/(?:build\/three\.(?:webgpu|tsl)\b[^/]*|src\/(?:nodes|renderers\/webgpu)\/|examples\/jsm\/tsl\/)/;

const sha256 = text => createHash('sha256').update(text).digest('hex');
const posixPath = id => id.replace(/\\/g, '/');

/** The text with a cut made; throws when its markers are not where they were, or the body is not the one expected. */
export function cutShader(text, cut, label) {
  const first = cut.after[0];
  if (text.split(first).length !== 2) throw new Error(`${label}: ${JSON.stringify(first)} is not in it exactly once, so ${cut.shader} cannot be found.`);
  let end = 0;
  for (const marker of cut.after) {
    const at = text.indexOf(marker, end);
    if (at < 0) throw new Error(`${label}: ${JSON.stringify(marker)} does not follow, so ${cut.shader} cannot be found.`);
    end = at + marker.length;
  }
  const stop = text.indexOf(cut.before, end);
  if (stop < 0) throw new Error(`${label}: ${JSON.stringify(cut.before)} does not follow, so ${cut.shader} cannot be found.`);
  const body = text.slice(end, stop);
  if (sha256(body) !== cut.sha256) {
    throw new Error(`${label}: the code where ${cut.shader} was is not that shader any more (sha256 ${sha256(body)}). Check what is `
      + 'there for code from Shadertoy and update scripts/three-shadertoy.mjs.');
  }
  return text.slice(0, end) + cut.put + text.slice(stop);
}

/** Which of SHADERTOY_FILES a module id names (any query), or undefined. */
export function shadertoyFile(id) {
  const path = posixPath(id.split('?')[0]);
  return SHADERTOY_FILES.find(entry => path.endsWith(`/node_modules/${entry.pkg}/${entry.file}`));
}

/** The text the builds ship for one of SHADERTOY_FILES at this path: the file with its cuts made, after checking that
 * its package is the release they were written for. */
export function shippedText(path) {
  const entry = shadertoyFile(path);
  if (!entry) throw new Error(`${path} is none of the files scripts/three-shadertoy.mjs cuts.`);
  const file = posixPath(path.split('?')[0]);
  const dir = file.slice(0, file.length - entry.file.length - 1);
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (version !== entry.version) {
    throw new Error(`node_modules/${entry.pkg} is ${version}, not the ${entry.version} scripts/three-shadertoy.mjs cuts the shaders from `
      + 'Shadertoy out of. Check the new release for them and update the cuts.');
  }
  return entry.cuts.reduce((text, cut) => cutShader(text, cut, `node_modules/${entry.pkg}/${entry.file}`), readFileSync(file, 'utf8'));
}

/** The plugin, for both build configs (also as a worker plugin) and both test configs. */
export function withoutShadertoyShaders() {
  const texts = new Map();
  return {
    name: 'awwo-without-shadertoy-shaders',
    enforce: 'pre',
    load(id) {
      if (id.startsWith('\0') || !shadertoyFile(id)) return null;
      const query = id.includes('?') ? id.slice(id.indexOf('?') + 1) : '';
      const keys = [...new URLSearchParams(query).keys()];
      // raw: the text a preview loads; import: what the dev server adds to a module's URL.
      if (keys.some(key => key !== 'raw' && key !== 'import')) {
        this.error(`${id} would ship one of three.js's files with its shaders from Shadertoy (scripts/three-shadertoy.mjs): import it `
          + 'as code or as ?raw text.');
      }
      const path = id.split('?')[0];
      if (!texts.has(path)) texts.set(path, shippedText(path));
      return keys.includes('raw') ? `export default ${JSON.stringify(texts.get(path))};` : texts.get(path);
    },
    // After the other plugins', so that every file the build writes is checked.
    generateBundle: { order: 'post', handler(_options, bundle) {
      for (const file of Object.values(bundle)) {
        const sources = file.type === 'chunk' ? Object.keys(file.modules) : file.originalFileNames ?? [];
        const webgpu = sources.find(source => WEBGPU.test(posixPath(source)));
        if (webgpu) {
          this.error(`${file.fileName} holds ${webgpu}: three.js's WebGPU and TSL code takes more from Shadertoy, whose shaders are under `
            + 'CC BY-NC-SA unless their author says otherwise. Find a way without it, or check that code first (scripts/three-shadertoy.mjs).');
        }
        const mark = shadertoyMark(file.type === 'chunk' ? file.code : Buffer.from(file.source).toString('latin1'));
        if (mark) {
          this.error(`${file.fileName} holds ${mark}, from one of the shaders scripts/three-shadertoy.mjs cuts out of three.js: some file `
            + 'carries it past the cut.');
        }
      }
    } },
  };
}

/** The first of SHADERTOY_MARKS a file's text holds, as it is or inside a base64 data: URL (an inlined asset or worker). */
export function shadertoyMark(text) {
  const found = SHADERTOY_MARKS.find(mark => text.includes(mark));
  if (found) return found;
  for (const match of text.matchAll(/data:[^,"'`\s]*;base64,([A-Za-z0-9+/]+=*)/g)) {
    const decoded = Buffer.from(match[1], 'base64').toString('latin1');
    const inner = SHADERTOY_MARKS.find(mark => decoded.includes(mark));
    if (inner) return inner;
  }
  return undefined;
}
