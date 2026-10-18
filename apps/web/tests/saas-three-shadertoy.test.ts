// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { SHADERTOY_FILES, SHADERTOY_MARKS, cutShader, shadertoyFile, shadertoyMark, shippedText, withoutShadertoyShaders } from '../scripts/three-shadertoy.mjs';
import { CORE, MODULE, R128, THREE_ENTRY, expectShipped, type OutputFile } from './three-shadertoy-checks';

const WEB = path.resolve(__dirname, '..');
const [DITHERING, BICUBIC] = SHADERTOY_FILES[0]!.cuts;
// What the cuts leave, as the build files write it (inside a JS string: line breaks and tabs as \n and \t).
const KEPT_DITHERING = 'vec3 dithering( vec3 color ) {\\n\\t\\treturn color;\\n\\t}\\n#endif';
const KEPT_BICUBIC = '\\tvec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {\\n\\t\\treturn textureLod( sampler, uv, lod );\\n\\t}\\n\\tvec3 getVolumeTransmissionRay(';
const scratch = mkdtempSync(path.join(tmpdir(), 'awwo-three-shadertoy-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
type Hooks = { name: string; enforce: string; load: (this: unknown, id: string) => string | null;
  generateBundle: { order: string; handler: (this: unknown, options: unknown, bundle: unknown) => void } };
const plugin = withoutShadertoyShaders() as unknown as Hooks;
const context = { error(message: string): never { throw new Error(message); } };

/** The text with a cut made, found here by plain index arithmetic (the plugin's own search is what is under test). */
function cutByHand(text: string, cut: typeof DITHERING) {
  let end = 0;
  for (const marker of cut!.after) end = text.indexOf(marker, end) + marker.length;
  return text.slice(0, end) + cut!.put + text.slice(text.indexOf(cut!.before, end));
}

describe('the shaders three.js took from Shadertoy, which the builds leave out', () => {
  it('are cut out of the files that hold them, each function kept under its name, and nothing else changes', () => {
    const module = readFileSync(MODULE, 'utf8'), r128 = readFileSync(R128, 'utf8');
    expect(module).toContain('dither_shift_RGB');
    expect(module).toContain('LodSizeInv');
    expect(r128).toContain('dither_shift_RGB');
    const shipped = { module: shippedText(MODULE), r128: shippedText(R128) };
    expect(shipped.module).toBe(cutByHand(cutByHand(module, DITHERING), BICUBIC));
    expect(shipped.r128).toBe(cutByHand(r128, DITHERING));
    for (const text of Object.values(shipped)) {
      for (const mark of SHADERTOY_MARKS) expect(text).not.toContain(mark);
      expect(text).toContain(KEPT_DITHERING);
      // The shader that calls it still does.
      expect(text).toContain('gl_FragColor.rgb = dithering( gl_FragColor.rgb );');
    }
    expect(shipped.module).toContain(KEPT_BICUBIC);
    expect(shipped.module).toContain('return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );');
    // The license header each file starts with is untouched.
    expect(shipped.module.slice(0, 200)).toBe(module.slice(0, 200));
    expect(shipped.r128.slice(0, 200)).toBe(r128.slice(0, 200));
    // three.core.js holds neither, so it is none of the files cut.
    expect(shadertoyFile(CORE)).toBeUndefined();
    for (const mark of SHADERTOY_MARKS) expect(readFileSync(CORE, 'utf8')).not.toContain(mark);
  });

  it('stop at a file, a body or a way to ship them that they were not written for', () => {
    const module = readFileSync(MODULE, 'utf8');
    const first = DITHERING!.after[0]!;
    expect(() => cutShader(`${module}${first}`, DITHERING, 'm')).toThrow(/m: "vec3 dithering\( vec3 color \) \{" is not in it exactly once/);
    expect(() => cutShader(module.replace(first, ''), DITHERING, 'm')).toThrow(/is not in it exactly once/);
    expect(() => cutShader(module.split(DITHERING!.before).join(''), DITHERING, 'm'))
      .toThrow(/does not follow, so the dithering from https:\/\/www\.shadertoy\.com\/view\/MslGR8 cannot be found/);
    // Other chunks declare the same varying: only those after the transmission chunk's start count.
    const transmission = module.indexOf(BICUBIC!.after[0]!);
    expect(() => cutShader(module.slice(0, transmission) + module.slice(transmission).split(BICUBIC!.after[1]!).join(''), BICUBIC, 'm'))
      .toThrow(/"varying vec3 vWorldPosition;\\\\n" does not follow/);
    // A body that is not the one known by its sha256: one more space in it.
    expect(() => cutShader(module.replace(first, `${first} `), DITHERING, 'm')).toThrow(/m: the code where the dithering .* is not that shader any more \(sha256 [0-9a-f]{64}\)/);
    // Another release of the package.
    const later = path.join(scratch, 'node_modules', 'three');
    mkdirSync(path.join(later, 'build'), { recursive: true });
    writeFileSync(path.join(later, 'package.json'), JSON.stringify({ name: 'three', version: '0.187.0' }));
    writeFileSync(path.join(later, 'build', 'three.module.js'), module);
    expect(() => shippedText(path.join(later, 'build', 'three.module.js'))).toThrow(/node_modules\/three is 0\.187\.0, not the 0\.186\.1/);
    expect(() => shippedText(CORE)).toThrow(/is none of the files/);

    // The load hook: as code, as ?raw text (the dev server adds &import), and nothing else.
    expect(plugin.load.call(context, MODULE)).toBe(shippedText(MODULE));
    expect(plugin.load.call(context, `${MODULE}?raw`)).toBe(`export default ${JSON.stringify(shippedText(MODULE))};`);
    expect(plugin.load.call(context, `${R128}?raw&import`)).toBe(`export default ${JSON.stringify(shippedText(R128))};`);
    expect(plugin.load.call(context, MODULE.replace(/\\/g, '/'))).toBe(shippedText(MODULE));
    for (const query of ['url', 'inline', 'worker', 'raw&url']) {
      expect(() => plugin.load.call(context, `${MODULE}?${query}`), query).toThrow(/would ship one of three\.js's files with its shaders from Shadertoy/);
    }
    expect(plugin.load.call(context, CORE)).toBeNull();
    expect(plugin.load.call(context, `\0${MODULE}`)).toBeNull();
  });

  it('stop a build whose output still holds either shader, or three.js code that takes more from Shadertoy', () => {
    const chunk = (code: string, modules: string[] = []): OutputFile => ({ type: 'chunk', fileName: 'assets/a.js', code, modules: Object.fromEntries(modules.map(id => [id, {}])) });
    // The load hook first, the check of the output last, after the files other plugins emit (the HTML, the licenses).
    expect([plugin.enforce, plugin.generateBundle.order]).toEqual(['pre', 'post']);
    const run = (...files: OutputFile[]) => plugin.generateBundle.handler.call(context, {}, Object.fromEntries(files.map((file, index) => [`${index}`, file])));
    expect(() => run(chunk('const ok = 1;', ['/app/node_modules/three/build/three.module.js', `${MODULE}?raw`]),
      { type: 'asset', fileName: 'assets/t.txt', source: new TextEncoder().encode('fine') })).not.toThrow();
    for (const mark of SHADERTOY_MARKS) {
      expect(() => run(chunk(`var s="${mark}"`))).toThrow(new RegExp(`assets/a\\.js holds ${mark}, from one of the shaders`));
      expect(() => run({ type: 'asset', fileName: 'assets/b.txt', source: new TextEncoder().encode(`x ${mark} y`) })).toThrow(/assets\/b\.txt holds/);
    }
    for (const id of ['/app/node_modules/three/build/three.webgpu.js', '/app/node_modules/three/build/three.tsl.js?raw',
      'C:\\app\\node_modules\\three\\src\\nodes\\accessors\\TextureBicubic.js', '/app/node_modules/three/examples/jsm/tsl/display/hashBlur.js']) {
      expect(() => run(chunk('const ok = 1;', [id])), id).toThrow(/three\.js's WebGPU and TSL code takes more from Shadertoy/);
    }
    expect(() => run({ type: 'asset', fileName: 'assets/w.js', source: 'x', originalFileNames: ['node_modules/three/build/three.webgpu.nodes.js'] }))
      .toThrow(/WebGPU and TSL/);
    // Inside a base64 data: URL too (an asset or a worker Vite inlines), in code or in a stylesheet.
    const base64 = (text: string) => Buffer.from(text).toString('base64');
    for (const mark of SHADERTOY_MARKS) {
      const padded = `x${mark}`; // base64 of a length that needs padding
      expect(shadertoyMark(`const u="data:text/javascript;base64,${base64(padded)}";`)).toBe(mark);
      expect(() => run(chunk(`new Worker("data:text/javascript;base64,${base64(`self.s='${mark}'`)}")`))).toThrow(new RegExp(`holds ${mark}`));
      expect(() => run({ type: 'asset', fileName: 'assets/c.css', source: `a{background:url(data:application/octet-stream;base64,${base64(mark)})}` }))
        .toThrow(/assets\/c\.css holds/);
    }
    expect(shadertoyMark(`url(data:font/woff2;base64,${base64('just a font')})`)).toBeUndefined();
    expect(() => run(chunk(`const f="data:font/woff2;base64,${base64('just a font')}";`))).not.toThrow();
  });

  it('are taken out by the hosted config for the app and for its workers', async () => {
    const { default: config } = await import('../vite.saas.config.mjs');
    const names = (plugins: unknown) => [plugins].flat(Infinity as 1).map(plugin => (plugin as { name?: string } | null)?.name);
    expect(names(config.plugins)).toContain(plugin.name);
    expect(names(config.worker.plugins())).toEqual([plugin.name]);
  });

  it("leave both out of a real hosted build: the app's own three.js and the copies a running preview loads", async () => {
    await expectShipped(await hostedBuild(THREE_ENTRY), 'hosted');
  }, 300_000);

  it("are cut out of the workspace image's copy as well, which the page check serves", () => {
    // The image's build step, run as the Dockerfile runs it, on a tools directory laid out as after its npm ci.
    const repo = path.resolve(WEB, '..', '..');
    const tools = path.join(repo, 'deploy', 'saas', 'workspace', 'tools');
    const copy = readFileSync(path.join(tools, 'three-shadertoy.mjs'), 'utf8');
    expect(copy).toBe(`// Copied by scripts/preview-modules.mjs from apps/web/scripts/three-shadertoy.mjs for the workspace image's build; do not edit by hand.\n`
      + readFileSync(path.join(WEB, 'scripts', 'three-shadertoy.mjs'), 'utf8'));
    const dockerfile = readFileSync(path.join(repo, 'deploy', 'saas', 'workspace', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('tools/keep-preview-files.mjs tools/three-shadertoy.mjs /opt/awwo/tools/');
    expect(dockerfile).toContain('&& node /opt/awwo/tools/keep-preview-files.mjs && rm /opt/awwo/tools/keep-preview-files.mjs /opt/awwo/tools/three-shadertoy.mjs');
    const list = JSON.parse(readFileSync(path.join(tools, 'three-preview-files.json'), 'utf8')) as { files: Record<string, string> };
    const layout = (name: string, files: Record<string, string>) => {
      const dir = path.join(scratch, name), three = path.join(dir, 'node_modules', 'three');
      for (const file of ['keep-preview-files.mjs', 'three-shadertoy.mjs']) cpSync(path.join(tools, file), path.join(dir, file));
      writeFileSync(path.join(dir, 'three-preview-files.json'), JSON.stringify({ ...list, files }));
      for (const file of ['package.json', 'LICENSE', 'build/three.cjs', ...Object.keys(list.files)]) cpSync(path.join(path.dirname(path.dirname(MODULE)), file), path.join(three, file));
      return { dir, three };
    };
    const image = layout('image', list.files);
    expect(execFileSync(process.execPath, [path.join(image.dir, 'keep-preview-files.mjs')], { encoding: 'utf8' }))
      .toMatch(/kept 91 files .*removed 1; cut the shaders from Shadertoy out of build\/three\.module\.js/);
    expect(readFileSync(path.join(image.three, 'build', 'three.module.js'), 'utf8') === shippedText(MODULE)).toBe(true);
    expect(existsSync(path.join(image.three, 'build', 'three.cjs'))).toBe(false);
    // A list that named the npm file as it is fails the build.
    const npm = { ...list.files, 'build/three.module.js': createHash('sha256').update(readFileSync(MODULE)).digest('hex') };
    expect(() => execFileSync(process.execPath, [path.join(layout('uncut', npm).dir, 'keep-preview-files.mjs')], { stdio: 'pipe' }))
      .toThrow(/build\/three\.module\.js is not the file the preview supplies/);
  });

  it('stop a real hosted build that would inline a file holding one of them as a base64 URL', async () => {
    // three's own source file of the dithering chunk, small enough for Vite to inline: the load hook leaves it alone
    // (none of the files it cuts), so only the check of the output stands between it and the bundle.
    const chunk = 'three/src/renderers/shaders/ShaderChunk/dithering_pars_fragment.glsl.js';
    await expect(hostedBuild(`import u from '${chunk}?url&inline';\nglobalThis.awwoInlined = u;\n`))
      .rejects.toThrow(/holds dither_shift_RGB, from one of the shaders scripts\/three-shadertoy\.mjs cuts out of three\.js/);
  }, 300_000);
});

/** A build with the hosted config of an entry made of these lines, nothing written; the release's NODE_ENV. With the
 * stylesheet that names the app's own fonts and with the preview fonts, which its font license plugins otherwise stop on. */
async function hostedBuild(lines: string): Promise<OutputFile[]> {
  const entry = 'virtual:awwo-three-shadertoy-hosted';
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
