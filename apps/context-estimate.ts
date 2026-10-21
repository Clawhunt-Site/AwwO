// How many input tokens a text can take, from its characters: the estimate every input budget compares with a model's
// context window. Shared by the Pi worker, the OpenAI Agents worker and computer-model.ts; the Go API
// (backend/internal/app/context_estimate.go) and the Python worker (context_estimate.py) count the same, and
// context-estimate-vectors.json holds the cases all three must agree on.
//
// One byte of UTF-8 is never fewer than one token for the tokenizers AwwO's models use, so counting bytes (the rule
// before 2026-10-21) is always safe, but ordinary text holds far more: Chinese, English and code ran at 2.1-6 bytes
// per token on every model measured on 2026-10-21, while base64, numbers, SVG paths, minified code and URLs ran at
// 1.02-1.8. So a text is split into what may count at a model's measured rate (prose) and what counts byte for byte
// (strict):
//   - a word is a run of code points that are neither ASCII whitespace nor CJK (U+2E80-U+9FFF, U+AC00-U+D7AF,
//     U+F900-U+FAFF, U+FF00-U+FFEF), the whitespace before it going with it;
//   - a word longer than 32 code points, or one holding an ASCII digit, counts strictly with its whitespace;
//   - in any other word only the ASCII letters are prose: punctuation and symbols (operators, brackets, quotes, which
//     often take a token each) and non-ASCII code points count strictly;
//   - a CJK character, and the whitespace before one, is prose;
//   - but a run of more than 32 whitespace characters counts strictly whatever follows it, so the class of the next word
//     (which a serializer's added field can change: the API and the workers measure a call's JSON) moves at most 32
//     bytes of it.
// The estimate is the strict bytes plus the prose bytes divided by the model's proseBytesPerToken, rounded up: at
// most the text's bytes, and exactly its bytes at a rate of 1 (a model nobody measured).

/** The smallest and largest prose rate a model profile may declare (bytes of prose per token). */
export const PROSE_RATE_MIN = 1;
export const PROSE_RATE_MAX = 4;
const LONG_WORD = 32;

function cjk(cp: number): boolean {
  return (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xff00 && cp <= 0xffef);
}

function asciiLetter(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function asciiSpace(cp: number): boolean {
  return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d);
}

// UTF-8 bytes of one code point as Buffer.byteLength counts them (a lone surrogate is written as U+FFFD, 3 bytes).
function utf8(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** A text's strict and prose bytes (strict + prose = its UTF-8 bytes). */
export function textCost(text: string): { strict: number; prose: number } {
  let strict = 0, prose = 0;
  let space = 0, wordBytes = 0, wordLetters = 0, wordLength = 0, wordDigit = false;
  const flush = () => {
    if (space > LONG_WORD) { strict += space; space = 0; }
    if (wordLength > LONG_WORD || wordDigit) strict += space + wordBytes;
    else { prose += space + wordLetters; strict += wordBytes - wordLetters; }
    space = 0; wordBytes = 0; wordLetters = 0; wordLength = 0; wordDigit = false;
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (asciiSpace(cp)) {
      if (wordLength) flush();
      space += 1;
    } else if (cjk(cp)) {
      flush();
      prose += 3;
    } else {
      const bytes = utf8(cp);
      wordBytes += bytes;
      if (asciiLetter(cp)) wordLetters += 1;
      if (cp >= 0x30 && cp <= 0x39) wordDigit = true;
      wordLength += 1;
    }
  }
  flush();
  return { strict, prose };
}

/** A text's estimated input tokens at a model's prose rate (1 when it has none: its UTF-8 bytes). */
export function estimateTokens(text: string, proseBytesPerToken = 1): number {
  const { strict, prose } = textCost(text);
  if (!(proseBytesPerToken > PROSE_RATE_MIN)) return strict + prose;
  return strict + Math.ceil(prose / Math.min(proseBytesPerToken, PROSE_RATE_MAX));
}

/** A profile's declared prose rate, checked: undefined means none (1); anything else must be a number from
 *  PROSE_RATE_MIN to PROSE_RATE_MAX in steps of 0.05. Throws on anything else, so a misspelt rate never loosens a
 *  budget. */
export function proseRate(value: unknown): number {
  if (value === undefined) return PROSE_RATE_MIN;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < PROSE_RATE_MIN || value > PROSE_RATE_MAX
    || Math.abs(value * 20 - Math.round(value * 20)) > 1e-9) throw new Error('Invalid proseBytesPerToken');
  return value;
}

/** A default model's prose rate from its environment variable (e.g. AWWO_PI_PROSE_BYTES_PER_TOKEN): unset or empty
 *  is none (1); otherwise a plain decimal such as 2.95, checked as proseRate checks a profile's. */
export function proseRateSetting(value: string | undefined, name: string): number {
  if (value === undefined || value.trim() === '') return PROSE_RATE_MIN;
  const text = value.trim();
  try {
    if (!/^[0-9](?:\.[0-9]{1,2})?$/.test(text)) throw new Error();
    return proseRate(Number(text));
  } catch { throw new Error(`${name} must be a number from 1 to 4 in steps of 0.05`); }
}
