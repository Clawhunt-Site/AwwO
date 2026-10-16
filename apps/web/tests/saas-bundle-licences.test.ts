// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { COMMITTED, OUTPUT, WRITE, bundleLicences, bundleUse, checkStyleImports, leadingComment, licenceDocument, neededLicences, packageOf, packageParts, uncovered } from '../scripts/bundle-licences.mjs';

const WEB = path.resolve(__dirname, '..');
type OutputFile = { type: 'chunk' | 'asset'; fileName: string; source?: string | Uint8Array; modules?: Record<string, { renderedLength: number }>; originalFileNames?: string[] };
type Plugin = { transform: (this: unknown, code: string, id: string) => Promise<unknown>; generateBundle: (this: unknown, options: unknown, bundle: unknown) => void };
const MIT = (holder: string) => `MIT License\n\nCopyright (c) ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n`;
const scratch = mkdtempSync(path.join(tmpdir(), 'awwo-bundle-licences-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let fixtures = 0;
/** A fake app root with packages under node_modules: { 'name/path': text }, package.json written for each package. */
function app(files: Record<string, string>, manifests: Record<string, object> = {}) {
  const root = path.join(scratch, `app-${fixtures += 1}`);
  const write = (file: string, data: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), data); };
  for (const [file, data] of Object.entries(files)) write(path.join('node_modules', file), data);
  for (const [name, manifest] of Object.entries(manifests)) write(path.join('node_modules', name, 'package.json'), JSON.stringify(manifest));
  return root;
}
const modulesOf = (root: string, ids: Record<string, number>) => ({ 'assets/a.js': { type: 'chunk', fileName: 'assets/a.js',
  modules: Object.fromEntries(Object.entries(ids).map(([id, length]) => [id.startsWith('\0') ? id : path.join(root, 'node_modules', id).replace(/\\/g, '/'), { renderedLength: length }])) } });
/** A build with the hosted config, nothing written; the release's NODE_ENV (vitest's would take React's development files). */
async function hostedBuild(options: Record<string, unknown> = {}) {
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = await build({ configFile: path.join(WEB, 'vite.saas.config.mjs'), configLoader: 'runner', logLevel: 'silent', mode: 'production', ...options,
      build: { write: false, ...(options.build as object | undefined) } });
    return (Array.isArray(result) ? result : [result]).flatMap(output => (output as unknown as { output: OutputFile[] }).output);
  } finally { process.env.NODE_ENV = nodeEnv; }
}

describe("the hosted bundle's third-party licenses", () => {
  it('are the committed file, which a full build needs exactly, at the root of the site', async () => {
    const files = await hostedBuild();
    expect(files.some(file => file.type === 'chunk' && Object.keys(file.modules ?? {}).some(id => id.endsWith('/react-dom/cjs/react-dom-client.production.js')))).toBe(true);
    const committed = readFileSync(path.join(WEB, COMMITTED), 'utf8');
    expect(Buffer.from(files.find(file => file.fileName === 'third-party-licenses.txt')?.source ?? '').toString('utf8')).toBe(committed);
    // Written from this build, the file would not change: nothing it holds is stale, nothing the bundle needs is missing.
    const bundle = Object.fromEntries(files.map(file => [file.fileName, file]));
    expect(licenceDocument(neededLicences(bundleUse(bundle, WEB), WEB))).toBe(committed);

    // Apart from the plugin: the packages whose code is in a chunk or whose file is an asset, and the build tools whose
    // helpers are, each have their heading and their top-level license files word for word.
    const dirs = new Set<string>();
    for (const file of files) {
      const sources = file.type === 'chunk' ? Object.entries(file.modules ?? {}).filter(([id, module]) => module.renderedLength > 0 || /\.css$/.test(id)).map(([id]) => id) : file.originalFileNames ?? [];
      for (const source of sources) {
        const tool = /^\0(vite|rolldown)\//.exec(source);
        const match = tool ? null : /^(.*\/node_modules\/(?:@[^/]+\/)?[^/?]+)\//.exec(path.resolve(WEB, source.replace(/^\0/, '')).replace(/\\/g, '/'));
        if (tool) dirs.add(path.join(WEB, 'node_modules', tool[1]!));
        else if (match) dirs.add(match[1]!);
      }
    }
    const headings = [...committed.matchAll(/^={80}\n(.+)\n={80}$/gm)].map(match => match[1]!).filter(line => line !== 'Left out');
    expect(headings).toHaveLength(dirs.size);
    for (const dir of dirs) {
      const { name, version } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      expect(headings.some(line => line.startsWith(`${name} ${version} (`)), `${name} ${version}`).toBe(true);
      for (const licence of readdirSync(dir).filter(file => /^(?:licen[cs]e|copying|notice)/i.test(file))) {
        const text = readFileSync(path.join(dir, licence), 'utf8');
        const own = name === 'vite' ? text.slice(0, text.indexOf('\n# Licenses of bundled dependencies\n') + 1) : text;
        expect(committed.includes(own), `${name}/${licence}`).toBe(true);
      }
    }
    expect(dirs.size).toBeGreaterThan(70);
    // What the license directories of pdf.js, the comment of vfile's path module and the texts kept in licences/ add.
    for (const words of ['Copyright 2024 Mozilla Foundation', 'Copyright 1990-2009 Adobe Systems Incorporated.', '// Copyright 2014 PDFium Authors. All rights reserved.',
      'Copyright (c) 2013 James Halliday', 'Copyright Joyent, Inc. and other Node contributors.', 'Copyright (c) 2019-present, VoidZero Inc. and Vite contributors',
      'Copyright (C) 2009-2024 Mozilla Corporation', 'Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium', 'Copyright 2026 Mozilla Foundation',
      'Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors.', '/* Copyright 2017 Google Inc. All Rights Reserved.', 'Copyright (C) 2018-2021 Guy Bedford',
      'Copyright (c) 2020 Evan Wallace']) expect(committed, words).toContain(words);
    for (const file of readdirSync(path.join(WEB, 'licences'))) expect(committed, file).toContain(readFileSync(path.join(WEB, 'licences', file), 'utf8'));
    // Vite's own license only, and not the GPL of fonts the site does not ship.
    expect(committed).not.toContain('# Licenses of bundled dependencies');
    expect(committed).not.toContain('LIBERATION FONT SOFTWARE');
    expect(committed).toContain('- pdfjs-dist 6.3.289, standard_fonts/LICENSE_LIBERATION: it covers the Liberation Sans fonts');
  }, 300_000);

  it("cover every library pdf.js's worker embeds, and its main build embeds none", () => {
    // pdf.js's own build marks each module it takes from its external/ tree; a new one needs a rule in scripts/bundle-licences.mjs.
    const embedded = (file: string) => [...new Set([...readFileSync(path.join(WEB, 'node_modules', 'pdfjs-dist', 'build', file), 'utf8').matchAll(/^;\/\/ \.\/external\/([^/\s]+)\//gm)].map(match => match[1]))].sort();
    expect(embedded('pdf.worker.mjs')).toEqual(['brotli', 'jbig2', 'openjpeg', 'qcms']);
    expect(embedded('pdf.mjs')).toEqual([]);
    // qcms, OpenJPEG and JBIG2: their licenses are in wasm/; Brotli's is kept in licences/.
    expect(readdirSync(path.join(WEB, 'node_modules', 'pdfjs-dist', 'wasm')).filter(file => file.startsWith('LICENSE')).sort())
      .toEqual(['LICENSE_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_JBIG2', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_PDFJS_QCMS', 'LICENSE_QCMS']);
  });

  it('know a file under node_modules by its package, scoped or nested, and what precedes the code of a file', () => {
    expect(OUTPUT).toBe('third-party-licenses.txt');
    expect(packageOf('/w/apps/web/node_modules/react/cjs/react.production.js')).toEqual({ dir: '/w/apps/web/node_modules/react', file: 'cjs/react.production.js' });
    expect(packageOf('E:\\w\\node_modules\\@ungap\\structured-clone\\esm\\index.js')).toEqual({ dir: 'E:/w/node_modules/@ungap/structured-clone', file: 'esm/index.js' });
    expect(packageOf('/w/node_modules/a/node_modules/b/index.js')).toEqual({ dir: '/w/node_modules/a/node_modules/b', file: 'index.js' });
    for (const file of ['/w/src/main.ts', '/w/node_modules/react', '/w/node_modules/@scope/index.js', '/w/node_modules//x.js']) expect(packageOf(file), file).toBeNull();
    const banner = '/**\n * @license Example\n */';
    expect(leadingComment(`${banner}\n'use strict';\nvar a = 1; // not this\n`)).toBe(banner);
    expect(leadingComment(`\uFEFF#!/usr/bin/env node\n\n// One\n//\n// Two\n\n/* Three */\nexport {}`)).toBe('// One\n//\n// Two\n\n/* Three */');
    expect(leadingComment('var a = "/* not a comment */";')).toBe('');
    expect(leadingComment('/* never closed')).toBe('');
    expect(leadingComment('// only a comment')).toBe('// only a comment');
  });

  it('find what each package gives the bundle: minified code, files as they are, stylesheets and tool helpers', () => {
    const root = app({});
    const use = bundleUse({ ...modulesOf(root, { 'a/index.js': 10, 'a/dead.js': 0, 'b/build/b.js?raw': 5, 'c/font.pfb?url': 3, 'c/lib/x.mjs?url&no-inline': 3,
      'g/data.js?inline': 6, 'h/style.css?inline': 6, 'e/style.css': 0, '\0vite/preload-helper.js': 7, '\0virtual:our-entry': 9 }),
    'assets/f.txt': { type: 'asset', fileName: 'assets/f.txt', originalFileNames: ['node_modules/f/LICENSE', path.join(root, 'src', 'own.txt')] } }, root);
    const at = (name: string) => use.get(path.join(root, 'node_modules', name).replace(/\\/g, '/'));
    // A stylesheet another of its own package pulls in has no module: it is counted from what the stylesheet check followed.
    const followed = bundleUse({}, root, [path.join(root, 'node_modules', 'k', 'vendor', 'v.css').replace(/\\/g, '/')]);
    expect([...followed.get(path.join(root, 'node_modules', 'k').replace(/\\/g, '/'))!.files]).toEqual([['vendor/v.css', true]]);
    expect([...at('a')!.files]).toEqual([['index.js', true]]);
    expect([...at('b')!.files]).toEqual([['build/b.js', false]]);
    expect([...at('c')!.files]).toEqual([['font.pfb', false], ['lib/x.mjs', false]]);
    // ?inline puts a file's bytes in as a data: URL, but a stylesheet's is the CSS Vite made of it.
    expect([...at('g')!.files]).toEqual([['data.js', false]]);
    expect([...at('h')!.files]).toEqual([['style.css', true]]);
    // A stylesheet renders nothing into its chunk (Vite takes its rules out), and is minified.
    expect([...at('e')!.files]).toEqual([['style.css', true]]);
    expect([...at('f')!.files]).toEqual([['LICENSE', false]]);
    expect(at('vite')).toEqual({ files: new Map(), helpers: new Set(['\0vite/preload-helper.js']) });
    // The app's own virtual modules and files are no package's.
    expect(use.size).toBe(8);
    // A Web Worker is bundled out of the plugin's sight: refused, by its module or by the script Vite emits for it.
    for (const id of ['d/worker.js?worker', 'd/worker.js?worker&url', 'd/worker.js?sharedworker&inline']) expect(() => bundleUse(modulesOf(root, { [id]: 4 }), root), id).toThrow(/is a Web Worker/);
    expect(() => bundleUse({ 'assets/worker-1x.js': { type: 'asset', fileName: 'assets/worker-1x.js' } }, root)).toThrow(/assets\/worker-1x\.js is a Web Worker/);
  });

  it('take the license files a package needs, leave out the ones that cover nothing it ships, and stop without one', () => {
    const root = app({
      'pkg/LICENSE': MIT('2020 Pkg'), 'pkg/NOTICE.md': '\uFEFFNotice of pkg', 'pkg/COPYING': 'Copying pkg\n', 'pkg/license.js': 'export {}', 'pkg/README.md': '# pkg',
      'pkg/lib/LICENSE-lib': MIT('2019 Lib'), 'pkg/lib/vendor/LICENSE-x.txt': MIT('2019 X'),
      'pkg/lib/vendor/x.js': '// Taken from x.\n// Permission is hereby granted, free of charge.\nexport const x = 1;\n',
      'pkg/lib/own.js': '/** @license pkg - MIT */\nexport {}', 'pkg/other/LICENSE': MIT('unused'),
      'pdfjs-dist/LICENSE': 'Apache License\r\nVersion 2.0\r\n', 'pdfjs-dist/standard_fonts/LICENSE_FOXIT': 'BSD\n', 'pdfjs-dist/standard_fonts/LICENSE_LIBERATION': 'GPL\n',
      'pdfjs-dist/wasm/LICENSE_PDFJS_QCMS': 'MIT qcms\n',
      'vite/LICENSE.md': `# Vite core license\n${MIT('Vite')}\n# Licenses of bundled dependencies\nlots\n`, 'none/index.js': 'export {}',
    }, { pkg: { name: 'pkg', version: '1.0.0', license: 'MIT' }, 'pdfjs-dist': { name: 'pdfjs-dist', version: '6.3.289', license: 'Apache-2.0' },
      vite: { name: 'vite', version: '8.0.16', license: 'MIT' }, none: { name: 'none', version: '0.1.0' } });
    cpSync(path.join(WEB, 'licences'), path.join(root, 'licences'), { recursive: true });
    const dir = (name: string) => path.join(root, 'node_modules', name).replace(/\\/g, '/');
    const parts = (name: string, files: [string, boolean][], helpers: string[] = []) => packageParts(dir(name), { files: new Map(files), helpers: new Set(helpers) }, root);
    const pkg = parts('pkg', [['lib/vendor/x.js', true], ['lib/own.js', true]]);
    // From its top, then from each directory between it and a file it ships, nearest first.
    expect(pkg.parts.map(part => part.label)).toEqual(['pkg 1.0.0', 'pkg 1.0.0: COPYING', 'pkg 1.0.0: LICENSE', 'pkg 1.0.0: NOTICE.md', 'pkg 1.0.0: lib/LICENSE-lib',
      'pkg 1.0.0: lib/vendor/LICENSE-x.txt', 'pkg 1.0.0: lib/vendor/x.js']);
    // Without a byte order mark, and ending in one line end.
    expect(pkg.parts[3]!.text).toBe('----- pkg 1.0.0: NOTICE.md -----\nNotice of pkg\n');
    expect(pkg.parts[6]!.text).toBe('----- pkg 1.0.0: lib/vendor/x.js, the comment at its top -----\n// Taken from x.\n// Permission is hereby granted, free of charge.\n');
    // A file the bundle ships as it is keeps its own comments, so none is taken from it.
    expect(parts('pkg', [['lib/vendor/x.js', false]]).parts).toHaveLength(6);
    const fonts = (files: string[]) => parts('pdfjs-dist', files.map(file => [file, false]));
    const symbol = fonts(['standard_fonts/FoxitSymbol.pfb', 'standard_fonts/LICENSE_FOXIT']);
    expect(symbol.parts.map(part => part.label)).toEqual(['pdfjs-dist 6.3.289', 'pdfjs-dist 6.3.289: LICENSE', 'pdfjs-dist 6.3.289: standard_fonts/LICENSE_FOXIT']);
    expect(symbol.parts[1]!.text).toBe('----- pdfjs-dist 6.3.289: LICENSE -----\nApache License\nVersion 2.0\n');
    expect(symbol.leftOut).toEqual([expect.stringMatching(/^pdfjs-dist 6\.3\.289, standard_fonts\/LICENSE_LIBERATION: it covers the Liberation Sans fonts/)]);
    // Any other file of that directory brings the license back, whatever its name.
    for (const other of ['standard_fonts/LiberationSans-Regular.ttf', 'standard_fonts/liberationsans-regular.ttf', 'standard_fonts/sub/Other.ttf']) {
      expect(fonts(['standard_fonts/FoxitSymbol.pfb', other]).parts.map(part => part.label), other).toContain('pdfjs-dist 6.3.289: standard_fonts/LICENSE_LIBERATION');
    }
    // The worker brings wasm/'s licenses and the texts kept for it in licences/, pinned to what was read.
    const worker = fonts(['build/pdf.worker.min.mjs']);
    expect(worker.parts.map(part => part.label)).toEqual(['pdfjs-dist 6.3.289', 'pdfjs-dist 6.3.289: LICENSE', 'pdfjs-dist 6.3.289: wasm/LICENSE_PDFJS_QCMS',
      'pdfjs-dist 6.3.289: licences/LICENSE-brotli.txt', 'pdfjs-dist 6.3.289: licences/NOTICE-brotli-decode.txt']);
    expect(worker.parts[3]!.text).toBe(`----- pdfjs-dist 6.3.289: Brotli's license, for the decoder its worker embeds (external/brotli/LICENSE_BROTLI in pdf.js at v6.3.289) -----\n${readFileSync(path.join(WEB, 'licences', 'LICENSE-brotli.txt'), 'utf8')}\n`);
    // Its legacy build embeds core-js as well, whose license nothing here carries: refused.
    for (const file of ['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.min.mjs']) expect(() => fonts([file]), file).toThrow(new RegExp(`pdfjs-dist 6\\.3\\.289 ships ${file.replace(/\./g, '\\.')}: pdf\\.js's legacy build embeds core-js`));
    const vite = parts('vite', [], ['\0vite/preload-helper.js', '\0vite/modulepreload-polyfill.js']);
    expect(vite.parts[0]!.text).toContain('vite 8.0.16 (MIT), for the helpers it writes into the bundle');
    expect(vite.parts[1]!.text).toBe(`----- vite 8.0.16: LICENSE.md, its own license -----\n# Vite core license\n${MIT('Vite')}`);
    expect(vite.parts.map(part => part.label)).toEqual(['vite 8.0.16', 'vite 8.0.16: LICENSE.md', 'vite 8.0.16: licences/LICENSE-es-module-shims.txt']);
    // Only the helper a text is for brings it.
    expect(parts('vite', [], ['\0vite/preload-helper.js']).parts).toHaveLength(2);
    // A supplement checked for another release, or a changed one, stops the build until someone reads it again.
    writeFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'package.json'), JSON.stringify({ name: 'pdfjs-dist', version: '6.4.299', license: 'Apache-2.0' }));
    expect(() => fonts(['build/pdf.worker.min.mjs'])).toThrow(/pdfjs-dist 6\.4\.299 is not the pdfjs-dist 6\.3\.289 that licences\/LICENSE-brotli\.txt was checked for/);
    expect(fonts(['standard_fonts/FoxitSymbol.pfb']).parts).toHaveLength(3);
    writeFileSync(path.join(root, 'licences', 'LICENSE-es-module-shims.txt'), 'edited');
    expect(() => parts('vite', [], ['\0vite/modulepreload-polyfill.js'])).toThrow(/licences\/LICENSE-es-module-shims\.txt is not the text that was read/);
    writeFileSync(path.join(root, 'node_modules', 'vite', 'LICENSE.md'), MIT('Vite'));
    expect(() => parts('vite', [], ['\0vite/preload-helper.js'])).toThrow(/no longer has the heading "# Licenses of bundled dependencies"/);
    expect(() => parts('none', [['index.js', true]])).toThrow(/none 0\.1\.0 .* has no license file/);
  });

  it('refuse a stylesheet that pulls in npm CSS, itself or through one it pulls in, and follow one package\'s own', async () => {
    const root = app({ 'pkg/a.css': '@import "./vendor/b.css";\n.a {}', 'pkg/vendor/b.css': '.b {}', 'other/c.css': '.c {}', 'pkg/d.css': '@import "other/c.css";' });
    const css = (name: string, source: string) => { const file = path.join(root, 'src', name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
    const modules = path.join(root, 'node_modules');
    const resolveId = async (specifier: string) => (/^(?:pkg|other)\//.test(specifier) ? { id: path.join(modules, specifier) } : specifier.startsWith('virtual:') ? { id: `\0${specifier}` } : null);
    const check = (file: string) => checkStyleImports(readFileSync(file, 'utf8'), file, { resolveId, root });
    // A URL, a comment and the app's own stylesheets pull in no package.
    await check(css('fine.css', '@import url("https://fonts.example/x.css");\n@import url(data:text/css,a);\n@import "./local.css";\n/* Was: @import "pkg/a.css"; */\n.x {}'));
    css('local.css', '.local {}');
    await expect(check(css('bare.css', '@import "pkg/a.css";'))).rejects.toThrow(/bare\.css pulls in pkg\/a\.css .*import that stylesheet from a script instead/);
    await expect(check(css('upper.css', '@IMPORT url(\'pkg/a.css\') screen;'))).rejects.toThrow(/upper\.css pulls in pkg\/a\.css/);
    await expect(check(css('composes.module.css', '.a { composes: b c from "pkg/a.css"; }'))).rejects.toThrow(/composes\.module\.css pulls in pkg\/a\.css/);
    await expect(check(css('value.module.css', '@value primary, accent from "pkg/a.css";'))).rejects.toThrow(/value\.module\.css pulls in pkg\/a\.css/);
    // A name holds what a CSS string may: spaces, the other quote and escapes, in each form; @import needs no white
    // space before its string; and a /* inside a string starts no comment.
    css("with space/it's.css", '@import "pkg/a.css";');
    await expect(check(css('spaced.css', `@import "./with space/it's.css";`))).rejects.toThrow(/it's\.css pulls in pkg\/a\.css/);
    await expect(check(css('single.css', `@import 'pkg/a "b" c.css';`))).rejects.toThrow(/single\.css pulls in pkg\/a "b" c\.css/);
    await expect(check(css('url-double.css', '@import url( "pkg/a b.css" ) screen;'))).rejects.toThrow(/url-double\.css pulls in pkg\/a b\.css/);
    await expect(check(css('url-single.css', "@import url('pkg/it\\'s.css');"))).rejects.toThrow(/url-single\.css pulls in pkg\/it's\.css/);
    await expect(check(css('url-bare.css', '@import url(pkg/a\\ b.css);'))).rejects.toThrow(/url-bare\.css pulls in pkg\/a b\.css/);
    await expect(check(css('tight.css', '@import"pkg/a.css";'))).rejects.toThrow(/tight\.css pulls in pkg\/a\.css/);
    await expect(check(css('escaped.css', '@import "pkg/\\61 .css";'))).rejects.toThrow(/escaped\.css pulls in pkg\/a\.css/);
    await expect(check(css('continued.css', '@import "pkg/a\\\n.css";'))).rejects.toThrow(/continued\.css pulls in pkg\/a\.css/);
    await expect(check(css('invalid.css', '@import "pkg/\\110000 x.css";'))).rejects.toThrow(/invalid\.css pulls in pkg\/\uFFFDx\.css/);
    await expect(check(css('composes-quote.module.css', `.a { composes: b from 'pkg/a "b".css'; }`))).rejects.toThrow(/composes-quote\.module\.css pulls in pkg\/a "b"\.css/);
    await expect(check(css('value-space.module.css', `@value v from "pkg/it's here.css";`))).rejects.toThrow(/value-space\.module\.css pulls in pkg\/it's here\.css/);
    await expect(check(css('star.css', '@import "pkg/a/*b.css"; .x { color: red } /* end */'))).rejects.toThrow(/star\.css pulls in pkg\/a\/\*b\.css/);
    // The app's own stylesheet with a space and a quote in its path is followed, and a URL with a space is the browser's.
    css("local dir/it's fine.css", '.fine {}');
    await check(css('fine-spaced.css', `@import "./local dir/it's fine.css";\n@import url("https://fonts.example/a b.css");`));
    css('theme.css', '@import "pkg/a.css";');
    await expect(check(css('chain.css', '@import "./theme.css";'))).rejects.toThrow(/theme\.css pulls in pkg\/a\.css/);
    await expect(check(css('root.css', '@import "/src/theme.css";'))).rejects.toThrow(/theme\.css pulls in pkg\/a\.css/);
    await expect(check(css('lost.css', '@import "nowhere/x.css";'))).rejects.toThrow(/lost\.css pulls in nowhere\/x\.css, which Vite inlines/);
    // A module a plugin makes up is no file the check can follow.
    await expect(check(css('virtual.css', '@import "virtual:theme.css";'))).rejects.toThrow(/virtual\.css pulls in virtual:theme\.css, which Vite inlines/);
    // A Windows drive letter is no URL scheme: an absolute path is checked like any other.
    const absolute = path.join(modules, 'pkg', 'a.css').replace(/\\/g, '/');
    const resolveAbsolute = async (specifier: string) => (/^[A-Za-z]:\//.test(specifier) || specifier.startsWith('/') ? { id: specifier } : resolveId(specifier));
    await expect(checkStyleImports(`@import "C:/${absolute.replace(/^[A-Za-z]:\//, '')}";`, path.join(root, 'src', 'drive.css'), { resolveId: resolveAbsolute, root })).rejects.toThrow(/drive\.css pulls in C:\//);
    // Within one npm package an import is that package's own, and what it follows is counted; into another package it is refused.
    const own = await checkStyleImports(readFileSync(path.join(modules, 'pkg', 'a.css'), 'utf8'), path.join(modules, 'pkg', 'a.css'), { resolveId, root });
    expect([...own]).toEqual([path.join(modules, 'pkg', 'vendor', 'b.css').replace(/\\/g, '/')]);
    await expect(checkStyleImports(readFileSync(path.join(modules, 'pkg', 'd.css'), 'utf8'), path.join(modules, 'pkg', 'd.css'), { resolveId, root })).rejects.toThrow(/pulls in other\/c\.css/);
    // And a cycle ends.
    css('loop-a.css', '@import "./loop-b.css";'); css('loop-b.css', '@import "./loop-a.css";');
    await check(path.join(root, 'src', 'loop-a.css'));
  });

  it("check every stylesheet Vite inlines, a page's own <style> too, and count what a package's stylesheet pulls in", async () => {
    const root = app({ 'pkg/LICENSE': MIT('2020 Pkg'), 'pkg/a.css': '@import "./vendor/b.css";', 'pkg/vendor/b.css': '.b {}', 'pkg/vendor/LICENSE-b': MIT('2019 B') },
      { pkg: { name: 'pkg', version: '1.0.0', license: 'MIT' } });
    const [styles, plugin] = bundleLicences(root) as unknown as [Plugin & { buildStart: () => void }, Plugin];
    const npm = path.join(root, 'node_modules', 'pkg', 'a.css');
    const context = { resolve: async () => ({ id: npm }) };
    for (const id of ['/w/src/x.css', '/w/src/x.css?inline', '/w/src/x.css?transform-only', '/w/page.html?html-proxy&inline-css&index=0.css', '/w/src/x.module.css']) {
      await expect(styles.transform.call(context, '@import "pkg/a.css";', id), id).rejects.toThrow(/pulls in pkg\/a\.css/);
    }
    // Vite inlines nothing of a ?raw or ?url stylesheet's text (it processes a ?url one again, as ?transform-only).
    for (const id of ['/w/src/x.css?raw', '/w/src/x.css?url', '\0virtual:x.css', '/w/src/x.ts']) expect(await styles.transform.call(context, '@import "pkg/a.css";', id), id).toBeNull();
    // A stylesheet of the package that pulls in another of its own: that one's directory license is needed too.
    mkdirSync(path.join(root, path.dirname(COMMITTED)), { recursive: true });
    const bundle = { 'assets/a.css': { type: 'asset', fileName: 'assets/a.css', originalFileNames: ['src/main.ts'] }, ...modulesOf(root, { 'pkg/a.css': 0 }) };
    writeFileSync(path.join(root, COMMITTED), licenceDocument(neededLicences(bundleUse(bundle, root), root)));
    const run = () => plugin.generateBundle.call({ emitFile: () => undefined }, {}, bundle);
    styles.buildStart();
    expect(await styles.transform.call(context, readFileSync(npm, 'utf8'), npm)).toBeNull();
    expect(run).toThrow(/lacks license texts this bundle ships: pkg 1\.0\.0: vendor\/LICENSE-b/);
    // Each build starts afresh.
    styles.buildStart();
    expect(run).not.toThrow();
  });

  it('stop a real build on npm CSS it would inline unseen and on a Web Worker', async () => {
    // A stylesheet outside the app that @imports one of tailwindcss's by a relative path, and a worker of one of the app's own modules.
    const sheet = path.join(scratch, 'imports-npm.css');
    writeFileSync(sheet, `@import "${path.relative(scratch, path.join(WEB, 'node_modules', 'tailwindcss', 'preflight.css')).replace(/\\/g, '/')}";\n`);
    const entry = 'virtual:awwo-bundle-licences-refusals';
    const run = (source: string) => hostedBuild({ plugins: [{ name: 'entry', resolveId: (id: string) => (id === entry ? `\0${entry}` : undefined), load: (id: string) => (id === `\0${entry}` ? source : undefined) }],
      build: { rollupOptions: { input: entry } } });
    await expect(run(`import ${JSON.stringify(sheet)};`)).rejects.toThrow(/imports-npm\.css pulls in .*preflight\.css/);
    // With the stylesheet that names the app's own fonts and with the preview fonts, which the config's font license
    // plugins otherwise stop on first.
    const fonts = `import ${JSON.stringify(path.join(WEB, 'src', 'saas', 'design', 'tokens.css'))};\n`
      + `import { previewFontSource } from ${JSON.stringify(path.join(WEB, 'src', 'canvas', 'previewFonts.ts'))};\nglobalThis.awwoPreviewFontSource = previewFontSource;\n`;
    await expect(run(`${fonts}import W from ${JSON.stringify(`${path.join(WEB, 'src', 'canvas', 'previewImportMap.ts')}?worker`)};\nglobalThis.awwoWorker = W;`)).rejects.toThrow(/is a Web Worker/);
  }, 300_000);

  it('stop a build whose bundle needs a license text the committed file lacks, and write it when asked', () => {
    const root = app({ 'a/LICENSE': MIT('2020 A'), 'a/index.js': 'export {}' }, { a: { name: 'a', version: '1.0.0', license: 'MIT' } });
    mkdirSync(path.join(root, path.dirname(COMMITTED)), { recursive: true });
    const [styles, plugin] = bundleLicences(root) as unknown as [Plugin, Plugin];
    expect(styles).toMatchObject({ enforce: 'pre', apply: 'build' });
    const run = () => { const emitted: unknown[] = []; plugin.generateBundle.call({ emitFile: (file: unknown) => emitted.push(file) }, {}, modulesOf(root, { 'a/index.js': 4 })); return emitted; };
    const needed = licenceDocument(neededLicences(bundleUse(modulesOf(root, { 'a/index.js': 4 }), root), root));
    writeFileSync(path.join(root, COMMITTED), needed.replace('2020 A', '2021 A'));
    expect(run).toThrow(/lacks license texts this bundle ships: a 1\.0\.0: LICENSE\. Read what changed/);
    expect(uncovered(needed.replace('(MIT)', '(ISC)'), neededLicences(bundleUse(modulesOf(root, { 'a/index.js': 4 }), root), root))).toEqual(['a 1.0.0']);
    // A file that holds more than the bundle needs, a part of a larger build, is enough.
    writeFileSync(path.join(root, COMMITTED), `${needed}\nmore\n`);
    expect(run()).toEqual([{ type: 'asset', fileName: OUTPUT, source: `${needed}\nmore\n` }]);
    // Write mode is the write script's, in its own process: the environment does not turn it on.
    process.env.AWWO_WRITE_BUNDLE_LICENCES = '1';
    try { expect(run()).toEqual([{ type: 'asset', fileName: OUTPUT, source: `${needed}\nmore\n` }]); } finally { delete process.env.AWWO_WRITE_BUNDLE_LICENCES; }
    (globalThis as Record<symbol, unknown>)[WRITE] = true;
    try { expect(run()).toEqual([{ type: 'asset', fileName: OUTPUT, source: needed }]); } finally { delete (globalThis as Record<symbol, unknown>)[WRITE]; }
    expect(readFileSync(path.join(root, COMMITTED), 'utf8')).toBe(needed);
  });
});
