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

type Spec = [number, number, number];
const PAREN = String.raw`\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`;
const compare = (a: Spec, b: Spec) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The specificity of the selectors these stylesheets write: :is, :not and :has count their most specific argument,
 *  :where nothing; ids; classes, attributes and pseudo-classes; types and pseudo-elements. */
function specificity(selector: string): Spec {
  const spec: Spec = [0, 0, 0];
  let rest = selector.replace(new RegExp(`:where${PAREN}`, 'g'), '');
  rest = rest.replace(new RegExp(`:(?:is|not|has)(${PAREN})`, 'g'), (_whole, args: string) => {
    const best = splitTop(args.slice(1, -1)).map(specificity).sort(compare).pop() ?? [0, 0, 0];
    spec[0] += best[0]; spec[1] += best[1]; spec[2] += best[2];
    return '';
  });
  rest = rest.replace(/::[\w-]+/g, () => { spec[2] += 1; return ''; });
  rest = rest.replace(/#[\w-]+/g, () => { spec[0] += 1; return ''; });
  rest = rest.replace(new RegExp(String.raw`\.[\w-]+|\[[^\]]*\]|:[\w-]+(?:${PAREN})?`, 'g'), () => { spec[1] += 1; return ''; });
  rest.replace(/(^|[\s>+~(])([a-zA-Z][\w-]*)/g, () => { spec[2] += 1; return ''; });
  return spec;
}

// The account panel (the header's 账号与工作区 dialog, and 设置 → 成员与工作区, which shows the same panel) cut a long
// display name or email mid-letter: its fields' text-overflow was clip.
describe('the account panel’s name and email', () => {
  it('end in an ellipsis, not mid-letter', () => {
    expect(declared(read('account/account.css'), '.account-workspace-panel input', 'text-overflow')).toBe('ellipsis');
  });
});

// On 设置 → 成员与工作区 the panel's refresh button drew a 6px-wide icon: the page's own rule for every button padded it
// 8px 14px, outranking the panel's padding 0 (the dialog had a rule of its own).
describe('the account panel’s refresh button', () => {
  it('stays unpadded against every page rule that pads the settings page’s buttons', () => {
    const own = rules(read('account/account.css')).find(rule => rule.selector === '.account-workspace-panel .account-icon-button');
    expect(own?.body).toMatch(/(^|;)\s*padding:\s*0\s*(;|$)/);
    // The classes around the panel there: the page (SettingsCenter.tsx), its content column and the members card
    // (settings/sections.tsx); a rule naming any other class, or a button's own class, does not reach this button.
    const around = new Set(['saas-dashboard', 'saas-personal', 'saas-settings', 'saas-settings-layout', 'saas-settings-content',
      'saas-card', 'saas-settings-card', 'saas-settings-members', 'account-workspace-panel', 'account-workspace-header']);
    const reaches = (selector: string) => {
      const compounds = selector.replace(/\s*([>+~])\s*/g, ' ').split(/\s+(?![^()]*\))/);
      const subject = compounds.pop() ?? '';
      if (!/^button(:[\w-]+(\([^()]*\))?)*$/.test(subject)) return false;
      return compounds.every(compound => {
        const any = new RegExp(`^:is${PAREN}$`).test(compound) ? splitTop(compound.slice(4, -1)) : [compound];
        return any.some(option => (option.match(/\.[\w-]+/g) ?? []).every(name => around.has(name.slice(1))));
      });
    };
    // Every stylesheet the hosted app loads on that page (saas/main.tsx, PersonalAccount.tsx, SettingsCenter.tsx), but
    // design/canvas.css, whose nested rules all sit under the canvas shell.
    const pages = ['styles.css', 'saas/saas.css', 'canvas/ios-theme.css', 'saas/design/system.css', 'saas/design/surfaces.css',
      'saas/design/modes.css', 'saas/personal-account.css', 'saas/settings/settings-center.css'];
    const padding = pages.flatMap(file => rules(read(file)).filter(rule => /(^|;)\s*padding(-inline|-left|-right)?\s*:/.test(rule.body) && reaches(rule.selector))
      .map(rule => ({ file, selector: rule.selector })));
    // The rule that squeezed it (design/system.css), so this check cannot pass by finding none.
    expect(padding).toContainEqual({ file: 'saas/design/system.css', selector: ':is(.saas-login, .saas-dashboard, .saas-notice) button' });
    for (const rule of padding) expect(compare(specificity(own!.selector), specificity(rule.selector)), `${rule.file}: ${rule.selector}`).toBeGreaterThan(0);
  });
});
