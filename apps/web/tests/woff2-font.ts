/**
 * What a WOFF2 font says about its license terms, for the font tests: its copyright notice, with the names it reserves,
 * and its glyph count, which tells a whole font from a subset of it. Both come from tables WOFF2 never transforms (name
 * and maxp), so they are read straight from the font's compressed data.
 */
import { brotliDecompressSync } from 'node:zlib';

/** A table of a WOFF2 font by its known-tag index (4 is maxp, 5 name); only for tables WOFF2 stores untransformed. */
function woff2Table(woff2: Buffer, wanted: number): Buffer {
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = woff2[at++];
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error('bad UIntBase128');
  };
  // The table directory: a known tag's index (10 glyf, 11 loca) or 63 and the tag, its length, and the length it takes
  // in the data when it is transformed (glyf and loca unless version 3, any other table unless 0).
  const tables: { index: number; length: number }[] = [];
  for (let i = 0, count = woff2.readUInt16BE(12); i < count; i += 1) {
    const flags = woff2[at++], index = flags & 0x3f, version = flags >> 6;
    if (index === 63) at += 4;
    const length = base128();
    tables.push({ index, length: (index === 10 || index === 11 ? version !== 3 : version !== 0) ? base128() : length });
  }
  // The tables follow each other, in the order of the directory, in one Brotli stream.
  const data = brotliDecompressSync(woff2.subarray(at, at + woff2.readUInt32BE(20)));
  let offset = 0;
  for (const { index, length } of tables) {
    if (index === wanted) return data.subarray(offset, offset + length);
    offset += length;
  }
  throw new Error(`no table ${wanted}`);
}

/** The font's copyright notice: name ID 0 on the Windows platform. */
export function copyrightNotice(woff2: Buffer): string {
  const name = woff2Table(woff2, 5), strings = name.readUInt16BE(4);
  for (let record = 6; record < 6 + name.readUInt16BE(2) * 12; record += 12) {
    if (name.readUInt16BE(record) !== 3 || name.readUInt16BE(record + 6) !== 0) continue;
    const start = strings + name.readUInt16BE(record + 10);
    return Buffer.from(name.subarray(start, start + name.readUInt16BE(record + 8))).swap16().toString('utf16le');
  }
  return '';
}

/** The font's glyph count (maxp): a subset of a font has fewer glyphs than the whole font. */
export function glyphCount(woff2: Buffer): number {
  return woff2Table(woff2, 4).readUInt16BE(4);
}

/**
 * The names a copyright notice reserves, however it writes them: 'with Reserved Font Name "Orbitron"', 'Reserved Font
 * Name: "Orbitron"', in single or curly quotes, or none ('with Reserved Font Name Source.').
 */
export function reservedNames(text: string): string[] {
  return [...text.matchAll(/Reserved Font Names?\s*:?\s*(?:["“'‘]([^"”'’]+)["”'’]|([^\s"“'‘.,;][^.,;"”'’\n]*))/g)]
    .map(match => (match[1] ?? match[2]).trim());
}
