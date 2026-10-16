// The license texts of the npm code the hosted bundle ships. The hosted build (vite.saas.config.mjs) minifies the
// packages' code, which drops the license comments it carries, and serves other files of theirs as they are (pdf.js's
// worker, character maps and fonts, the three.js modules a running preview loads) under hashed names, with no license
// file beside them; MIT, ISC, BSD and Apache-2.0 each ask that copies carry the license. So this plugin writes one text
// file to the root of the site, OUTPUT: for every package the bundle holds code or files of, the license and notice
// files at its top, in each directory between it and those files and in the directories ALSO names; the comment at the
// top of a file the build minifies when that comment grants a license (vfile's lib/minpath.browser.js does, for code it
// took from path-browserify and Node.js); and the texts SUPPLEMENTS keeps in licences/ for code that came with no
// license of its own. Its text is COMMITTED, so that a person reads each license before it ships: the build fails when
// the bundle needs a text that file lacks, and `npm run licences:saas` (scripts/write-bundle-licences.mjs) writes the
// file again from a full build. The build also fails on the ways it knows of for npm code to enter unseen: a stylesheet
// (also a page's <style>) that pulls in npm CSS by @import or CSS Modules' composes/@value … from, which Vite inlines
// without a module; a Web Worker, which Vite bundles in a build of its own; and pdf.js's legacy build, which embeds
// core-js. It does not see a small npm file that a stylesheet's url() or a script's new URL() names, which Vite inlines
// as a data: URL (the app has none).
// tests/saas-bundle-licences.test.ts checks that a full build needs exactly that file.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';

/** The committed text, relative to the app root (apps/web), and the file the build writes it to. */
export const COMMITTED = 'src/saas/bundleLicences.txt';
export const OUTPUT = 'third-party-licenses.txt';
/** Set to true on globalThis by `npm run licences:saas`, in its own process and never from the environment: the build then writes COMMITTED. */
export const WRITE = Symbol.for('awwo.bundleLicences.write');

const LICENCE_FILE = /(?:^|[._-])(?:(?:UN)?LICEN[CS]ES?|COPYING|COPYRIGHT|NOTICES?|PATENTS|THIRD[-_ ]?PARTY[-_ ]?NOTICES?|OFL)(?:[._-]|$)/i;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|css|map|html?)$/i;
const STYLE_FILE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|sss)$/i;
// A module a build tool writes into the bundle itself, from no file under node_modules: Vite's module preload helpers,
// Rolldown's runtime helpers.
const TOOL_MODULE = /^\0(vite|rolldown)\//;
// Vite's LICENSE.md goes on, after Vite's own license, to give those of the packages Vite's own build bundles into it,
// none of which reaches a browser: only the part before that heading is taken.
const OWN_PART = new Map([['vite/LICENSE.md', '\n# Licenses of bundled dependencies\n']]);
// License files in a directory the bundle uses that cover other files of it: each is left out while every file the
// bundle takes from that directory (and below) is one `others` names, and comes back by itself once any other ships.
const LEFT_OUT = [
  { name: 'pdfjs-dist', file: 'standard_fonts/LICENSE_LIBERATION', others: /^standard_fonts\/(?:Foxit[A-Za-z]+\.pfb|LICENSE_FOXIT)$/,
    reason: 'it covers the Liberation Sans fonts, which this site does not ship (pdf.js asks for them only when it may not use the system\'s fonts)' },
  { name: 'three', file: 'examples/jsm/misc/SculptGL.LICENSE.txt', others: /^examples\/jsm\/misc\/GPUComputationRenderer\.js$/,
    reason: 'it covers the Sculptor modules, which this site does not ship' },
];
// Directories whose license files come with a file outside them: pdf.js's worker embeds the JavaScript of pdf.js's
// qcms, OpenJPEG and JBIG2 builds, whose licenses it keeps in wasm/ beside their WebAssembly, which this site does not ship.
const ALSO = [{ name: 'pdfjs-dist', uses: /^build\/pdf\.worker(?:\.min)?\.mjs$/, directory: 'wasm' }];
// Texts kept in licences/ for code that came with no license of its own, each pinned by the SHA-256 of the file a person
// read and by the version of the package it was read for: a changed file, or another version, stops the build until
// someone has checked the text again. `uses` is a file of the package the bundle ships, `helper` a tool's helper module.
const SUPPLEMENTS = [
  { name: 'pdfjs-dist', version: '6.3.289', uses: /^build\/pdf\.worker(?:\.min)?\.mjs$/, file: 'licences/LICENSE-brotli.txt',
    sha256: '2a57418d6b10947fe0dfbec3a600269e2745136c125cbf15b256e5ae18af23cb',
    label: 'Brotli\'s license, for the decoder its worker embeds (external/brotli/LICENSE_BROTLI in pdf.js at v6.3.289)' },
  { name: 'pdfjs-dist', version: '6.3.289', uses: /^build\/pdf\.worker(?:\.min)?\.mjs$/, file: 'licences/NOTICE-brotli-decode.txt',
    sha256: '192a8ef8abda29b039350d266468f1499d3e0f6647514990fe54e2e57e45e60c',
    label: 'the comment at the top of that decoder, which its build drops (external/brotli/decode.js in pdf.js at v6.3.289)' },
  { name: 'vite', version: '8.0.16', helper: /^\0vite\/modulepreload-polyfill/, file: 'licences/LICENSE-es-module-shims.txt',
    sha256: '13dc18f97f767475f7ad48fdd12a2e45be30fb309c604730f406f625cf7d8f7f',
    label: 'es-module-shims\' license (its LICENSE from 1.0.0 to 1.5.18), for the module preload polyfill Vite adapted from it, which Rolldown 1.0.3 writes without that notice' },
  { name: 'rolldown', version: '1.0.3', helper: /^\0rolldown\/runtime/, file: 'licences/LICENSE-rolldown-third-party.txt',
    sha256: 'a877291d800ed43692f3f9ae09d8e01cc6f7293ad39d43896059c188ffbb8b7c',
    label: 'the licenses its LICENSE links (Rollup\'s and esbuild\'s), for its runtime helpers, which derive from esbuild\'s (THIRD-PARTY-LICENSE in Rolldown at v1.0.3)' },
];
// Files of a package that need a license this plugin does not carry: the build stops on them.
const REFUSED = [{ name: 'pdfjs-dist', files: /^legacy\//,
  reason: 'pdf.js\'s legacy build embeds core-js as well, whose license this plugin does not carry: add it to SUPPLEMENTS, and the legacy worker to ALSO and to the Brotli texts, before shipping it' }];
// The words of a license grant, which a file's own comment holds when the file has code from elsewhere in it.
const GRANT = /permission is hereby granted|permission to use, copy, modify|redistribution and use in source and binary forms|licensed under the apache license/i;
// A CSS string in either quote, which may hold spaces, the other quote and escapes; the same without its groups.
const STRING = String.raw`"((?:[^"\\\n]|\\[^])*)"|'((?:[^'\\\n]|\\[^])*)'`, ANY_STRING = String.raw`"(?:[^"\\\n]|\\[^])*"|'(?:[^'\\\n]|\\[^])*'`;
// What a stylesheet pulls in from another file: @import "x", 'x', url(x), url("x") or url('x'), and CSS Modules'
// composes: … from "x" and @value … from "x".
const STYLE_IMPORTS = [new RegExp(String.raw`@import\b\s*(?:url\(\s*(?:${STRING}|((?:[^)\s"'\\]|\\[^])*))\s*\)|${STRING})`, 'gi'),
  new RegExp(String.raw`\bcomposes\s*:[^;{}]*?\bfrom\s+(?:${STRING})`, 'gi'), new RegExp(String.raw`@value\s[^;{}]*?\bfrom\s+(?:${STRING})`, 'gi')];
// A comment, or a string, which may hold what looks like one.
const COMMENT_OR_STRING = new RegExp(String.raw`\/\*[^]*?\*\/|${ANY_STRING}`, 'g');
/** The name a CSS string or url() spells, without its escapes: \hex and one white space after it, an escaped line break, \c. */
const unescapeCss = value => value.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([^]))/gi, (_, hex, lineBreak, char) => {
  if (lineBreak !== undefined) return '';
  if (char !== undefined) return char;
  const code = parseInt(hex, 16);
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code);
});
const RULE = '='.repeat(80);

const text = bytes => bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The package directory a file under node_modules belongs to, and the file's path inside it (POSIX); null for others. */
export function packageOf(file) {
  const path = file.replace(/\\/g, '/'), at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const parts = path.slice(at + '/node_modules/'.length).split('/'), length = parts[0]?.startsWith('@') ? 2 : 1;
  if (parts.length <= length || parts.slice(0, length + 1).some(part => !part)) return null;
  return { dir: path.slice(0, at + '/node_modules/'.length) + parts.slice(0, length).join('/'), file: parts.slice(length).join('/') };
}

/** The comments a file starts with, after a byte order mark or a #! line, exactly as written; '' when code comes first. */
export function leadingComment(source) {
  let at = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.startsWith('#!', at)) { const end = source.indexOf('\n', at); at = end < 0 ? source.length : end + 1; }
  let start = -1, end = at;
  for (let i = at; i < source.length;) {
    if (/\s/.test(source[i])) { i += 1; continue; }
    let stop;
    if (source.startsWith('//', i)) { const line = source.indexOf('\n', i); stop = line < 0 ? source.length : line; }
    else if (source.startsWith('/*', i)) { const close = source.indexOf('*/', i + 2); if (close < 0) break; stop = close + 2; }
    else break;
    if (start < 0) start = i;
    end = stop; i = stop;
  }
  return start < 0 ? '' : source.slice(start, end);
}

/**
 * What a bundle uses of each package: by package directory, the files it holds code or text of, each marked when the
 * build minified it (so its comments are gone), and the helper modules a build tool wrote into the bundle itself.
 * bundle: generateBundle's bundle, or a build's output files; root: the app root, whose node_modules holds the tools;
 * followed: npm stylesheets that stylesheets of their own package pull in (checkStyleImports), which have no module.
 * Throws on a Web Worker, whose npm code Vite bundles in a build of its own, out of this plugin's sight.
 */
export function bundleUse(bundle, root, followed = []) {
  const use = new Map();
  const entry = dir => {
    if (!use.has(dir)) use.set(dir, { files: new Map(), helpers: new Set() });
    return use.get(dir);
  };
  const add = (file, minified) => {
    const found = packageOf(file);
    if (!found) return;
    const files = entry(found.dir).files;
    files.set(found.file, files.get(found.file) || minified);
  };
  const worker = name => new Error(`${name} is a Web Worker, or another script Vite emits with no source file. The hosted build refuses every `
    + 'one, since the bundle license plugin (scripts/bundle-licences.mjs) cannot see the npm code a separate build put into it: give that build '
    + 'a license check of its own (Vite\'s worker.plugins) before shipping such a script.');
  for (const file of followed) add(file, true);
  for (const output of Object.values(bundle)) {
    if (output.type === 'asset') {
      const sources = output.originalFileNames ?? [];
      if (/\.[cm]?js$/i.test(output.fileName) && !sources.length) throw worker(output.fileName);
      for (const source of sources) add(isAbsolute(source) ? source : resolve(root, source), false);
      continue;
    }
    for (const [id, module] of Object.entries(output.modules ?? {})) {
      const query = id.includes('?') ? id.slice(id.indexOf('?')) : '', path = id.slice(id.startsWith('\0') ? 1 : 0, id.length - query.length);
      if (/[?&](?:shared)?worker(?:_file)?\b/.test(query)) throw worker(path);
      // Vite takes a stylesheet's rules out of its chunk, so the stylesheet's module renders nothing: count it anyway.
      if (!(module.renderedLength > 0) && !STYLE_FILE.test(path)) continue;
      const tool = TOOL_MODULE.exec(id);
      if (tool) { entry(join(root, 'node_modules', tool[1]).replace(/\\/g, '/')).helpers.add(id); continue; }
      // ?raw, ?url and ?inline put a file's bytes into the bundle as they are, except that a stylesheet's ?inline is
      // the CSS Vite made of it; everything else of code is minified.
      const verbatim = /[?&](?:raw|url)(?:&|$)/.test(query) || (/[?&]inline(?:&|$)/.test(query) && !STYLE_FILE.test(path));
      add(path, !verbatim && (/\.[cm]?[jt]sx?$/i.test(path) || STYLE_FILE.test(path)));
    }
  }
  return use;
}

/**
 * Throws when a stylesheet pulls in npm CSS (@import, or CSS Modules' composes/@value … from), itself or through a
 * stylesheet it pulls in by a relative or root path: Vite inlines such a file into the CSS it emits without a module of
 * its own, so bundleUse would not see the package. Within one npm package a stylesheet's import is that package's own
 * (bundleUse sees the stylesheet a script imports); its targets go into `followed`, for bundleUse to count too.
 * resolveId: a plugin context's resolver; root: the app root, for an import from the site's root ("/x.css").
 */
export async function checkStyleImports(source, file, { resolveId, root, followed = new Set() }, seen = new Set()) {
  if (seen.has(file)) return followed;
  seen.add(file);
  const own = packageOf(file)?.dir;
  // A comment is no import, and a /* inside a string starts none.
  const code = source.replace(COMMENT_OR_STRING, found => (found.startsWith('/*') ? '' : found));
  for (const pattern of STYLE_IMPORTS) {
    for (const match of code.matchAll(pattern)) {
      // The one group of the form that matched.
      const specifier = unescapeCss(match.slice(1).find(group => group !== undefined) ?? '');
      // A URL is the browser's to fetch, not the bundle's.
      if (/^(?:https?:|data:|\/\/)/i.test(specifier)) continue;
      let target = specifier.startsWith('.') ? resolve(dirname(file), specifier)
        : specifier.startsWith('/') ? join(root, specifier) : (await resolveId(specifier, file))?.id?.split('?')[0];
      // A module a plugin makes up (an id starting with \0) is no file this check can follow.
      if (target && (target.startsWith('\0') || !isAbsolute(target))) target = undefined;
      const found = target ? packageOf(target) : null;
      if (!target || (found && found.dir !== own)) {
        throw new Error(`${file} pulls in ${specifier}${target ? ` (${target})` : ''}, which Vite inlines without a module of its own, so the bundle `
          + 'license plugin (scripts/bundle-licences.mjs) cannot see its package: import that stylesheet from a script instead.');
      }
      if (found) followed.add(target.replace(/\\/g, '/'));
      let imported;
      try { imported = readFileSync(target, 'utf8'); } catch { continue; }
      await checkStyleImports(imported, target, { resolveId, root, followed }, seen);
    }
  }
  return followed;
}

const licenceFilesIn = (root, directory) => {
  let names;
  try { names = readdirSync(join(root, directory)); } catch { return []; }
  return names.filter(name => LICENCE_FILE.test(name) && !CODE_FILE.test(name) && isFile(join(root, directory, name))).sort().map(name => posix.join(directory, name));
};

/**
 * The license texts one package needs, as parts of the document: its heading; each license or notice file (from its
 * top, then from the directories of the files used, nearest first, then from those ALSO adds); the texts SUPPLEMENTS
 * adds; and each grant in a minified file's leading comment. root: the app root, which holds licences/. Throws when the
 * package has no license file at all, or a supplement no longer matches what was read.
 */
export function packageParts(dir, { files, helpers = new Set() }, root) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const declared = typeof manifest.license === 'string' ? manifest.license : [manifest.license, ...(manifest.licenses ?? [])].filter(Boolean).map(entry => entry.type ?? String(entry)).join(' OR ') || 'no license field';
  const installed = dir.slice(dir.lastIndexOf('/node_modules/') + '/node_modules/'.length);
  const id = `${manifest.name} ${manifest.version}`;
  const heading = `${id} (${declared})${installed === manifest.name ? '' : `, installed as ${installed}`}${helpers.size ? ', for the helpers it writes into the bundle' : ''}`;
  const parts = [{ label: id, text: `${RULE}\n${heading}\n${RULE}\n` }], leftOut = [];
  const shipped = [...files.keys()].sort();
  for (const rule of REFUSED) {
    const file = rule.name === manifest.name ? shipped.find(path => rule.files.test(path)) : undefined;
    if (file) throw new Error(`${id} ships ${file}: ${rule.reason}.`);
  }
  const paths = new Set(licenceFilesIn(dir, ''));
  for (const file of shipped) {
    for (let directory = posix.dirname(file); directory !== '.' && directory !== ''; directory = posix.dirname(directory)) for (const path of licenceFilesIn(dir, directory)) paths.add(path);
  }
  for (const rule of ALSO) if (rule.name === manifest.name && shipped.some(file => rule.uses.test(file))) for (const path of licenceFilesIn(dir, rule.directory)) paths.add(path);
  const licences = [...paths].filter(path => {
    const rule = LEFT_OUT.find(entry => entry.name === manifest.name && entry.file === path);
    if (!rule || !shipped.filter(file => file.startsWith(`${posix.dirname(path)}/`)).every(file => rule.others.test(file))) return true;
    leftOut.push(`${id}, ${path}: ${rule.reason}.`);
    return false;
  });
  if (!licences.length) throw new Error(`${id} (${dir}) is in the bundle but has no license file (LICENSE*, NOTICE*, COPYING*): add its license text by hand, or keep the package out of the hosted bundle.`);
  for (const path of licences) {
    let body = text(readFileSync(join(dir, path)));
    const own = OWN_PART.get(`${installed}/${path}`);
    if (own) {
      if (!body.includes(own)) throw new Error(`${id}'s ${path} no longer has the heading "${own.trim()}" its own license ends at; read the file again.`);
      body = text(Buffer.from(body.slice(0, body.indexOf(own))));
    }
    parts.push({ label: `${id}: ${path}`, text: `----- ${id}: ${path}${own ? ', its own license' : ''} -----\n${body}` });
  }
  for (const supplement of SUPPLEMENTS) {
    if (supplement.name !== manifest.name) continue;
    if (!(supplement.uses ? shipped.some(file => supplement.uses.test(file)) : [...helpers].some(helper => supplement.helper.test(helper)))) continue;
    if (manifest.version !== supplement.version) {
      throw new Error(`${id} is not the ${supplement.name} ${supplement.version} that ${supplement.file} was checked for: check the text against this release, then update its version in scripts/bundle-licences.mjs.`);
    }
    const bytes = readFileSync(join(root, supplement.file));
    if (createHash('sha256').update(bytes).digest('hex') !== supplement.sha256) {
      throw new Error(`${supplement.file} is not the text that was read (its SHA-256 differs): read it, then pin its new hash in scripts/bundle-licences.mjs.`);
    }
    parts.push({ label: `${id}: ${supplement.file}`, text: `----- ${id}: ${supplement.label} -----\n${text(bytes)}` });
  }
  for (const [file, minified] of [...files].sort(([a], [b]) => compare(a, b))) {
    if (!minified) continue;
    const comment = leadingComment(readFileSync(join(dir, file), 'utf8'));
    if (GRANT.test(comment)) parts.push({ label: `${id}: ${file}`, text: `----- ${id}: ${file}, the comment at its top -----\n${text(Buffer.from(comment))}` });
  }
  return { id, parts, leftOut };
}

/** Every package's parts, in the order of the document: by name and version. root: the app root. */
export function neededLicences(use, root) {
  return [...use].map(([dir, entry]) => packageParts(dir, entry, root)).sort((a, b) => compare(a.id, b.id));
}

const PREAMBLE = `Third-party software in AwwO's hosted app
=========================================

AwwO's hosted app is built from AwwO's source, under the MIT License (see LICENSE in
the repository); from third-party files kept in the repository, which its
THIRD_PARTY_NOTICES.md lists with their licenses; and from code and files of the npm
packages below. Building the app minifies their code, which drops the license comments
in it, and serves some of their files as they are: pdf.js's worker, character maps and
two fonts, and the three.js modules a running preview loads. For each package, at the
version the app's lockfile pins, this file carries its license and notice files, from
its top directory and from each directory between it and a file the app uses (and
pdf.js's wasm/ directory, for the loaders its worker embeds), and the comment at the
top of a file the build minifies when that comment grants a license. It adds, kept in
AwwO's repository, the licenses of three pieces of code that reach the app with no
license text of their own: Brotli's decoder in pdf.js's worker, the module preload
polyfill Vite adds (from es-module-shims), and Rolldown's runtime helpers (with the
list of licenses Rolldown's LICENSE links). Each is copied as it was written, with LF
line ends. Code that a package credits to another project only in a comment, without
that project's license text, is not covered here.
`;

/** The whole document for these packages. */
export function licenceDocument(packages) {
  const leftOut = packages.flatMap(entry => entry.leftOut);
  return [PREAMBLE, ...packages.map(entry => entry.parts.map(part => part.text).join('\n')),
    ...(leftOut.length ? [`${RULE}\nLeft out\n${RULE}\n${leftOut.map(line => `- ${line}`).join('\n')}\n`] : [])].join('\n');
}

/** The labels of the parts the committed text lacks, exactly as they would be written. */
export function uncovered(committed, packages) {
  return packages.flatMap(entry => entry.parts).filter(part => !committed.includes(part.text)).map(part => part.label);
}

/** The Vite plugins: one that checks stylesheets before Vite inlines their @imports, one that checks the bundle. root: the app root (apps/web). */
export function bundleLicences(root) {
  // npm stylesheets that stylesheets of their own package pull in, which the bundle holds without a module of their own:
  // found while Vite transforms the stylesheets, counted with the bundle.
  const followed = new Set();
  return [{
    name: 'awwo-bundle-licences-styles', apply: 'build', enforce: 'pre',
    buildStart() { followed.clear(); },
    async transform(code, id) {
      const query = id.includes('?') ? id.slice(id.indexOf('?')) : '', file = id.slice(0, id.length - query.length);
      // A stylesheet's CSS, also one a page writes in a <style> (Vite names it page.html?html-proxy&inline-css…); not a
      // ?raw or ?url one, whose text Vite does not inline (it processes a ?url stylesheet again, as ?transform-only).
      const style = STYLE_FILE.test(file) || /[?&]inline-css\b/.test(query);
      if (!id.startsWith('\0') && style && !/[?&](?:raw|url)(?:&|$)/.test(query)) {
        await checkStyleImports(code, file, { resolveId: (specifier, importer) => this.resolve(specifier, importer), root, followed });
      }
      return null;
    },
  }, {
    name: 'awwo-bundle-licences', apply: 'build', enforce: 'post',
    generateBundle(_options, bundle) {
      const packages = neededLicences(bundleUse(bundle, root, followed), root), committed = join(root, COMMITTED);
      if (globalThis[WRITE] === true) writeFileSync(committed, licenceDocument(packages));
      const current = readFileSync(committed, 'utf8'), missing = uncovered(current, packages);
      if (missing.length) {
        throw new Error(`${COMMITTED} lacks license texts this bundle ships: ${missing.join('; ')}. Read what changed, then run `
          + '`npm run licences:saas` in apps/web (a full build that writes the file) and commit it.');
      }
      this.emitFile({ type: 'asset', fileName: OUTPUT, source: current });
    },
  }];
}
