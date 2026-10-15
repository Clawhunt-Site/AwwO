// Whether a delivery that arrives as Markdown or plain text is really code: a module, data written as constants or
// literals, a stylesheet, JSON or markup. Read as Markdown its punctuation turns into emphasis and its lines run into
// one paragraph (seen 2026-10-15: the EV plant twin's plant layout, a JavaScript constant, read as a wall of prose in
// the opened node); read as code it keeps every character and line. A text that fences its code anywhere, that is laid
// out as Markdown (a link, a heading, a list, a table) or that quotes code inline (`step()`, **bold**) stays Markdown.
const SCRIPT_OPENING = [
  /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
  /^(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(/,
  /^class\s+[A-Za-z_$][\w$]*\s*(?:extends\s+[\w$.]+\s*)?\{/,
  /^(?:import|export)\s+(?:\{|\*|default\b|const\b|let\b|function\b|class\b|[\w$]+\s+from\b|['"])/,
  /^module\.exports\s*=/,
  /^['"]use strict['"]/,
  /^#!\//,
  /^(?:async\s+)?def\s+\w+\s*\(/,
  /^from\s+[\w.]+\s+import\s+[\w*(]/,
  /^import\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:\n|$)/,
  /^(?:SELECT|WITH|CREATE\s+(?:TABLE|INDEX|VIEW)|INSERT\s+INTO)\b/,
];
// A page or a stylesheet: it opens as one (a document, an svg, a style or script block, at most four selectors and a
// declaration) and ends as one, so markup followed by a sentence about it is prose.
const MARKUP_OPENING = /^(?:<!doctype\s+html|<html[\s>]|<svg[\s>]|<style[\s>]|<script[\s>]|<\?xml\s|@import\s|@media\s|:root\s*\{)/i;
const STYLESHEET_OPENING = /^[.#:]?[a-z][\w-]*(?:[\s,>+~]{1,3}[.#:]?[a-z][\w-]*){0,3}\s*\{\s*[\w-]+\s*:/i;
const MARKUP_ENDING = /[>}]$/;
const MARKDOWN_LAYOUT = /^(?:#{1,6}\s|[-*+]\s+\S|\d+[.)]\s+\S|>\s|\|.*\||\[[^\]\n]+\]\([^)\n]+\))/m;
const MARKDOWN_INLINE = /`[^`\n]+`|\*\*[^*\n]+\*\*/;
const FENCE = /^(?:```|~~~)/m;
// A line of a data literal: a key and its value, an item, a closing bracket or a comment.
const DATA_LINE = /^(?:\/\/|\/\*|\*|[}\]][,;)]*$|["'`]?[\w$-]+["'`]?\s*:|["'`\d[{-])/;

function isJson(value: string): boolean {
  if (!/^[{[]/.test(value)) return false;
  try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'object' && parsed !== null; } catch { return false; }
}

/** An object or array written out as code but not JSON (comments, unquoted keys, trailing commas). */
function isDataLiteral(value: string): boolean {
  if (!/^[{[]/.test(value)) return false;
  const lines = value.slice(0, 4000).split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length >= 3 && lines.filter(line => DATA_LINE.test(line)).length >= lines.length * 0.8;
}

export function looksLikeCode(text: string): boolean {
  const value = text.trim();
  if (value.length < 40 || FENCE.test(value)) return false;
  if (SCRIPT_OPENING.some(pattern => pattern.test(value)) || isJson(value)) return true;
  const head = value.slice(0, 2000);
  if ((MARKUP_OPENING.test(head) || STYLESHEET_OPENING.test(head)) && MARKUP_ENDING.test(value)) return true;
  const sample = value.slice(0, 4000);
  if (MARKDOWN_LAYOUT.test(sample.slice(0, 600)) || MARKDOWN_INLINE.test(sample)) return false;
  if (isDataLiteral(value)) return true;
  // Code is dense with its punctuation and ends its statements; prose is mostly letters.
  const punctuation = (sample.match(/[{}();=<>[\]]/g) ?? []).length;
  const letters = (sample.match(/[A-Za-z一-鿿]/g) ?? []).length;
  return punctuation / sample.length > 0.08 && /[;{}]/.test(sample) && letters / sample.length < 0.7;
}
