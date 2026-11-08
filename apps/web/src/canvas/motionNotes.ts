// The free motion check on a delivered page (MOTION.md, "The free check"), as notes and nothing more: it reads the
// page's own source, never runs it, never refuses or repairs anything, and so also reads a held market or hand-in
// page. It is the page profile of scripts/motion-lint.mjs (the same engine, ported); both are tested against
// apps/motion-lint-vectors.json.
//
// It works on declarations, not lines: the page's code (comments removed; prose, data blocks and every attribute but
// style blanked) is cut at `;`, `{` and `}` with a stack that knows when it is inside @keyframes or a reduced-motion
// query, and .animate calls are read whole. What it says without judging taste: `transition: all` (written or
// implied); a layout property that animates; a page that moves things with no reduced-motion path; a film page's
// renderAt reading the clock or chance; and, only when the page declares motion tokens of its own, a curve or
// duration written in place beside them or a curve that is none of its own tokens. Every pass is linear, so a 2 MiB
// page stays fast.

export type MotionRule =
  | 'transition-all'
  | 'layout-property'
  | 'raw-curve'
  | 'off-language-curve'
  | 'raw-duration'
  | 'reduced-motion-missing'
  | 'render-clock';

export type MotionNote = { line: number; rule: MotionRule };

const RULE_ORDER: MotionRule[] = ['transition-all', 'layout-property', 'raw-curve', 'off-language-curve', 'raw-duration', 'reduced-motion-missing', 'render-clock'];
const NUM = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const FOUR = `\\(\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\)`;
const CSS_CURVE = new RegExp(`cubic-bezier${FOUR}`, 'gi');
const JS_CURVE_CALL = new RegExp(`(?<![\\w$.-])(?:Easing\\.bezier|bezierEasing|cubicBezier|bezier)${FOUR}`, 'g');
const JS_CURVE_ARRAY = new RegExp(`\\b(?:ease|easing|curve)\\s*:\\s*\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]`, 'g');
const FOUR_ARRAY = new RegExp(`\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]`, 'g');
const DECLARED_CURVE = new RegExp(`(?<![\\w-])--[\\w-]+\\s*:\\s*cubic-bezier${FOUR}`, 'gi');
const TOKEN_DECLARED = /(?<![\w-])--(?:dur|ease)-[\w-]+\s*:/;
const MOTION_OBJECT = /\bMOTION\s*(?::[^=;{}\n]{1,200})?=\s*\{/;
const TOKEN_OBJECT = /\b(MOTION|TUNE)\s*(?::[^=;{}\n]{1,200})?=\s*\{/g;
const ANIMATE_CALL = /\.animate\s*\(/g;
const TIME = /^(?:\d+(?:\.\d+)?|\.\d+)(ms|s)$/;
const LAYOUT = ['width', 'height', 'top', 'right', 'bottom', 'left', 'inset', 'min-width', 'max-width', 'min-height', 'max-height'];
const isLayout = (p: string) => LAYOUT.includes(p) || /^(?:margin|padding)(?:-[a-z]+)?$/.test(p) || /^inset-[a-z]+$/.test(p);
const isMoving = (p: string) => ['transform', 'translate', 'scale', 'rotate', 'background-position'].includes(p) || p.startsWith('offset') || isLayout(p);
const KEYWORD_CURVES: Record<string, number[]> = { ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };
const isKeyword = (word: string) => Object.prototype.hasOwnProperty.call(KEYWORD_CURVES, word);
const STEP_WORDS = new Set(['linear', 'step-start', 'step-end']);
const IGNORED_WORDS = new Set(['allow-discrete', 'normal', 'initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const DECL = /(?:^|[\s,{(;"'.])(['"]?)(transition(?:-property|-duration|-delay|-timing-function)?|transition(?:Property|Duration|Delay|TimingFunction)|animation(?:-duration|-delay|-timing-function)?|animation(?:Duration|Delay|TimingFunction))\1\s*[:=]\s*/g;
const LAYOUT_DECL = /(?:^|[\s,{;'"])['"]?(width|height|top|right|bottom|left|inset|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|min-width|max-width|min-height|max-height)['"]?\s*:/i;
const MOVING_DECL = /(?:^|[\s,{;'"])['"]?(transform|translate|scale|rotate|offset-[a-z-]+|width|height|top|right|bottom|left|inset|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?)['"]?\s*:/i;
const TRANSFORM_DECL = /(?:^|[\s,{;'".])['"]?(?:transform|translate|scale|rotate)['"]?\s*[:=]/;
const REDUCE_MEDIA = /@media[^{@]*prefers-reduced-motion\s*:\s*reduce/i;
// renderAt defined: on window or an alias of it (w.renderAt =), as a function, or as a binding.
const FILM_DEF = /\b[\w$]+\.renderAt\s*=(?!=)|\bfunction\s+renderAt\s*\(|(?<![\w$.])renderAt\s*=\s*(?:async\s*)?(?:\(|function\b|[\w$]+\s*=>)/g;
const CLOCK = /\bDate\.now\s*\(|\bperformance\.now\s*\(|\bnew Date\s*\(\s*\)|\bMath\.random\s*\(/g;
const EASING_STRING = /\b(?:ease|easing)['"]?\s*:\s*(['"`])([A-Za-z][\w.()-]{0,40})\1/g;
const REMOTION_EASING = /\bEasing\.(?:(?:in|out|inOut)\s*\(|(?:quad|cubic|sin|exp|circle|back|elastic|bounce|ease|poly)\b)/g;
const ALLOW = /motion-lint-allow\s+([a-z-]+(?:\s*,\s*[a-z-]+)*)\s*:/;
const ALLOW_FILE = /motion-lint-allow-file\s+([a-z-]+(?:\s*,\s*[a-z-]+)*)\s*:/g;
const JS_TYPES = /^(?:module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|text\/babel|text\/jsx)$/i;
/** The language's curve token names: `ease: 'enter'` names a token, not a library curve. */
const TOKEN_NAMES = new Set(['enter', 'move', 'exit', 'emphasis', 'linear']);

const curveKey = (c: (string | number)[]) => c.map((v) => Math.round(Number(v) * 1000) / 1000).join(',');

type Range = { name?: string; start: number; end: number };

/** Where a tag that starts at `from` (just after its `<`) ends: after its `>`, skipping quoted attribute values. */
function tagEnd(text: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, j + 1);
      if (end < 0) return text.length;
      j = end;
    } else if (c === '>') return j + 1;
  }
  return text.length;
}

/** The [start, end) ranges of a tag's style attribute values, read attribute by attribute (quotes respected). */
function styleValueRanges(tag: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = /^<\/?[a-zA-Z][\w-]*/.exec(tag)?.[0].length ?? 1;
  const n = tag.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(tag[i])) i++;
    if (i >= n || tag[i] === '>') break;
    const nameStart = i;
    while (i < n && !/[\s=>/]/.test(tag[i])) {
      if (tag[i] === '"' || tag[i] === "'") { const end = tag.indexOf(tag[i], i + 1); i = end < 0 ? n : end + 1; } else i++;
    }
    const name = tag.slice(nameStart, i).toLowerCase();
    while (i < n && /\s/.test(tag[i])) i++;
    if (tag[i] !== '=') continue;
    i++;
    while (i < n && /\s/.test(tag[i])) i++;
    let start = i;
    let end: number;
    if (tag[i] === '"' || tag[i] === "'") {
      start = i + 1;
      end = tag.indexOf(tag[i], start);
      if (end < 0) end = n;
      i = end + 1;
    } else {
      while (i < n && !/[\s>]/.test(tag[i])) i++;
      end = i;
    }
    if (name === 'style') ranges.push([start, end]);
  }
  return ranges;
}

/** The page's code at the same offsets: comments, prose, data blocks and attributes other than style become spaces. */
function prepareCode(text: string): string {
  const out = text.split('');
  const n = text.length;
  const lower = text.toLowerCase();
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  const keepStyleValues = (tag: string, offset: number) => {
    let from = 0;
    for (const [start, end] of styleValueRanges(tag)) {
      blank(offset + from, offset + start);
      from = end;
    }
    blank(offset + from, offset + tag.length);
  };
  let i = 0;
  let mode: 'text' | 'css' | 'script' | 'raw' = 'text';
  let quote = '';
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === 'text') {
      if (c === '<' && text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        const stop = end < 0 ? n : end + 3;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (c === '<' && /[a-zA-Z/!?]/.test(next ?? '')) {
        const stop = tagEnd(text, i + 1);
        const tag = text.slice(i, stop);
        const name = /^<\/?([a-zA-Z][\w-]*)/.exec(tag)?.[1]?.toLowerCase() ?? '';
        keepStyleValues(tag, i);
        i = stop;
        if (next !== '/' && name === 'style') mode = 'css';
        else if (next !== '/' && name === 'script') {
          const type = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i.exec(tag);
          const value = type ? (type[1] ?? type[2] ?? type[3] ?? '').trim() : '';
          mode = !value || JS_TYPES.test(value) ? 'script' : 'raw';
        }
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }
    if (c === '<' && next === '/' && lower.startsWith(mode === 'css' ? '</style' : '</script', i)) { mode = 'text'; quote = ''; continue; }
    if (mode === 'raw') { blank(i, i + 1); i++; continue; }
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (mode === 'script' && c === '/' && next === '/' && (i === 0 || /[\s;,(){}[\]=:]/.test(text[i - 1]))) {
      let end = text.indexOf('\n', i);
      if (end < 0) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (mode === 'script' && (c === '"' || c === "'" || c === '`')) quote = c;
    i++;
  }
  return out.join('');
}

/** The code with '...' and "..." string contents blanked (each ending at its line's end): code shown as text reads no clock. */
function blankStrings(code: string): string {
  const out = code.split('');
  const n = code.length;
  const frames: number[] = [];
  let mode: 'code' | 'string' | 'template' = 'code';
  let quote = '';
  for (let i = 0; i < n; i++) {
    const c = code[i];
    if (mode === 'code') {
      if (c === '"' || c === "'") { mode = 'string'; quote = c; }
      else if (c === '`') mode = 'template';
      else if (frames.length && c === '{') frames[frames.length - 1]++;
      else if (frames.length && c === '}') {
        if (frames[frames.length - 1] === 0) { frames.pop(); mode = 'template'; } else frames[frames.length - 1]--;
      }
      continue;
    }
    if (mode === 'string') {
      if (c === '\n') { mode = 'code'; continue; }
      if (c === '\\' && code[i + 1] !== '\n') { out[i] = ' '; out[i + 1] = ' '; i++; continue; }
      if (c === quote) mode = 'code';
      else out[i] = ' ';
      continue;
    }
    if (c === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i++; continue; }
    if (c === '`') { mode = 'code'; continue; }
    if (c === '$' && code[i + 1] === '{') { frames.push(0); mode = 'code'; i++; continue; }
    out[i] = ' ';
  }
  return out.join('');
}

/** The index of the bracket that closes the one at `open`, skipping quoted strings, or `stop - 1` if none does. */
function matchPair(code: string, open: number, stop: number): number {
  const o = code[open];
  const c = o === '(' ? ')' : o === '[' ? ']' : '}';
  let depth = 0;
  for (let k = open; k < stop; k++) {
    const ch = code[k];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = code.indexOf(ch, k + 1);
      if (end < 0 || end >= stop) return stop - 1;
      k = end;
    } else if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return stop - 1;
}

type Chunk = { start: number; text: string; prelude: boolean; inKeyframes: boolean; inReduce: boolean; isToken: boolean };

function chunksOf(code: string): Chunk[] {
  const chunks: Chunk[] = [];
  const stack: { keyframes: boolean; reduce: boolean }[] = [];
  let keyframes = 0;
  let reduce = 0;
  let start = 0;
  for (let i = 0; i <= code.length; i++) {
    const c = i < code.length ? code[i] : ';';
    if (c !== '{' && c !== '}' && c !== ';') continue;
    const text = code.slice(start, i);
    chunks.push({ start, text, prelude: c === '{', inKeyframes: keyframes > 0, inReduce: reduce > 0, isToken: /^\s*--[\w-]+\s*:/.test(text) });
    if (c === '{') {
      const frame = { keyframes: /@(?:-webkit-)?keyframes\b/.test(text), reduce: REDUCE_MEDIA.test(text) };
      stack.push(frame);
      if (frame.keyframes) keyframes++;
      if (frame.reduce) reduce++;
    } else if (c === '}') {
      const frame = stack.pop();
      if (frame?.keyframes) keyframes--;
      if (frame?.reduce) reduce--;
    }
    start = i + 1;
  }
  return chunks;
}

function objectRanges(code: string): Range[] {
  const ranges: Range[] = [];
  for (const m of code.matchAll(TOKEN_OBJECT)) {
    const at = m.index ?? 0;
    if (ranges.length && at <= ranges[ranges.length - 1].end) continue;
    ranges.push({ name: m[1], start: at, end: matchPair(code, at + m[0].length - 1, code.length) });
  }
  return ranges;
}

function inRanges(ranges: Range[], offset: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < ranges[mid].start) hi = mid - 1;
    else if (offset > ranges[mid].end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** For every `(`, `[` and `{`, the offset of the one that closes it (-1 when none does), in one pass. */
function bracketPairs(code: string): Int32Array {
  const pairs = new Int32Array(code.length).fill(-1);
  const stacks: Record<string, number[]> = { '(': [], '[': [], '{': [] };
  const opener: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') stacks[c].push(i);
    else if (c === ')' || c === ']' || c === '}') {
      const open = stacks[opener[c]].pop();
      if (open !== undefined) pairs[open] = i;
    }
  }
  return pairs;
}

/** Every named function in the code, by name (the first definition of each): `function f(` and `const f =`. */
function definitionIndex(code: string): Map<string, number> {
  const index = new Map<string, number>();
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = m[1] ?? m[2];
    const at = m.index ?? 0;
    if (!index.has(name)) index.set(name, m[1] !== undefined ? at + m[0].length - 1 : at + m[0].length);
  }
  return index;
}

function mergeRanges(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

type Body = Range & { alias?: boolean };
type Names = { resolved: Map<string, Body | null>; index: () => Map<string, number>; pairs: () => Int32Array };

/** The body of the function whose definition continues at `from` (after `=`, or at a parameter list). */
function functionBody(code: string, from: number, names: Names, hops = 0): Body | null {
  const n = code.length;
  let i = from;
  const ws = () => { while (i < n && /\s/.test(code[i])) i++; };
  ws();
  if (code.startsWith('async', i) && !/[\w$]/.test(code[i + 5] ?? '')) { i += 5; ws(); }
  if (code.startsWith('function', i) && !/[\w$]/.test(code[i + 8] ?? '')) {
    i += 8;
    ws();
    if (code[i] === '*') { i++; ws(); }
    while (i < n && /[\w$]/.test(code[i])) i++;
    ws();
  }
  const pairs = names.pairs();
  const close = (at: number) => (pairs[at] < 0 ? n - 1 : pairs[at]);
  if (code[i] === '(') {
    i = close(i) + 1;
    ws();
    if (code.startsWith('=>', i)) { i += 2; ws(); }
  } else if (/[\w$]/.test(code[i] ?? '')) {
    const idStart = i;
    while (i < n && /[\w$.]/.test(code[i])) i++;
    const id = code.slice(idStart, i);
    ws();
    if (code.startsWith('=>', i)) { i += 2; ws(); }
    else {
      if (hops > 0 || !/^[A-Za-z_$][\w$]*$/.test(id)) return null;
      if (!names.resolved.has(id)) {
        const at = names.index().get(id);
        const body = at === undefined ? null : functionBody(code, at, names, hops + 1);
        names.resolved.set(id, body && { ...body, alias: true });
      }
      return names.resolved.get(id) ?? null;
    }
  } else return null;
  if (code[i] === '{') return { start: i, end: close(i) };
  let j = i;
  for (; j < n; j++) {
    const ch = code[j];
    if (ch === '(' || ch === '[' || ch === '{') j = close(j);
    else if (ch === ')' || ch === ']' || ch === '}' || ch === ';' || ch === '\n') break;
  }
  return { start: i, end: Math.min(j, n - 1) };
}

/** Whether the code defines renderAt, and every body that draws a frame, as sorted, merged ranges (linear). */
function renderBodies(code: string): { film: boolean; ranges: Range[] } {
  const ranges: Range[] = [];
  let film = false;
  let covered = -1;
  let index: Map<string, number> | null = null;
  let pairs: Int32Array | null = null;
  const names: Names = { resolved: new Map(), index: () => (index ??= definitionIndex(code)), pairs: () => (pairs ??= bracketPairs(code)) };
  for (const m of code.matchAll(FILM_DEF)) {
    film = true;
    const at = m.index ?? 0;
    if (at <= covered) continue;
    const from = m[0].startsWith('function') ? at + m[0].length - 1 : at + m[0].indexOf('=') + 1;
    const body = functionBody(code, from, names);
    if (!body) continue;
    ranges.push(body);
    if (!body.alias && body.start > at) covered = Math.max(covered, body.end);
  }
  return { film, ranges: mergeRanges(ranges) };
}

function declValue(text: string, from: number, limit: number) {
  const q = text[from];
  const stop = Math.min(limit, from + 4000);
  if (q === '"' || q === "'" || q === '`') {
    const end = text.indexOf(q, from + 1);
    return { value: text.slice(from + 1, end < 0 || end > stop ? stop : end), quoted: true };
  }
  return { value: text.slice(from, stop), quoted: false };
}

function splitTop(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) { items.push(value.slice(start, i)); start = i + 1; }
  }
  items.push(value.slice(start));
  return items.map((s) => s.trim()).filter(Boolean);
}

type Word = { word: string; fn?: undefined; args?: undefined } | { fn: string; args: string; word?: undefined };

function wordsOf(item: string): Word[] {
  const words: Word[] = [];
  let i = 0;
  while (i < item.length) {
    if (/\s/.test(item[i])) { i++; continue; }
    let j = i;
    while (j < item.length && !/[\s(]/.test(item[j])) j++;
    if (item[j] === '(') {
      let depth = 0;
      let k = j;
      for (; k < item.length; k++) {
        if (item[k] === '(') depth++;
        else if (item[k] === ')') { depth--; if (depth === 0) break; }
      }
      words.push({ fn: item.slice(i, j).toLowerCase(), args: item.slice(j + 1, k) });
      i = k + 1;
    } else {
      words.push({ word: item.slice(i, j).toLowerCase() });
      i = j;
    }
  }
  return words;
}

const msOf = (word: string) => (word.endsWith('ms') ? Number(word.slice(0, -2)) : Number(word.slice(0, -1)) * 1000);
const TIMING_PARTS = new Set(['dur', 'duration', 'ease', 'easing', 'curve']);
const timingVar = (args: string) => args.split(',')[0].trim().replace(/^--/, '').split('-').some((part) => TIMING_PARTS.has(part));

function readTransitionItem(item: string) {
  let property = '';
  let timing = false;
  let unknown = false;
  const times: number[] = [];
  const keywords: string[] = [];
  for (const w of wordsOf(item)) {
    if (w.fn !== undefined) {
      if (w.fn === 'var') {
        if (timingVar(w.args)) timing = true;
        else unknown = true;
      } else if (w.fn === 'cubic-bezier' || w.fn === 'steps' || w.fn === 'linear') timing = true;
      else unknown = true;
      continue;
    }
    if (TIME.test(w.word)) { times.push(msOf(w.word)); timing = true; continue; }
    if (isKeyword(w.word)) { keywords.push(w.word); timing = true; continue; }
    if (STEP_WORDS.has(w.word)) { timing = true; continue; }
    if (IGNORED_WORDS.has(w.word)) continue;
    if (w.word === 'none') return { property: 'none', implicit: false, times, keywords, unknown: false };
    if (!property) property = w.word;
  }
  if (!property && timing && !unknown) return { property: 'all', implicit: true, times, keywords, unknown };
  return { property, implicit: false, times, keywords, unknown: !property && unknown };
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The motion notes for one delivered page's source, in line order. */
export function motionNotes(source: string): MotionNote[] {
  const code = prepareCode(source);
  // renderAt and the clock never read text: code shown as a string is not run.
  const plain = blankStrings(code);
  const render = renderBodies(plain);
  const rawLines = source.split('\n');
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const fileAllowed = new Set<string>();
  for (const match of source.matchAll(ALLOW_FILE)) for (const rule of match[1].split(',')) fileAllowed.add(rule.trim());
  const tokenRules = TOKEN_DECLARED.test(code) || MOTION_OBJECT.test(code);
  const declared = objectRanges(code);
  const motionOnly = declared.filter((r) => r.name === 'MOTION');
  const curves: { at: number; curve: string[]; bracket: number }[] = [];
  for (const pattern of [CSS_CURVE, JS_CURVE_CALL, JS_CURVE_ARRAY]) {
    for (const m of code.matchAll(pattern)) {
      const at = m.index ?? 0;
      curves.push({ at, curve: [m[1], m[2], m[3], m[4]], bracket: pattern === JS_CURVE_ARRAY ? at + m[0].indexOf('[') : -1 });
    }
  }
  const brackets = new Set(curves.map((c) => c.bracket));
  for (const r of motionOnly) {
    for (const m of code.slice(r.start, r.end + 1).matchAll(FOUR_ARRAY)) {
      const at = r.start + (m.index ?? 0);
      if (!brackets.has(at)) curves.push({ at, curve: [m[1], m[2], m[3], m[4]], bracket: at });
    }
  }
  const own = [...code.matchAll(DECLARED_CURVE)].map((m) => curveKey([m[1], m[2], m[3], m[4]]));
  for (const c of curves) if (inRanges(motionOnly, c.at)) own.push(curveKey(c.curve));
  const language = own.length ? new Set(own) : null;
  const reducedPath = /prefers-reduced-motion/.test(code);
  const notes: MotionNote[] = [];
  const seen = new Set<string>();
  const lineAllows = new Map<number, string[]>();

  const allowsOn = (at: number) => {
    let rules = lineAllows.get(at);
    if (!rules) {
      const m = at >= 0 ? ALLOW.exec(rawLines[at] ?? '') : null;
      rules = m ? m[1].split(',').map((s) => s.trim()) : [];
      lineAllows.set(at, rules);
    }
    return rules;
  };
  const allowedAt = (index: number, rule: MotionRule) => fileAllowed.has(rule) || fileAllowed.has('all')
    || [index, index - 1].some((at) => allowsOn(at).some((r) => r === rule || r === 'all'));
  const add = (index: number, rule: MotionRule) => {
    const key = `${index}:${rule}`;
    if (seen.has(key) || allowedAt(index, rule)) return;
    seen.add(key);
    notes.push({ line: index + 1, rule });
  };

  const chunks = chunksOf(code);
  const chunkAt = (offset: number) => {
    let lo = 0;
    let hi = chunks.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (chunks[mid].start <= offset) lo = mid; else hi = mid - 1; }
    return chunks[lo];
  };
  const isFallback = (at: number) => {
    const floor = Math.max(0, at - 200);
    let k = at - 1;
    while (k >= floor && /\s/.test(code[k])) k--;
    if (code[k] !== ',') return false;
    k--;
    while (k >= floor && /\s/.test(code[k])) k--;
    const end = k;
    while (k >= floor && /[\w-]/.test(code[k])) k--;
    if (end - k < 3 || code[k + 1] !== '-' || code[k + 2] !== '-') return false;
    while (k >= floor && /\s/.test(code[k])) k--;
    return code[k] === '(' && code.slice(Math.max(0, k - 3), k) === 'var';
  };
  const curveUse = (at: number, curve: (string | number)[]) => {
    const line = lineOf(at);
    if (language && !language.has(curveKey(curve))) add(line, 'off-language-curve');
    if (tokenRules && !chunkAt(at).isToken && !isFallback(at) && !inRanges(declared, at)) add(line, 'raw-curve');
  };
  const libraryCurve = (at: number) => {
    const line = lineOf(at);
    if (language) add(line, 'off-language-curve');
    if (tokenRules && !inRanges(declared, at)) add(line, 'raw-curve');
  };
  let firstMotion = -1;
  let firstMaybe = -1;
  const moved = (index: number) => { if (firstMotion < 0 || index < firstMotion) firstMotion = index; };
  const maybeMoved = (index: number) => { if (firstMaybe < 0 || index < firstMaybe) firstMaybe = index; };

  for (const chunk of chunks) {
    if (chunk.prelude || !chunk.text.trim()) continue;
    if (chunk.inKeyframes) {
      const layout = LAYOUT_DECL.exec(chunk.text);
      if (layout) add(lineOf(chunk.start + layout.index + layout[0].indexOf(layout[1])), 'layout-property');
      const moving = MOVING_DECL.exec(chunk.text);
      if (moving && !chunk.inReduce) moved(lineOf(chunk.start + moving.index));
    }
    const decls = [...chunk.text.matchAll(DECL)];
    for (let d = 0; d < decls.length; d++) {
      const m = decls[d];
      const index = m.index ?? 0;
      const name = kebab(m[2]);
      const at = chunk.start + index + m[0].indexOf(m[2]);
      const line = lineOf(at);
      const limit = d + 1 < decls.length ? (decls[d + 1].index ?? chunk.text.length) : chunk.text.length;
      const { value, quoted } = declValue(chunk.text, index + m[0].length, limit);
      if (!quoted && /[A-Z]/.test(m[2])) continue;
      const kind = name.startsWith('transition') ? 'transition' : 'animation';
      const part = name.slice(kind.length + 1);
      const items = splitTop(value);
      const keywords: string[] = [];
      const properties: { property: string; implicit: boolean }[] = [];
      if (kind === 'transition' && part === '') {
        for (const item of items) {
          const read = readTransitionItem(item);
          keywords.push(...read.keywords);
          if (read.property === 'none' || read.unknown) continue;
          properties.push({ property: read.property, implicit: read.implicit });
        }
      } else if (part === 'property') {
        for (const item of items) properties.push({ property: item.toLowerCase(), implicit: false });
      } else if (part === 'timing-function' || (kind === 'animation' && part === '')) {
        for (const item of items) for (const w of wordsOf(item)) if (w.word !== undefined && isKeyword(w.word)) keywords.push(w.word);
      }
      for (const { property } of properties) {
        if (property === 'all') {
          add(line, 'transition-all');
          if (!chunk.inReduce) maybeMoved(line);
        } else {
          if (isLayout(property)) add(line, 'layout-property');
          if (isMoving(property) && !chunk.inReduce) moved(line);
        }
      }
      for (const word of keywords) curveUse(at, KEYWORD_CURVES[word]);
      if (tokenRules && !chunk.isToken && !chunk.inReduce && part !== 'property' && part !== 'timing-function') {
        const literal = items.flatMap((item) => (kind === 'transition' && part === ''
          ? readTransitionItem(item).times
          : wordsOf(item).filter((w): w is { word: string } => w.word !== undefined && TIME.test(w.word)).map((w) => msOf(w.word))));
        if (literal.some((ms) => ms > 1)) add(line, 'raw-duration');
      }
    }
  }

  for (const c of curves) curveUse(c.at, c.curve);
  for (const m of code.matchAll(EASING_STRING)) {
    const word = m[2];
    const lowered = word.toLowerCase();
    if (lowered === 'linear' || lowered === 'none' || /^steps?\b|^step-/.test(lowered) || TOKEN_NAMES.has(word)) continue;
    if (isKeyword(lowered)) curveUse(m.index ?? 0, KEYWORD_CURVES[lowered]);
    else libraryCurve(m.index ?? 0);
  }
  for (const m of code.matchAll(REMOTION_EASING)) libraryCurve(m.index ?? 0);

  const animates = [...code.matchAll(ANIMATE_CALL)];
  for (let a = 0; a < animates.length; a++) {
    const start = animates[a].index ?? 0;
    const open = start + animates[a][0].length - 1;
    const stop = a + 1 < animates.length ? (animates[a + 1].index ?? code.length) : code.length;
    const span = code.slice(open, matchPair(code, open, Math.min(stop, open + 8000)) + 1);
    const line = lineOf(start);
    if (LAYOUT_DECL.test(span)) add(line, 'layout-property');
    if (/\b(?:transform|translate|scale|rotate)\b/.test(span)) moved(line);
    if (tokenRules && !inRanges(declared, start) && /\bduration\s*:\s*\d/.test(span)) add(line, 'raw-duration');
  }

  if (render.film) {
    for (const m of plain.matchAll(CLOCK)) {
      const at = m.index ?? 0;
      if (inRanges(render.ranges, at)) add(lineOf(at), 'render-clock');
    }
  }

  let motionAt = firstMotion;
  if (firstMaybe >= 0 && (motionAt < 0 || firstMaybe < motionAt) && TRANSFORM_DECL.test(code)) motionAt = firstMaybe;
  if (motionAt >= 0 && !reducedPath && !render.film) add(motionAt, 'reduced-motion-missing');
  return notes.sort((a, b) => a.line - b.line || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
}
