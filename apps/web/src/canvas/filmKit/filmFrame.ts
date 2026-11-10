// How a preview frames a film page, a page that loads AwwO's film kit (filmKit.ts): at the film's own shape, so its picture
// fills the frame with no band of black, as large as the view it stands in allows (artifactPreview.css, .is-film). The
// page frame's tall default left a band above a 16:9 picture and, in a node's drawer, put its lower part out of view
// (the signed-in check of 2026-11-09).
import { previewScriptLibraries } from '../previewLibraries';
import { isClassicScript, isModuleScript } from '../previewImportMap';
import { FILM_KIT_URL } from './filmKit';

export interface FilmFrame {
  /** The film's shape as a CSS aspect-ratio ("16 / 9"). */
  readonly aspect: string;
  /** The same shape as a number (width / height): the frame's width where a view caps its height. */
  readonly ratio: number;
}

/** The shape a film takes when it names none the kit reads: the kit then makes it the frame's own shape, so this one. */
const TEMPLATE: FilmFrame = { aspect: '16 / 9', ratio: 16 / 9 };
/** The kit's own reading of Film.run's aspect (its boot): '<w>:<h>', '<w>x<h>' or '<w>/<h>', nothing around it. */
const SHAPE = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/;
/** Shapes a preview frames as they are; a film outside them is framed at the template's and letterboxed by the kit. */
const MIN_RATIO = 1 / 4;
const MAX_RATIO = 4;
/** The characters that continue a name, as JavaScript reads names (ID_Continue, '$', ZWNJ and ZWJ), as the body of a
 *  character class for the `u` patterns here: café2, 宽 and 𝑥 are each one name, which an ASCII \w would cut. */
const NAME_PART = String.raw`\p{ID_Continue}$\u200c\u200d`;
/** One UTF-16 unit of a name: NAME_PART's, or either half of a pair (in code, a character outside the BMP can only
 *  stand in a name). The scanners, and every look back over a name, read the code one unit at a time. */
const NAME_UNIT = new RegExp(`[${NAME_PART}\\ud800-\\udfff]`, 'u');
/** One UTF-16 unit that can begin a name (ID_Start, '$', '_'; either half of a pair, as in NAME_UNIT). */
const NAME_START = new RegExp(String.raw`[\p{ID_Start}$_\ud800-\udfff]`, 'u');
/** A whole name, for the `u` patterns here. */
const NAME_TEXT = String.raw`[\p{ID_Start}$_\ud800-\udfff][${NAME_PART}\ud800-\udfff]*`;
/** The name at the start of a text (a declarator's, a call's argument): café, 宽 and 𝑥 too. */
const NAME_AT = new RegExp(`^${NAME_TEXT}`, 'u');
const RUN = new RegExp(String.raw`(?:^|[^${NAME_PART}])Film\s*\.\s*run\s*\(`, 'gu');
/** Film reached as Film[...] or Film?.x; as another object's property; Film.run; Film at all; typeof just before. */
const FILM_COMPUTED = new RegExp(String.raw`(?:^|[^${NAME_PART}.])Film\s*(?:\[|\?\.)`, 'u');
const FILM_PROPERTY = new RegExp(String.raw`\.\s*Film(?![${NAME_PART}])`, 'u');
const FILM_RUN = new RegExp(String.raw`(?:^|[^${NAME_PART}])Film\s*\.\s*run(?![${NAME_PART}])`, 'gu');
const FILM = new RegExp(String.raw`(?:^|[^${NAME_PART}.])Film(?![${NAME_PART}])`, 'gu');
const TYPEOF_BEFORE = new RegExp(String.raw`(?:^|[^${NAME_PART}.])typeof\s*$`, 'u');
/** The inside of the guide's destructuring line, `{ CAM, text }`: plain names, and whether run is one of them. */
const PLAIN_NAMES = new RegExp(String.raw`^\s*${NAME_TEXT}(?:\s*,\s*${NAME_TEXT})*\s*,?\s*$`, 'u');
const NAMES_RUN = new RegExp(String.raw`(?:^|[\s,])run(?![${NAME_PART}\ud800-\udfff])`, 'u');
const NAME = new RegExp(`^${NAME_TEXT}$`, 'u');
// Each character is matched one way (the fraction's dot opens its own group), so a long value that is no number fails at
// once, never by retrying.
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;
const NO_SHAPE = /^(?:null|undefined|true|false|NaN|void\s+0)$/;

/** What a film's description says of its shape: the string it names (to be read as the kit reads it), '' for a value
 *  the kit reads no shape from, UNKNOWN for one this cannot tell, undefined for none. */
const UNKNOWN = null;
type Named = string | typeof UNKNOWN | undefined;

/** The page's code twice over, character for character: `code` with its comments blanked and its regular expressions
 *  emptied, `bare` the same with the inside of every string and template literal blanked too. Calls, names and brackets
 *  are looked for in `bare`, so nothing a string says is taken for code; a literal's value is read from `code`. */
interface Source { readonly code: string; readonly bare: string }

/**
 * How a preview frames this page, or null for a page it frames as any other: one that does not load the film kit (by
 * previewScriptLibraries: the script tags previewScriptNeeds reads first, the rule that inlines the kit when a preview runs,
 * never the page's modules, fonts or any other text), or a film whose shape cannot be told from its
 * text. A film is described as the guide teaches, in one Film.run call; its shape is the own, top-level aspect of the
 * object that call is given (written in the call, or held by a const that nothing else names): a whole quoted or plain
 * template literal, or a const that holds one and is named only where it is declared and where the description reads it.
 * A description that names no shape the kit reads takes the frame's, so it is framed at 16:9. Anything this cannot be sure
 * of keeps the page frame: no call or several, Film reached any other way, a spread, a computed key or an inherited
 * aspect, an expression, a let or var, a name used anywhere else.
 */
export function filmFrame(html: string): FilmFrame | null {
  // Most pages are not films: one whose text names no film.js (nor could, through a character reference) is not parsed.
  if (!/film\.js/i.test(html) && !html.includes('&')) return null;
  let named: Named;
  try {
    if (!previewScriptLibraries(html).some(library => library.urls.includes(FILM_KIT_URL))) return null;
    // Patterns are read in time linear in the page (endOfPattern): eight scans of it, and a million characters more.
    patternBudget = 8 * html.length + 1_000_000;
    const source = split(inlineScripts(html));
    const calls = Array.from(source.bare.matchAll(RUN));
    if (calls.length !== 1 || reachesFilmOtherwise(source)) return null;
    const description = argumentObject(source, (calls[0].index ?? 0) + calls[0][0].length);
    if (description === null) return null;
    named = ownAspect(source, description);
  } catch {
    return null;   // a page this cannot read (too deep for the stack, say) is framed as a page
  }
  if (named === UNKNOWN) return null;
  const shape = named === undefined ? null : SHAPE.exec(named);
  if (!shape) return TEMPLATE;
  const width = Number(shape[1]), height = Number(shape[2]);
  if (!(width > 0 && height > 0)) return TEMPLATE;
  const ratio = width / height;
  return ratio >= MIN_RATIO && ratio <= MAX_RATIO ? { aspect: `${shape[1]} / ${shape[2]}`, ratio } : TEMPLATE;
}

/** The text of the page's own inline scripts that run as JavaScript (classic or module, as the preview tells them), in
 *  order. */
function inlineScripts(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.querySelectorAll('script'))
    .filter(script => !script.hasAttribute('src') && (isClassicScript(script) || isModuleScript(script)))
    .map(script => script.textContent ?? '').join('\n;\n');
}

/** Does the code reach Film other than as Film.<name>: an alias, Film[...] or Film?.x, Film through another object
 *  (window.Film), a name or a key written with an escape or in a string, or a run taken out of it? Then the one Film.run
 *  call found may not be the film's. */
function reachesFilmOtherwise({ code, bare }: Source): boolean {
  if (FILM_COMPUTED.test(bare)) return true;
  // An escape outside a literal can only be in a name (F\u0069lm, Film.\u0072un): one this does not read.
  if (bare.includes('\\')) return true;
  // Film as another object's property (window.Film, globalThis.Film), or reached through a member named by a string
  // (globalThis['Film'], self[name]['run']): reached where this does not look. A film's own words ('Film', 'run') are
  // words, in a list of words too (`const actions = ['run']`).
  if (FILM_PROPERTY.test(bare) || namedByString({ code, bare })) return true;
  // Film.run itself is only ever called where it is named: taken as a value (an alias, .call) it could be run elsewhere.
  for (const use of bare.matchAll(FILM_RUN)) {
    if (!/^\s*\(/.test(bare.slice((use.index ?? 0) + use[0].length, (use.index ?? 0) + use[0].length + 256))) return true;
  }
  for (const use of bare.matchAll(FILM)) {
    const at = (use.index ?? 0) + use[0].length;
    if (/^\s*\./.test(bare.slice(at, at + 256))) continue;
    // What comes just before (a destructuring line is short): never the whole page again for each use.
    const before = bare.slice(Math.max(0, at - 'Film'.length - 4096), at - 'Film'.length);
    // A check that the kit is there reaches nothing in it.
    if (TYPEOF_BEFORE.test(before)) continue;
    // `const { CAM, text } = Film`: the guide's one destructuring line, plain names only and never run (a quoted,
    // computed or renamed key, a default or a rest could take run under another name).
    const pattern = /\{([^{}]*)\}\s*=\s*$/.exec(before);
    if (!pattern || !PLAIN_NAMES.test(pattern[1]) || NAMES_RUN.test(pattern[1])) return true;
  }
  return false;
}

/** Does a member access name Film or run by a string (globalThis['Film'], self[name]['run'], x?.[`run`], or a key with an
 *  escape this does not decode)? Only a '[' that opens an access counts (opensAccess): an array that holds the word
 *  (`const actions = ['run']`) is a list of words, and a string's own text ("Choose ['run']") is text. */
function namedByString({ code, bare }: Source): boolean {
  // Which '(' each ')' closes, found in one pass over the page the first time a ')' stands before such a member.
  let opens: Map<number, number> | null = null;
  const openOf = (close: number): number => {
    if (!opens) {
      opens = new Map();
      const stack: number[] = [];
      for (let index = 0; index < bare.length; index += 1) {
        if (bare[index] === '(') stack.push(index);
        else if (bare[index] === ')') opens.set(index, stack.pop() ?? -1);
      }
    }
    return opens.get(close) ?? -1;
  };
  // In `bare` a string is its two quotes around spaces: brackets around one whole string, whose text is read from `code`.
  for (const member of bare.matchAll(/\[\s*(['"`])\s*\1\s*\]/g)) {
    const open = member.index ?? 0;
    const quote = open + member[0].indexOf(member[1]);
    const key = decode(code.slice(quote + 1, bare.indexOf(member[1], quote + 1)));
    if ((key === null || key === 'Film' || key === 'run') && opensAccess(bare, open, openOf)) return true;
  }
  return false;
}

/** Does the '[' at `open` in `bare` open a member access? It does right after an operand, a new line between them or
 *  not, as JavaScript reads it: a name or a number (not one of BEFORE_ARRAY), a closing ']', a string or template, a
 *  ')' that closes no if, for, while or with, or '?.'. After anything else (an operator, a ',', ':', '(', '{', or a '}'
 *  that ends a block, as one does far more often than an object read in place) it opens an array. Comments are blank
 *  in `bare`, so they stand as space wherever they are. */
function opensAccess(bare: string, open: number, openOf: (close: number) => number): boolean {
  const before = wordBefore(bare, open);
  const char = before.end > 0 ? bare[before.end - 1] : '';
  if (char === ']' || char === "'" || char === '"' || char === '`') return true;
  if (char === '.') return bare[before.end - 2] === '?';
  if (char === ')') {
    const paren = openOf(before.end - 1);
    if (paren < 0) return true;
    // The head of an if, for (for await too), while or with ends there: what follows is a statement. A property of
    // that name (`rules.if(ready)`, `rules. if (ready)`) is called there, and its result read.
    let head = wordBefore(bare, paren);
    if (head.word === 'await') head = wordBefore(bare, head.start);
    return propertyName(bare, head.start) || !/^(?:if|for|while|with)$/.test(head.word);
  }
  // A property named like one of those words (`timing.in`, `config.get`) is an operand.
  return NAME_UNIT.test(char) && (!BEFORE_ARRAY.has(before.word) || propertyName(bare, before.start));
}

/** What stands before `index` in `bare`, space skipped: `end` is just after it, and `word` the name or keyword that ends
 *  there (from `start`), '' for none. */
function wordBefore(bare: string, index: number): { word: string; start: number; end: number } {
  let end = index;
  while (end > 0 && /\s/.test(bare[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && NAME_UNIT.test(bare[start - 1])) start -= 1;
  return { word: bare.slice(start, end), start, end };
}

/** The range [start, end) of the inside of the object the Film.run call at `from` (just after its parenthesis) is given:
 *  an object literal in the call, or the whole initializer of a const nothing else names. Null for anything else. */
function argumentObject(source: Source, from: number): [number, number] | null {
  const { bare } = source;
  const at = skipSpace(bare, from);
  if (bare[at] === '{') {
    const end = closing(bare, at + 1);
    return end >= 0 && /^\s*[,)]/.test(bare.slice(end + 1)) ? [at + 1, end] : null;
  }
  const name = NAME_AT.exec(bare.slice(at))?.[0];
  if (!name || !/^\s*[,)]/.test(bare.slice(at + name.length))) return null;
  // An object can be changed through anything else that names it: it is read only when nothing does, even in a string.
  if (mentions(source.code, name) !== 2) return null;
  const value = soleConstant(source, name);
  if (value === null || bare[value] !== '{') return null;
  const end = closing(bare, value + 1);
  return end >= 0 && endsDeclaration(bare, end + 1) ? [value + 1, end] : null;
}

/** What the object's own properties (between `start` and `end`) say of aspect: the last that does, as JavaScript reads
 *  them; a spread, a computed key or a method of that name before it is unknown. An accessor (it runs as the kit reads
 *  the description, and can change it) or a prototype (it may hold an aspect or an accessor) makes it unknown whatever
 *  else the object says. */
function ownAspect(source: Source, [start, end]: [number, number]): Named {
  const properties = topLevel(source.bare, start, end);
  if (properties === null) return UNKNOWN;
  // What the last property that may set aspect says decides; only it is read (a value can cost a scan of the page, and
  // an object may name aspect thousands of times).
  let last: (() => Named) | null = null;
  const unknown = () => UNKNOWN;
  for (const [from, to] of properties) {
    const bare = source.bare.slice(from, to).trim();
    if (!bare) continue;
    if (bare.startsWith('...') || bare.startsWith('[')) { last = unknown; continue; }
    const lead = source.code.slice(from, to).search(/\S/);
    const key = propertyKey(source.code.slice(from + lead, to).trimEnd());
    if (key === null) { last = unknown; continue; }   // a key this cannot read could be aspect
    if (key.accessor || (key.name === '__proto__' && key.colon)) return UNKNOWN;
    if (key.name !== 'aspect') continue;
    if (key.shorthand) { last = () => constantString(source, 'aspect'); continue; }
    if (!key.colon) { last = unknown; continue; }   // a method of that name
    const at = from + lead + key.length;
    last = () => valueOf(source, at, to);
  }
  return last ? last() : undefined;
}

/** A key written as a name (a get, set or async before it, or a '*'): a name's characters (café, 宽) or escapes. */
const PLAIN_KEY = new RegExp(String.raw`^(?:(?:get|set|async)\s+(?=[\p{ID_Start}$_\\#'"[*\ud800-\udfff]))?\*?\s*((?:[${NAME_PART}\ud800-\udfff]|\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4})+)\s*`, 'u');

/** A property's key as JavaScript reads it (escapes decoded), whether it is `key:` or shorthand or an accessor, and how
 *  many characters of `text` the key and its colon take; null when the property opens with no key this can read. */
function propertyKey(text: string): { name: string; colon: boolean; shorthand: boolean; accessor: boolean; length: number } | null {
  const quoted = /^(['"])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1\s*/.exec(text);
  const plain = quoted ? null : PLAIN_KEY.exec(text);
  const match = quoted ?? plain;
  if (!match) return null;
  const raw = quoted ? quoted[2] : plain![1];
  const name = decode(raw);
  if (name === null) return null;
  const rest = text.slice(match[0].length);
  const prefixed = !quoted && /^(?:get|set|async)\s|^\*/.test(text);
  const accessor = !quoted && /^(?:get|set)\s/.test(text) && !rest.startsWith(':');
  if (rest.startsWith(':') && !prefixed) return { name, colon: true, shorthand: false, accessor: false, length: match[0].length + 1 };
  if (!rest && !quoted && !prefixed && NAME.test(raw)) return { name, colon: false, shorthand: true, accessor: false, length: match[0].length };
  return { name, colon: false, shorthand: false, accessor, length: match[0].length };
}

/** A key's characters with \u, \x and single-character escapes decoded; null for one this does not decode. */
function decode(raw: string): string | null {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '\\') { out += raw[index]; continue; }
    const rest = raw.slice(index + 1);
    const braced = /^u\{([0-9a-fA-F]+)\}/.exec(rest), four = /^u([0-9a-fA-F]{4})/.exec(rest), two = /^x([0-9a-fA-F]{2})/.exec(rest);
    const escape = braced ?? four ?? two;
    if (escape) {
      // A code point past U+10FFFF is no character (String.fromCodePoint would throw): such a key is not read.
      const point = escape[1].length > 6 ? Infinity : parseInt(escape[1], 16);
      if (!(point <= 0x10ffff)) return null;
      out += String.fromCodePoint(point);
      index += escape[0].length;
      continue;
    }
    if (/^[^\dux\n]/.test(rest)) { out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' }[rest[0]] ?? rest[0]; index += 1; continue; }
    return null;
  }
  return out;
}

/** A property's value between `from` and `to` in the code: a whole literal, a number or a value the kit reads no shape
 *  from, or a const that holds a string. */
function valueOf(source: Source, from: number, to: number): Named {
  const raw = source.code.slice(from, to);
  const value = raw.trim();
  if (!value) return UNKNOWN;
  const start = from + raw.search(/\S/);
  const literal = wholeLiteral(source, start, start + value.length);
  if (literal !== null) return literal;
  // Values the kit reads no shape from (it takes `aspect || ''` as a string): the film then takes the frame's shape.
  // undefined and NaN are names a page could bind to something else: trusted only where nothing else names them.
  if (NUMBER.test(value) || (NO_SHAPE.test(value) && (!/^(?:undefined|NaN)$/.test(value) || mentions(source.bare, value) === 1))) return '';
  if (NAME.test(value)) return constantString(source, value);
  return UNKNOWN;
}

/** The text of the string or plain template literal that is all of code[start, end), or null. */
function wholeLiteral(source: Source, start: number, end: number): string | null {
  const quote = source.bare[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const close = quote === '`' ? endOfTemplate(source.code, start) : endOfString(source.code, start);
  if (close !== end - 1) return null;
  const inside = source.code.slice(start + 1, end - 1);
  return /[\\$]/.test(inside) ? null : inside;
}

/** The string literal held by a const `name`, declared at the top of the page's code, that is named only where it is
 *  declared and where it is read once; else UNKNOWN. (A string cannot change; a name used anywhere else, even as a
 *  property, may be another binding of it: a parameter, a destructured value, a global, a second declaration.) */
function constantString(source: Source, name: string): Named {
  if (mentions(source.bare, name) !== 2) return UNKNOWN;
  const value = soleConstant(source, name);
  if (value === null) return UNKNOWN;
  const quote = source.bare[value];
  if (quote !== "'" && quote !== '"' && quote !== '`') return UNKNOWN;
  const end = quote === '`' ? endOfTemplate(source.code, value) : endOfString(source.code, value);
  if (end < 0 || !endsDeclaration(source.bare, end + 1)) return UNKNOWN;
  return wholeLiteral(source, value, end + 1) ?? UNKNOWN;
}

/** Where the initializer of `name` starts, when the code declares that name once, as a const, at its top level (outside
 *  every block and bracket: a const in a block is not the name the film's description reads outside it), as its
 *  declaration's first name or a later one (`const BPM = 100, ASPECT = '9:16'`, as the guide declares its tempo). */
function soleConstant(source: Source, name: string): number | null {
  const declarations = Array.from(source.bare.matchAll(new RegExp(`(?:^|[^${NAME_PART}.])(const|let|var|function|class)\\s+${escapeName(name)}(?![${NAME_PART}])`, 'gu')));
  if (declarations.length > 1 || (declarations.length === 1 && declarations[0][1] !== 'const')) return null;
  // Measured at the keyword: the match can begin with the brace that opens the block the const is in ({const X=...}).
  const [keyword, end] = declarations.length
    ? [(declarations[0].index ?? 0) + declarations[0][0].indexOf(declarations[0][1]), (declarations[0].index ?? 0) + declarations[0][0].length]
    : laterDeclarator(source, name) ?? [-1, -1];
  if (keyword < 0 || depthAt(source.bare, keyword) !== 0) return null;
  const equals = /^\s*=\s*/.exec(source.bare.slice(end, end + 64));
  return equals ? end + equals[0].length : null;
}

/** The keyword const, standing alone (in `myconst`, `宽const` or `config.const` it is no keyword). */
const CONST_KEYWORD = new RegExp(String.raw`(?:^|[^${NAME_PART}.])const(?=\s)`, 'gu');

/** Where `name` stands as a later declarator of a top-level const declaration: that declaration's keyword and the end of
 *  the name. The one place the name is followed by '=' is such a declarator only where walking the declarators of the
 *  nearest top-level const before it reaches it: no other top-level const can stand between a declaration's keyword and
 *  its declarators (one in an initializer is inside a function's braces). Null for anything else: a let or var, an
 *  assignment, a default in a pattern, a name inside an initializer, a const in a block or a function. */
function laterDeclarator(source: Source, name: string): [number, number] | null {
  const { bare } = source;
  const sites = Array.from(bare.matchAll(new RegExp(`(?:^|[^${NAME_PART}.])${escapeName(name)}\\s*=(?![=>])`, 'gu')));
  if (sites.length !== 1) return null;
  const site = (sites[0].index ?? 0) + (sites[0][0].startsWith(name) ? 0 : 1);
  // The depth is counted on from one const keyword to the next, so the page is read once.
  let keyword = -1, depth = 0, counted = 0;
  for (const match of bare.matchAll(CONST_KEYWORD)) {
    const at = (match.index ?? 0) + match[0].length - 'const'.length;
    if (at >= site) break;
    // A property named const (`config.const`, `config?.const`, a space or a comment before it) is no keyword; after a
    // number's decimal point (`1.`) it is.
    if (propertyName(bare, at)) continue;
    for (; counted < at; counted += 1) {
      const char = bare[counted];
      if (char === '{' || char === '[' || char === '(') depth += 1;
      else if (char === '}' || char === ']' || char === ')') depth -= 1;
    }
    if (depth === 0) keyword = at;
  }
  return keyword >= 0 && declaratorAt(source, keyword, site) ? [keyword, site + name.length] : null;
}

/** Is the '.' at `dot` a number's decimal point (`1.`, `1_000.`), not a member access? The name-like run right before
 *  it must be a plain decimal integer, standing alone: not a fraction's digits (`1.5.x` reads x of 1.5), not a hex,
 *  exponent or BigInt literal (`1e2`, `0x1F`, `1n`: none takes a decimal point), not a name, nothing with a space
 *  before the dot, and not the digits of a signed exponent (`1e+2.x`), which a '+' or '-' after a whole mantissa's e
 *  (`1e`, `1.5e`, `.5e`) begins; after anything else (`Math.E+2.`, `value1e+2.`) the sign adds, and the integer
 *  after it is a number of its own. */
function decimalPoint(bare: string, dot: number): boolean {
  let start = dot;
  while (start > 0 && NAME_UNIT.test(bare[start - 1])) start -= 1;
  if (!/^\d[\d_]*$/.test(bare.slice(start, dot))) return false;
  const before = bare[start - 1] ?? '';
  if (before === '.') return false;
  if (before === '+' || before === '-') return !exponentSign(bare, start - 1);
  return true;
}

/** Does the '+' or '-' at `sign` follow a number's whole mantissa and its e, standing alone (`1e`, `1.5e`, `.5e`, no
 *  name or dot before it), so that it begins the exponent? The mantissa is read back to its own start, however long. */
function exponentSign(bare: string, sign: number): boolean {
  if (!/[eE]/.test(bare[sign - 1] ?? '')) return false;
  let start = sign - 1;
  while (start > 0 && /[\d_.]/.test(bare[start - 1])) start -= 1;
  // One way to match each character (the fraction's dot opens its own group), so a long run that is no mantissa fails
  // at once, never by retrying.
  return /^(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)$/.test(bare.slice(start, sign - 1)) && !NAME_UNIT.test(bare[start - 1] ?? '');
}

/** Do the declarators of the declaration whose keyword is at `keyword` reach `site`, one of them starting there? */
function declaratorAt(source: Source, keyword: number, site: number): boolean {
  const { bare } = source;
  let index = keyword + 'const'.length;
  for (;;) {
    index = skipSpace(bare, index);
    if (index >= site) return index === site;
    if (bare[index] === '{' || bare[index] === '[') {
      const close = closing(bare, index + 1);
      if (close < 0) return false;
      index = close + 1;
    } else {
      const word = NAME_AT.exec(bare.slice(index, index + 256));
      if (!word) return false;
      index += word[0].length;
    }
    index = skipSpace(bare, index);
    if (bare[index] !== '=') return false;
    const stop = initializerEnd(source, index + 1);
    if (stop < 0 || stop > site || bare[stop] !== ',') return false;
    index = stop + 1;
  }
}

/** in or instanceof at the start, standing alone: an operator that carries an expression on from the line before. */
const OPERATOR_WORD = new RegExp(String.raw`^(?:in|instanceof)(?![${NAME_PART}\ud800-\udfff])`, 'u');

/** Where the initializer starting at `from` ends: at a ',' or ';' of its own level, an outer closing bracket, or a line
 *  break before a new statement: a name or a '}' after it (not the operators in and instanceof), and the line not
 *  ending in a way that carries the expression on (carriesOn). Strings and templates are skipped whole (read in `code`,
 *  where they stand as written). -1 when a bracket or a literal in it does not close. */
function initializerEnd({ code, bare }: Source, from: number): number {
  for (let index = from; index < bare.length; index += 1) {
    const char = bare[index];
    if (char === "'" || char === '"' || char === '`') {
      const end = char === '`' ? endOfTemplate(code, index) : endOfString(code, index);
      if (end < 0) return -1;
      index = end;
    } else if (char === '{' || char === '[' || char === '(') {
      const close = closing(bare, index + 1);
      if (close < 0) return -1;
      index = close;
    } else if (char === ',' || char === ';' || char === '}' || char === ')' || char === ']') {
      return index;
    } else if (TERMINATED.test(char)) {
      const next = skipSpace(bare, index);
      const starts = (NAME_START.test(bare[next] ?? '') || bare[next] === '}') && !OPERATOR_WORD.test(bare.slice(next, next + 12));
      if (starts && !carriesOn(bare, index)) return index;
      index = next - 1;
    }
  }
  return bare.length;
}

/** Does the line that ends at `index` end in a way that carries an expression on to the next: an operator (a '/' that
 *  divides, not one that closes a pattern, which in `bare` is two slashes around spaces), a '.' (a member access's or
 *  a spread's, not a number's decimal point: `1.` ends its number), or one of BEFORE_PATTERN's words (typeof, in, ...)
 *  that is no property's name (`timing.in` is an operand)? */
function carriesOn(bare: string, index: number): boolean {
  const before = wordBefore(bare, index);
  const last = bare[before.end - 1] ?? '';
  if (last === '/') {
    const open = bare.lastIndexOf('/', before.end - 2);
    return !(open >= 0 && /^ +$/.test(bare.slice(open + 1, before.end - 1)));
  }
  if (last === '.') return !decimalPoint(bare, before.end - 1);
  return /[-+*%=<>&|^!~?:]/.test(last) || (BEFORE_PATTERN.has(before.word) && !propertyName(bare, before.start));
}

/** How many brackets are open at `index` in `bare` (which has no string or comment to mislead the count). */
function depthAt(bare: string, index: number): number {
  let depth = 0;
  for (let at = 0; at < index; at += 1) {
    const char = bare[at];
    if (char === '{' || char === '[' || char === '(') depth += 1;
    else if (char === '}' || char === ']' || char === ')') depth -= 1;
  }
  return depth;
}

/** How often `name` stands in the code as a name, a property (after a dot) included. */
function mentions(code: string, name: string): number {
  return Array.from(code.matchAll(new RegExp(`(?:^|[^${NAME_PART}])${escapeName(name)}(?![${NAME_PART}])`, 'gu'))).length;
}

/** Does what follows `from` end a declaration's initializer: a ';', a ',', the end, or a new line that starts a statement? */
function endsDeclaration(bare: string, from: number): boolean {
  const after = /^(\s*)(.?)/.exec(bare.slice(from));
  const next = after?.[2] ?? '';
  return !next || next === ';' || next === ',' || (after![1].includes('\n') && (NAME_START.test(next) || next === '}'));
}

/** The ranges of an object body's top-level properties, split at its own commas (`bare` has no string to mislead it), or
 *  null when its brackets do not close inside it. */
function topLevel(bare: string, start: number, end: number): Array<[number, number]> | null {
  const parts: Array<[number, number]> = [];
  let from = start;
  for (let index = start; index < end; index += 1) {
    const char = bare[index];
    if (char === '{' || char === '[' || char === '(') {
      const close = closing(bare, index + 1);
      if (close < 0 || close >= end) return null;
      index = close;
    } else if (char === ',') {
      parts.push([from, index]);
      from = index + 1;
    }
  }
  parts.push([from, end]);
  return parts;
}

/** The index of the bracket that closes the one just before `from` in `bare`, or -1. */
function closing(bare: string, from: number): number {
  const open = bare[from - 1];
  const stack = [open === '{' ? '}' : open === '[' ? ']' : ')'];
  for (let index = from; index < bare.length; index += 1) {
    const char = bare[index];
    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '(') stack.push(')');
    else if (char === '}' || char === ']' || char === ')') {
      if (stack.pop() !== char) return -1;
      if (!stack.length) return index;
    }
  }
  return -1;
}

function endOfString(code: string, from: number): number {
  const quote = code[from];
  for (let index = from + 1; index < code.length; index += 1) {
    if (code[index] === '\\') { index += 1; continue; }
    if (code[index] === quote) return index;
    if (code[index] === '\n' || code[index] === '\r') return -1;
  }
  return -1;
}

/** JavaScript's line terminators: a line comment ends at the first, and no pattern holds one. */
const LINE_TERMINATORS = '\n\r\u2028\u2029';

/** The index of the first line terminator at or after `from`, or -1. */
function lineEnd(code: string, from: number): number {
  for (let index = from; index < code.length; index += 1) if (LINE_TERMINATORS.includes(code[index])) return index;
  return -1;
}

/** Whether `code[index]` and the next character are a postfix ++ or -- (one after an operand, where `pattern` is false,
 *  on the operand's line): it ends the operand, so a '/' after it divides. With a line terminator between them
 *  (`newline`, one inside a comment too) JavaScript ends the statement before the ++ or --, a prefix of what follows. */
function postfix(code: string, index: number, pattern: boolean, newline: boolean): boolean {
  return !pattern && !newline && (code[index] === '+' || code[index] === '-') && code[index + 1] === code[index];
}

/** Does the text hold a line terminator? */
const TERMINATED = /[\n\r\u2028\u2029]/;

/** Templates nested deeper than this are not read (no film nests a handful), which keeps every scan of the page linear. */
const MAX_NESTING = 16;

/** The index of the backtick that ends the template literal at `from` (the code in its ${...} skipped whole), or -1. */
function endOfTemplate(code: string, from: number, nesting = 0): number {
  if (nesting > MAX_NESTING) return -1;
  for (let index = from + 1; index < code.length; index += 1) {
    if (code[index] === '\\') { index += 1; continue; }
    if (code[index] === '`') return index;
    if (code[index] === '$' && code[index + 1] === '{') {
      const end = endOfSubstitution(code, index + 2, nesting);
      if (end < 0) return -1;
      index = end;
    }
  }
  return -1;
}

/** The index of the '}' that ends the ${...} substitution whose code starts at `from`, or -1. Its code is read as split
 *  reads code: a '}' in one of its strings, templates, comments or regular expressions ends nothing. */
function endOfSubstitution(code: string, from: number, nesting = 0): number {
  let depth = 1;
  let pattern = true;
  let newline = false;   // a line terminator since the last token (see postfix)
  let member = false;    // the last token was a member access's '.' or a private name's '#' (see split)
  for (let index = from; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'") {
      const end = endOfString(code, index);
      if (end < 0) return -1;
      index = end;
      pattern = false;
      newline = false;
      member = false;
    } else if (char === '`') {
      const end = endOfTemplate(code, index, nesting + 1);
      if (end < 0) return -1;
      index = end;
      pattern = false;
      newline = false;
      member = false;
    } else if (char === '/' && (code[index + 1] === '/' || code[index + 1] === '*')) {
      const line = code[index + 1] === '/';
      const stop = line ? lineEnd(code, index) : code.indexOf('*/', index + 2);
      if (stop < 0) return -1;
      // A line comment ends at a line terminator (skipped with it here); a block comment may hold one.
      if (line || TERMINATED.test(code.slice(index + 2, stop))) newline = true;
      index = line ? stop : stop + 1;
    } else if (char === '/' && pattern && endOfPattern(code, index) > 0) {
      index = endOfPattern(code, index);
      pattern = false;
      newline = false;
      member = false;
    } else if (postfix(code, index, pattern, newline)) {
      index += 1;
    } else if (char === '.') {
      const dot = dotAt(code, index);
      if (dot === 'spread') index += 2;
      pattern = dot !== 'point';
      member = dot === 'member';
      newline = false;
    } else if (NAME_UNIT.test(char)) {
      let stop = index + 1;
      while (stop < code.length && NAME_UNIT.test(code[stop])) stop += 1;
      pattern = !member && BEFORE_PATTERN.has(code.slice(index, stop));
      member = false;
      newline = false;
      index = stop - 1;
    } else {
      if (char === '{') depth += 1;
      else if (char === '}' && (depth -= 1) === 0) return index;
      if (TERMINATED.test(char)) newline = true;
      else if (!/\s/.test(char)) { pattern = char !== ')' && char !== ']'; newline = false; member = char === '#'; }
    }
  }
  return -1;
}

/** What the '.' at `index` of the code is, as split reads it: the first of a spread's '...', a number's decimal point
 *  (`1.`, see decimalPoint), after which a '/' divides, or a member access ('.' or '?.'), whose next word (space or a
 *  comment between them) is a property's name, never a keyword: `timing.in / 2` divides. */
function dotAt(code: string, index: number): 'spread' | 'point' | 'member' {
  if (code.startsWith('...', index)) return 'spread';
  return decimalPoint(code, index) ? 'point' : 'member';
}

/** Is the word that starts at `start` in `bare` a name, not a keyword, as dotAt reads the code: a property's after a
 *  member access (`timing.in`, `x?.\n  get`, a comment between them), or a private one's after its '#' (`this.#in`)?
 *  After a spread's '...' or a number's decimal point (`1. in x`) a keyword is the keyword. */
function propertyName(bare: string, start: number): boolean {
  if (bare[start - 1] === '#') return true;
  const dot = wordBefore(bare, start).end - 1;
  return bare[dot] === '.' && !(bare[dot - 1] === '.' && bare[dot - 2] === '.') && !decimalPoint(bare, dot);
}

function skipSpace(code: string, from: number): number {
  let index = from;
  while (index < code.length && /\s/.test(code[index])) index += 1;
  return index;
}

function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$');
}

/** Words after which a '/' starts a regular expression, not a division. */
const BEFORE_PATTERN = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** Words after which a '[' opens an array or a computed key, not a member access: those after which a '/' starts a
 *  pattern, and the words a computed key or an exported value follows. */
const BEFORE_ARRAY = new Set([...BEFORE_PATTERN, 'default', 'extends', 'get', 'set', 'static', 'async']);

/** The page's code as `code` and `bare` (see Source), each exactly as long as the code: a comment becomes spaces (its
 *  line breaks kept), a regular expression keeps its two slashes around spaces, and in `bare` a string keeps its quotes
 *  around spaces, and a template literal its backticks and its ${...} code (split the same way) around spaces. A '/'
 *  starts a pattern where a parser would read one: at the start, after an operator, an opening bracket, a ',', ';', '}'
 *  or one of BEFORE_PATTERN; after a name, a number (its decimal point too: `1. / 2`) or a closing ')' or ']' it
 *  divides. One of BEFORE_PATTERN's words after a member access or a '#' is a name (see dotAt): `timing.in / 2`. */
function split(source: string): Source {
  let code = '';
  let bare = '';
  let pattern = true;
  let newline = false;   // a line terminator since the last token (see postfix)
  let member = false;    // the last token was a member access's '.' or a private name's '#': the next word is a name
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    // A string or a template that does not close (or nests too deep) is no page this can read: its text would be taken
    // for code (filmFrame catches this and keeps the page frame).
    if (char === '"' || char === "'") {
      const end = endOfString(source, index);
      if (end < 0) throw new Error('A string that does not close');
      const literal = source.slice(index, end + 1);
      code += literal;
      bare += char + blank(literal.slice(1, -1)) + char;
      index = end;
      pattern = false;
      newline = false;
      member = false;
      continue;
    }
    if (char === '`') {
      const end = endOfTemplate(source, index);
      if (end < 0) throw new Error('A template that does not close');
      const template = splitTemplate(source, index, end, blank);
      code += template.code;
      bare += template.bare;
      index = end;
      pattern = false;
      newline = false;
      member = false;
      continue;
    }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      const line = source[index + 1] === '/';
      const stop = line ? lineEnd(source, index) : source.indexOf('*/', index + 2);
      const end = stop < 0 ? source.length : line ? stop : stop + 2;
      const spaces = blank(source.slice(index, end));
      code += spaces;
      bare += spaces;
      // A block comment may hold a line terminator (a line comment's own comes after it, read as the next character).
      if (TERMINATED.test(source.slice(index, end))) newline = true;
      index = end - 1;
      continue;
    }
    if (char === '/' && pattern) {
      const end = endOfPattern(source, index);
      if (end > 0) {
        const emptied = `/${' '.repeat(end - index - 1)}/`;
        code += emptied;
        bare += emptied;
        index = end;
        pattern = false;
        newline = false;
        member = false;
        continue;
      }
    }
    if (NAME_UNIT.test(char)) {
      let stop = index + 1;
      while (stop < source.length && NAME_UNIT.test(source[stop])) stop += 1;
      const word = source.slice(index, stop);
      code += word;
      bare += word;
      index = stop - 1;
      pattern = !member && BEFORE_PATTERN.has(word);
      member = false;
      newline = false;
      continue;
    }
    if (char === '.') {
      const dot = dotAt(source, index);
      const dots = dot === 'spread' ? '...' : '.';
      code += dots;
      bare += dots;
      index += dots.length - 1;
      pattern = dot !== 'point';
      member = dot === 'member';
      newline = false;
      continue;
    }
    if (postfix(source, index, pattern, newline)) {
      code += source.slice(index, index + 2);
      bare += source.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (TERMINATED.test(char)) newline = true;
    else if (!/\s/.test(char)) { pattern = char !== ')' && char !== ']'; newline = false; member = char === '#'; }
    code += char;
    bare += char;
  }
  return { code, bare };
}

/** The template literal source[start..end] (its two backticks) split as `split` splits code: its text blanked in `bare`,
 *  the code of each ${...} kept and split in turn, so a call or a name in a substitution is seen. */
function splitTemplate(source: string, start: number, end: number, blank: (text: string) => string): Source {
  let code = '`';
  let bare = '`';
  for (let index = start + 1; index < end; index += 1) {
    if (source[index] === '\\') {
      const pair = source.slice(index, index + 2);
      code += pair;
      bare += blank(pair);
      index += 1;
      continue;
    }
    if (source[index] === '$' && source[index + 1] === '{') {
      const close = endOfSubstitution(source, index + 2);
      const inner = split(source.slice(index + 2, close));
      code += `\${${inner.code}}`;
      bare += `\${${inner.bare}}`;
      index = close;
      continue;
    }
    code += source[index];
    bare += blank(source[index]);
  }
  return { code: `${code}\``, bare: `${bare}\`` };
}

/** What reading a page's patterns may cost, in characters scanned, set by filmFrame for each page: a '/' that starts no
 *  pattern is scanned to its line's end, so a line of many such could cost the square of its length. Past it the page
 *  is one this cannot read (filmFrame keeps the page frame), never one that holds the preview up. */
let patternBudget = Infinity;

/** The index of the '/' that ends the pattern opened at `from` (a '/' inside a character class or escaped does not), or
 *  -1 when none does on its line. */
function endOfPattern(code: string, from: number): number {
  let inClass = false;
  for (let index = from + 1; index < code.length; index += 1) {
    if (--patternBudget < 0) throw new Error('A page whose patterns cost too much to read');
    const char = code[index];
    if (LINE_TERMINATORS.includes(char)) return -1;
    if (char === '\\') { index += 1; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return index;
  }
  return -1;
}
