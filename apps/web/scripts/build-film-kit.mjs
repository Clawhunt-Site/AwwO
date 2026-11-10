// Builds AwwO's film kit: the frame engine of cinecode's one-file film (third_party/cinecode/templates/quick/film.html,
// MIT) as ONE classic browser script that defines window.Film. A film node's page loads it by its fixed URL and then
// describes its film with Film.run({...}); AwwO's running previews inline this exact file (src/canvas/previewLibraries.ts),
// the render worker answers the same URL with its own pinned copy (apps/render-worker/kits), and the hosted site serves
// the same bytes there for downloaded pages (vite.saas.config.mjs).
//
// The engine is cinecode's own text. AwwO's changes are the named edits below, each of which must match exactly once,
// so an upstream change that moves or rewords a line stops the build instead of producing a kit that silently differs;
// the film's description, the renderer's contract and the preview player are AwwO's code (RUNTIME).
//
// The output is deterministic. tests/saas-film-kit.test.ts rebuilds it in memory and compares it byte for byte with the
// committed copy, so editing the bundle by hand or forgetting to rebuild after a vendored update fails the suite.
//
//   node apps/web/scripts/build-film-kit.mjs           write src/canvas/filmKit/film-kit.js
//   node apps/web/scripts/build-film-kit.mjs --check   exit 1 when the committed bundle is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const KIT_DIR = join(here, '..', '..', '..', 'third_party', 'cinecode');
export const KIT_OUTPUT = join(here, '..', 'src', 'canvas', 'filmKit', 'film-kit.js');
export const KIT_VERSION = '1';
export const KIT_COMMIT = '67f9807112b97ae253d4a5f0eccaccc46c3b2633';

const FILM_BANNER = '// ============================== FILM ==============================';
const PICTURE_BANNER = '// ============================== HELPERS (picture) ==============================';

/** The one line of `lines` that starts with `prefix`, after index `from`; throws unless there is exactly one. */
function lineIndex(lines, prefix, from = 0, what = prefix) {
  const hits = [];
  for (let i = from; i < lines.length; i++) if (lines[i].startsWith(prefix)) hits.push(i);
  if (hits.length !== 1) throw new Error(`film kit: expected one line starting ${JSON.stringify(what)}, found ${hits.length}`);
  return hits[0];
}

/** `text` with `find` replaced by `replace`; throws unless `find` occurs exactly once. */
function replaceOnce(text, find, replace, why) {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`film kit: the edit "${why}" did not match exactly once`);
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

// Blocks taken out whole, as [the first line's start, the line after the block's start): parts that need cinecode's own
// tools, local files or the URL a capture gives, none of which an AwwO page has.
const CUTS = [
  { why: 'the model sheet (a ?modelsheet= URL check)', from: '// The model sheet: every view', to: '// ---- Formulas:' },
  { why: 'formulas (MathJax loaded at run time)', from: '// ---- Formulas:', to: 'async function loadType(T) {' },
  { why: 'captions timed from a speech transcript', from: '// ---- talking-head captions', to: '// ---- type check ----' },
  { why: 'recorded instruments read from local files', from: '// Recorded instruments. sample(ctx', to: 'function loadAudio(ctx, url) {' },
  { why: 'local audio, the capture contract, the text check and the preview loop (AwwO keeps its own in RUNTIME)', from: 'function loadAudio(ctx, url) {', to: null },
];

// Lines changed in place: what AwwO's renderer gives a page instead of URL parameters, and what Film.run sets at boot.
const EDITS = [
  {
    why: 'the canvas, its size and the seed come from Film.run, not the URL',
    find: "const q = new URLSearchParams(location.search);\n"
      + "const W = +q.get('w') || 1080, H = +q.get('h') || 1920, SEED = +q.get('seed') || 7;\n"
      + 'const FRAMES = Math.round(FPS * DURATION), TAU = Math.PI * 2, SR = 48000;\n'
      + "const canvas = document.getElementById('c');\n"
      + 'canvas.width = W; canvas.height = H;\n'
      + "const g = canvas.getContext('2d', { alpha: false });\n"
      + 'const S = { W, H, u: Math.min(W, H) };       // u = the short side; sizes below are fractions of it\n',
    replace: '// AwwO: the canvas, its size and the seed are set when the page calls Film.run (boot(), at the end of the kit).\n'
      + 'let W = 0, H = 0, SEED = 7, FRAMES = 0, canvas = null, g = null;\n'
      + 'const S = { W: 0, H: 0, u: 1 };              // u = the short side; sizes below are fractions of it\n'
      + 'const TAU = Math.PI * 2, SR = 48000;\n',
  },
  {
    why: 'casing follows the film\'s language (cinecode defaults to Turkish, which turns English i into İ)',
    find: "const up = (s, lang = 'tr') => String(s).toLocaleUpperCase(lang);\nconst low = (s, lang = 'tr') => String(s).toLocaleLowerCase(lang);\n",
    replace: "const up = (s, lang = TYPE.lang || 'en') => String(s).toLocaleUpperCase(lang);\nconst low = (s, lang = TYPE.lang || 'en') => String(s).toLocaleLowerCase(lang);\n",
  },
  {
    why: 'a character keeps a one-pixel outline inside a camera plane too (cinecode sized it in screen pixels only)',
    find: 'ow = Math.max(1, h * 0.008)',
    replace: 'ow = Math.max(1 / (Math.hypot(g.getTransform().a, g.getTransform().b) || 1), h * 0.008)',
  },
  {
    why: 'the frame buffers are made at boot, at the film\'s size',
    find: 'const bufA = buffer(), bufB = buffer(), bufSub = buffer(), bufOut = buffer();\n',
    replace: 'let bufA, bufB, bufSub, bufOut;              // AwwO: made at boot, at the film\'s size\n',
  },
  {
    why: 'finishing comes from the film\'s FINISH only (no URL overrides)',
    find: "const SAMPLES = Math.max(1, Math.round(+(q.get('shutter') ?? FINISH.shutter?.samples ?? 1)) || 1);\n"
      + "const WEAVE = +(q.get('weave') ?? FINISH.weave) || 0, TONE = q.get('tone') === '0' ? null : FINISH.tone;\n",
    replace: 'let SAMPLES = 1, WEAVE = 0, TONE = null;     // AwwO: from FINISH at boot\n',
  },
  {
    why: 'the motion-blur probe is sized at boot',
    find: "const STILL = 0.6, probe = document.createElement('canvas');\n"
      + 'probe.width = 64; probe.height = Math.max(1, Math.round(64 * H / W));\n'
      + "const probeG = probe.getContext('2d', { willReadFrequently: true });\n",
    replace: "const STILL = 0.6, probe = document.createElement('canvas');\n"
      + 'let probeG = null;                           // AwwO: sized at boot\n',
  },
  {
    why: 'the print-tone filter is installed at boot',
    find: 'if (TONE) {\n',
    replace: 'function installTone() {                     // AwwO: called at boot\n  if (!TONE) return;\n',
  },
  {
    why: 'a frame is drawn for the renderer\'s t (any frame rate), not only for a frame index at 24',
    find: 'window.renderFrame = (frame) => {\n'
      + '  if (MODEL_SHEET) { modelSheet(g, S, MODEL_SHEET); return; }\n'
      + '  const t = frame / FPS;                       // time comes only from the frame index\n',
    replace: 'function renderFrame(frame, at) {             // AwwO: the renderer\'s t when it gives one\n'
      + '  const t = at ?? frame / FPS;                 // time comes only from the frame index (or the renderer\'s t)\n',
  },
  {
    why: 'no speech captions',
    find: '  const punch = CAPTIONS ? captionPunch(CAPTIONS, t, CAPTION_STYLE.punch) : 1;\n',
    replace: '  const punch = 1;\n',
  },
  {
    why: 'no speech captions',
    find: '  if (CAPTIONS) kineticCaptions(g, TYPE, CAPTIONS, t, W, H, CAPTION_STYLE);   // after the grade: exact type colours\n',
    replace: '',
  },
  {
    why: 'no capture contract (AwwO\'s is in RUNTIME)',
    find: '\n};\nwindow.captureFrame = (frame, type = \'image/png\', quality = 0.95) => { window.renderFrame(frame); return canvas.toDataURL(type, quality); };\n',
    replace: '\n}\n',
  },
  {
    why: 'Google Fonts\' simplified Chinese subset is one file with no unicode-range (Fontsource\'s stylesheet gives it none): as one of a role\'s subsets it is tried for every character, as a face with no range is, and a role that lacks it can say so by name',
    find: '};\nconst TYPE_FALLBACK = {',
    replace: "  'chinese-simplified': 'U+0-10FFFF',            // AwwO: Noto Sans SC's (BRAND_FONTS), beside its latin-ext subset\n"
      + '};\nconst TYPE_FALLBACK = {',
  },
  {
    why: 'the glyph check measures after fonts of the kit\'s own (the generic families cannot tell a missing Chinese glyph: every font that has one draws it an em wide)',
    find: "    const a = w('monospace'), b = w('serif'), c = w('cursive');\n"
      + '    if (Math.abs(a - b) > 0.01 || Math.abs(b - c) > 0.01) miss.add(ch);\n',
    replace: '    const widths = glyphFallbacks().map(w);      // AwwO: the kit\'s glyph probes, or three generic families without them\n'
      + '    if (widths.some((x) => Math.abs(x - widths[0]) > 0.01)) miss.add(ch);\n',
  },
  {
    why: 'the glyph check measures each listed string without its emoji, string by string (a lone base and a lone skin tone in two strings are no emoji)',
    find: "    const strs = [...(c.strings?.[name] || []), ...(T.lang === 'tr' || T.lang == null ? [TYPE_TR_TEST] : [])].join('');\n",
    replace: "    const strs = [...[].concat(c.strings?.[name] || []).map((s) => String(s).replace(EMOJI, '')),   // AwwO: emoji aside\n"
      + "      ...(T.lang === 'tr' || T.lang == null ? [TYPE_TR_TEST] : [])].join('');\n",
  },
  {
    why: 'a line breaks between Chinese and Japanese characters too, which put no space between words (cinecode breaks at spaces only, so a Chinese line never wrapped), as typesetters do: never before a closing mark or after an opening one; text with spaces between its words breaks at them, as before',
    find: [
      'function wrap(g, str, maxW, balance = false) {',
      String.raw`  const words = String(str).split(/[ \t\n]+/).filter(Boolean);   // a no-break space (\u00A0) keeps '24.990\u00A0₺' together`,
      '  const fit = (w) => {',
      "    const lines = []; let cur = '';",
      '    for (const word of words) {',
      '      const t = cur ? `${cur} ${word}` : word;',
      '      if (g.measureText(t).width <= w || !cur) cur = t; else { lines.push(cur); cur = word; }',
      '    }',
      '    if (cur) lines.push(cur);',
      '    return lines;',
      '  };',
      '  let lines = fit(maxW);',
      '  if (balance && lines.length > 1) {',
      '    let lo = maxW * 0.5, hi = maxW;',
      '    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (fit(mid).length > lines.length) lo = mid; else hi = mid; }',
      '    lines = fit(hi);',
      '  }',
      '  const n = lines.length;',
      "  if (n > 1 && !lines[n - 1].includes(' ')) {",
      "    const prev = lines[n - 2].split(' ');",
      "    if (prev.length > 2) { lines[n - 1] = `${prev.pop()} ${lines[n - 1]}`; lines[n - 2] = prev.join(' '); }",
      '  }',
      '  return lines;',
      '}',
      '',
    ].join('\n'),
    replace: String.raw`// AwwO: a line also breaks between Chinese and Japanese characters, which put no space between words (wrapUnits);
// text written with spaces between its words, as Latin is, breaks at them and only there, as before.
function wrap(g, str, maxW, balance = false) {
  const units = wrapUnits(str);                 // a no-break space (\u00A0) keeps '24.990\u00A0₺' together
  const line = (us) => us.map((u, i) => (i && u.space ? ' ' : '') + u.text).join('');
  const fit = (w) => {
    const lines = []; let cur = [];
    for (const unit of units) {
      const t = [...cur, unit];
      if (g.measureText(line(t)).width <= w || !cur.length) cur = t; else { lines.push(cur); cur = [unit]; }
    }
    if (cur.length) lines.push(cur);
    return lines;
  };
  let lines = fit(maxW);
  if (balance && lines.length > 1) {
    let lo = maxW * 0.5, hi = maxW;
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (fit(mid).length > lines.length) lo = mid; else hi = mid; }
    lines = fit(hi);
  }
  const n = lines.length;
  if (n > 1 && lines[n - 1].length === 1 && lines[n - 2].length > 2) lines[n - 1].unshift(lines[n - 2].pop());
  return lines.map(line);
}

// AwwO: what wrap may break a line between, in order, each with whether a space stood before it: the words between
// spaces, and inside a word each Chinese or Japanese character (Han, kana, bopomofo, the full-width forms) apart. A
// closing mark (，。、」』）…, a small kana, a mark that combines with the character before it) joins the unit before it,
// an opening one (「『（…) the unit after it, and a no-break space both, so a line neither starts with the one nor ends
// with the other.
const WRAP_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u3000-\u303F\u309B-\u309C\u30A0-\u30FF\u3200-\u33FF\uFE10-\uFE19\uFE30-\uFE4F\uFF01-\uFF9F\uFFE0-\uFFE6]/u;
const WRAP_CLOSE = /^[\p{M}\u00A0\u2007\u2011\u200D\u2060\u202F\uFEFF\u3000)\]}!?,.:;%\/°′″‰℃¢’”»›…‥‐–—～〜、。，．：；！？％）］｝｠」』】〕〗〙〛〉》〞〟・ー々〻ゝゞヽヾぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿ｡｣､･ﾞﾟｧ-ｰ゛゜︐-︖︘︙︶︸︺︼︾﹀﹂﹄﹈﹐-﹗﹚﹜﹞-]/u;
const WRAP_OPEN = /[\u00A0\u2007\u2011\u2060\u202F\uFEFF(\[{«‹‘“（［｛｟「『【〔〖〘〚〈《〝｢＄￡￥︗︵︷︹︻︽︿﹁﹃﹇﹙﹛﹝]$/u;
function wrapUnits(str) {
  const units = [];
  let after = false;                            // whether the word before held a Chinese or Japanese character
  for (const word of String(str).split(/[ \t\n]+/).filter(Boolean)) {
    const pieces = [];
    let run = '', cjk = false;
    for (const ch of word) {
      const now = WRAP_CJK.test(ch);
      if ((now || cjk) && run) { pieces.push(run); run = ''; }
      run += ch; cjk = now;
    }
    if (run) pieces.push(run);
    // Inside a word a mark joins its neighbour; across a space only where the word on either side of the space holds
    // Chinese or Japanese, the space kept (text with no such word, Latin, breaks at its spaces, as before).
    const near = after || WRAP_CJK.test(word);
    pieces.forEach((piece, i) => {
      // The unit before ends with the piece before (joined to it or not); an opening mark is read past the marks that
      // combine with it, such as a variation selector.
      const last = units[units.length - 1], before = last ? last.text : '';
      if (last && (i || near) && (WRAP_CLOSE.test(piece) || WRAP_OPEN.test(before.replace(/\p{M}+$/u, '')))) last.text += (i ? '' : ' ') + piece;
      else units.push({ text: piece, space: !i });
    });
    after = WRAP_CJK.test(word);
  }
  return units;
}
`,
  },
];

// The glyph check's two fonts (RUNTIME, GLYPH_PROBES), AwwO's own, made here: each a TrueType font with one blank glyph,
// this many thousandths of an em wide, that every code point but the surrogates maps to.
export const GLYPH_PROBE_ADVANCES = [100, 700];

/** The bytes of one glyph probe: a TrueType font whose one blank glyph (and .notdef), `advance` units of 1000 to the em
 *  wide, every code point but the surrogates maps to (a cmap format 13 table), so a character a family lacks measures
 *  that width after it. Deterministic: no dates, no names but "AwwO glyph probe" and "Regular", no outlines. */
export function probeFont(advance) {
  const u16 = 'UInt16BE', i16 = 'Int16BE', u32 = 'UInt32BE';
  const struct = (size, fields) => {
    const bytes = Buffer.alloc(size);
    for (const [at, type, value] of fields) bytes['write' + type](value, at);
    return bytes;
  };
  const groups = [[0x0000, 0xD7FF], [0xE000, 0x10FFFF]];
  const names = [[1, 'AwwO glyph probe'], [2, 'Regular']].map(([id, text]) => [id, Buffer.from(text, 'utf16le').swap16()]);
  const tables = {
    // Version 4: weight 400, width 5, regular, ascent 800 and descent 200 (typo and win), break character the space.
    'OS/2': Buffer.concat([struct(58, [[0, u16, 4], [2, i16, advance], [4, u16, 400], [6, u16, 5], [26, i16, 50], [28, i16, 300]]),
      Buffer.from('NONE', 'latin1'),
      struct(34, [[0, u16, 0x40], [2, u16, 0], [4, u16, 0xFFFF], [6, i16, 800], [8, i16, -200], [12, u16, 800], [14, u16, 200], [30, u16, 32]])]),
    // One subtable, Windows full Unicode, format 13: each group maps its whole range to glyph 1.
    cmap: Buffer.concat([struct(28, [[2, u16, 1], [4, u16, 3], [6, u16, 10], [8, u32, 12], [12, u16, 13], [16, u32, 16 + 12 * groups.length], [24, u32, groups.length]]),
      ...groups.map(([from, to]) => struct(12, [[0, u32, from], [4, u32, to], [8, u32, 1]]))]),
    glyf: Buffer.alloc(1),
    // checkSumAdjustment (at 8) is set once the font is whole; 1000 units to the em, short loca offsets.
    head: struct(54, [[0, u32, 0x10000], [4, u32, 0x10000], [12, u32, 0x5F0F3CF5], [16, u16, 0x000B], [18, u16, 1000], [46, u16, 8], [48, i16, 2]]),
    hhea: struct(36, [[0, u32, 0x10000], [4, i16, 800], [6, i16, -200], [10, u16, advance], [18, i16, 1], [34, u16, 1]]),
    hmtx: struct(6, [[0, u16, advance]]),
    loca: Buffer.alloc(6),
    maxp: struct(32, [[0, u32, 0x10000], [4, u16, 2], [14, u16, 2]]),
    name: Buffer.concat([struct(6 + 12 * names.length, [[2, u16, names.length], [4, u16, 6 + 12 * names.length],
      ...names.flatMap(([id, text], i) => [[6 + 12 * i, u16, 3], [8 + 12 * i, u16, 1], [10 + 12 * i, u16, 0x409], [12 + 12 * i, u16, id],
        [14 + 12 * i, u16, text.length], [16 + 12 * i, u16, names.slice(0, i).reduce((n, [, t]) => n + t.length, 0)]])]),
      ...names.map(([, text]) => text)]),
    post: struct(32, [[0, u32, 0x30000], [8, i16, -100], [10, i16, 50]]),
  };
  const tags = Object.keys(tables).sort();
  const pad = (bytes) => Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  const sum = (bytes) => { const p = pad(bytes); let s = 0; for (let i = 0; i < p.length; i += 4) s = (s + p.readUInt32BE(i)) >>> 0; return s; };
  const power = 2 ** Math.floor(Math.log2(tags.length));
  const directory = struct(12 + 16 * tags.length, [[0, u32, 0x10000], [4, u16, tags.length], [6, u16, power * 16], [8, u16, Math.log2(power)],
    [10, u16, (tags.length - power) * 16]]);
  let offset = directory.length, headAt = 0;
  tags.forEach((tag, i) => {
    directory.write(tag, 12 + 16 * i, 'latin1');
    directory.writeUInt32BE(sum(tables[tag]), 16 + 16 * i);
    directory.writeUInt32BE(offset, 20 + 16 * i);
    directory.writeUInt32BE(tables[tag].length, 24 + 16 * i);
    if (tag === 'head') headAt = offset;
    offset += pad(tables[tag]).length;
  });
  const font = Buffer.concat([directory, ...tags.map((tag) => pad(tables[tag]))]);
  font.writeUInt32BE((0xB1B0AFBA - sum(font)) >>> 0, headAt + 8);
  return font;
}

// What must not survive the edits: names of the parts cut out, the URL parameters and the capture globals.
const GONE = /\b(?:CAPTIONS|CAPTION_STYLE|FORMULAS|FORMULA|OWN_MUSIC|INSTRUMENTS|MODEL_SHEET|modelSheet|loadFormulas|kineticCaptions|captionPunch|loadSamples|BANK|loadAudio|captureFrame|LOOK_ID)\b|\bq\.get\(|window\.(?:renderFrame|READY|renderAudio)\b/;

// AwwO's part: the film a page describes (Film.run), the renderer's contract and the preview player. AwwO's own code.
const RUNTIME = String.raw`
// ============================== AwwO: the film, the renderer's contract, the preview ==============================
// The film a page describes with Film.run({...}). The engine above reads these by name, as it read cinecode's FILM
// section; nothing else sets them.
let TITLE = 'Untitled', PURPOSE = 'cinematic', LOOK = LOOKS['cinematic-realistic'], FINISH = { shutter: null, weave: 0, tone: null };
let FPS = 24, DURATION = 8, BPM = 96, BEAT0 = 0, PALETTE = { ...LOOK.palette }, CUES = {}, VO = [], SCENES = [], SFX = [];
let TYPE = { lang: 'en', roles: { display: null, text: null, mono: null } }, ROOM = { secs: 2.2, decay: 3.2, tone: 5000 };
let ARRANGEMENT = [], CAST = {}, score = () => {};
const beat = (n) => BEAT0 + n * 60 / BPM, bar = (n) => beat(4 * n);

// AwwO's brand fonts, the families its running previews supply by name (apps/web/src/canvas/previewFontList.ts), as
// the Fontsource 5.3.0 packages on jsDelivr: their Latin subsets, and for Noto Sans SC, the face a film's Chinese words
// have, two of Google Fonts' subsets of its one bold cut: the simplified Chinese one (7,333 Han characters, with ASCII,
// Latin-1 and CJK punctuation) and the latin-ext one (4 KB), which has the rest of pinyin's letters (ā ǎ ǜ …). A TYPE
// role may name one by family alone. AwwO's render worker answers the URLs these name from its own
// copies (apps/render-worker/fonts.mjs), so a render of a role that names a brand family alone needs no network (one
// that sets other subsets or another version names other files, which it fetches); a downloaded page loads them from
// jsDelivr.
const BRAND_FONTS = {
  'Inter': { pkg: 'inter', variable: 'wght', axes: { wght: [100, 900] }, styles: ['normal', 'italic'] },
  'Space Grotesk': { pkg: 'space-grotesk', variable: 'wght', axes: { wght: [300, 700] } },
  'Manrope': { pkg: 'manrope', variable: 'wght', axes: { wght: [200, 800] } },
  'Outfit': { pkg: 'outfit', variable: 'wght', axes: { wght: [100, 900] } },
  'Montserrat': { pkg: 'montserrat', variable: 'wght', axes: { wght: [100, 900] }, styles: ['normal', 'italic'] },
  'Unbounded': { pkg: 'unbounded', variable: 'wght', axes: { wght: [200, 900] } },
  'Orbitron': { pkg: 'orbitron', variable: 'wght', axes: { wght: [400, 900] } },
  'Exo 2': { pkg: 'exo-2', variable: 'wght', axes: { wght: [100, 900] }, styles: ['normal', 'italic'] },
  'Oxanium': { pkg: 'oxanium', variable: 'wght', axes: { wght: [200, 800] } },
  'Rajdhani': { pkg: 'rajdhani', weights: [400, 500, 600, 700] },
  'Bebas Neue': { pkg: 'bebas-neue', weights: [400] },
  'Playfair Display': { pkg: 'playfair-display', variable: 'wght', axes: { wght: [400, 900] }, styles: ['normal', 'italic'] },
  'Instrument Serif': { pkg: 'instrument-serif', weights: [400], styles: ['normal', 'italic'] },
  'Cinzel': { pkg: 'cinzel', variable: 'wght', axes: { wght: [400, 900] } },
  'JetBrains Mono': { pkg: 'jetbrains-mono', variable: 'wght', axes: { wght: [100, 800] }, styles: ['normal', 'italic'] },
  'Press Start 2P': { pkg: 'press-start-2p', weights: [400] },
  'Pixelify Sans': { pkg: 'pixelify-sans', variable: 'wght', axes: { wght: [400, 700] } },
  'Noto Sans SC': { pkg: 'noto-sans-sc', weights: [700], subsets: ['chinese-simplified', 'latin-ext'] },
};

/** A TYPE role as the engine reads it: a brand family by name, a full Fontsource role, or any other family as written
 *  (a system font, never fetched). */
function filmRole(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const brand = BRAND_FONTS[value];
    return brand ? { family: value, version: '5.3.0', subsets: ['latin'], ...brand } : { family: value };
  }
  if (typeof value === 'object' && value.family) {
    const brand = !value.pkg && !value.files ? BRAND_FONTS[value.family] : null;
    return brand ? { version: '5.3.0', subsets: ['latin'], ...brand, ...value } : { ...value };
  }
  return null;
}

// The roles whose faces are still loading, with what is known of each (loadFilmType). The type a renderer's first frame
// finds is the type the whole film keeps, as far as the kit's own faces go: one that comes after that frame is not
// used, and the renderer is told (renderAt). A page's own @font-face of a role's family (which the film guide does not
// ask for) is the page's: the kit cannot refuse one, so a face of the page's that arrives late can still change it.
const typeLoading = new Map();
// The FontFace objects the kit made: the document's other faces are the page's own.
const kitFaces = new WeakSet();

/** Loads every role's faces, the roles together. A face that cannot load (a preview reaches no network) is fine when
 *  the page has the family itself: AwwO's previews supply its brand fonts by name (and AwwO's render worker answers
 *  their URLs, so in a render they load). A role whose faces an AwwO preview wrote into the page and started gets none
 *  of the kit's (pageHolds), which would be the same type fetched again, unless one of the page's fails before the first
 *  frame. A face that loads only after a renderer has drawn its first frame is not used, so a film keeps one type from
 *  its first frame to its last. Returns each role that lacks a face the page does not make up for, in role order, as
 *  { name, state, used } (used[i]: whether state.faces[i] is in use). */
async function loadFilmType(T) {
  // Whether the page has faces of the family itself, as the browser picks them for the role's first weight upright:
  // asked, as before, only once the kit's own faces are not all used, since asking starts loading them, and a face in
  // flight while the page loads holds up its load event, which a render waits for; and never once a frame is drawn,
  // when one that came would change the film's type. The kit's own faces do not count.
  const supplied = async (r) => {
    if (rendering) return false;
    try {
      return (await document.fonts.load((r.weights?.[0] ?? 400) + ' 40px "' + r.family + '"')).some((face) => !kitFaces.has(face));
    } catch (e) { return false; }
  };
  const remote = remoteFontsAllowed(), held = remote ? heldFaces() : null;
  const outcomes = await Promise.all(Object.entries(T.roles || {}).map(async ([name, r]) => {
    if (!r || (!r.pkg && !r.files)) return null;
    const page = remote ? pageHolds(r, held) : null;
    const state = { family: r.family, faces: remote && !page ? roleFaces(r) : [], used: [], late: [], settled: [] };
    typeLoading.set(name, state);
    try {
      // The faces a preview wrote in and started: waited for (the kit starts none of them). One that fails, and the
      // kit's own are fetched after all, unless a frame is drawn by then.
      if (page) {
        if ((await Promise.all(page.map((face) => face.loaded.then(() => true, () => false)))).every(Boolean)) return null;
        if (!rendering) state.faces = roleFaces(r);
      }
      const used = await Promise.all(state.faces.map(([family, url, desc], i) => kitFace(family, 'url(' + url + ')', desc).then((face) => {
        state.settled[i] = true;
        if (rendering) { state.late[i] = true; return false; }
        document.fonts.add(face); state.used[i] = true; return true;
      }, () => { state.settled[i] = true; return false; })));
      if (used.length && used.every(Boolean)) return null;
      if (await supplied(r)) return null;
      // A role with no face of the kit's own, reached once a frame is drawn: nothing of the kit's is missing, and the
      // page's faces cannot be asked about then without starting them, so nothing is said (nor checked for glyphs).
      if (!state.faces.length && rendering) return { name, state, used };
      // Said as soon as it is known, not once every role has settled: a role still loading holds up no other's news.
      const late = state.late.some(Boolean) && used.every((ok, i) => ok || state.late[i]);
      typeTrouble([{ name, words: roleLack(name, state, used) }], late ? 'fonts loaded only after the first frame, not used in this film: ' : 'fonts not loaded: ');
      return { name, state, used };
    } finally {
      typeLoading.delete(name);
    }
  }));
  return outcomes.filter(Boolean);
}

/** One face of the kit's own, made and loaded (it resolves with the face): under its family's name as written, and once
 *  more with that name quoted only where the browser took it for no name at all. Firefox reads a FontFace's family as
 *  CSS, where a word that starts with a digit ("Exo 2", "Press Start 2P") or a stop's name ("Fraunces~SOFT50") names no
 *  family: the face is made in error and its load() rejects with a SyntaxError, so the film drew in another font. As a
 *  CSS string (the JSON form of the name, for any name a font has) it is taken as written. Never quoted up front:
 *  Chrome keeps the quotes as part of the name. */
function kitFace(family, source, desc) {
  const load = (name) => { const face = new FontFace(name, source, desc); kitFaces.add(face); return face.load().then(() => face); };
  return load(family).catch((e) => {
    if (!e || e.name !== 'SyntaxError') throw e;
    return load(JSON.stringify(family));
  });
}

/** What of the kit's own fonts a role lacks, in words for a renderer (what draws instead is the browser's choice: a cut
 *  it makes from the ones that loaded, a local font of that name, a page's own face, or the fallback): 'text "Roboto"'
 *  when none of its faces is in use, else the cuts and character ranges it lacks, 'text "Inter" italic', 'display
 *  "Rajdhani" 600 and 700', 'text "Inter" latin-ext'. A cut is named by its style and its weight (not a variable font's
 *  range), or by its family when the role makes faces under other names for axis stops. */
function roleLack(name, state, used) {
  const head = name + ' "' + state.family + '"';
  if (!used.some(Boolean)) return head;
  const rangeOf = ([, , desc]) => desc.unicodeRange || '';
  const cut = ([family, , desc]) => [family === state.family ? '' : '"' + family + '"', desc.style === 'italic' ? 'italic' : '',
    String(desc.weight).includes(' ') ? '' : String(desc.weight)].filter(Boolean).join(' ') || 'regular';
  const parts = [];
  for (const range of new Set(state.faces.map(rangeOf))) {
    const faces = state.faces.map((face, i) => [face, i]).filter(([face]) => rangeOf(face) === range);
    const missing = faces.filter(([, i]) => !used[i]);
    if (!missing.length) continue;
    const subset = range ? (Object.keys(TYPE_SUBSETS).find((key) => TYPE_SUBSETS[key] === range) || 'some characters') : '';
    parts.push(missing.length === faces.length ? subset || 'some characters'
      : [subset, [...new Set(missing.map(([face]) => cut(face)))].join(' and ')].filter(Boolean).join(' '));
  }
  return head + ' ' + parts.join(' and ');
}

// What the film's type lacks, for a renderer: each role, named once, said with the next frame it draws (renderAt),
// since its console is read by no one.
const typeNamed = new Set();
let typeNews = [];
function typeTrouble(lacks, why) {
  for (const lack of lacks) if (!typeNamed.has(lack.name)) { typeNamed.add(lack.name); typeNews.push({ name: lack.name, words: lack.words, why }); }
}

/** The news of the film's type not yet told, in words, and told: each reason once, with its roles in role order. */
function typeTold() {
  const order = Object.keys(TYPE.roles || {});
  const told = [...new Set(typeNews.map((news) => news.why))].map((why) => why + typeNews.filter((news) => news.why === why)
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)).map((news) => news.words).join(', '));
  typeNews = [];
  return told;
}

/** Whether the document's own policy lets it fetch the brand fonts: AwwO's preview allows no font but data (it
 *  supplies the brand fonts it sees a page name), so there the kit fetches none and uses the faces it has; a render's
 *  page states no such policy and loads every role's own faces, as cinecode does. */
function remoteFontsAllowed() {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
  const policy = (meta && meta.getAttribute('content')) || '';
  if (!policy) return true;
  const directive = (name) => { const m = new RegExp('(?:^|;)\\s*' + name + '\\s+([^;]*)', 'i').exec(policy); return m ? m[1] : null; };
  const sources = directive('font-src') ?? directive('default-src');
  return sources === null || /(?:^|\s)(?:\*|https?:\S*)(?:\s|$)/i.test(sources);
}

/** The brand faces AwwO's running previews wrote into the page, by family (in lower case, as CSS matches names): the
 *  @font-face rules of the style element they mark (data-awwo-fonts, previewFontList.ts PREVIEW_FONTS_ATTRIBUTE), each
 *  from one data: source and no other, counted by cut ("normal 700"), with the document's FontFace objects of the
 *  family. A family the document has any other face of is left out (a rule of the page's own, one this does not read,
 *  in @media or an imported sheet, or a face a script made), and every family is when a style sheet cannot be read (one
 *  from elsewhere). Null where the page cannot be asked. Reading the rules, and listing the document's faces, starts no
 *  font. */
function heldFaces() {
  try {
    const name = (family) => String(family || '').trim().replace(/^(["'])(.*)\1$/, '$2').toLowerCase();
    const held = new Map(), other = new Set();
    for (const sheet of Array.from(document.styleSheets || [])) {
      const node = sheet.ownerNode, awwo = !!(node && node.hasAttribute && node.hasAttribute('data-awwo-fonts'));
      for (const rule of Array.from(sheet.cssRules)) {   // throws for a sheet from elsewhere: then nothing is known
        if (rule.type !== 5) continue;                   // CSSRule.FONT_FACE_RULE
        const style = rule.style, family = name(style.getPropertyValue('font-family'));
        if (!awwo || !ONE_DATA_SOURCE.test(style.getPropertyValue('src').trim())) { other.add(family); continue; }
        const entry = held.get(family) || { cuts: new Map(), faces: [] };
        const cut = (style.getPropertyValue('font-style') || 'normal') + ' ' + (style.getPropertyValue('font-weight') || '400');
        entry.cuts.set(cut, (entry.cuts.get(cut) || 0) + 1);
        held.set(family, entry);
      }
    }
    if (!held.size) return held;
    document.fonts.forEach((face) => { const entry = !kitFaces.has(face) && held.get(name(face.family)); if (entry) entry.faces.push(face); });
    for (const [family, entry] of held) {
      if (other.has(family) || entry.faces.length !== [...entry.cuts.values()].reduce((a, b) => a + b, 0)) held.delete(family);
    }
    return held;
  } catch (e) {
    return null;
  }
}

// One source, a data: URL with at most its format, as a preview writes a face (previewFonts.ts). A list with a fallback
// (another URL, a local font) could start a request the kit would not have made.
const ONE_DATA_SOURCE = /^url\(\s*(["']?)data:[^"'()\s]*\1\s*\)(?:\s*format\(\s*["']?[\w-]+["']?\s*\))?$/i;

/** The page's own faces of a role's family where an AwwO preview wrote them in and started them (heldFaces): for a
 *  role that names its brand family alone (asks for no other face), when the preview gave the family a face for each
 *  one the kit would make, by cut, and each is loading or loaded already. The kit then fetches none of its own for the
 *  role and waits for these, starting none (the studio's live page, whose policy allows the CDN, had the kit fetch the
 *  same type again: Noto Sans SC's 1.17 MB, waited for before the film's first still). Null otherwise. */
function pageHolds(r, held) {
  const entry = held && BRAND_FONTS[r.family] ? held.get(r.family.toLowerCase()) : null;
  if (!entry || JSON.stringify(roleFaces(r)) !== JSON.stringify(roleFaces(filmRole(r.family)))) return null;
  const need = new Map();
  for (const [, , desc] of roleFaces(r)) need.set(desc.style + ' ' + desc.weight, (need.get(desc.style + ' ' + desc.weight) || 0) + 1);
  if (![...need].every(([cut, n]) => (entry.cuts.get(cut) || 0) >= n)) return null;
  return entry.faces.every((face) => face.status === 'loading' || face.status === 'loaded') ? entry.faces : null;
}

// The glyph check (typeCheck) measures each character in a role's family twice, followed each time by another font: a
// character the family draws measures the same both times, one it lacks takes the width of the font after it. The
// system's generic families cannot tell for Chinese: every font that has a Han character draws it an em wide, so a
// Latin family "has" 雨 after each of them. The kit follows the family with two fonts of its own instead, which draw
// every character as a blank 0.1 and 0.7 em wide (made by apps/web/scripts/build-film-kit.mjs, probeFont). They are
// made from bytes, so no font policy (a preview's font-src data:) refuses them, are in the document only while the
// check measures, and are no role's face. Their names are identifiers only: Firefox reads a FontFace's family as CSS,
// where a word that starts with a digit ("probe 1", as "Exo 2" or "Press Start 2P") is no family name, and the face's
// load() rejects.
const GLYPH_PROBES = GLYPH_PROBES_TOKEN;
const GLYPH_PROBE_NAMES = ['AwwO glyph probe a', 'AwwO glyph probe b'];
let probing = false;
const glyphFallbacks = () => (probing ? GLYPH_PROBE_NAMES.map((name) => '"' + name + '"') : ['monospace', 'serif', 'cursive']);

/** check(), run with the glyph probes in the document, or with the generic families where the probes cannot be made. */
async function withGlyphProbes(check) {
  const faces = [];
  try {
    for (let i = 0; i < GLYPH_PROBES.length; i++) {
      const face = new FontFace(GLYPH_PROBE_NAMES[i], Uint8Array.from(atob(GLYPH_PROBES[i]), (c) => c.charCodeAt(0)).buffer);
      kitFaces.add(face);
      faces.push(face);
    }
    await Promise.all(faces.map((face) => face.load()));
    for (const face of faces) document.fonts.add(face);
    probing = true;
  } catch (e) { /* the generic families measure instead */ }
  try {
    return check();
  } finally {
    probing = false;
    for (const face of faces) { try { document.fonts.delete(face); } catch (e) { /* never added */ } }
  }
}

// Emoji are drawn by the system's emoji font whatever a role's family is, so no choice of family makes them the film's:
// the glyph check measures none of them, as it always passed them. Whole sequences go first (pictographs joined by
// ZWJ, a skin tone with its base, a pictograph with its emoji selector), then default emoji, flags and tags, then any
// stray selector, joiner, keycap mark or skin tone. A pictograph written as text (❤ or ✌ alone) is measured like any
// character, and so is a keycap's digit. The film's strings themselves stay whole for typeCheck's other checks.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier_Base}][\u{FE0F}\p{Emoji_Modifier}]?(?:\u{200D}[\p{Extended_Pictographic}\p{Emoji_Modifier_Base}][\u{FE0F}\p{Emoji_Modifier}]?)+|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}|\p{Extended_Pictographic}\u{FE0F}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]|\p{Emoji_Modifier}/gu;

/** typeCheck of the roles in T, the probes made only when it has characters to measure (emoji aside): a role's own
 *  strings, and Turkish's for a film in Turkish, as typeCheck takes them. */
function checkType(T) {
  const listed = (T.check && T.check.strings) || {};
  const measured = (name) => [].concat(listed[name] || []).map((s) => String(s).replace(EMOJI, '')).join('').trim().length > 0;
  const measures = Object.keys(T.roles).some((name) => measured(name) || T.lang === 'tr' || T.lang == null);
  const check = () => typeCheck(g, T, W, H, PALETTE);
  return measures ? withGlyphProbes(check) : check();
}

/** What is wrong with the film as described, in words a page's author can act on. */
function filmErrors() {
  const errs = [], near = (a, b) => Math.abs(a - b) < 1e-3;
  if (!(DURATION > 0 && DURATION <= 300)) errs.push('duration must be between 0 and 300 seconds, not ' + DURATION);
  if (!Array.isArray(SCENES) || !SCENES.length) errs.push('scenes: give at least one { from, to, draw }');
  else {
    for (let i = 0; i < SCENES.length; i++) {
      const s = SCENES[i], n = i + 1;
      if (!s || typeof s.draw !== 'function') errs.push('scene ' + n + ': draw is not a function');
      if (!(s && s.to > s.from)) errs.push('scene ' + n + ': to must be after from');
      if (i === 0 && s && !near(s.from, 0)) errs.push('scene 1 must start at 0');
      const before = SCENES[i - 1];
      if (i > 0 && s && before && !near(before.to, s.from)) errs.push('scenes ' + i + ' and ' + n + (before.to > s.from ? ' overlap' : ' leave a gap'));
      const type = s && s.in && s.in.type;
      if (type && !['cut', 'smash', 'match'].includes(type) && !TRANSITION[type]) errs.push('scene ' + n + ': unknown transition ' + type);
      if (type && TRANSITION[type] && !(s.in.dur > 0)) errs.push('scene ' + n + ': a ' + type + ' needs in.dur in seconds');
    }
    const last = SCENES[SCENES.length - 1];
    if (last && !near(last.to, DURATION)) errs.push('the last scene must end at the duration (' + DURATION + ' s)');
  }
  for (const e of SFX) if (!['hit', 'whoosh', 'riser', 'tick', 'air', 'foley'].includes(e && e.voice)) errs.push('sfx: unknown voice ' + (e && e.voice));
  if (ARRANGEMENT.length) { try { checkArrangement(); } catch (e) { errs.push(String(e.message || e)); } }
  return errs;
}

let READY = null, booted = false, started = false, rendering = false, hud = null, failure = '', said = false, thrown = false, aspect = '', hintLang = 'en';
// Not ready until a film has booted and its type has loaded: the renderer waits for __ready, so a page that calls
// Film.run after an await still renders from its first frame.
window.__ready = false;
// A film longer than one render is cut into cards, each a copy of the page with <html data-offset="seconds">: a card
// draws film time OFFSET + t. Its sound is made once, for the whole film, from 0 (one page sound in the edit).
let OFFSET = 0, POSTER = 0;

/** A defect in the film as described, said once to a running preview (which reports it, and AwwO repairs the page). A
 *  render gets it as an error from its first frame instead (renderAt), which the renderer records. */
function report(message) {
  if (said) return;
  said = true;
  console.error(new Error('Film: ' + message));
}

function boot() {
  if (started) return;
  started = true;
  const vw = Math.max(64, Math.round(window.innerWidth || 1280)), vh = Math.max(64, Math.round(window.innerHeight || 720));
  let w = vw, h = vh;
  const m = /^(\d+(?:\.\d+)?)\s*[:x\/]\s*(\d+(?:\.\d+)?)$/.exec(String(aspect || ''));
  if (m && +m[1] > 0 && +m[2] > 0) { const r = +m[1] / +m[2]; if (vw / vh > r) w = Math.round(vh * r); else h = Math.round(vw / r); }
  W = w; H = h; S.W = W; S.H = H; S.u = Math.min(W, H);
  FRAMES = Math.max(1, Math.round(FPS * DURATION));
  OFFSET = Math.max(0, Number(document.documentElement.getAttribute('data-offset')) || 0);
  const style = document.createElement('style');
  style.textContent = 'html,body{margin:0;height:100%;background:#000;overflow:hidden}'
    + 'canvas.awwo-film{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:block}'
    // The hint sits on the picture (a preview frames a film at its own shape), so it has its own dark backing: light
    // grey on the film alone could not be read over a light look's floor.
    + '.awwo-film-hud{position:fixed;left:8px;bottom:8px;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.62);color:#eee;font:12px/1.4 ui-monospace,Menlo,monospace;pointer-events:none}';
  document.head.appendChild(style);
  canvas = document.createElement('canvas');
  canvas.className = 'awwo-film'; canvas.width = W; canvas.height = H;
  document.body.appendChild(canvas);
  // The film keeps the size it was made at (what a page built once at that size stays right for); a window that
  // changes later (a preview made larger or smaller, a downloaded page) shows it whole, scaled to fit.
  const fit = () => {
    const k = Math.min((window.innerWidth || W) / W, (window.innerHeight || H) / H);
    canvas.style.width = Math.round(W * k) + 'px'; canvas.style.height = Math.round(H * k) + 'px';
  };
  // A frame can learn its size only after the page has started (a preview's iframe is laid out after its document
  // parses, often with no resize event): the root element's own box says when it does.
  fit();
  addEventListener('resize', fit);
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(document.documentElement);
  g = canvas.getContext('2d', { alpha: false });
  bufA = buffer(); bufB = buffer(); bufSub = buffer(); bufOut = buffer();
  SAMPLES = Math.max(1, Math.round(+(FINISH.shutter?.samples ?? 1)) || 1);
  WEAVE = +FINISH.weave || 0; TONE = FINISH.tone || null;
  probe.width = 64; probe.height = Math.max(1, Math.round(64 * H / W));
  probeG = probe.getContext('2d', { willReadFrequently: true });
  installTone();
  let errs;
  try { errs = filmErrors(); } catch (e) { errs = [String((e && e.message) || e)]; }
  if (errs.length) failure = errs.join('; ');
  READY = (async () => {
    const notes = [];
    try {
      const missing = await loadFilmType(TYPE);
      if (missing.length) notes.push('fonts not loaded: ' + missing.map(({ name, state, used }) => roleLack(name, state, used)).join(', '));
      await document.fonts.ready;
      // Glyphs are checked only in the faces that loaded: a system family or a stand-in proves nothing about the film's.
      const absent = missing.filter(({ used }) => !used.some(Boolean)).map(({ name }) => name);
      const loaded = { ...TYPE, roles: Object.fromEntries(Object.entries(TYPE.roles || {}).filter(([name, r]) => r && (r.pkg || r.files) && !absent.includes(name))) };
      const qc = await checkType(loaded);
      for (const e of qc.errors) (/glyphs/.test(e) ? (failure = failure ? failure + '; ' + e : e) : notes.push(e));
      notes.push(...qc.warnings);
    } catch (e) {
      notes.push(String((e && e.message) || e));
    }
    for (const note of notes) console.warn('Film: ' + note);
    window.__ready = true;
    if (failure && !rendering) report(failure);
  })();
  startPreview();
  // A film that boots after the renderer asked for a frame draws that frame now rather than leave it black; whatever
  // stops it is said by the renderer's next frame.
  if (rendering && pending !== null) { const t = pending; pending = null; try { frameAt(t); } catch (e) { /* said next frame */ } }
}

/** The film a page describes, once: { title, purpose, look, palette, type, fps, duration, bpm, beat0, cues, scenes,
 *  sfx, room, arrangement, score, cast, vo, finish, seed, aspect }. */
function run(spec) {
  if (booted) throw new Error('Film.run: a page describes its film once');
  booted = true;
  const f = spec || {};
  TITLE = String(f.title ?? 'Untitled');
  PURPOSE = f.purpose === 'ad' ? 'ad' : 'cinematic';
  const base = LOOKS[f.look] || (f.look && typeof f.look === 'object' && LOOKS[f.look.base]) || LOOKS['cinematic-realistic'];
  LOOK = f.look && typeof f.look === 'object' ? { ...base, ...f.look, palette: { ...base.palette, ...(f.look.palette || {}) } } : base;
  FINISH = { shutter: null, weave: 0, tone: null, ...(f.finish || {}) };
  FPS = f.fps > 0 ? +f.fps : 24;
  DURATION = +f.duration > 0 ? +f.duration : 8;
  BPM = +f.bpm > 0 ? +f.bpm : 96;
  BEAT0 = +f.beat0 || 0;
  PALETTE = { ...LOOK.palette, ...(f.palette || {}) };
  const roles = (f.type && f.type.roles) || {};
  TYPE = { lang: 'en', ...(f.type || {}), roles: { display: filmRole(roles.display), text: filmRole(roles.text), mono: filmRole(roles.mono) } };
  // The play hint's language: the film's own (type.lang), else the page's (its html lang).
  hintLang = String((f.type && f.type.lang) || (document.documentElement && document.documentElement.getAttribute('lang')) || 'en');
  CUES = f.cues || {}; VO = Array.isArray(f.vo) ? f.vo : []; SCENES = Array.isArray(f.scenes) ? f.scenes : [];
  SFX = Array.isArray(f.sfx) ? f.sfx : []; ROOM = { ...ROOM, ...(f.room || {}) };
  ARRANGEMENT = Array.isArray(f.arrangement) ? f.arrangement : []; CAST = f.cast || {};
  score = typeof f.score === 'function' ? f.score : () => {};
  SEED = Number.isFinite(+f.seed) && f.seed !== null && f.seed !== undefined ? +f.seed : 7;
  aspect = f.aspect || '';
  POSTER = Number.isFinite(+f.poster) && f.poster !== null && f.poster !== undefined ? Math.min(Math.max(0, +f.poster), DURATION) : DURATION * 0.4;
  window.__ready = false;
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
}

// The renderer's contract (apps/render-worker/README.md): every frame is drawn for its t from scratch; the preview
// player stops for good on the first call, so it never draws over a frame the renderer is about to take.
let unrun = false, pending = null;
const frameAt = (t) => { const time = OFFSET + Math.max(0, Number(t) || 0); renderFrame(Math.floor(time * FPS + 1e-6), time); };
window.renderAt = (t) => {
  if (!rendering) {
    rendering = true;
    if (hud) hud.remove();
    // A face of the kit's still loading now would change the film's type mid-film when it came: it is left out
    // (loadFilmType). A role whose own faces have all settled waits only on the page's (its own failed); one with no
    // face of the kit's own waits on the page's, which the kit cannot refuse.
    const loading = [...typeLoading].map(([name, state]) => [state.faces.some((face, i) => !state.settled[i]) ? 'fonts still loading at the first frame, not used in this film: '
      : state.faces.length ? 'fonts not loaded: ' : 'fonts still loading at the first frame: ', { name, words: roleLack(name, state, state.faces.map((face, i) => state.used[i] === true)) }]);
    for (const why of new Set(loading.map(([reason]) => reason))) typeTrouble(loading.filter(([reason]) => reason === why).map(([, lack]) => lack), why);
  }
  if (!canvas) {
    // A film that starts later still (Film.run after a timer, a frame or a long await) draws this frame as it boots.
    pending = t;
    if (!booted && !unrun) {
      unrun = true;
      throw new Error('Film: Film.run had not been called when the renderer drew its first frame; call it at the end of the page script, not from a timer, an animation frame or an await');
    }
    return;
  }
  pending = null;
  // What is wrong with the film is said first (even when it is also why its frame cannot be drawn), then what its type
  // lacks; the frame is drawn before either is said, so the render goes on with it.
  let threw = false, error;
  try { frameAt(t); } catch (e) { threw = true; error = e; }
  const news = [];
  if (failure && !thrown) { thrown = true; news.push(failure); }
  if (typeNews.length) news.push(...typeTold());
  if (news.length) {
    throw new Error('Film: ' + news.join('; ') + (threw ? ' (the frame could not be drawn: ' + String((error && error.message) || error) + ')' : ''));
  }
  if (threw) throw error;
};

// The film's sound, rendered offline in one pass: ambience per scene, the picture-locked effects, the score, all in
// one room. AwwO keeps it as 16-bit, so the peak is brought to -1 dBFS at most rather than clipped.
window.renderAudio = async (o = {}) => {
  if (!booted) throw new Error('Film: the page never called Film.run');
  const rate = Math.min(48000, Math.max(8000, Math.round(Number(o && o.sampleRate) || SR)));
  const seconds = Math.max(DURATION, Number(o && o.seconds) || 0);
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(seconds * rate)), rate);
  const bus = ctx.createGain(); duck(bus.gain, 0.8, VO);
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 8; lim.attack.value = 0.003; lim.release.value = 0.15;
  bus.connect(lim).connect(ctx.destination);
  ROOM_IN = makeRoom(ctx, bus);
  SCENES.forEach((s, i) => { if (s && s.amb) ambience(ctx, wet(ctx, bus, 0.15), s.from, s.to, s.amb.kind, s.amb.gain, 300 + i); });
  for (const e of SFX) sfx(ctx, bus, e);
  score(ctx, bus);
  const buf = await ctx.startRendering();
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
  if (peak > 0.891) { const k = 0.891 / peak; for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; } }
  // The last 60 ms fade to nothing, so a film that ends while its sound still plays ends without a click.
  const tail = Math.min(buf.length, Math.round(0.06 * rate));
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < tail; i++) d[buf.length - 1 - i] *= i / tail; }
  return buf;
};

// The line a running preview shows until the film plays: in the film's own language (its type.lang, else the page's),
// and never its title, which can be the film's closing words (a check of 2026-11-09 saw「雨停了」 under the frame from
// the first one). Chinese in traditional characters where the language says so (zh-Hant, zh-TW, zh-HK, zh-MO).
const PLAY_HINT = { zh: '点击播放（有声音）', 'zh-Hant': '點擊播放（有聲音）', en: 'click to play with sound' };
const playHint = () => {
  const lang = hintLang.trim().toLowerCase();
  if (!/^zh(?:[-_]|$)/.test(lang)) return PLAY_HINT.en;
  return /^zh[-_](?:hant|tw|hk|mo)(?:[-_]|$)/.test(lang) ? PLAY_HINT['zh-Hant'] : PLAY_HINT.zh;
};

// A running preview shows one still of the film (its poster) and plays it, picture and sound together, on a click;
// nothing plays by itself. Space plays or pauses, the arrows step a frame. Nothing here runs once the renderer has
// called renderAt, and it draws only while the film plays or after a step. Its hint is hidden while the film plays.
function startPreview() {
  if (rendering) return;   // a film that boots after the renderer's first frame is the renderer's alone
  hud = document.createElement('div');
  hud.className = 'awwo-film-hud';
  hud.textContent = playHint();
  document.body.appendChild(hud);
  const hint = (on) => { if (hud) hud.hidden = !on; };
  // The number in run names the current play: a pause, the end or a later play leaves an older one's wait for its sound moot, so
  // only one sound and one frame loop ever run. The sound is made once, however often a click comes while it is made.
  let audio = null, source = null, making = null, playing = false, live = false, run = 0;
  let from = 0, t0 = 0, clock = 0, held = POSTER;
  const show = (t) => { if (!rendering) renderFrame(Math.floor(t * FPS + 1e-6), t); };
  // A still drawn while the film is stopped (a pause, a step, the end, the type loading): a scene that throws there
  // leaves the next play to start from the beginning, and the error goes on to be reported.
  const still = (t) => { try { show(t); } catch (e) { held = POSTER; throw e; } };
  // Until its picture starts (its sound may still be in the making) a play stands where it will start.
  const now = () => (!live ? from : source ? audio.currentTime - t0 + from : (performance.now() - clock) / 1000 + from);
  // Whatever stops a play (a pause, the end, a scene that throws) shows the hint again, before anything is drawn.
  const stop = () => {
    run += 1; playing = false; live = false;
    if (source) { source.onended = null; try { source.stop(); } catch (e) { /* already ended */ } source = null; }
    hint(true);
  };
  const tick = (id) => {
    if (id !== run || rendering) return;
    const t = now();
    if (t >= DURATION) { stop(); held = POSTER; still(held); return; }
    // A scene that throws ends the play (a later click starts again from the beginning) and the error is reported.
    try { show(t); } catch (e) { stop(); held = POSTER; throw e; }
    requestAnimationFrame(() => tick(id));
  };
  const play = async () => {
    if (rendering || playing) return;
    playing = true;
    hint(false);
    const id = ++run;
    from = held >= DURATION - 1 / FPS || held === POSTER ? 0 : held;
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume().catch(() => {});
      making = making || window.renderAudio({ seconds: DURATION, sampleRate: audio.sampleRate });
      const sound = await making;
      if (id !== run || rendering) return;
      source = audio.createBufferSource(); source.buffer = sound; source.connect(audio.destination);
      t0 = audio.currentTime; source.start(0, from);
    } catch (e) {
      if (id !== run || rendering) return;
      source = null;   // no sound here: the picture plays on its own
      console.warn('Film: the sound cannot play here (' + ((e && e.message) || e) + ')');
    }
    clock = performance.now(); live = true;
    requestAnimationFrame(() => tick(id));
  };
  const pause = () => { held = Math.min(DURATION - 1e-3, now()); stop(); still(held); };
  addEventListener('click', () => { if (playing) pause(); else play(); });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); if (playing) pause(); else play(); }
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      if (playing) pause();
      held = Math.min(DURATION - 1e-3, Math.max(0, held + (e.code === 'ArrowRight' ? 1 : -1) / FPS));
      still(held);
    }
  });
  // The still, once the film's type has loaded; a film already playing by then draws its own frames.
  READY.then(() => { if (!failure && !playing) still(held); });
}

// The film's own type by role, for a page that sets type itself: font() is a ctx.font string, setFont() sets it with the
// tracking for its size (cinecode's typeFont and setType, bound to the film's TYPE).
const font = (role, px, o = {}) => typeFont(TYPE, role, px, o);
const setFont = (g, role, px, o = {}) => setType(g, TYPE, role, px, o);

const API = {
  run, version: KIT_VERSION_TOKEN, commit: KIT_COMMIT_TOKEN, LOOKS, BRAND_FONTS: Object.freeze(Object.keys(BRAND_FONTS)),
  EASE, MOTION, CAM, VIEW, retime, plane, TRANSITION, poly, morphShape, fillShape, lightSweep, dot, circle, text, label, lazy,
  flash, grain, shade, inkLine, vignette, rng, hash1, noise1, clamp, lerp, TAU, character, EMOTIONS, font, setFont, wrap,
  headroom, typeReveal, breathe, up, low, pad, kick, tick, hit, riser, whoosh, air, pluck, lead, foley, ambience, wet, spans,
  beats, hz, chord, chordAt, grid, snare, hat, clap, sub808, bass, stab,
};
window.Film = Object.freeze(API);
`;

export function buildFilmKit(kitDir = KIT_DIR) {
  const html = readFileSync(join(kitDir, 'templates', 'quick', 'film.html'), 'utf8');
  if (html.includes('\r')) throw new Error('film kit: film.html must have LF line endings, as upstream');
  const open = html.indexOf('\n<script>\n'), close = html.lastIndexOf('\n</script>\n');
  if (open < 0 || close < 0 || html.indexOf('<script') !== html.lastIndexOf('<script')) throw new Error('film kit: film.html must hold one inline script');
  const lines = html.slice(open + '\n<script>\n'.length, close + 1).split('\n');
  const film = lineIndex(lines, FILM_BANNER), picture = lineIndex(lines, PICTURE_BANNER);
  // The eight look families are the FILM section's starting data; the kit offers them by id.
  const looksStart = lineIndex(lines, 'const LOOKS = {', film);
  if (looksStart > picture) throw new Error('film kit: LOOKS must be in the FILM section');
  let looksEnd = looksStart;
  while (looksEnd < picture && lines[looksEnd] !== '};') looksEnd++;
  if (looksEnd === picture) throw new Error('film kit: LOOKS has no end');
  const looks = lines.slice(looksStart, looksEnd + 1).join('\n');
  let engine = lines.slice(picture);
  for (const cut of CUTS) {
    const from = lineIndex(engine, cut.from, 0, cut.why);
    const to = cut.to === null ? engine.length : lineIndex(engine, cut.to, from + 1, cut.why);
    engine = [...engine.slice(0, from), ...engine.slice(to)];
  }
  let text = engine.join('\n').trimEnd() + '\n';
  for (const edit of EDITS) text = replaceOnce(text, edit.find, edit.replace, edit.why);
  const leftover = text.match(GONE);
  if (leftover) throw new Error(`film kit: "${leftover[0]}" survived the edits`);
  const runtime = RUNTIME.replace('KIT_VERSION_TOKEN', JSON.stringify(KIT_VERSION)).replace('KIT_COMMIT_TOKEN', JSON.stringify(KIT_COMMIT))
    .replace('GLYPH_PROBES_TOKEN', JSON.stringify(GLYPH_PROBE_ADVANCES.map((advance) => probeFont(advance).toString('base64'))));
  const license = readFileSync(join(kitDir, 'LICENSE'), 'utf8').trimEnd().split('\n').map((line) => (line ? ` * ${line}` : ' *')).join('\n');
  const body = `${looks}\n\n${text}${runtime}`
    // Inlined into an HTML <script>: nothing in it may close the element or open a comment there. In JavaScript source
    // `<\/` and `<\!` read the same as `</` and `<!` inside strings, templates and regular expressions alike.
    .replace(/<\/script/gi, (match) => `<\\/${match.slice(2)}`).replace(/<!--/g, '<\\!--');
  return `/*! AwwO film kit ${KIT_VERSION}: the frame engine of cinecode's one-file film (https://github.com/sarpstar/cinecode, commit ${KIT_COMMIT},
 * templates/quick/film.html) as one classic script that defines window.Film: looks, a 2.5D camera, depth planes,
 * transitions, type, stylised characters and a whole soundtrack rendered offline with Web Audio. AwwO's changes: a page
 * describes its film with Film.run({...}) instead of editing a FILM section; the frame comes from AwwO's renderer
 * (renderAt, __ready, renderAudio) and the picture takes the page's size; casing follows the film's language; the glyph
 * check measures after two blank fonts of AwwO's own; and the parts that need cinecode's own tools are left out (local
 * files, recorded instruments, formulas, speech captions).
 * Generated by apps/web/scripts/build-film-kit.mjs from third_party/cinecode; do not edit by hand.
 *
${license}
 */
(function () {
"use strict";
// One kit a page: a second copy of the tag (after the page's Film.run) must not replace the renderer's entry points
// with ones that never booted.
try { if (window.Film && typeof window.Film.run === 'function') return; } catch (e) { /* another origin's frame named Film */ }
${body.trimEnd()}
})();
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = buildFilmKit();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(KIT_OUTPUT, 'utf8'); } catch { /* missing counts as stale */ }
    if (current !== built) { console.error('film kit is stale: run node apps/web/scripts/build-film-kit.mjs'); process.exit(1); }
    console.log('film kit is up to date');
  } else {
    writeFileSync(KIT_OUTPUT, built);
    console.log(`wrote ${KIT_OUTPUT} (${Buffer.byteLength(built)} bytes)`);
  }
}
