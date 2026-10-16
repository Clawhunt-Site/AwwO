// Keeps the license of a folder of fonts with every copy the hosted build ships of them. The folder it is used for is
// src/saas/design/fonts/ (Mona Sans, under the SIL Open Font License): a stylesheet names its fonts, so they reach the
// bundle as files Vite emits under hashed names, but nothing names the license file beside them, so Vite leaves it
// out. The OFL asks that each copy of a font come with its copyright notice and license, so this plugin writes every
// license file of the folder, unchanged and under its own name, into each output directory that receives one of the
// folder's fonts. The build fails when a font of the folder ships as no file of its own (inlined, or no longer used)
// or the folder has no license, so no copy goes without it. Fonts that reach the bundle another way, such as the
// preview fonts src/canvas/previewFonts.ts inlines as data: URLs, are not covered. tests/saas-font-licences.test.ts
// runs the hosted build config (vite.saas.config.mjs) on these fonts and checks what it writes.
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

/** The Vite plugin: once the bundle is complete, the folder's licenses beside every one of its fonts the bundle holds. */
export function fontLicences(directory) {
  return {
    name: 'awwo-font-licences', apply: 'build', enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = new Map();
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset') continue;
        const { source } = file;
        assets.set(file.fileName, typeof source === 'string' ? Buffer.from(source) : Buffer.from(source.buffer, source.byteOffset, source.byteLength));
      }
      for (const { fileName, source } of licenceAssets(directory, fontFolder(directory), assets)) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
