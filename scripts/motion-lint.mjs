#!/usr/bin/env node
// AwwO's free motion check (MOTION.md, "The free check"). It reads apps/motion-tokens.json (or --tokens <file>) and
// reports, file by file, the drift a script can see without judging taste: `transition: all` (written or implied),
// layout properties that animate, curves written in place (numbers, CSS keywords such as ease-in-out, a library's
// named easings) or outside the language, durations and springs written by hand, a page that moves things with no
// reduced-motion path, and a film that reads the clock or chance while it draws a frame. It never runs what it reads.
//
// It works on declarations, not lines: the code (comments removed; in an HTML page, prose and every attribute but
// style blanked) is cut at `;`, `{` and `}` with a stack that knows when it is inside @keyframes or a reduced-motion
// query, and object literals (springs, .animate options) are read whole, so minified CSS and values over several
// lines are read alike. Every pass is linear in the input.
//
// strict (the default) is for code people and kits keep: the language's curves, every rule, exit 1 on any finding
// the baseline does not cover. page is for a delivered page: it is held to the curve tokens it declares itself (none
// when it declares none), the token rules apply only when it declares tokens, there are no spring or file-name rules,
// every finding is a note and the exit code stays 0. A film page (one that defines renderAt) is held to the clock
// rule inside renderAt: a player loop around it may read the clock. --video holds every file to it (a Remotion or
// shotcraft project, whose helpers also run for every frame).
//
// A line may break a rule on purpose with `motion-lint-allow <rule>[, <rule>]: <reason>` on that line or the line
// above; `motion-lint-allow-file <rule>: <reason>` anywhere covers the whole file. A baseline lists known findings by
// rule and text, not by file, so code that moves keeps its allowance and a new finding fails where it was added;
// --prune-baseline lowers it once drift is fixed and never raises a count. Exit codes: 0 clean, 1 findings, 2 usage.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `node scripts/motion-lint.mjs [options] <files or folders>
  --profile strict|page     strict (default): the language, every rule, exit 1; page: a delivered page, notes only
  --video                   every file is part of a film: no file may read the clock or chance
  --tokens <file>           another motion language (the same shape as apps/motion-tokens.json)
  --ignore <path part>      leave out files under this path (repeatable; either slash)
  --baseline <file>         fail only on findings the baseline does not list
  --prune-baseline <file>   lower the baseline's counts to the code's (it never raises one), then check
  --write-baseline <file>   write a new baseline (--force to replace one; never to make the check pass)
  --json                    print { files, findings, failing, stale, skipped }
  --report                  exit 0 even with findings
`;

export const RULES = [
  'transition-all',
  'layout-property',
  'raw-curve',
  'off-language-curve',
  'raw-duration',
  'raw-spring',
  'reduced-motion-missing',
  'render-clock',
  'fps-literal',
];

const MESSAGES = {
  'transition-all': 'Never transition: all; name the properties (transform, opacity).',
  'layout-property': 'Animates a layout property; move with transform and opacity instead.',
  'raw-curve': 'A curve written in place: use a curve token (--ease-enter / move / exit / emphasis, or MOTION.ease.*).',
  'off-language-curve': 'This curve is not in the motion language (no token, no character preset).',
  'raw-duration': 'A raw duration: use a duration token (--dur-fast / base / slow / scene, or MOTION.dur.*).',
  'raw-spring': 'Spring numbers written by hand: use a named spring (snappy, sheet, land, glide, bounce).',
  'reduced-motion-missing': 'Moves things with no prefers-reduced-motion path in CSS or script.',
  'render-clock': 'A film reads the clock or chance while it draws a frame; every frame must follow from the time alone.',
  'fps-literal': 'A frame rate written into a spring; take fps from the composition.',
};

const SEVERITY = {
  'transition-all': 'fix', 'layout-property': 'fix', 'raw-curve': 'fix', 'off-language-curve': 'fix',
  'raw-duration': 'fix', 'raw-spring': 'fix', 'reduced-motion-missing': 'fix', 'render-clock': 'block',
  'fps-literal': 'fix',
};

const TEXT_EXTENSIONS = new Set(['.css', '.scss', '.html', '.htm', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-saas', 'build', 'out', 'coverage', '.next', '.turbo', '.cache']);
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const NUM = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const FOUR = `\\(\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\)`;
const CSS_CURVE = new RegExp(`cubic-bezier${FOUR}`, 'gi');
const JS_CURVE_CALL = new RegExp(`(?<![\\w$.-])(?:Easing\\.bezier|bezierEasing|cubicBezier|bezier)${FOUR}`, 'g');
const JS_CURVE_ARRAY = new RegExp(`\\b(?:ease|easing|curve)\\s*:\\s*\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]`, 'g');
const FOUR_ARRAY = new RegExp(`\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]`, 'g');
// Every pattern that can start inside a run of its own characters is anchored so the run is read once, not from
// each of its characters (a page of `--dur---dur-...` must not take minutes).
const DECLARED_CURVE = new RegExp(`(?<![\\w-])--[\\w-]+\\s*:\\s*cubic-bezier${FOUR}`, 'gi');
const TOKEN_DECLARED = /(?<![\w-])--(?:dur|ease)-[\w-]+\s*:/;
const MOTION_OBJECT = /\bMOTION\s*(?::[^=;{}\n]{1,200})?=\s*\{/;
const TOKEN_OBJECT = /\b(MOTION|TUNE)\s*(?::[^=;{}\n]{1,200})?=\s*\{/g;
const SPRING_KEY = new RegExp(`\\b(stiffness|damping|mass|tension|friction)['"]?\\s*:\\s*(${NUM})`, 'g');
const SPRING_AT = new RegExp(`\\b(?:springAt|F\\.spring|spring)\\s*\\(\\s*[\\w.]+\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\)`, 'g');
const SPRING_CALL = /\bspring\s*\(\s*\{/g;
const ANIMATE_CALL = /\.animate\s*\(/g;
const TIME = /^(?:\d+(?:\.\d+)?|\.\d+)(ms|s)$/;
const LAYOUT = ['width', 'height', 'top', 'right', 'bottom', 'left', 'inset', 'min-width', 'max-width', 'min-height', 'max-height'];
const isLayout = (p) => LAYOUT.includes(p) || /^(?:margin|padding)(?:-[a-z]+)?$/.test(p) || /^inset-[a-z]+$/.test(p);
const isMoving = (p) => ['transform', 'translate', 'scale', 'rotate', 'background-position'].includes(p) || p.startsWith('offset') || isLayout(p);
/** The CSS timing keywords that are curves, as the browser defines them. linear is the language's own linear. */
const KEYWORD_CURVES = { ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };
const STEP_WORDS = new Set(['linear', 'step-start', 'step-end']);
const IGNORED_WORDS = new Set(['allow-discrete', 'normal', 'initial', 'inherit', 'unset', 'revert', 'revert-layer']);
// A transition or animation declaration, in CSS or as a script property (quoted, camel-cased or assigned).
const DECL = /(?:^|[\s,{(;"'.])(['"]?)(transition(?:-property|-duration|-delay|-timing-function)?|transition(?:Property|Duration|Delay|TimingFunction)|animation(?:-duration|-delay|-timing-function)?|animation(?:Duration|Delay|TimingFunction))\1\s*[:=]\s*/g;
const LAYOUT_DECL = /(?:^|[\s,{;'"])['"]?(width|height|top|right|bottom|left|inset|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|min-width|max-width|min-height|max-height)['"]?\s*:/i;
const MOVING_DECL = /(?:^|[\s,{;'"])['"]?(transform|translate|scale|rotate|offset-[a-z-]+|width|height|top|right|bottom|left|inset|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?)['"]?\s*:/i;
const TRANSFORM_DECL = /(?:^|[\s,{;'".])['"]?(?:transform|translate|scale|rotate)['"]?\s*[:=]/;
const REDUCE_MEDIA = /@media[^{@]*prefers-reduced-motion\s*:\s*reduce/i;
// renderAt defined: on window or an alias of it (w.renderAt =), as a function, or as a binding.
const FILM_DEF = /\b[\w$]+\.renderAt\s*=(?!=)|\bfunction\s+renderAt\s*\(|(?<![\w$.])renderAt\s*=\s*(?:async\s*)?(?:\(|function\b|[\w$]+\s*=>)/g;
const CLOCK = /\bDate\.now\s*\(|\bperformance\.now\s*\(|\bnew Date\s*\(\s*\)|\bMath\.random\s*\(/g;
const REMOTION = /from\s+['"]remotion['"]|from\s+['"]@remotion\//;
// An easing given by name in script: WAAPI's easing: 'ease-in', Motion's ease: 'easeOut', GSAP's ease: 'power2.out'.
const EASING_STRING = /\b(?:ease|easing)['"]?\s*:\s*(['"`])([A-Za-z][\w.()-]{0,40})\1/g;
// Remotion's named easings (Easing.bezier with numbers is read as a curve; Easing.linear is the linear token).
const REMOTION_EASING = /\bEasing\.(?:(?:in|out|inOut)\s*\(|(?:quad|cubic|sin|exp|circle|back|elastic|bounce|ease|poly)\b)/g;
const ALLOW = /motion-lint-allow\s+([a-z-]+(?:\s*,\s*[a-z-]+)*)\s*:/;
const ALLOW_FILE = /motion-lint-allow-file\s+([a-z-]+(?:\s*,\s*[a-z-]+)*)\s*:/g;
const JS_TYPES = /^(?:module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|text\/babel|text\/jsx)$/i;

export function loadTokens(path = fileURLToPath(new URL('../apps/motion-tokens.json', import.meta.url))) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every curve the language names: the ease tokens and each character preset's entrance. */
export function languageCurves(tokens) {
  const curves = Object.values(tokens.ease).map((entry) => entry.curve);
  for (const [name, preset] of Object.entries(tokens.character ?? {})) if (name !== 'about') curves.push(preset.enter);
  return curves;
}

/** A curve's key for set lookups: its four numbers rounded to three places. */
const curveKey = (c) => c.map((v) => Math.round(Number(v) * 1000) / 1000).join(',');

function namedSpring(stiffness, damping, tokens) {
  for (const [name, s] of Object.entries(tokens.spring)) {
    if (Math.abs(s.stiffness - stiffness) <= Math.max(1, s.stiffness * 0.01) && Math.abs(s.damping - damping) <= Math.max(0.2, s.damping * 0.01)) return name;
  }
  return '';
}

function namedSpringZS(zeta, settle, tokens) {
  for (const [name, s] of Object.entries(tokens.spring)) if (Math.abs(s.zeta - zeta) <= 0.01 && Math.abs(s.settle - settle) <= 0.01) return name;
  return '';
}

/**
 * The code a rule may read, at the same offsets as the source (so line numbers hold): comments become spaces and, in
 * an HTML page, so does every character outside <style> and script <script> elements, except a tag's style
 * attribute values (prose, other attributes and data blocks are not code).
 */
export function prepareCode(text, { css = false, html = false, scss = false } = {}) {
  const out = text.split('');
  const n = text.length;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  let i = 0;
  let mode = html ? 'text' : css ? 'css' : 'script';
  let quote = '';
  const lower = html ? text.toLowerCase() : '';
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
        keepStyleValues(tag, i, blank);
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
    if (html && c === '<' && next === '/' && lower.startsWith(mode === 'css' ? '</style' : '</script', i)) { mode = 'text'; quote = ''; continue; }
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
    const lineComment = mode === 'script'
      ? i === 0 || /[\s;,(){}[\]=:]/.test(text[i - 1])
      : scss && (i === 0 || /[\s;{}]/.test(text[i - 1]));
    if (c === '/' && next === '/' && lineComment) {
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

/**
 * The code with the contents of '...' and "..." strings blanked, each string ending at its line's end, for the rules
 * that never read text (the clock, springs): code shown as text, as a tutorial or a film shows it, reads nothing.
 * Template literals are kept, since an expression inside `${...}` runs.
 */
export function blankStrings(code, { keys = false } = {}) {
  const out = code.split('');
  const n = code.length;
  // Inside a template, each open ${...} is a frame holding its own brace depth.
  const frames = [];
  let mode = 'code';
  let quote = '';
  let start = 0;
  for (let i = 0; i < n; i++) {
    const c = code[i];
    if (mode === 'code') {
      if (c === '"' || c === "'") { mode = 'string'; quote = c; start = i + 1; }
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
      if (c !== quote) { out[i] = ' '; continue; }
      mode = 'code';
      // With keys, a quoted property name ({"stiffness": 300}) keeps its letters: it sits after `{` or `,` and before
      // `:` (a ternary's operand or a case label does not). Only the spring rule reads this view.
      if (keys) {
        let k = i + 1;
        while (k < n && /\s/.test(code[k])) k++;
        let b = start - 2;
        while (b >= 0 && /\s/.test(code[b])) b--;
        if (code[k] === ':' && (code[b] === '{' || code[b] === ',')) for (let j = start; j < i; j++) out[j] = code[j];
      }
      continue;
    }
    // Template text: blanked, its line breaks too (lines are counted on the code, not on this view).
    if (c === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i++; continue; }
    if (c === '`') { mode = 'code'; continue; }
    if (c === '$' && code[i + 1] === '{') { frames.push(0); mode = 'code'; i++; continue; }
    out[i] = ' ';
  }
  return out.join('');
}

/** Where a tag that starts at `from` (just after its `<`) ends: after its `>`, skipping quoted attribute values. */
function tagEnd(text, from) {
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
export function styleValueRanges(tag) {
  const ranges = [];
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
    let end;
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

/** Blanks a tag (at `offset`) except the values of its style attributes. */
function keepStyleValues(tag, offset, blank) {
  let from = 0;
  for (const [start, end] of styleValueRanges(tag)) {
    blank(offset + from, offset + start);
    from = end;
  }
  blank(offset + from, offset + tag.length);
}

/** The index of the bracket that closes the one at `open`, skipping quoted strings, or `stop - 1` if none does. */
function matchPair(code, open, stop) {
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

/** Splits code into chunks at `;`, `{` and `}`, each knowing whether it sits inside @keyframes or a reduced-motion query. */
function chunksOf(code) {
  const chunks = [];
  const stack = [];
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

/** Where each MOTION or TUNE object literal is: its numbers are the language's definition or the tunables, not uses. */
function objectRanges(code) {
  const ranges = [];
  for (const m of code.matchAll(TOKEN_OBJECT)) {
    if (ranges.length && m.index <= ranges[ranges.length - 1].end) continue;
    ranges.push({ name: m[1], start: m.index, end: matchPair(code, m.index + m[0].length - 1, code.length) });
  }
  return ranges;
}

const inRanges = (ranges, offset) => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < ranges[mid].start) hi = mid - 1;
    else if (offset > ranges[mid].end) lo = mid + 1;
    else return true;
  }
  return false;
};

/**
 * For every `(`, `[` and `{`, the offset of the one that closes it (-1 when none does), in one pass over the
 * string-blind view (no text is left in it to skip); each kind is paired on its own, as matchPair counts only its own kind.
 */
function bracketPairs(code) {
  const pairs = new Int32Array(code.length).fill(-1);
  const stacks = { '(': [], '[': [], '{': [] };
  const opener = { ')': '(', ']': '[', '}': '{' };
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
function definitionIndex(code) {
  const index = new Map();
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = m[1] ?? m[2];
    if (!index.has(name)) index.set(name, m[1] !== undefined ? m.index + m[0].length - 1 : m.index + m[0].length);
  }
  return index;
}

/** Sorted, merged copies of ranges, for inRanges. */
function mergeRanges(ranges) {
  const out = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * The body of the function whose definition continues at `from` (after `=`, or at a parameter list). `names` resolves
 * a renderAt given by name (window.renderAt = draw) to draw's definition, once per name.
 */
function functionBody(code, from, names, hops = 0) {
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
  const close = (at) => (pairs[at] < 0 ? n - 1 : pairs[at]);
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
      // window.renderAt = draw: the body is draw's (one hop), looked up in an index built once, each name once.
      if (hops > 0 || !/^[A-Za-z_$][\w$]*$/.test(id)) return null;
      if (!names.resolved.has(id)) {
        const at = names.index().get(id);
        const body = at === undefined ? null : functionBody(code, at, names, hops + 1);
        names.resolved.set(id, body && { ...body, alias: true });
      }
      return names.resolved.get(id);
    }
  } else return null;
  if (code[i] === '{') return { start: i, end: close(i) };
  // An expression body: to the end of its statement, stepping over each bracketed part in one move (text is blank here).
  let j = i;
  for (; j < n; j++) {
    const ch = code[j];
    if (ch === '(' || ch === '[' || ch === '{') j = close(j);
    else if (ch === ')' || ch === ']' || ch === '}' || ch === ';' || ch === '\n') break;
  }
  return { start: i, end: Math.min(j, n - 1) };
}

/**
 * Whether the code defines renderAt, and every body that draws a frame (any definition may be the one that runs), as
 * sorted, merged ranges. `code` has its strings blanked, so code shown as text defines nothing. A definition inside a
 * body already read (one that follows its own definition) is not read again, and every bracket's partner comes from
 * one table, so the pass stays linear.
 */
function renderBodies(code) {
  const ranges = [];
  let film = false;
  let covered = -1;
  let index = null;
  let pairs = null;
  const names = { resolved: new Map(), index: () => (index ??= definitionIndex(code)), pairs: () => (pairs ??= bracketPairs(code)) };
  for (const m of code.matchAll(FILM_DEF)) {
    film = true;
    if (m.index <= covered) continue;
    const from = m[0].startsWith('function') ? m.index + m[0].length - 1 : m.index + m[0].indexOf('=') + 1;
    const body = functionBody(code, from, names);
    if (!body) continue;
    ranges.push(body);
    // Only a body that follows its own definition covers what is inside it; an alias's body is elsewhere.
    if (!body.alias && body.start > m.index) covered = Math.max(covered, body.end);
  }
  return { film, ranges: mergeRanges(ranges) };
}

/** For each offset (ascending), the offset of the innermost `{` still open there, or -1. */
function enclosingOpens(code, offsets) {
  const result = new Array(offsets.length).fill(-1);
  const stack = [];
  let p = 0;
  for (let i = 0; i < code.length && p < offsets.length; i++) {
    while (p < offsets.length && offsets[p] === i) result[p++] = stack.length ? stack[stack.length - 1] : -1;
    if (code[i] === '{') stack.push(i);
    else if (code[i] === '}') stack.pop();
  }
  return result;
}

/**
 * The value of a declaration starting at `from` in a chunk: a quoted string's contents, or the text up to `limit`
 * (the next declaration, or the chunk's end), so no value is read twice and the pass stays linear.
 */
function declValue(text, from, limit) {
  const q = text[from];
  const stop = Math.min(limit, from + 4000);
  if (q === '"' || q === "'" || q === '`') {
    const end = text.indexOf(q, from + 1);
    return { value: text.slice(from + 1, end < 0 || end > stop ? stop : end), quoted: true };
  }
  return { value: text.slice(from, stop), quoted: false };
}

/** Splits at commas outside parentheses. */
function splitTop(value) {
  const items = [];
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

/** The words of one item, with function calls kept whole: [{word}|{fn, args}]. */
function wordsOf(item) {
  const words = [];
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

const msOf = (word) => (word.endsWith('ms') ? Number(word.slice(0, -2)) : Number(word.slice(0, -1)) * 1000);
const TIMING_PARTS = new Set(['dur', 'duration', 'ease', 'easing', 'curve']);
/** A var() that names a timing token, as the language or the app spells it (--dur-base, --saas-ease). */
const timingVar = (args) => args.split(',')[0].trim().replace(/^--/, '').split('-').some((part) => TIMING_PARTS.has(part));

/** What one transition item names: { property, implicit, times (literal ms), keywords (curve words), unknown }. */
function readTransitionItem(item) {
  let property = '';
  let timing = false;
  let unknown = false;
  const times = [];
  const keywords = [];
  for (const w of wordsOf(item)) {
    if (w.fn) {
      if (w.fn === 'var') {
        if (timingVar(w.args)) timing = true;
        else unknown = true;
      } else if (w.fn === 'cubic-bezier' || w.fn === 'steps' || w.fn === 'linear') timing = true;
      else unknown = true;
      continue;
    }
    if (TIME.test(w.word)) { times.push(msOf(w.word)); timing = true; continue; }
    if (Object.hasOwn(KEYWORD_CURVES, w.word)) { keywords.push(w.word); timing = true; continue; }
    if (STEP_WORDS.has(w.word)) { timing = true; continue; }
    if (IGNORED_WORDS.has(w.word)) continue;
    if (w.word === 'none') return { property: 'none', implicit: false, times, keywords, unknown: false };
    if (!property) property = w.word;
  }
  if (!property && timing && !unknown) return { property: 'all', implicit: true, times, keywords, unknown };
  return { property, implicit: false, times, keywords, unknown: !property && unknown };
}

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const excerptOf = (text) => {
  const s = text.slice(0, 400).replace(/\s+/g, ' ').trim();
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

/**
 * Lints one text. Returns findings in line order: { line, rule, severity, message, excerpt }.
 * profile 'strict' holds code to the language with every rule; 'page' holds a delivered page to its own tokens,
 * makes every finding a note, and leaves springs, frame rates and file names alone. video holds every line of the
 * file to the clock rule.
 */
export function lintText(text, { path = 'page.html', profile = 'strict', tokens = loadTokens(), video = false } = {}) {
  const strict = profile === 'strict';
  const ext = extname(path).toLowerCase();
  const css = ext === '.css' || ext === '.scss';
  const html = ext === '.html' || ext === '.htm' || (!strict && !css);
  const tokenFile = strict && (/(?:^|[\\/._-])(?:motion-)?tokens?\.[a-z]+$/i.test(path) || /(?:^|[\\/])motion-language\.[a-z]+$/i.test(path));
  const code = prepareCode(text, { css, html, scss: ext === '.scss' });
  // The clock, springs and renderAt never read text: code shown as a string is not run.
  const plain = css ? code : blankStrings(code);
  // Spring keys may be quoted ({"stiffness": 300}): the spring rule reads a view that keeps property names.
  const keyed = strict && !css ? blankStrings(code, { keys: true }) : plain;
  const filmWhole = (strict && video) || (strict && REMOTION.test(code));
  const render = filmWhole ? { film: true, ranges: [] } : renderBodies(plain);
  const film = filmWhole || render.film;
  const rawLines = text.split('\n');
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const fileAllowed = new Set();
  for (const match of text.matchAll(ALLOW_FILE)) for (const rule of match[1].split(',')) fileAllowed.add(rule.trim());
  const tokenRules = strict || TOKEN_DECLARED.test(code) || MOTION_OBJECT.test(code);
  const declared = objectRanges(code);
  const motionOnly = declared.filter((r) => r.name === 'MOTION');
  const curves = [];
  for (const pattern of [CSS_CURVE, JS_CURVE_CALL, JS_CURVE_ARRAY]) {
    for (const m of code.matchAll(pattern)) curves.push({ at: m.index, curve: [m[1], m[2], m[3], m[4]], bracket: pattern === JS_CURVE_ARRAY ? m.index + m[0].indexOf('[') : -1 });
  }
  // Inside a MOTION object every four-number array is a curve (MOTION.md writes them as ease: { enter: [...] }).
  const brackets = new Set(curves.map((c) => c.bracket));
  for (const r of motionOnly) {
    for (const m of code.slice(r.start, r.end + 1).matchAll(FOUR_ARRAY)) {
      if (!brackets.has(r.start + m.index)) curves.push({ at: r.start + m.index, curve: [m[1], m[2], m[3], m[4]], bracket: r.start + m.index });
    }
  }
  let language = null;
  if (strict) language = new Set(languageCurves(tokens).map(curveKey));
  else {
    const own = [...code.matchAll(DECLARED_CURVE)].map((m) => curveKey([m[1], m[2], m[3], m[4]]));
    for (const c of curves) if (inRanges(motionOnly, c.at)) own.push(curveKey(c.curve));
    if (own.length) language = new Set(own);
  }
  const tokenNames = new Set(Object.keys(tokens.ease ?? {}));
  const reducedPath = /prefers-reduced-motion/.test(code);
  const findings = [];
  const seen = new Set();
  const lineAllows = new Map();

  const allowsOn = (at) => {
    if (!lineAllows.has(at)) {
      const m = at >= 0 ? ALLOW.exec(rawLines[at] ?? '') : null;
      lineAllows.set(at, m ? m[1].split(',').map((s) => s.trim()) : []);
    }
    return lineAllows.get(at);
  };
  const allowedAt = (index, rule) => fileAllowed.has(rule) || fileAllowed.has('all')
    || [index, index - 1].some((at) => allowsOn(at).some((r) => r === rule || r === 'all'));
  const add = (index, rule, detail = '', context = undefined) => {
    const key = `${index}:${rule}`;
    if (seen.has(key) || allowedAt(index, rule)) return;
    seen.add(key);
    findings.push({
      line: index + 1, rule, severity: strict ? SEVERITY[rule] : 'note',
      message: detail ? `${MESSAGES[rule]} ${detail}` : MESSAGES[rule],
      excerpt: excerptOf(context ?? rawLines[index] ?? ''),
    });
  };

  const chunks = chunksOf(code);
  const chunkAt = (offset) => {
    let lo = 0;
    let hi = chunks.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (chunks[mid].start <= offset) lo = mid; else hi = mid - 1; }
    return chunks[lo];
  };
  /** A var(--name, <here>) fallback: read backwards from the curve, at most 200 characters. */
  const isFallback = (at) => {
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
  /** One curve used at `at`: off the language, and/or written in place. */
  const curveUse = (at, curve, label, context) => {
    const line = lineOf(at);
    if (language && !language.has(curveKey(curve))) {
      const what = `${label ? `${label} is ` : ''}${curve.map(Number).join(', ')}`;
      add(line, 'off-language-curve', strict ? `(${what})` : `(${what}: none of the page's own curve tokens)`, context);
    }
    if (tokenRules && !tokenFile && !chunkAt(at).isToken && !isFallback(at) && !inRanges(declared, at)) add(line, 'raw-curve', label ? `(${label})` : '', context);
  };
  const libraryCurve = (at, label, context) => {
    const line = lineOf(at);
    if (language) add(line, 'off-language-curve', `(${label} is a library curve, none of the language's)`, context);
    if (tokenRules && !tokenFile && !inRanges(declared, at)) add(line, 'raw-curve', `(${label})`, context);
  };
  let firstMotion = -1;
  let firstMaybe = -1;
  const moved = (index) => { if (firstMotion < 0 || index < firstMotion) firstMotion = index; };
  const maybeMoved = (index) => { if (firstMaybe < 0 || index < firstMaybe) firstMaybe = index; };

  for (const chunk of chunks) {
    if (chunk.prelude || !chunk.text.trim()) continue;
    if (chunk.inKeyframes) {
      const layout = LAYOUT_DECL.exec(chunk.text);
      if (layout) add(lineOf(chunk.start + layout.index + layout[0].indexOf(layout[1])), 'layout-property', '', chunk.text.slice(layout.index, layout.index + 400));
      const moving = MOVING_DECL.exec(chunk.text);
      if (moving && !chunk.inReduce) moved(lineOf(chunk.start + moving.index));
    }
    const decls = [...chunk.text.matchAll(DECL)];
    for (let d = 0; d < decls.length; d++) {
      const m = decls[d];
      const name = kebab(m[2]);
      const nameAt = m.index + m[0].indexOf(m[2]);
      const at = chunk.start + nameAt;
      const line = lineOf(at);
      const limit = d + 1 < decls.length ? decls[d + 1].index : chunk.text.length;
      const { value, quoted } = declValue(chunk.text, m.index + m[0].length, limit);
      // A camel-cased script property whose value is an expression, not a string: nothing to read.
      if (!quoted && /[A-Z]/.test(m[2])) continue;
      const context = chunk.text.slice(nameAt, nameAt + 400);
      const kind = name.startsWith('transition') ? 'transition' : 'animation';
      const part = name.slice(kind.length + 1);
      const items = splitTop(value);
      const keywords = [];
      const properties = [];
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
        for (const item of items) for (const w of wordsOf(item)) if (w.word && Object.hasOwn(KEYWORD_CURVES, w.word)) keywords.push(w.word);
      }
      for (const { property, implicit } of properties) {
        if (property === 'all') {
          add(line, 'transition-all', implicit ? '(it names no property, so it transitions all)' : '', context);
          if (!chunk.inReduce) maybeMoved(line);
        } else {
          if (isLayout(property)) add(line, 'layout-property', '', context);
          if (isMoving(property) && !chunk.inReduce) moved(line);
        }
      }
      for (const word of keywords) curveUse(at, KEYWORD_CURVES[word], word, context);
      if (tokenRules && !chunk.isToken && !tokenFile && !chunk.inReduce && part !== 'property' && part !== 'timing-function') {
        const literal = items.flatMap((item) => (kind === 'transition' && part === ''
          ? readTransitionItem(item).times
          : wordsOf(item).filter((w) => w.word && TIME.test(w.word)).map((w) => msOf(w.word))));
        if (literal.some((ms) => ms > 1)) add(line, 'raw-duration', '', context);
      }
    }
  }

  // Curves, anywhere in the code: numbers, then easings given by name.
  for (const c of curves) curveUse(c.at, c.curve, '', rawLines[lineOf(c.at)]);
  if (!css) {
    for (const m of code.matchAll(EASING_STRING)) {
      const word = m[2];
      const lowered = word.toLowerCase();
      if (lowered === 'linear' || lowered === 'none' || /^steps?\b|^step-/.test(lowered) || tokenNames.has(word)) continue;
      if (Object.hasOwn(KEYWORD_CURVES, lowered)) curveUse(m.index, KEYWORD_CURVES[lowered], lowered, rawLines[lineOf(m.index)]);
      else libraryCurve(m.index, `'${word}'`, rawLines[lineOf(m.index)]);
    }
    for (const m of code.matchAll(REMOTION_EASING)) libraryCurve(m.index, m[0].replace(/\s*\($/, '(...)'), rawLines[lineOf(m.index)]);
  }

  // Scripted animation, read call by call (its arguments may span lines).
  const animates = [...code.matchAll(ANIMATE_CALL)];
  for (let a = 0; a < animates.length; a++) {
    const open = animates[a].index + animates[a][0].length - 1;
    const stop = a + 1 < animates.length ? animates[a + 1].index : code.length;
    const span = code.slice(open, matchPair(code, open, Math.min(stop, open + 8000)) + 1);
    const line = lineOf(animates[a].index);
    if (LAYOUT_DECL.test(span)) add(line, 'layout-property');
    if (/\b(?:transform|translate|scale|rotate)\b/.test(span)) moved(line);
    if (tokenRules && !tokenFile && !inRanges(declared, animates[a].index) && /\bduration\s*:\s*\d/.test(span)) add(line, 'raw-duration');
  }

  // Springs: every object literal that holds spring keys is read whole.
  if (strict && !css) {
    const keys = [...keyed.matchAll(SPRING_KEY)];
    const opens = enclosingOpens(keyed, keys.map((k) => k.index));
    const groups = new Map();
    keys.forEach((k, i) => {
      const group = groups.get(opens[i]) ?? [];
      group.push(k);
      groups.set(opens[i], group);
    });
    for (const [open, group] of groups) {
      const v = {};
      for (const k of group) v[k[1]] ??= Number(k[2]);
      const first = group[0].index;
      const line = lineOf(first);
      const exempt = tokenFile || inRanges(declared, first);
      if (v.stiffness !== undefined && v.damping !== undefined) {
        const name = v.mass === undefined || v.mass === 1 ? namedSpring(v.stiffness, v.damping, tokens) : '';
        const mass = v.mass !== undefined && v.mass !== 1 ? `, mass ${v.mass}` : '';
        if (!name) add(line, 'raw-spring', `(stiffness ${v.stiffness}, damping ${v.damping}${mass} is no named spring)`);
        else if (!exempt) add(line, 'raw-spring', `(these are the numbers of ${name}: use the name)`);
      } else if (v.stiffness !== undefined || v.damping !== undefined) {
        // One key alone counts where the object is a spring's: a config, a spring's options, a spring transition.
        const before = open < 0 ? '' : code.slice(Math.max(0, open - 40), open);
        const near = code.slice(Math.max(0, open), Math.min(first + 200, Math.max(0, open) + 400));
        const spring = /(?:config|spring\w*|transition)\s*[:=(]\s*$/i.test(before) || /\btype\s*:\s*['"]spring['"]/.test(near);
        if (spring) add(line, 'raw-spring', `(${v.stiffness !== undefined ? `stiffness ${v.stiffness}` : `damping ${v.damping}`} alone is a spring by hand)`);
      } else if (v.tension !== undefined && v.friction !== undefined) {
        add(line, 'raw-spring', `(tension ${v.tension}, friction ${v.friction} is a spring by hand)`);
      }
    }
    for (const m of plain.matchAll(SPRING_AT)) {
      const name = namedSpringZS(Number(m[1]), Number(m[2]), tokens);
      if (!name) add(lineOf(m.index), 'raw-spring', `(zeta ${Number(m[1])}, settle ${Number(m[2])} is no named spring)`);
      else if (!tokenFile && !inRanges(declared, m.index)) add(lineOf(m.index), 'raw-spring', `(these are the numbers of ${name}: use the name)`);
    }
    if (film) {
      const calls = [...plain.matchAll(SPRING_CALL)];
      for (let s = 0; s < calls.length; s++) {
        const open = calls[s].index + calls[s][0].indexOf('(');
        const stop = s + 1 < calls.length ? calls[s + 1].index : plain.length;
        if (/\bfps\s*:\s*\d/.test(plain.slice(open, matchPair(plain, open, Math.min(stop, open + 4000)) + 1))) add(lineOf(calls[s].index), 'fps-literal');
      }
    }
  }

  // The clock: anywhere in a video file, inside renderAt in a film page.
  if (film) {
    for (const m of plain.matchAll(CLOCK)) {
      if (filmWhole) add(lineOf(m.index), 'render-clock');
      else if (inRanges(render.ranges, m.index)) add(lineOf(m.index), 'render-clock', '(inside renderAt)');
    }
  }

  // `all` moves things only when something in the file is moved by a transform.
  let motionAt = firstMotion;
  if (firstMaybe >= 0 && (motionAt < 0 || firstMaybe < motionAt) && TRANSFORM_DECL.test(code)) motionAt = firstMaybe;
  const checksMotionPath = !strict || css || html || /\.(?:jsx|tsx)$/i.test(path);
  if (motionAt >= 0 && !reducedPath && !film && checksMotionPath) add(motionAt, 'reduced-motion-missing');
  return findings.sort((a, b) => a.line - b.line || RULES.indexOf(a.rule) - RULES.indexOf(b.rule));
}

/** An --ignore part as a path segment run: forward slashes, no leading ./ or trailing slash. */
export const normalisePart = (part) => part.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

function walk(target, files, ignore, cwd, skipped) {
  const rel = relative(cwd, target).split(sep).join('/');
  if (ignore.some((part) => `/${rel}/`.includes(`/${part}/`))) return;
  const stat = statSync(target);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target).sort()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(join(target, entry), files, ignore, cwd, skipped);
    }
  } else if (TEXT_EXTENSIONS.has(extname(target).toLowerCase()) && !/\.min\.js$/i.test(target)) {
    if (stat.size > MAX_FILE_BYTES) skipped.push(rel);
    else files.push(target);
  }
}

/**
 * Lints files and folders; paths in the result are relative to cwd with forward slashes. `ignore` lists path parts
 * (either slash) whose files are left out, for example recorded case data that is not code anyone maintains.
 * Files over 4 MiB are not read; they are listed in `skipped`.
 */
export function lintPaths(targets, { profile = 'strict', tokens = loadTokens(), cwd = process.cwd(), ignore = [], video = false } = {}) {
  const parts = ignore.map(normalisePart).filter(Boolean);
  const files = [];
  const skipped = [];
  for (const target of targets) walk(resolve(cwd, target), files, parts, cwd, skipped);
  files.sort();
  const results = [];
  for (const file of files) {
    const path = relative(cwd, file).split(sep).join('/');
    for (const f of lintText(readFileSync(file, 'utf8'), { path, profile, tokens, video })) results.push({ file: path, ...f });
  }
  return { files: files.length, findings: results, skipped };
}

const BASELINE_ABOUT = 'Known motion drift, listed by rule and text rather than by file, so code that moves keeps its allowance. '
  + 'A finding that matches nothing here fails. Lower it with --prune-baseline once drift is fixed; never raise it to pass the check.';
/**
 * The text a baseline knows a finding by: its declaration or line (for a missing reduced-motion path, the file's first
 * moving line, so a moved file keeps its allowance and an unrelated new one does not inherit it).
 */
export const baselineText = (f) => f.excerpt;
const keyOf = (rule, text) => `${rule}\u0000${text}`;

function counts(findings) {
  const out = new Map();
  for (const f of findings) {
    const key = keyOf(f.rule, baselineText(f));
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

function knownCounts(baseline) {
  const out = new Map();
  for (const e of baseline?.known ?? []) out.set(keyOf(e.rule, e.text), (out.get(keyOf(e.rule, e.text)) ?? 0) + e.count);
  return out;
}

export function baselineOf(findings) {
  const known = new Map();
  for (const f of findings) {
    const text = baselineText(f);
    const key = keyOf(f.rule, text);
    const entry = known.get(key);
    if (entry) {
      entry.count++;
      if (f.file < entry.where) entry.where = f.file;
    } else known.set(key, { rule: f.rule, text, count: 1, where: f.file });
  }
  const list = [...known.values()].sort((a, b) => a.where.localeCompare(b.where) || a.rule.localeCompare(b.rule) || a.text.localeCompare(b.text));
  return { about: BASELINE_ABOUT, known: list };
}

/**
 * The findings the baseline does not cover. When a rule and text appear more often than the baseline knows, every
 * finding with that text is listed (with `known` and `seen`), since copies of one text cannot be told apart.
 */
export function overBaseline(findings, baseline) {
  const known = knownCounts(baseline);
  const seen = counts(findings);
  return findings
    .filter((f) => (seen.get(keyOf(f.rule, baselineText(f))) ?? 0) > (known.get(keyOf(f.rule, baselineText(f))) ?? 0))
    .map((f) => ({ ...f, known: known.get(keyOf(f.rule, baselineText(f))) ?? 0, seen: seen.get(keyOf(f.rule, baselineText(f))) }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Baseline entries above the code: drift that was fixed, so the baseline can be lowered. */
export function staleBaseline(findings, baseline) {
  const seen = counts(findings);
  return (baseline?.known ?? [])
    .map((e) => ({ ...e, now: seen.get(keyOf(e.rule, e.text)) ?? 0 }))
    .filter((e) => e.now < e.count);
}

/** The baseline with each count lowered to the code's; it never raises a count or adds an entry. */
export function pruneBaseline(findings, baseline) {
  const seen = counts(findings);
  const known = [];
  for (const e of baseline?.known ?? []) {
    const count = Math.min(e.count, seen.get(keyOf(e.rule, e.text)) ?? 0);
    if (count > 0) known.push({ ...e, count });
  }
  return { about: baseline?.about ?? BASELINE_ABOUT, known };
}

function main(argv) {
  const args = [...argv];
  const opts = { profile: 'strict', tokens: '', baseline: '', prune: '', write: '', json: false, report: false, video: false, force: false };
  const takes = { '--profile': 'profile', '--tokens': 'tokens', '--baseline': 'baseline', '--prune-baseline': 'prune', '--write-baseline': 'write' };
  const ignore = [];
  const targets = [];
  const usage = (message) => { process.stderr.write(`${message}\n\n${HELP}`); return 2; };
  const fail = (message) => { process.stderr.write(`${message}\n`); return 2; };
  while (args.length) {
    const arg = args.shift();
    if (Object.hasOwn(takes, arg) || arg === '--ignore') {
      const value = args.shift();
      if (value === undefined || value.startsWith('--')) return usage(`${arg} needs a value`);
      if (arg === '--ignore') ignore.push(value);
      else opts[takes[arg]] = value;
    } else if (arg === '--json') opts.json = true;
    else if (arg === '--report') opts.report = true;
    else if (arg === '--video') opts.video = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--help' || arg === '-h') { process.stdout.write(HELP); return 0; }
    else if (arg.startsWith('-')) return usage(`unknown option ${arg}`);
    else targets.push(arg);
  }
  if (opts.profile !== 'strict' && opts.profile !== 'page') return usage(`unknown profile "${opts.profile}"`);
  if (!targets.length) return usage('give at least one file or folder');
  const missing = targets.find((t) => !existsSync(t));
  if (missing) return fail(`no such file or folder: ${missing}`);
  let tokens;
  try {
    tokens = opts.tokens ? loadTokens(resolve(opts.tokens)) : loadTokens();
  } catch (error) {
    return fail(`cannot read the motion tokens${opts.tokens ? ` at ${opts.tokens}` : ''}: ${error.message}`);
  }
  let result;
  try {
    result = lintPaths(targets, { profile: opts.profile, tokens, ignore, video: opts.video });
  } catch (error) {
    return fail(`cannot read the files: ${error.message}`);
  }
  const { files, findings, skipped } = result;
  for (const path of skipped) process.stderr.write(`skipped (over 4 MiB, not read): ${path}\n`);
  if (opts.write) {
    if (existsSync(opts.write) && !opts.force) return fail(`${opts.write} exists: --prune-baseline lowers it; --force replaces it (never to make the check pass)`);
    writeFileSync(opts.write, `${JSON.stringify(baselineOf(findings), null, 2)}\n`);
    process.stdout.write(`wrote ${opts.write}: ${findings.length} findings in ${files} files\n`);
    return 0;
  }
  const baselinePath = opts.prune || opts.baseline;
  let baseline = null;
  if (baselinePath) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    } catch (error) {
      return fail(`cannot read the baseline ${baselinePath}: ${error.message}`);
    }
    if (!Array.isArray(baseline.known)) return fail(`${baselinePath} is not a baseline (no "known" list)`);
    if (opts.prune) {
      baseline = pruneBaseline(findings, baseline);
      writeFileSync(opts.prune, `${JSON.stringify(baseline, null, 2)}\n`);
      process.stdout.write(`lowered ${opts.prune} to the code: ${baseline.known.reduce((sum, e) => sum + e.count, 0)} known findings\n`);
    }
  }
  const failing = baseline ? overBaseline(findings, baseline) : findings;
  const stale = baseline ? staleBaseline(findings, baseline) : [];
  if (opts.json) process.stdout.write(`${JSON.stringify({ files, findings, failing, stale, skipped }, null, 2)}\n`);
  else {
    for (const f of failing) {
      const copies = f.known ? `\n    (the baseline knows this text ${f.known} time${f.known === 1 ? '' : 's'}; it appears ${f.seen} times)` : '';
      process.stdout.write(`${f.file}:${f.line}  ${f.rule}  ${f.message}\n    ${f.excerpt}${copies}\n`);
    }
    const known = findings.length - failing.length;
    process.stdout.write(`${files} files, ${failing.length} finding${failing.length === 1 ? '' : 's'}${baseline ? ` (${known} known in the baseline)` : ''}\n`);
    if (stale.length) {
      process.stdout.write(`${stale.length} baseline entr${stale.length === 1 ? 'y is' : 'ies are'} above the code (drift was fixed): `
        + `run again with --prune-baseline ${baselinePath} to lower ${stale.length === 1 ? 'it' : 'them'}.\n`);
    }
    if (failing.length && opts.profile === 'strict') {
      process.stdout.write('Fix: use a token from MOTION.md (--ease-*, --dur-*, a named spring), or mark a deliberate exception on the line '
        + 'or the line above with `motion-lint-allow <rule>: <reason>` and record it in the decision record.\n');
    }
  }
  return failing.length && opts.profile === 'strict' && !opts.report ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
