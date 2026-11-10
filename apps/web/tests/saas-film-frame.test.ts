import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filmFrame } from '../src/canvas/filmKit/filmFrame';
import { FILM_GUIDE, FILM_KIT_URL } from '../src/canvas/filmKit/filmKit';
import { previewScriptNeeds } from '../src/canvas/previewLibraries';

const tag = `<script src="${FILM_KIT_URL}"></script>`;
const film = (script: string, head = tag, type = '') => `<!doctype html><html><body>${head}<script${type ? ` type="${type}"` : ''}>${script}</script></body></html>`;
const run = (fields: string) => film(`Film.run({ title: 'x', ${fields} duration: 2, scenes: [{ from: 0, to: 2, draw() {} }] });`);
const shapeOf = (page: string) => filmFrame(page)?.aspect ?? null;
/** Whether a running preview would inline the kit for this page: the rule filmFrame must follow. */
const runsKit = (page: string) => previewScriptNeeds(page).libraries.some(library => library.id === 'film-kit-1');

function guideExample(): string {
  const start = FILM_GUIDE.indexOf('```html', FILM_GUIDE.indexOf('### 2.'));
  const body = FILM_GUIDE.slice(start + '```html'.length);
  return body.slice(0, body.indexOf('```')).trim();
}

describe('a film page, as a preview tells one', () => {
  it('is a page whose kit tag a running preview inlines, however the tag is written', () => {
    const runs = [
      tag,
      `<script type="text/javascript" src="${FILM_KIT_URL}"></script>`,
      `<script crossorigin="anonymous" src='${FILM_KIT_URL}'></script>`,
      `<script src=${FILM_KIT_URL}></script>`,
      `<script src="  ${FILM_KIT_URL}  "></script>`,
      `<SCRIPT SRC="${FILM_KIT_URL}"></SCRIPT>`,
    ];
    const not = [
      `<!-- ${tag} -->`,
      `<script>const note = '${tag.replace('</script>', '<\\/script>')}';</script>`,
      `<script src="${FILM_KIT_URL.toUpperCase()}"></script>`,
      `<script src="${FILM_KIT_URL.replace('/film/1/', '/film/2/')}"></script>`,
      `<script href="${FILM_KIT_URL}"></script>`,
      '',
    ];
    for (const head of runs) {
      const page = film("Film.run({ aspect: '9:16' });", head);
      expect(runsKit(page), head).toBe(true);
      expect(filmFrame(page), head).toEqual({ aspect: '9 / 16', ratio: 9 / 16 });
    }
    for (const head of not) {
      const page = film("Film.run({ aspect: '9:16' });", head);
      expect(runsKit(page), head).toBe(false);
      expect(filmFrame(page), head).toBeNull();
    }
  });

  it('is framed at the shape its Film.run names, the way the kit reads it', () => {
    expect(filmFrame(run("aspect: '16:9',"))).toEqual({ aspect: '16 / 9', ratio: 16 / 9 });
    expect(filmFrame(run('aspect: "9:16",'))).toEqual({ aspect: '9 / 16', ratio: 9 / 16 });
    expect(filmFrame(run("aspect:'1x1',"))).toEqual({ aspect: '1 / 1', ratio: 1 });
    expect(filmFrame(run("aspect: '4/5',"))).toEqual({ aspect: '4 / 5', ratio: 0.8 });
    expect(filmFrame(run("aspect: '2.39:1',"))).toEqual({ aspect: '2.39 / 1', ratio: 2.39 });
    expect(shapeOf(run('aspect: `9:16`,'))).toBe('9 / 16');
    expect(shapeOf(run("'aspect': '1:1',"))).toBe('1 / 1');
    expect(shapeOf(guideExample())).toBe('16 / 9');
    // Its script runs as JavaScript in any type the preview runs it in.
    for (const type of ['text/javascript', 'text/ecmascript', 'application/x-javascript', 'module']) {
      expect(shapeOf(film("Film.run({ aspect: '9:16' });", tag, type)), type).toBe('9 / 16');
    }
    expect(shapeOf(film("Film.run({ aspect: '9:16' });", tag, 'text/plain'))).toBeNull();
  });

  it('reads the object its Film.run is given, at its top level only', () => {
    expect(shapeOf(film("const FILM = { aspect: '9:16', duration: 2 };\nconst PRESET = { aspect: '16:9' };\nFilm.run(FILM);"))).toBe('9 / 16');
    expect(shapeOf(film("const OLD = { aspect: '9:16' };\nFilm.run({ aspect: '16:9' });"))).toBe('16 / 9');
    expect(shapeOf(film("Film.run({ scenes: [{ aspect: '1:1', draw() {} }], look: { aspect: '1:1' }, aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("Film.run({ look: { aspect: '9:16' }, duration: 2 });"))).toBe('16 / 9');
    expect(shapeOf(film("Film.run({ aspect: '1:1', aspect: '9:16' });"))).toBe('9 / 16');   // the last one counts, as in JavaScript
    expect(shapeOf(film("Film.run({ ...BASE, aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("Film.run({ title: 'a, b', draw: (g) => { const s = `${1},{`; return s; }, aspect: '4:5' });"))).toBe('4 / 5');
  });

  it('reads a shape held in a const declared once, as the guide names its palette and tempo', () => {
    const named = (declaration: string, fields: string) => film(`${declaration}\nFilm.run({ title: 'x', ${fields} duration: 2 });`);
    expect(shapeOf(named("const ASPECT = '9:16';", 'aspect: ASPECT,'))).toBe('9 / 16');
    expect(shapeOf(named("const aspect = '1:1';", 'aspect,'))).toBe('1 / 1');
    expect(shapeOf(named("const A = '4:5', B = 2;", 'aspect: A,'))).toBe('4 / 5');
    expect(shapeOf(named("const ASPECT = '9:16'\nconst BPM = 96;", 'aspect: ASPECT,'))).toBe('9 / 16');
  });

  it('keeps the page frame for a shape it cannot be sure of', () => {
    const named = (declaration: string, fields: string) => film(`${declaration}\nFilm.run({ title: 'x', ${fields} duration: 2 });`);
    for (const page of [
      run("aspect: '9:16'.replace('9:16', '16:9'),"),
      run("aspect: wide ? '16:9' : '9:16',"),
      run('aspect: SIZES.reel,'),
      run('aspect: UNDECLARED,'),
      run('aspect: `${W}:${H}`,'),
      named("let shape = '9:16';\nshape = '16:9';", 'aspect: shape,'),
      named("var ASPECT = '9:16';", 'aspect: ASPECT,'),
      named("const ASPECT = '9:16'.toString();", 'aspect: ASPECT,'),
      named("const ASPECT = '9:16'\n.toString();", 'aspect: ASPECT,'),
      named("const ASPECT = '9:16';\nfunction f() { const ASPECT = '16:9'; }", 'aspect: ASPECT,'),
      film("Film.run({ aspect: '9:16', ...BASE });"),
      film("Film.run({ aspect: '9:16', [key]: 1 });"),
      film("Film.run({ get aspect() { return '9:16'; } });"),
      film("const FILM = { aspect: '9:16' };\nFILM.aspect = '16:9';\nFilm.run(FILM);"),
      film("const FILM = { aspect: '9:16' };\nObject.assign(FILM, OTHER);\nFilm.run(FILM);"),
      film("let FILM = { aspect: '9:16' };\nFilm.run(FILM);"),
      film("Film.run(make('9:16'));"),
      film("Film.run({ aspect: '9:16' });\nFilm.run({ aspect: '16:9' });"),
      film("const { run } = Film;\nrun({ aspect: '9:16' });"),
    ]) expect(filmFrame(page), page.slice(page.indexOf('<script>'))).toBeNull();
  });

  it('takes no shape from a note', () => {
    expect(shapeOf(film("/* aspect: '9:16' was tried first */\nFilm.run({ aspect: '16:9' });"))).toBe('16 / 9');
    expect(shapeOf(film("Film.run({\n  // aspect: '9:16',\n  aspect: '1:1',\n});"))).toBe('1 / 1');
    expect(shapeOf(film("// Film.run({ aspect: '1:1' }) was the first try\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("const note = 'see https://example.com // aspect: \\'9:16\\'';\nFilm.run({ aspect: '4:5' });"))).toBe('4 / 5');
  });

  it('is framed at 16:9 when its film names no shape the kit reads (the kit then takes the frame\'s)', () => {
    for (const fields of ['', "aspect: '',", "aspect: ' 9:16 ',", "aspect: 'portrait',", 'aspect: 1.5,', "aspect: '0:9',"]) {
      expect(filmFrame(run(fields)), fields).toEqual({ aspect: '16 / 9', ratio: 16 / 9 });
    }
    // A shape no preview frame takes (the kit letterboxes it in the template's).
    expect(shapeOf(run("aspect: '100:1',"))).toBe('16 / 9');
    expect(shapeOf(run("aspect: '1:5',"))).toBe('16 / 9');
  });

  it('is no film without the kit, whatever its text says', () => {
    expect(filmFrame('<html><body><canvas></canvas><script>/* aspect: "16:9" */ Film.run({ aspect: "9:16" });</script></body></html>')).toBeNull();
    expect(filmFrame('<html><body><p>Film.run({ aspect: "9:16" })</p></body></html>')).toBeNull();
    // A kit tag written with character references is still the kit, as the preview reads it.
    const encoded = film("Film.run({ aspect: '9:16' });", `<script src="${FILM_KIT_URL.replace('film.js', 'film&#46;js')}"></script>`);
    expect(runsKit(encoded)).toBe(true);
    expect(shapeOf(encoded)).toBe('9 / 16');
  });

  it('reads strings, patterns and divisions as code reads them', () => {
    // A '//' or '/*' inside a string is no comment, and an escaped quote does not end the string.
    expect(shapeOf(film("Film.run({ title: 'see https://example.com', aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("Film.run({ title: 'it\\'s https://example.com', aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("Film.run({ title: \"a /* b\", aspect: '9:16' });"))).toBe('9 / 16');
    // A quote, a '/*' or a bracket inside a regular expression is no string, comment or bracket.
    expect(shapeOf(film("const trim = (s) => s.replace(/\\/*$/, '');\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("const q = /'/;\nconst pattern = '/*';\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("Film.run({ split: /[{,]/g, aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("const f = (s) => { return /'/.test(s); };\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    // A division is not taken for a pattern.
    expect(shapeOf(film("const half = W / 2 / 3, third = (W) / 3;\nFilm.run({ aspect: '9:16', y: H / 2 });"))).toBe('9 / 16');
    // A property or a private name spelt like a keyword (timing.in, as a film times its fades) is an operand, however its
    // dot is spaced, and so is a number that ends in its decimal point: the '/' after it divides, in a substitution too.
    const tail = "Film.run({ aspect:'9:16', duration:6 / 1, scenes:[{from:0,to:6,draw(){}}] });";
    expect(shapeOf(film(`const timing = { in: 12 }; const half = timing.in / 2; ${tail}`))).toBe('9 / 16');
    for (const operand of ['timing?.in', 'timing. in', 'timing./* in */in', 'timing.\n  in', 'timing.typeof', 'timing?.\n  await',
      '1.', '1..in', '1.5.in', '1 .in', '1e+2.in']) {
      expect(shapeOf(film(`const timing = { in: 12 }; const half = ${operand} / 2; ${tail}`)), operand).toBe('9 / 16');
      expect(shapeOf(film(`const timing = { in: 12 }; const label = \`\${${operand} / 2}s\`; ${tail}`)), `\${${operand}}`).toBe('9 / 16');
    }
    expect(shapeOf(film(`class Fade { #in = 12; half() { return this.#in / 2; } } ${tail}`))).toBe('9 / 16');
    expect(shapeOf(film(`class Fade { #in = 12; label() { return \`\${this.#in / 2}s\`; } } ${tail}`))).toBe('9 / 16');
    // A name is read whole, as JavaScript reads names: with a letter outside ASCII (café2, 宽), a character outside the
    // BMP (𝑥2) or a joiner, it is one name, the dot after it a member access and a '/' after it a division.
    for (const name of ['café2', '宽', '𝑥2', 'a\u200c2']) {
      expect(shapeOf(film(`const ${name} = { in: 12 }; const half = ${name}.in / 2; ${tail}`)), name).toBe('9 / 16');
      expect(shapeOf(film(`const ${name} = { in: 12 }; const label = \`\${${name}.in / 2}s\`; ${tail}`)), name).toBe('9 / 16');
      expect(shapeOf(film(`const ${name} = 4; const half = ${name} / 2; ${tail}`)), name).toBe('9 / 16');
      expect(shapeOf(film(`const ${name} = 4; const label = \`\${${name} / 2}s\`; ${tail}`)), name).toBe('9 / 16');
    }
    // The keyword is still the keyword after a spread, after a number's decimal point, and after a property.
    for (const keyword of ['[...typeof /a\\/b/]', '1. in /a\\/b/', 'timing.in in /a\\/b/', 'timing.in\n  in /a\\/b/', "timing.in in /'}/"]) {
      expect(shapeOf(film(`const timing = { in: 12 }; const k = ${keyword}; ${tail}`)), keyword).toBe('9 / 16');
      expect(shapeOf(film(`const timing = { in: 12 }; const k = \`\${${keyword}}\`; ${tail}`)), `\${${keyword}}`).toBe('9 / 16');
    }
  });

  it('frames the shapes at the edge of what it frames, and reads every way of naming the key', () => {
    expect(filmFrame(run("aspect: '4:1',"))).toEqual({ aspect: '4 / 1', ratio: 4 });
    expect(filmFrame(run("aspect: '1:4',"))).toEqual({ aspect: '1 / 4', ratio: 0.25 });
    expect(shapeOf(run('"aspect": \'1:1\','))).toBe('1 / 1');
    // Values the kit reads no shape from: the film takes the frame's, 16:9.
    for (const value of ['null', 'undefined', 'true', 'false', 'NaN', 'void 0']) {
      expect(filmFrame(run(`aspect: ${value},`)), value).toEqual({ aspect: '16 / 9', ratio: 16 / 9 });
    }
  });

  it('reads no call, name or key out of a string, and reaches the film only through Film.run', () => {
    expect(shapeOf(film("const note = \"Film.run({ aspect: '9:16' })\";\nFilm.run({ aspect: '16:9' });"))).toBe('16 / 9');
    expect(shapeOf(film("const note = `const ASPECT = '1:1'`;\nconst ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    for (const page of [
      film("const note = \"Film.run({ aspect: '9:16' })\";\nFilm['run']({ aspect: '16:9' });"),
      film("Film?.run({ aspect: '9:16' });"),
      film("const F = Film;\nFilm.run({ aspect: '9:16' });\nF.run({ aspect: '16:9' });"),
      film("const { run, CAM } = Film;\nFilm.run({ aspect: '9:16' });"),
      film("const { ...all } = Film;\nFilm.run({ aspect: '9:16' });"),
    ]) expect(filmFrame(page), page.slice(page.indexOf('<script>'))).toBeNull();
    // The guide's own destructuring line, and a check that the kit is there, leave the call the film's.
    expect(shapeOf(film("const { CAM, EASE,\n  text } = Film;\nif (typeof Film === 'undefined') throw new Error('no kit');\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
  });

  it('reads a const only when nothing else names it, and an object only when it is the whole initializer', () => {
    for (const page of [
      film("const FILM = { aspect: '9:16' } && { aspect: '16:9' };\nFilm.run(FILM);"),
      film("const FILM = { aspect: '9:16' };\nconst alias = FILM;\nalias.aspect = '16:9';\nFilm.run(FILM);"),
      film("const FILM = { aspect: '9:16' };\ntweak(FILM);\nFilm.run(FILM);"),
      film("const FILM = { aspect: '9:16', title: `${(FILM_TITLE)}` };\nconst t = `${FILM.aspect = '16:9'}`;\nFilm.run(FILM);"),
      film("const ASPECT = '9:16';\nfunction make(ASPECT) { Film.run({ aspect: ASPECT }); }\nmake('16:9');"),
      film("const ASPECT = '9:16';\n[1].forEach((ASPECT) => 0);\nFilm.run({ aspect: ASPECT });"),
      film("const { ASPECT } = CONFIG;\nFilm.run({ aspect: ASPECT });"),
      film("const ASPECT = '9:16';\nconst wide = ASPECT === '16:9';\nFilm.run({ aspect: ASPECT });"),
    ]) expect(filmFrame(page), page.slice(page.indexOf('<script>'))).toBeNull();
    expect(shapeOf(film("const FILM = {\n  title: 'x', aspect: '9:16',\n};\nFilm.run(FILM);"))).toBe('9 / 16');
    expect(shapeOf(film("const FILM = { aspect: '4:5' }, BPM = 96;\nFilm.run(FILM);"))).toBe('4 / 5');
  });

  it('reads a const declared after another in the same declaration, as the guide declares its tempo', () => {
    expect(shapeOf(film("const A = 1, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    expect(shapeOf(film("const BPM = 100, beat = (n) => n * 60 / BPM,\n  bar = (n) => beat(4 * n), ASPECT = `4:5`;\nFilm.run({ aspect: ASPECT });"))).toBe('4 / 5');
    expect(shapeOf(film("const BPM = 100\n  , T = `a\n${BPM}`, ASPECT = '1:1';\nFilm.run({ aspect: ASPECT });"))).toBe('1 / 1');
    expect(shapeOf(film("const W = { x: [1, 2] }, FILM = { aspect: '9:16' };\nFilm.run(FILM);"))).toBe('9 / 16');
    expect(shapeOf(film("const H = 2 +\n  W, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    // A line that ends in a division, or a next one that opens with in or instanceof, goes on.
    expect(shapeOf(film("const BPM = 100, beat = 60 /\n  BPM, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    expect(shapeOf(film("const A = 'k'\n  in OBJ, B = x\n  instanceof Y, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    // So does one that ends in the keyword in or typeof, or in a dot that reads a member of a number.
    expect(shapeOf(film("const A = 'k' in\n  OBJ, B = typeof\n  x, C = 1..\n  toFixed(), ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    // A property named const is no declaration's keyword, however its dot is spaced.
    expect(shapeOf(film("const config = { const: 2 };\nconst n = config./* setting */const + 1, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    expect(shapeOf(film("const config = { const: 2 };\nconst n = config?.\n  const + 1, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    // After a number's decimal point a const is the keyword; after a fraction's digits a dot reads a property.
    expect(shapeOf(film("1.\nconst unused = 0, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    expect(shapeOf(film("const n = 1.5./* x */const + 1, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    // Nor after an exponent, signed or not, a hex or a BigInt literal (none takes a decimal point), nor a spaced dot.
    for (const number of ['1e+2', '1E-2', '1.5e+2', '.5e-1', '1e2', '0x1F', '1n', '1 ']) {
      expect(shapeOf(film(`const n = ${number}./* x */const + 1, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });`)), number).toBe('9 / 16');
    }
    // A sign after a name's e adds: the integer after it is a number of its own, and its dot a decimal point.
    for (const sum of ['Math.E+2', 'value1e+2', 'value1e-2', 'n.e+2', '宽1e+2']) {
      expect(shapeOf(film(`const value1e = 1, 宽1e = 1, n = { e: 1 };\n${sum}.\nconst unused = 0, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });`)), sum).toBe('9 / 16');
    }
    // A name outside ASCII is a declarator, a statement's start, and no part of another name.
    expect(shapeOf(film("const 宽 = 1080, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    expect(shapeOf(film("const 宽const = 1, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    expect(shapeOf(film("const ASPECT = '9:16'\n宽 = 1\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    expect(shapeOf(film("const ASPECT = '9:16';\nconst ASPECT宽 = '1:1';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    expect(shapeOf(film("const a = 1, ASPECT = '9:16';\n宽ASPECT = 2;\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    // However long the mantissa, its exponent is read whole.
    for (const digits of [61, 62, 63, 200]) {
      expect(shapeOf(film(`const n = 1_${'1'.repeat(digits)}e+2./* x */const + 1, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });`)), String(digits)).toBe('9 / 16');
    }
    // However many consts a function in an initializer declares, the declaration's own keyword is found.
    const locals = Array.from({ length: 20 }, (_, n) => `const v${n} = ${n};`).join(' ');
    expect(shapeOf(film(`const draw = (g) => { ${locals} }, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT, scenes: [{ from: 0, to: 2, draw }] });`))).toBe('9 / 16');
    expect(shapeOf(film("const { x } = POINT, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"))).toBe('9 / 16');
    const guide = guideExample().replace(/aspect:\s*'[^']*'/, 'aspect: ASPECT').replace('const BPM = 100, ', "const BPM = 100, ASPECT = '9:16', ");
    expect(guide).toContain("const BPM = 100, ASPECT = '9:16', ");
    expect(shapeOf(guide)).toBe('9 / 16');
    const divided = guideExample().replace(/aspect:\s*'[^']*'/, 'aspect: ASPECT')
      .replace('beat = (n) => n * 60 / BPM, ', "beat = (n) => n * 60 /\n  BPM, ASPECT = '9:16', ");
    expect(divided).toContain("n * 60 /\n  BPM, ASPECT = '9:16', ");
    expect(shapeOf(divided)).toBe('9 / 16');
    // Not a const of the page's top level: a let's or a var's, a pattern's default, an assignment after a declaration
    // ended (by a ';' or a new line), one in a block or a function.
    for (const page of [
      film("let a = 1, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"),
      film("const B = 1;\nvar a = 1, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"),
      film("const { ASPECT = '9:16' } = CONFIG;\nFilm.run({ aspect: ASPECT });"),
      film("const a = 1;\nASPECT = '9:16';\nFilm.run({ aspect: ASPECT });"),
      film("const a = 1\nASPECT = '9:16'\nFilm.run({ aspect: ASPECT });"),
      film("const a = 1\nb = 2, ASPECT = '9:16'\nFilm.run({ aspect: ASPECT });"),
      film("const R = /a/\nb = 2, ASPECT = '9:16'\nFilm.run({ aspect: ASPECT });"),
      film("const a = 1\n宽 = 2, ASPECT = '9:16'\nFilm.run({ aspect: ASPECT });"),
      film("const a = 1\nin宽 = 2, ASPECT = '9:16'\nFilm.run({ aspect: ASPECT });"),
      film("const 宽in = 1, a = 宽in\nb = 2, ASPECT = '9:16'\nFilm.run({ aspect: ASPECT });"),
      film("const ASPECT宽 = '1:1';\nFilm.run({ aspect: ASPECT });"),
      // A line that ends in a property spelt like a keyword, or in a number's decimal point, ends its operand.
      film("const t = { in: 1 }, a = t.in\nb = 2, ASPECT = '9:16'\nFilm.run({ aspect: ASPECT });"),
      film("const t = { in: 1 }, a = t?.\n  in\nb = 2, ASPECT = '9:16'\nFilm.run({ aspect: ASPECT });"),
      film("const a = 1.\nb = 2, ASPECT = '9:16'\nFilm.run({ aspect: ASPECT });"),
      film("const A = 1;\n{ const B = 2, ASPECT = '9:16'; }\nFilm.run({ aspect: ASPECT });"),
      film("{ const a = 1, ASPECT = '9:16'; }\nFilm.run({ aspect: ASPECT });"),
      film("function f() { const a = 1, ASPECT = '9:16'; }\nFilm.run({ aspect: ASPECT });"),
    ]) expect(filmFrame(page), page.slice(page.indexOf('<script>'))).toBeNull();
  });

  it('reads a key as JavaScript does: escapes decoded, the last one counting, an inherited one unknown', () => {
    expect(shapeOf(film("Film.run({ aspect: '9:16', '\\u0061spect': '16:9' });"))).toBe('16 / 9');
    // An escape in a name, a key's too, could as well spell Film or run elsewhere: such a page keeps the page frame.
    expect(filmFrame(film("Film.run({ \\u0061spect: '1:1' });"))).toBeNull();
    expect(shapeOf(film("Film.run({ 'asp\\x65ct': '4:5' });"))).toBe('4 / 5');
    // A prototype may hold an accessor that changes the description as the kit reads it: unknown even beside an own one.
    expect(filmFrame(film("Film.run({ __proto__: BASE, aspect: '9:16' });"))).toBeNull();
    expect(filmFrame(film("Film.run({ __proto__: { aspect: '9:16' } });"))).toBeNull();
    expect(filmFrame(film("Film.run({ '__proto__': BASE, title: 'x' });"))).toBeNull();
    expect(filmFrame(film("Film.run({ async aspect() {} });"))).toBeNull();
    expect(filmFrame(film("Film.run({ set aspect(v) {} });"))).toBeNull();
    // Keys that only look like aspect are other keys.
    expect(shapeOf(film("Film.run({ aspectRatio: '9:16', get: 1, 'aspect ': '1:1' });"))).toBe('16 / 9');
  });

  it('never throws on a page it cannot read: a key past U+10FFFF, deep nesting, an unterminated string or template', () => {
    // A key it cannot read could be aspect: unknown when it comes after the shape, and a later aspect still counts.
    expect(filmFrame(film("Film.run({ aspect: '9:16', '\\u{110000}': 1 });"))).toBeNull();
    expect(shapeOf(film("Film.run({ '\\u{110000}': 1, aspect: '9:16' });"))).toBe('9 / 16');
    expect(filmFrame(film("Film.run({ '\\u{0000000061}spect': '9:16' });"))).toBeNull();
    expect(shapeOf(film("Film.run({ '\\u{61}spect': '9:16' });"))).toBe('9 / 16');
    const deep = '`${'.repeat(3000) + '1' + '}`'.repeat(3000);
    expect(() => filmFrame(film(`const x = ${deep};\nFilm.run({ aspect: '9:16' });`))).not.toThrow();
    expect(() => filmFrame(film("Film.run({ aspect: '9:16', title: 'open"))).not.toThrow();
    expect(() => filmFrame(film('Film.run({ aspect: `9:16 ${ {'))).not.toThrow();
    expect(() => filmFrame(film('Film.run('.repeat(5000)))).not.toThrow();
  });

  it('reads a page with many uses of Film quickly', () => {
    const helpers = 'const t = Film.text;\n'.repeat(20000);
    const started = performance.now();
    expect(shapeOf(film(`${helpers}Film.run({ aspect: '9:16' });`))).toBe('9 / 16');
    expect(performance.now() - started).toBeLessThan(5000);
    // A long run of digits and dots before an exponent's sign is read once, never retried.
    const digits = '1'.repeat(100000);
    const long = performance.now();
    expect(shapeOf(film(`const n = ${digits}..e+2.\nconst unused = 0, ASPECT = '9:16';\nFilm.run({ aspect: ASPECT });`))).toBe('9 / 16');
    expect(performance.now() - long).toBeLessThan(1000);
    // So is a long number that is not all of a value, and a key of many escapes.
    const value = performance.now();
    expect(filmFrame(film(`Film.run({ aspect: ${digits} + 1 });`))).toBeNull();
    expect(shapeOf(film(`const k = x['${'\\x41'.repeat(50000)}'];\nFilm.run({ aspect: '9:16' });`))).toBe('9 / 16');
    expect(performance.now() - value).toBeLessThan(1000);
    // An object that names aspect thousands of times reads its last one only; a run of comments after an import word in
    // a line comment is no import to look for.
    const many = performance.now();
    expect(shapeOf(film(`const A = '16:9'; Film.run({ ${'aspect: A, '.repeat(8000)}aspect: '9:16' });`))).toBe('9 / 16');
    expect(shapeOf(film(`${Array.from({ length: 8000 }, (_, n) => `const A${n} = '1:1';`).join('')}\nFilm.run({ ${Array.from({ length: 8000 }, (_, n) => `aspect: A${n}, `).join('')}aspect: '9:16' });`))).toBe('9 / 16');
    expect(shapeOf(film(`// import${'/**/'.repeat(30)}\nFilm.run({ aspect: '9:16' });`))).toBe('9 / 16');
    expect(performance.now() - many).toBeLessThan(2000);
    // The kit is found by the page's script tags alone: no import scan of its text, however much it looks like imports.
    const imports = performance.now();
    expect(shapeOf(film(`// ${'import /*a '.repeat(40000)}\nFilm.run({ aspect: '9:16' });`))).toBe('9 / 16');
    expect(performance.now() - imports).toBeLessThan(2000);
    // A line of many '/' that start no pattern is read in time linear in the page, or not read (the page frame stays).
    const slashes = performance.now();
    expect(filmFrame(film(`${'(/['.repeat(50000)}\nFilm.run({ aspect: '9:16' });`))).toBeNull();
    expect(performance.now() - slashes).toBeLessThan(2000);
  });

  it('counts every way of reaching Film.run, in a substitution too, and trusts only top-level consts', () => {
    for (const page of [
      film("const run = Film.run;\nif (true) run({ aspect: '16:9' });\nelse Film.run({ aspect: '9:16' });"),
      film("const t = `${Film.run({ aspect: '16:9' })}`;\nFilm.run({ aspect: '9:16' });"),
      film("Film.run.call(null, { aspect: '16:9' });\nFilm.run({ aspect: '9:16' });"),
      film("window.ASPECT = '16:9';\n{ const ASPECT = '9:16'; }\nFilm.run({ aspect: ASPECT });"),
      film("function f() { const ASPECT = '9:16'; }\nFilm.run({ aspect: ASPECT });"),
      film("{ const FILM = { aspect: '9:16' }; }\nFilm.run(FILM);"),
      film("const ASPECT = '9:16';\nconst label = `${ASPECT} film`;\nFilm.run({ aspect: ASPECT });"),
      film("function f(undefined) { Film.run({ aspect: undefined }); }\nf('9:16');"),
      film("Film.run({ aspect: '9:16', get duration() { this.aspect = '16:9'; return 2; } });"),
      film("Film.run({ aspect: '9:16', set title(v) {} });"),
      film("Film.run({ __proto__: BASE, aspect: '9:16' });"),
    ]) expect(filmFrame(page), page.slice(page.indexOf('<script>'))).toBeNull();
    // A template's own text says nothing, and a top-level const read once is still read.
    expect(shapeOf(film("const note = `Film.run({ aspect: '1:1' })`;\nconst ASPECT = '9:16';\nFilm.run({ aspect: ASPECT, title: `${2 + 2}` });"))).toBe('9 / 16');
    // undefined that nothing rebinds names no shape.
    expect(shapeOf(film("Film.run({ aspect: undefined });"))).toBe('16 / 9');
    // A property named get, set or async is an ordinary property.
    expect(shapeOf(film("Film.run({ get: 1, set: 2, async: 3, aspect: '4:5' });"))).toBe('4 / 5');
    // A name outside ASCII is a name: a key, a const holding the shape or the description, one of the guide's
    // destructured names, and never Film or run with a letter added to either end.
    expect(shapeOf(film("Film.run({ aspect: '9:16', 标题: '短片' });"))).toBe('9 / 16');
    expect(shapeOf(film("const 竖屏 = '9:16';\nFilm.run({ aspect: 竖屏 });"))).toBe('9 / 16');
    expect(shapeOf(film("const 设置 = { aspect: '9:16' };\nFilm.run(设置);"))).toBe('9 / 16');
    expect(shapeOf(film("const { CAM, 宽, run宽 } = Film;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("const 宽Film = { run() {} };\n宽Film.run({ aspect: '1:1' });\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("const 宽Film = [1], Film宽 = 1, k = 宽Film[0], go = Film.run宽, p = globalThis.Film宽;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
  });

  it('frames the guide\'s own example at its shape, a character running in it', () => {
    const example = guideExample().replace(/aspect:\s*'[^']*'/, "aspect: '9:16'").replace(/'walk'/g, "'run'");
    expect(example).toContain("'run'");
    expect(shapeOf(example)).toBe('9 / 16');
    // A list of the actions it uses is words too, after a commented if as well.
    const listed = example.replace('<script>', "<script>\nconst actions = ['run'];\nif /* show a running character */ (true) ['run'].forEach(a => void a);");
    expect(listed).toContain("const actions = ['run'];");
    expect(shapeOf(listed)).toBe('9 / 16');
  });

  it('keeps the page frame where Film is reached in a way it cannot follow, and finds a substitution\'s end in its code', () => {
    for (const page of [
      film("window['ASPECT']='16:9'; {const ASPECT='9:16';} Film.run({aspect:ASPECT,duration:2,scenes:[{from:0,to:2,draw(){}}]});"),
      film("function f(){const ASPECT='9:16';}\nFilm.run({ aspect: ASPECT });"),
      film("const {'run':r}=Film;\nif(true) r({aspect:'16:9',duration:2,scenes:[{from:0,to:2,draw(){}}]});\nelse Film.run({aspect:'9:16'});"),
      film("const {[k]:r}=Film;\nFilm.run({ aspect: '9:16' });"),
      film("const { run: go } = Film;\nFilm.run({ aspect: '9:16' });"),
      film("const { text = Film.run } = Film;\nFilm.run({ aspect: '9:16' });"),
      film("window.Film['run']({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("globalThis['Film'].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("Film.\\u0072un({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("F\\u0069lm.run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("const t=`${ /}/.test('}') && Film.run({aspect:'16:9',duration:2,scenes:[{from:0,to:2,draw(){}}]}) }`;\nif(false) Film.run({aspect:'9:16'});"),
      film("const t=`${ /* } */ Film.run({ aspect: '16:9' }) }`;\nif (false) Film.run({ aspect: '9:16' });"),
      film("const t=`${ 1 /* } */ + Film.run({ aspect: '16:9' }) }`;\nif (false) Film.run({ aspect: '9:16' });"),
      film("const t=`${ 1 // }\n + Film.run({ aspect: '16:9' }) }`;\nif (false) Film.run({ aspect: '9:16' });"),
      film("const F = window.Film;\nF.run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      // A member named by a string, however it is quoted, spaced or escaped, and whatever operand it follows.
      film("self[name]['run']({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("const k = globalThis?.['Film'];\nFilm.run({ aspect: '9:16' });"),
      film("globalThis[`Film`].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("globalThis\n[ \"Film\" ].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("(0, globalThis)['Film'].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("globalThis['F\\x69lm'].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("const go = rules.if(ready)['run'];\nFilm.run({ aspect: '9:16' });"),
      // After a property or a private name spelt like a keyword (default, in, get, if), a string in brackets is a member.
      film("const go = rules. if (ready)['run'];\nFilm.run({ aspect: '9:16' });"),
      film("frames.default['Film'].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("scope?.\n  in['Film'].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("class P { #get = globalThis; go() { this.#get['Film'].run({ aspect: '16:9' }); } }\nif (false) Film.run({ aspect: '9:16' });"),
      // After a name outside ASCII too (zé, 𝑥), and typeof is no keyword at the end of one (宽typeof).
      film("const zé = globalThis;\nzé['Film'].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("const 宽in = globalThis;\n宽in['Film'].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("const 𝑥 = globalThis;\n𝑥['Film'].run({ aspect: '16:9' });\nif (false) Film.run({ aspect: '9:16' });"),
      film("const 宽typeof = 1;\nconst t = 宽typeof\nFilm;\nFilm.run({ aspect: '9:16' });"),
      // A page whose template never closes does not run: it is no film to frame.
      film("Film.run({ aspect: '9:16' });\nconst t = `never closed;"),
    ]) expect(filmFrame(page), page.slice(page.indexOf('<script>'))).toBeNull();
    // Written as the guide writes it, the shape is still read: a top-level const however compact, the guide's own
    // destructuring line, and substitutions with a division, a pattern or a string that holds a brace.
    expect(shapeOf(film("const ASPECT='9:16';Film.run({aspect:ASPECT});"))).toBe('9 / 16');
    expect(shapeOf(film("const { CAM, text,\n  pad } = Film;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("const t = `${ 1 / 2 } ${ /x/.test('}') } ${ '}' }`;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    // A film's own words are words: a title 'Film', a character's action 'run' (as the guide documents them).
    expect(shapeOf(film("Film.run({ title: 'Film', aspect: '9:16', scenes: [{ from: 0, to: 2, draw() { hero.act('run'); } }] });"))).toBe('9 / 16');
    expect(shapeOf(film("const moves = ['walk', 'run'];\nFilm.run({ aspect: '9:16', caption: `run` });"))).toBe('9 / 16');
    // A '[' that opens an array or a computed key holds words, and a string's text that looks like an access is text.
    expect(shapeOf(film([
      "const actions = ['run'];",
      "const pick = () => ['run'];",
      "function moves() { return ['run']; }",
      "for (const a of ['run']) hero.act(a);",
      "if (ready) ['run'].forEach((a) => hero.act(a));",
      "if /* show a running character */ (true) ['run'].forEach(a => void a);",
      "while (false)\n  // never\n  ['run'].pop();",
      "class Pose { static ['run']() {} }",
      "const kinds = [...typeof ['run']], has = 1. in ['run'];",
      "Film.run({ title: \"Choose ['run']\", aspect: '9:16' });",
    ].join('\n')))).toBe('9 / 16');
    expect(shapeOf(film("for await (const a of list) ['run'].forEach(f);\nFilm.run({ aspect: '9:16' });", tag, 'module'))).toBe('9 / 16');
    // A postfix ++ or -- ends an operand: the '/' after it divides, in a substitution and outside one.
    expect(shapeOf(film("let n = 4;\nconst label = `${n++ / 2}`;\nconst m = n-- / 2;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("let n = 4;\nconst label = `${n++ / 2}Film.run({ aspect: '16:9' })${1 / 2}`;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("let n = 4; const m = n-- / 2; Film.run({ aspect: '9:16' }); const k = 1 / 2;"))).toBe('9 / 16');
    // On a new line (a line comment's end or a block comment's line break counts), JavaScript ends the statement before a
    // ++ or --: it is a prefix, and the '/' after it starts a pattern, in a substitution's code as well.
    expect(shapeOf(film("let n = 0;\nn\n++/['}]/.lastIndex;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("let n = 0;\nn\u2028++/['}]/.lastIndex;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("let n = 0;\nn/*\n*/--/['}]/.lastIndex;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("const t = `${(() => { let n = 0; n\n++/['}]/.lastIndex; return '' })()}`;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("const t = `${(() => { let n = 0; n // count\n++/['}]/.lastIndex; return '' })()}`;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    expect(shapeOf(film("const t = `${(() => { let n = 0; n /*\n*/ ++/['}]/.lastIndex; return '' })()}`;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
    // A line comment ends at every line terminator, U+2028 and U+2029 among them.
    expect(shapeOf(film("const a = `${1 // }\u2028 + 2}`;\nconst b = `${1 // }\u2029 + 2}`;\nFilm.run({ aspect: '9:16' });"))).toBe('9 / 16');
  });
});

describe('a film page\'s frame in each view', () => {
  const web = join(__dirname, '..');
  const css = (path: string) => readFileSync(join(web, 'src', ...path.split('/')), 'utf8');
  const sheets = ['canvas/artifactPreview.css', 'canvas/canvas-results.css', 'saas/design/canvas.css', 'saas/assistant-execution.css'];
  /** Every value one property takes in the rules whose selector ends with `selector`. */
  const values = (text: string, selector: string, property: string) => {
    const found: string[] = [];
    const rules = new RegExp(`${selector.replace(/[.]/g, '\\.')}\\s*\\{([^{}]*)\\}`, 'g');
    for (const rule of text.matchAll(rules)) {
      for (const declaration of rule[1].matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, 'g'))) found.push(declaration[1].trim());
    }
    return found;
  };

  it('is capped, in every view that gives the page frame a height, at that same height', () => {
    for (const sheet of sheets) {
      const text = css(sheet);
      // The enlarged dialog fills (100%) and is no view a film is capped in.
      const heights = values(text, '.awwo-artifact-frame', 'height').filter(value => value !== '100%');
      const caps = values(text, '.awwo-artifact-frame.is-film', '--awwo-film-cap');
      expect(heights.length, sheet).toBeGreaterThan(0);
      expect([...caps].sort(), sheet).toEqual([...heights].sort());
      // Wherever a view gives the page frame a height, the film's own frame gives that up for its shape.
      expect(values(text, '.awwo-artifact-frame.is-film', 'height').filter(value => value !== '100%').every(value => value === 'auto'), sheet).toBe(true);
    }
  });

  it('keeps clear of the drawer\'s fade by the fade\'s own height', () => {
    const text = css('saas/design/canvas.css');
    const fade = /@keyframes awwo-scroll-fade\s*\{\s*from,\s*88%\s*\{\s*--awwo-scroll-fade:\s*([\d.]+px)/.exec(text)?.[1];
    const drawer = /\.awwo-node-delivery-drawer \.awwo-deliverables\s*\{[^}]*scroll-padding-bottom:\s*([\d.]+px)/.exec(text)?.[1];
    expect(fade).toBeDefined();
    expect(drawer).toBe(fade);
  });
});
