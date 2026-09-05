import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unicodeCaseFold } from '../src/unicode-casefold.js';

// Read the published data independently of the generated implementation.
const caseFoldingData = readFileSync(
  new URL('../data/unicode/17.0.0/CaseFolding.txt', import.meta.url), 'utf8',
);
const rows = caseFoldingData.split(/\r?\n/u)
  .map(line => line.split('#', 1)[0].trim())
  .filter(Boolean)
  .map(line => {
    const match = /^([0-9A-F]+);\s*([CFST]);\s*([0-9A-F ]+);$/u.exec(line);
    assert.ok(match, `Unexpected CaseFolding.txt record: ${line}`);
    return {
      codePoint: Number.parseInt(match[1], 16),
      status: match[2],
      folded: String.fromCodePoint(...match[3].trim().split(/\s+/u)
        .map(hex => Number.parseInt(hex, 16))),
    };
  });
const fullRows = rows.filter(row => row.status === 'C' || row.status === 'F');
const fullMappings = new Map(fullRows.map(row => [row.codePoint, row.folded]));
const codePointLabel = codePoint => `U+${codePoint.toString(16).padStart(4, '0')}`;

test('the reference fixture is the complete pinned Unicode 17.0.0 case-folding table', () => {
  assert.match(caseFoldingData, /^# CaseFolding-17\.0\.0\.txt\r?\n/u);
  const counts = Object.fromEntries(['C', 'F', 'S', 'T'].map(status => [
    status, rows.filter(row => row.status === status).length,
  ]));
  assert.deepEqual(counts, { C: 1481, F: 104, S: 31, T: 2 });
  assert.equal(fullMappings.size, 1585, 'C/F must supply one mapping per source');
});

test('every C/F mapping exactly matches the official full default folding', () => {
  for (const { codePoint, folded, status } of fullRows) {
    assert.equal(unicodeCaseFold(String.fromCodePoint(codePoint)), folded,
      `${codePointLabel(codePoint)} (${status})`);
  }

  const source = fullRows.map(row => String.fromCodePoint(row.codePoint)).join('\0');
  const expected = fullRows.map(row => row.folded).join('\0');
  assert.equal(unicodeCaseFold(source), expected, 'adjacent mappings preserve order and separators');
});

test('simple and Turkic alternatives never override the C/F mapping', () => {
  const alternateRows = rows.filter(row => row.status === 'S' || row.status === 'T');
  for (const { codePoint, folded, status } of alternateRows) {
    const expected = fullMappings.get(codePoint) ?? String.fromCodePoint(codePoint);
    assert.notEqual(expected, folded, `${codePointLabel(codePoint)} has a distinct ${status} alternative`);
    assert.equal(unicodeCaseFold(String.fromCodePoint(codePoint)), expected,
      `${codePointLabel(codePoint)} must exclude status ${status}`);
  }
});

test('every Unicode scalar without a C/F mapping is preserved', () => {
  // Batches keep this exhaustive check bounded in memory and avoid a million assertions.
  let batch = [];
  let checked = 0;
  const verifyBatch = () => {
    if (!batch.length) return;
    const input = String.fromCodePoint(...batch);
    assert.equal(unicodeCaseFold(input), input,
      `unmapped scalars ${codePointLabel(batch[0])} to ${codePointLabel(batch.at(-1))}`);
    checked += batch.length;
    batch = [];
  };
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    if (fullMappings.has(codePoint)) continue;
    batch.push(codePoint);
    if (batch.length === 4096) verifyBatch();
  }
  verifyBatch();
  assert.equal(checked, 0x110000 - 0x800 - fullMappings.size);
});

test('all isolated UTF-16 surrogates survive without replacement or loss', () => {
  for (let codeUnit = 0xd800; codeUnit <= 0xdfff; codeUnit++) {
    const input = String.fromCharCode(codeUnit);
    assert.equal(unicodeCaseFold(input), input, codePointLabel(codeUnit));
    assert.equal(unicodeCaseFold(`A${input}Z`), `a${input}z`,
      `${codePointLabel(codeUnit)} between mapped characters`);
  }
  assert.equal(unicodeCaseFold('\ud800A\udfff'), '\ud800a\udfff');
  assert.equal(unicodeCaseFold('\udfff\ud800'), '\udfff\ud800');
  assert.equal(unicodeCaseFold('\ud801\udc00'), '\ud801\udc28',
    'a valid Deseret surrogate pair is folded as one supplementary code point');
});

test('full folding is idempotent for every mapped code point and a mixed string', () => {
  for (const { codePoint, folded } of fullRows) {
    assert.equal(unicodeCaseFold(folded), folded,
      `${codePointLabel(codePoint)} produces a stable full mapping`);
  }
  const input = 'Straße ẞ Σσς İIıi Ꭰꭰ և ﬓ \u{10400}\u{10428} Ａ É E\u0301 😀 \ud800';
  const once = unicodeCaseFold(input);
  assert.equal(unicodeCaseFold(once), once);
});

test('full folding expands sharp S, Greek decompositions and Armenian ligatures', () => {
  assert.equal(unicodeCaseFold('Straße STRAẞE'), 'strasse strasse');
  assert.equal(unicodeCaseFold('\u0390'), '\u03b9\u0308\u0301');
  assert.equal(unicodeCaseFold('\u03b0'), '\u03c5\u0308\u0301');
  assert.equal(unicodeCaseFold('\u0587\ufb13'), '\u0565\u0582\u0574\u0576');
  assert.equal(unicodeCaseFold('\ufb00\ufb03'), 'ffffi');
});

test('non-Latin folding handles sigma, uppercase Cherokee and supplementary scripts', () => {
  assert.equal(unicodeCaseFold('ΟΣ Σσς'), 'οσ σσσ', 'sigma is independent of word position');
  assert.equal(unicodeCaseFold('\u13a0\uab70\u13f0\u13f8'), '\u13a0\u13a0\u13f0\u13f0');
  assert.equal(unicodeCaseFold('\u0531\u0561'), '\u0561\u0561');
  assert.equal(unicodeCaseFold('\u{10400}\u{10428}😀'), '\u{10428}\u{10428}😀');
  assert.equal(unicodeCaseFold('\u1c89\ua7cb\ua7ce'), '\u1c8a\u0264\ua7cf',
    'mappings newer than older JavaScript Unicode tables remain available');
});

test('default I folding includes the dot and never selects Turkic mappings', () => {
  assert.equal(unicodeCaseFold('Iİıi'), 'ii\u0307ıi');
  assert.equal(unicodeCaseFold('I'), unicodeCaseFold('i'));
  assert.notEqual(unicodeCaseFold('I'), unicodeCaseFold('ı'));
  assert.notEqual(unicodeCaseFold('İ'), unicodeCaseFold('i'));
});

test('folding itself does not perform compatibility or canonical normalization', () => {
  assert.equal(unicodeCaseFold('ＡⅠℌ'), 'ａⅰℌ');
  assert.equal(unicodeCaseFold('ＡⅠℌ'.normalize('NFKC')), 'aih',
    'the caller can explicitly normalize before folding');
  assert.equal(unicodeCaseFold('É'), 'é');
  assert.equal(unicodeCaseFold('E\u0301'), 'e\u0301');
  assert.notEqual(unicodeCaseFold('É'), unicodeCaseFold('E\u0301'));
  assert.equal(unicodeCaseFold('\u0390'), '\u03b9\u0308\u0301',
    'full folding may decompose an NFC input without recomposing it');
});

test('folding is independent of JavaScript case and normalization APIs', t => {
  const forbidden = () => { throw new Error('Host case/normalization API must not be used'); };
  for (const method of ['toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'normalize']) {
    t.mock.method(String.prototype, method, forbidden);
  }
  try {
    assert.equal(unicodeCaseFold('Iİıi ẞ Σς ꭰ Ａ \u{10400}'),
      'ii\u0307ıi ss σσ Ꭰ ａ \u{10428}');
  } finally {
    t.mock.restoreAll();
  }
});

test('nullish and non-string inputs retain String(value ?? empty) semantics', () => {
  assert.equal(unicodeCaseFold(), '');
  assert.equal(unicodeCaseFold(undefined), '');
  assert.equal(unicodeCaseFold(null), '');
  assert.equal(unicodeCaseFold(''), '');
  assert.equal(unicodeCaseFold(0), '0');
  assert.equal(unicodeCaseFold(false), 'false');
  assert.equal(unicodeCaseFold(123n), '123');
  assert.equal(unicodeCaseFold(Symbol('A')), 'symbol(a)');
  assert.equal(unicodeCaseFold({ toString: () => 'Straẞe' }), 'strasse');
  assert.equal(unicodeCaseFold(' A\tB\n\0 '), ' a\tb\n\0 ', 'whitespace is preserved');
});
