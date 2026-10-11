// A small syntax highlighter for the studio's code view: comments, strings, numbers, keywords, tags and attributes,
// enough to read a delivered file at a glance. It only splits text into typed tokens; the view renders them as
// React text, so highlighting can never turn delivered text into markup.

export type TokenType = 'comment' | 'string' | 'number' | 'keyword' | 'tag' | 'attr' | 'punct' | 'heading' | 'emphasis' | 'plain';
export interface Token { type: TokenType; text: string }
export type CodeLanguage = 'js' | 'css' | 'html' | 'json' | 'python' | 'go' | 'shell' | 'markdown' | 'sql' | 'yaml' | 'plain';

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  js: new Set('await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of package private protected public return static super switch this throw true try type typeof undefined var void while with yield async as readonly declare abstract keyof never unknown any boolean number string symbol bigint'.split(' ')),
  python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self print'.split(' ')),
  go: new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false error string int int64 float64 bool byte rune any'.split(' ')),
  shell: new Set('if then else elif fi for while do done case esac function in export local return echo cd set unset source exit sudo'.split(' ')),
  sql: new Set('select from where insert into update delete create table alter drop index on join left right inner outer group by order having limit offset as and or not null is in values primary key foreign references default unique distinct union all case when then else end returning with begin commit rollback'.split(' ')),
  css: new Set('important media supports keyframes from to import font-face root'.split(' ')),
};

export function languageOf(name: string): CodeLanguage {
  const extension = name.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte'].includes(extension)) return 'js';
  if (['css', 'scss', 'sass', 'less'].includes(extension)) return 'css';
  if (['html', 'htm', 'xml', 'svg'].includes(extension)) return 'html';
  if (['json', 'jsonc', 'geojson'].includes(extension)) return 'json';
  if (extension === 'py') return 'python';
  if (extension === 'go') return 'go';
  if (['sh', 'bash', 'zsh', 'ps1', 'bat'].includes(extension)) return 'shell';
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  if (extension === 'sql') return 'sql';
  if (['yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env'].includes(extension)) return 'yaml';
  return 'plain';
}

type State = { block?: 'comment' | 'html-comment' | 'triple' | 'template'; quote?: string };

function push(tokens: Token[], type: TokenType, text: string) {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.type === type) last.text += text; else tokens.push({ type, text });
}

function codeLine(line: string, language: CodeLanguage, state: State): Token[] {
  const tokens: Token[] = [];
  const keywords = KEYWORDS[language === 'json' ? 'js' : language] ?? KEYWORDS.js;
  const lineComment = language === 'python' || language === 'shell' || language === 'yaml' ? '#' : language === 'sql' ? '--' : language === 'css' ? null : '//';
  let index = 0;
  while (index < line.length) {
    if (state.block === 'comment') {
      const end = line.indexOf('*/', index);
      if (end < 0) { push(tokens, 'comment', line.slice(index)); return tokens; }
      push(tokens, 'comment', line.slice(index, end + 2)); index = end + 2; state.block = undefined; continue;
    }
    if (state.block === 'triple' || state.block === 'template') {
      const close = state.block === 'triple' ? state.quote! : '`';
      const end = line.indexOf(close, index);
      if (end < 0) { push(tokens, 'string', line.slice(index)); return tokens; }
      push(tokens, 'string', line.slice(index, end + close.length)); index = end + close.length; state.block = undefined; continue;
    }
    const rest = line.slice(index);
    if (language !== 'python' && language !== 'shell' && language !== 'yaml' && rest.startsWith('/*')) { state.block = 'comment'; continue; }
    if (lineComment && rest.startsWith(lineComment) && (lineComment !== '#' || index === 0 || /\s/.test(line[index - 1]))) { push(tokens, 'comment', rest); return tokens; }
    if (language === 'python' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      state.block = 'triple'; state.quote = rest.slice(0, 3); push(tokens, 'string', rest.slice(0, 3)); index += 3; continue;
    }
    if (language === 'js' && rest.startsWith('`')) { state.block = 'template'; push(tokens, 'string', '`'); index += 1; continue; }
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let end = 1;
      while (end < rest.length && rest[end] !== quote) end += rest[end] === '\\' ? 2 : 1;
      const text = rest.slice(0, Math.min(rest.length, end + 1));
      // A JSON key reads as an attribute, its value as a string.
      push(tokens, language === 'json' && /^\s*:/.test(rest.slice(text.length)) ? 'attr' : 'string', text);
      index += text.length; continue;
    }
    const number = rest.match(/^(?:0x[0-9a-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/i);
    if (number && (index === 0 || !/[A-Za-z_$]/.test(line[index - 1]))) { push(tokens, 'number', number[0]); index += number[0].length; continue; }
    const word = rest.match(/^[A-Za-z_$][\w$-]*/);
    if (word) {
      const text = language === 'css' ? word[0] : word[0].replace(/-.*$/, '');
      const lower = language === 'sql' ? text.toLowerCase() : text;
      push(tokens, keywords.has(lower) ? 'keyword' : language === 'css' && /^\s*:/.test(rest.slice(text.length)) ? 'attr' : 'plain', text);
      index += text.length; continue;
    }
    push(tokens, /[{}()[\];,.:<>=+\-*/%!&|?]/.test(rest[0]) ? 'punct' : 'plain', rest[0]);
    index += 1;
  }
  return tokens;
}

function htmlLine(line: string, state: State): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    if (state.block === 'html-comment') {
      const end = line.indexOf('-->', index);
      if (end < 0) { push(tokens, 'comment', line.slice(index)); return tokens; }
      push(tokens, 'comment', line.slice(index, end + 3)); index = end + 3; state.block = undefined; continue;
    }
    const rest = line.slice(index);
    if (rest.startsWith('<!--')) { state.block = 'html-comment'; continue; }
    const tag = rest.match(/^<\/?[A-Za-z][\w:-]*/);
    if (tag) {
      push(tokens, 'tag', tag[0]); index += tag[0].length;
      // Attributes up to the end of the tag (or the line).
      while (index < line.length && line[index] !== '>') {
        const attr = line.slice(index).match(/^(\s+)([\w:@.-]+)(?:(=)("[^"]*"|'[^']*'|[^\s>]+))?/);
        if (!attr) { push(tokens, 'plain', line[index]); index += 1; continue; }
        push(tokens, 'plain', attr[1]); push(tokens, 'attr', attr[2]);
        if (attr[3]) { push(tokens, 'punct', '='); push(tokens, 'string', attr[4]); }
        index += attr[0].length;
      }
      if (line[index] === '>') { push(tokens, 'tag', '>'); index += 1; }
      continue;
    }
    const text = rest.match(/^[^<]+/);
    push(tokens, 'plain', text ? text[0] : rest[0]);
    index += text ? text[0].length : 1;
  }
  return tokens;
}

function markdownLine(line: string): Token[] {
  if (/^#{1,6}\s/.test(line)) return [{ type: 'heading', text: line }];
  if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
    const marker = line.match(/^\s*(?:[-*+]|\d+\.)\s/)![0];
    return [{ type: 'punct', text: marker }, ...inlineMarkdown(line.slice(marker.length))];
  }
  if (/^\s*>/.test(line)) return [{ type: 'comment', text: line }];
  return inlineMarkdown(line);
}

function inlineMarkdown(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    push(tokens, 'plain', text.slice(last, match.index));
    push(tokens, match[0].startsWith('`') ? 'string' : match[0].startsWith('[') ? 'attr' : 'emphasis', match[0]);
    last = match.index! + match[0].length;
  }
  push(tokens, 'plain', text.slice(last));
  return tokens;
}

/** Tokens per line; long files are cut at `maxLines` (the view says so). */
export function highlight(source: string, language: CodeLanguage, maxLines = 20000): Token[][] {
  const lines = source.split(/\r?\n/).slice(0, maxLines);
  const state: State = {};
  let inFence = false;
  return lines.map(line => {
    if (language === 'plain' || line.length > 4000) return [{ type: 'plain' as const, text: line }];
    if (language === 'markdown') {
      if (/^\s*```/.test(line)) { inFence = !inFence; return [{ type: 'punct' as const, text: line }]; }
      return inFence ? [{ type: 'string' as const, text: line }] : markdownLine(line);
    }
    if (language === 'html') return htmlLine(line, state);
    return codeLine(line, language, state);
  });
}
