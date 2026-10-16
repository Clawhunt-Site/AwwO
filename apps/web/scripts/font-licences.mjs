// Keeps the license of a folder of fonts with every copy the app's builds ship of them. The fonts are under the SIL
// Open Font License, which asks that each copy of a font come with its copyright notice and license, as a stand-alone
// text file or a human-readable header. Two plugins, for the two ways the builds ship fonts:
// - fontLicences, for src/saas/design/fonts/ (Mona Sans, which only the hosted build ships): a stylesheet names its
//   fonts, so they reach the bundle as files Vite emits under hashed names, but nothing names the license file beside
//   them, so Vite leaves it out. The plugin writes every license file of the folder, unchanged and under its own name,
//   into each output directory that receives one of the folder's fonts. The build fails when a font of the folder
//   ships as no file of its own (inlined, or no longer used) or the folder has no license, so no copy goes without it.
// - inlinedFontLicences, for src/canvas/fonts/ (the preview fonts, which the hosted build and the native one both
//   ship, each family with its own <family>.LICENSE.txt, which both configs pair with the family's fonts by
//   src/canvas/previewFontList.ts through familyLicences): previewFonts.ts inlines each font as a data: URL in a script
//   chunk of its own, so no file beside it would travel with it. The plugin starts every chunk that holds one of them
//   with its family's license, unchanged, as a /*! comment (an output postBanner: the minifier would strip a comment in
//   the code, and the chunk's hash covers it). The build fails when a font of the folder has no license, ships in any
//   other file (also one copied into the output), or in no file.
// tests/saas-font-licences.test.ts runs the hosted build config (vite.saas.config.mjs) on both folders and checks
// what it writes; tests/native-font-licences.test.ts runs the native one (vite.config.mjs) on the preview fonts.
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const FONT = /\.(?:woff2?|[ot]tf)$/i;
const LICENCE = /^(?:LICEN[CS]E|OFL)(?:[._-].*)?$/i;
const same = (a, b) => a.length === b.length && a.equals(b);

/** A folder's font files and license files, each by name with its bytes. */
export function fontFolder(directory) {
  const fonts = new Map(), licences = new Map();
  for (const name of readdirSync(directory).sort()) {
    if (FONT.test(name)) fonts.set(name, readFileSync(join(directory, name)));
    else if (LICENCE.test(name)) licences.set(name, readFileSync(join(directory, name)));
  }
  return { fonts, licences };
}

/**
 * The license files a bundle lacks: each license of the folder under its own name, in every output directory that
 * holds one of the folder's fonts (found by its bytes, as the bundle names it by its hash). assets maps each output
 * file name to its bytes. Throws when the folder has fonts but no license, when one of its fonts is in no file of its
 * own, or when a license would take the place of another file.
 */
export function licenceAssets(directory, { fonts, licences }, assets) {
  if (fonts.size && !licences.size) throw new Error(`${directory} has fonts but no license file (LICENSE*, OFL*) to ship with them.`);
  const targets = new Set(), unshipped = [];
  for (const [name, bytes] of fonts) {
    const shipped = [...assets].filter(([, source]) => same(source, bytes));
    if (!shipped.length) unshipped.push(name);
    for (const [fileName] of shipped) targets.add(posix.dirname(fileName));
  }
  if (unshipped.length) {
    throw new Error(`No file of its own in the bundle (inlined, or no longer used) holds ${unshipped.join(', ')} from ${directory}, so `
      + 'the license cannot ship beside it. Emit each font as a file, or delete a font file no stylesheet uses (and, once the folder '
      + 'has no font left, its license and its entry in THIRD_PARTY_NOTICES.md).');
  }
  const missing = [];
  for (const target of [...targets].sort()) {
    for (const [name, source] of licences) {
      const fileName = posix.join(target, name), existing = assets.get(fileName);
      if (existing && !same(existing, source)) throw new Error(`The license ${name} would replace another file at ${fileName}.`);
      if (!existing) missing.push({ fileName, source });
    }
  }
  return missing;
}

const bytesOf = source => (typeof source === 'string' ? Buffer.from(source) : Buffer.from(source.buffer, source.byteOffset, source.byteLength));

/** The Vite plugin: once the bundle is complete, the folder's licenses beside every one of its fonts the bundle holds. */
export function fontLicences(directory) {
  return {
    name: 'awwo-font-licences', apply: 'build', enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = new Map();
      for (const file of Object.values(bundle)) if (file.type === 'asset') assets.set(file.fileName, bytesOf(file.source));
      for (const { fileName, source } of licenceAssets(directory, fontFolder(directory), assets)) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}

const FAMILY_LICENCE = /\.LICEN[CS]E\.txt$/i;

/** A folder's files by name, with their bytes; hidden files (a Finder .DS_Store) are none of them. */
export function folderFiles(directory) {
  return new Map(readdirSync(directory).filter(name => !name.startsWith('.')).sort().map(name => [name, readFileSync(join(directory, name))]));
}

/**
 * Each font's license file by the font's name, given the families with their fonts (src/canvas/previewFontList.ts): its
 * family's, <family>.LICENSE.txt with the family's name in lower case and a dash for each space, alike in every build.
 */
export const familyLicences = families => new Map(families.flatMap(font => font.faces.map(face =>
  [face.file, `${font.family.toLowerCase().replace(/ /g, '-')}.LICENSE.txt`])));

/**
 * The fonts of a folder that holds each font family's license as <family>.LICENSE.txt (src/canvas/fonts/), given its
 * files by name and each font's license file by the font's name (from the list naming the families, so that a font
 * never borrows another family's license): each font with its bytes, their base64 (as a data: URL holds them) and its
 * license. Throws for a font the list gives no license, a license the folder lacks, a license of no font, and one that
 * would end the comment carrying it.
 */
export function familyFonts(directory, files, licenceOf) {
  const licences = new Map(), fonts = [], problems = [];
  for (const [name, bytes] of files) if (FAMILY_LICENCE.test(name)) licences.set(name, { name, text: bytes.toString('utf8') });
  for (const [name, bytes] of files) {
    if (!FONT.test(name)) continue;
    const licence = licences.get(licenceOf.get(name));
    if (licence) fonts.push({ name, bytes, base64: bytes.toString('base64'), licence });
    else problems.push(licenceOf.has(name) ? `${name}: its license ${licenceOf.get(name)} is missing` : `${name}: no family lists it`);
  }
  for (const licence of licences.values()) {
    if (!fonts.some(font => font.licence === licence)) problems.push(`${licence.name}: the license of no font`);
    if (licence.text.includes('*/')) problems.push(`${licence.name} holds "*/", which would end the comment that carries it`);
  }
  if (problems.length) throw new Error(`${directory}: ${problems.join('; ')}.`);
  return fonts;
}

/** The comment a script chunk holding these fonts starts with: each of their licenses, unchanged, after the fonts it covers. */
export function licenceBanner(fonts) {
  const covered = new Map();
  for (const font of fonts) covered.set(font.licence, [...new Set([...(covered.get(font.licence) ?? []), font.name])].sort());
  return [...covered].sort(([a], [b]) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(([licence, names]) => `/*! License of ${names.join(', ')} (${licence.name}):\n${licence.text}${licence.text.endsWith('\n') ? '' : '\n'}*/`)
    .join('\n');
}

/** The fonts a rendered chunk holds: each whose bytes, as base64, are in the code of one of its modules. */
export function fontsInModules(fonts, modules) {
  const shortest = Math.min(...fonts.map(font => font.base64.length)), held = new Set();
  for (const module of Object.values(modules ?? {})) {
    const code = module?.code;
    if (!code || code.length < shortest) continue;
    for (const font of fonts) if (code.includes(font.base64)) held.add(font);
  }
  return [...held];
}

/**
 * What would ship a font of the folder without its license, given every output file by name (a chunk with its code,
 * an asset with its bytes): a chunk holding the font's bytes, as base64, without its license; any other file holding
 * them, or the font itself (only a script chunk can start with the license); and a font in no file.
 */
export function unlicensedFonts(fonts, outputs) {
  const problems = [];
  for (const font of fonts) {
    let shipped = false;
    for (const [fileName, { type, content }] of outputs) {
      if (!(type === 'chunk' ? content.includes(font.base64) : holdsFont(content, font))) continue;
      shipped = true;
      if (type !== 'chunk') problems.push(`${fileName} holds ${font.name} (${OTHER_FILE})`);
      else if (!content.includes(font.licence.text)) problems.push(`${fileName} holds ${font.name} without its license ${font.licence.name}`);
    }
    if (!shipped) problems.push(`no file holds ${font.name} (delete a font no page loads, then a license of no font and its entry in THIRD_PARTY_NOTICES.md)`);
  }
  return problems;
}

const OTHER_FILE = 'only a script chunk can start with its license: load it from a script with ?inline, and keep it out of '
  + 'source maps, stylesheets and copied folders such as public/';
const holdsFont = (bytes, font) => bytes.equals(font.bytes) || bytes.includes(font.base64);

/** Every file below a directory, by its path from there (POSIX); links are not followed. */
function filesBelow(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesBelow(join(directory, entry.name), path);
    return entry.isFile() ? [path] : [];
  });
}

/**
 * The Vite plugin for src/canvas/fonts/, given each font's license file by the font's name: every script chunk holding
 * one of the folder's fonts starts with that font's license, as an output postBanner (added after minification, which
 * strips comments, and covered by the chunk's hash). Once the bundle is complete, and again once the output directory
 * holds what the build copies there besides it (public/, the showcase), the build fails if a font of the folder would
 * ship without its license.
 */
export function inlinedFontLicences(directory, licenceOf) {
  let fonts = [];
  const written = [];
  return {
    name: 'awwo-inlined-font-licences', apply: 'build', enforce: 'post',
    buildStart() { fonts = familyFonts(directory, folderFiles(directory), licenceOf); written.length = 0; },
    outputOptions(options) {
      const previous = options.postBanner;
      return { ...options, postBanner: async chunk => {
        const before = typeof previous === 'function' ? await previous(chunk) : previous;
        const banner = licenceBanner(fontsInModules(fonts, chunk.modules));
        // No banner, not even an empty one, for any other chunk: Rolldown puts a line break after an empty string too.
        if (!banner) return before;
        return before ? `${before}\n${banner}` : banner;
      } };
    },
    generateBundle(_options, bundle) {
      const outputs = new Map(Object.values(bundle).map(file => [file.fileName,
        file.type === 'chunk' ? { type: 'chunk', content: file.code } : { type: 'asset', content: bytesOf(file.source) }]));
      const problems = unlicensedFonts(fonts, outputs);
      if (problems.length) throw new Error(`The build would ship fonts of ${directory} without their license: ${problems.join('; ')}.`);
    },
    writeBundle(options, bundle) { if (options.dir) written.push({ dir: options.dir, bundled: new Set(Object.keys(bundle)) }); },
    // The files copied into the output directory rather than bundled are no chunk, so none may hold a font of the folder.
    closeBundle() {
      const problems = written.flatMap(({ dir, bundled }) => filesBelow(dir).filter(path => !bundled.has(path)).flatMap(path => {
        const bytes = readFileSync(join(dir, path));
        return fonts.filter(font => holdsFont(bytes, font)).map(font => `${path} holds ${font.name} (${OTHER_FILE})`);
      }));
      if (problems.length) throw new Error(`The build shipped fonts of ${directory} without their license: ${problems.join('; ')}.`);
    },
  };
}
