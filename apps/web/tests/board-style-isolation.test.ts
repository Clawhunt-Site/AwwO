import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Embedded-board style isolation (apps/web/src/styles.css).
//
// super's stylesheet is UNLAYERED while the embedded Paperclip board ships layered
// Tailwind, so any bare-element rule in super (h1, textarea, `button { font: inherit }`,
// …) outranks the board's utilities wherever it matches board content. This used to be
// countered with `revert-layer` bridge blocks — but `revert-layer` inside an UNLAYERED
// author rule resolves differently per engine (Chromium rolls back to the board's
// utilities layer; WebKit/WKWebView rolls back past it), which stripped every embedded
// button's padding / inflated fonts on the desktop app. The fix is scope-at-source:
// every bare-element rule carries a zero-specificity :where(:not(…board scopes…)) guard
// so it never matches board content anywhere (in-container or body-portals).
//
// These tests pin both halves of that contract at the stylesheet-source level.

// vitest's jsdom environment rewrites import.meta.url to an http URL, so resolve
// from the package root (vitest always runs with cwd = apps/web).
const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

const GUARD = ':where(:not(.company-board-root *, [data-slot], [data-slot] *, [data-board-portal], [data-board-portal] *, [data-paperclip-floating-ui], [data-paperclip-floating-ui] *))';

// Tags whose bare (element-selector) rules are known to bleed into the board when
// unguarded. Keep in sync with the guard comment in styles.css.
const GUARDED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li',
  'figure', 'blockquote', 'pre', 'textarea', 'input', 'select', 'button',
]);

/** Collect every selector list in the stylesheet (any nesting depth), split into
 * individual selector items with comments stripped. */
function collectSelectorItems(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const items: string[] = [];
  let start = 0;
  const stack: string[] = [];
  for (let i = 0; i < noComments.length; i += 1) {
    const ch = noComments[i];
    if (ch === '{') {
      const sel = noComments.slice(start, i).trim().split('}').pop()!.trim();
      stack.push(sel);
      if (!sel.startsWith('@')) {
        // Split on top-level commas only (parenthesised commas belong to :not()/:is()).
        let depth = 0;
        let item = '';
        for (const c of sel) {
          if (c === '(') depth += 1;
          if (c === ')') depth -= 1;
          if (c === ',' && depth === 0) {
            items.push(item.trim());
            item = '';
          } else {
            item += c;
          }
        }
        if (item.trim()) items.push(item.trim());
      }
      start = i + 1;
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    }
  }
  return items;
}

/** True when the selector item is a bare element rule for one of the guarded tags:
 * it starts with the tag itself (no ancestor scope, no class/id/attribute compound),
 * e.g. `textarea`, `h1`, `button:focus` — but NOT `.composer-card textarea` or
 * `button[aria-label="…"]`. */
function isUnscopedBareElementRule(item: string): boolean {
  const match = /^([a-z][a-z0-9]*)((?::[a-z-]+(?:\([^)]*\))?|\.[\w-]+|\[[^\]]*\])*)$/i.exec(
    item.replace(/\s+/g, ' '),
  );
  if (!match) return false;
  const [, tag, rest] = match;
  if (!GUARDED_TAGS.has(tag.toLowerCase())) return false;
  // A compound with a class/attribute qualifier is already scoped to super's own UI
  // (e.g. button[aria-label="Switch to light mode"] intentionally targets the board).
  if (/\.|\[/.test(rest.replace(/:where\(\s*:not\([^)]*\)\s*\)/g, ''))) return false;
  return !rest.includes(':where(:not(');
}

describe('embedded board style isolation', () => {
  it('contains no revert-layer declarations (engine-divergent in WebKit/WKWebView)', () => {
    const declarations = styles
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => /:\s*revert-layer\b/.test(line));
    expect(declarations).toEqual([]);
  });

  it('guards every bare-element rule for board-bleeding tags with the board-scope :where(:not(…))', () => {
    const unguarded = collectSelectorItems(styles).filter(isUnscopedBareElementRule);
    expect(unguarded).toEqual([]);
  });

  it('keeps the exact guard selector stable across all guarded rules', () => {
    // The guard string is load-bearing: [data-slot]/[data-board-portal]/
    // [data-paperclip-floating-ui] cover the board's body-portals, which render
    // OUTSIDE .company-board-root. Pin it verbatim so a partial edit (e.g. dropping
    // the portal scopes) fails loudly.
    const guarded = collectSelectorItems(styles).filter((item) => item.includes(':where(:not('));
    expect(guarded.length).toBeGreaterThanOrEqual(10);
    for (const item of guarded) {
      expect(item).toContain(GUARD);
    }
  });
});
