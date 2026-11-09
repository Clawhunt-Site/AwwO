// Older look and copy faults of the settings pages and the home, found in the screenshots of a signed-in check of the
// live site on 2026-11-08 (none from a recent change); each was measured in Chrome on a local build before its fix.
// jsdom draws nothing, so the layout rules are pinned at the stylesheet source (as saas-market-card-styles.test.ts
// does), with their specificity where a page-wide rule competes; the rest is rendered.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs with cwd = apps/web.
const SRC = resolve(process.cwd(), 'src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
type Rule = { selector: string; body: string };

/** Splits on commas outside parentheses. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0, item = '';
  for (const c of text) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { out.push(item.trim()); item = ''; } else item += c;
  }
  if (item.trim()) out.push(item.trim());
  return out;
}

/** Every innermost rule of a stylesheet (a media query's rules too), one per selector of its list. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{};]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (m[1].trim().startsWith('@')) continue;
    for (const selector of splitTop(m[1].trim())) out.push({ selector, body: m[2] });
  }
  return out;
}

/** A stylesheet without its at-rule blocks (media queries, keyframes, @property): the rules every width gets. */
function topLevel(css: string): string {
  let out = '', i = 0;
  while (i < css.length) {
    const at = css.indexOf('@', i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    const semi = css.indexOf(';', at);
    if (open < 0 || (semi >= 0 && semi < open)) { i = semi < 0 ? css.length : semi + 1; continue; }
    let depth = 0, j = open;
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}' && (depth -= 1) === 0) break;
    }
    i = j + 1;
  }
  return out;
}

/** What the last of a stylesheet's rules for exactly this selector (outside media queries) declares for a property. */
function declared(css: string, selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules(topLevel(css))) {
    if (rule.selector.replace(/\s+/g, ' ') !== selector) continue;
    const found = rule.body.split(';').map(part => part.trim()).filter(part => part.startsWith(property + ':')).pop();
    if (found) value = found.slice(property.length + 1).trim();
  }
  return value;
}

// The account panel (the header's 账号与工作区 dialog, and 设置 → 成员与工作区, which shows the same panel) cut a long
// display name or email mid-letter: its fields' text-overflow was clip.
describe('the account panel’s name and email', () => {
  it('end in an ellipsis, not mid-letter', () => {
    expect(declared(read('account/account.css'), '.account-workspace-panel input', 'text-overflow')).toBe('ellipsis');
  });
});
