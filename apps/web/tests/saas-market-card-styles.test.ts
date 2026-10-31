import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Agent market's cards and its primary button are buttons, and the pages the market opens on style every button:
// the hosted shell (design/system.css, saas.css, the iOS theme's rules) and the library frame (canvas-library.css).
// On 2026-10-31 the cards came out as pills on the workspace home and its Use button turned white on near-white under
// the pointer, because those page-wide rules outranked the market's own bare classes. These tests pin, at the
// stylesheet source, that for every property the market sets, its own rule outranks each page-wide button rule in each
// state the rule applies to: as drawn, hovered and pressed. A tie fails too: which file the bundle puts last decides one.

// vitest runs with cwd = apps/web.
const SRC = resolve(process.cwd(), 'src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
// The stylesheets with button rules for the pages and frames below (none of them nests rules, which the parser here
// relies on). design/canvas.css nests, and none of its rules reaches a button inside the market.
const PAGE_WIDE = ['saas/design/system.css', 'saas/saas.css', 'canvas/ios-theme.css', 'saas/canvas-library.css', 'canvas/awwo-workspace.css'];
// The classes of the market's wrappers where it shows, read in Chrome on 2026-10-31: the workspace home's strip, the
// market opened from it and from a canvas's bar; with the hosted shell's other page classes.
const SCOPES = new Set([
  'saas-dashboard', 'saas-home', 'saas-home-section', 'saas-market-strip', 'awwo-knowledge-overlay', 'awwo-library', 'awwo-market',
  'awwo-library-body', 'has-editor', 'awwo-library-list-column', 'awwo-library-group', 'awwo-stage-canvas', 'awwo-stage', 'awwo-main',
  'awwo-workspace', 'is-simple', 'has-model-library', 'saas-canvas-shell',
  'saas-login', 'saas-notice', 'saas-card', 'saas-native-dialog', 'saas-error-banner',
]);
const STATES = ['drawn', 'hover', 'active'] as const;
type State = typeof STATES[number];
type Spec = [number, number, number];
interface Rule { selector: string; props: Set<string>; important: Set<string>; spec: Spec; index: number }

/** Longhands the shells set, under the name the market's rules set them by. */
const KEY: Record<string, string> = {
  border: 'border-color', 'border-color': 'border-color', background: 'background', 'background-color': 'background',
  font: 'font', 'font-family': 'font', 'font-size': 'font', 'font-weight': 'font', 'line-height': 'font',
};

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

/** Every rule of a stylesheet without nesting (at-rules' own preludes skipped), one per selector of its list. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const re = /([^{};]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const prelude = m[1].trim();
    if (prelude.startsWith('@')) continue;
    const declarations = m[2].split(';').map(d => d.trim()).filter(Boolean);
    const name = (d: string) => { const p = d.split(':')[0].trim().toLowerCase(); return KEY[p] ?? p; };
    const props = new Set(declarations.map(name));
    const important = new Set(declarations.filter(d => /!\s*important\s*$/i.test(d)).map(name));
    for (const selector of splitTop(prelude)) out.push({ selector, props, important, spec: specificity(selector), index: out.length });
  }
  return out;
}

function add(a: Spec, b: Spec): Spec { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function compare(a: Spec, b: Spec): number { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }

/** Specificity of the selectors these stylesheets write: ids, classes, attributes, pseudo-classes and types; :is, :not
 * and :has count their most specific argument, :where nothing. (Not :nth-child(… of S), which none of them uses.) */
function specificity(selector: string): Spec {
  let spec: Spec = [0, 0, 0];
  let i = 0;
  const ident = () => { const m = /^-?[_a-zA-Z][\w-]*/.exec(selector.slice(i)); i += m ? m[0].length : 1; return m ? m[0] : ''; };
  const group = () => { // the text inside the parenthesis at i, i left after it
    let depth = 0, start = i + 1;
    for (; i < selector.length; i += 1) {
      if (selector[i] === '(') depth += 1;
      if (selector[i] === ')' && --depth === 0) { i += 1; return selector.slice(start, i - 1); }
    }
    return selector.slice(start);
  };
  while (i < selector.length) {
    const c = selector[i];
    if (c === '#') { i += 1; ident(); spec = add(spec, [1, 0, 0]); }
    else if (c === '.') { i += 1; ident(); spec = add(spec, [0, 1, 0]); }
    else if (c === '[') { i = selector.indexOf(']', i) + 1 || selector.length; spec = add(spec, [0, 1, 0]); }
    else if (c === ':' && selector[i + 1] === ':') { i += 2; ident(); if (selector[i] === '(') group(); spec = add(spec, [0, 0, 1]); }
    else if (c === ':') {
      i += 1;
      const name = ident().toLowerCase();
      const args = selector[i] === '(' ? group() : null;
      if (name === 'where') continue;
      if (args !== null && ['is', 'not', 'has'].includes(name)) {
        spec = add(spec, splitTop(args).map(specificity).reduce((a, b) => (compare(a, b) >= 0 ? a : b), [0, 0, 0] as Spec));
      } else spec = add(spec, [0, 1, 0]);
    }
    else if (/[_a-zA-Z]/.test(c)) { ident(); spec = add(spec, [0, 0, 1]); }
    else i += 1; // combinators, whitespace, *
  }
  return spec;
}

/** The selector's last compound, which says what element it styles and in which state. */
function lastCompound(selector: string): string {
  let depth = 0;
  for (let i = selector.length - 1; i >= 0; i -= 1) {
    const c = selector[i];
    if (c === ')') depth += 1;
    if (c === '(') depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(c)) return selector.slice(i + 1);
  }
  return selector;
}

const STATE_PSEUDO = /:(hover|active|disabled|focus|focus-visible|focus-within)\b/;

/** Whether a compound's pseudo-classes hold for an enabled, unfocused button, hovered or not, pressed or not:
 * :is()/:where() hold when one of their arguments does, :not() when none of its state-naming arguments does. An
 * argument naming no state (a class) is taken to hold for a page's rule (it may) and not for the market's (it may not). */
function holds(compound: string, hovered: boolean, pressed: boolean, page: boolean): boolean {
  for (const m of compound.matchAll(/:([\w-]+)(\((?:[^()]|\([^()]*\))*\))?/g)) {
    const name = m[1].toLowerCase();
    const args = m[2] ? splitTop(m[2].slice(1, -1)) : [];
    if (name === 'hover' && !hovered) return false;
    if (name === 'active' && !pressed) return false;
    if (['disabled', 'focus', 'focus-visible', 'focus-within'].includes(name)) return false;
    if ((name === 'is' || name === 'where') && args.some(arg => STATE_PSEUDO.test(arg))
      && !args.some(arg => (STATE_PSEUDO.test(arg) ? holds(arg, hovered, pressed, page) : page))) return false;
    if (name === 'not' && args.some(arg => STATE_PSEUDO.test(arg) && holds(arg, hovered, pressed, page))) return false;
  }
  return true;
}

/** The states a rule applies in, by its last compound. A pointer's press is hovered as well, so a :hover rule applies
 * pressed too; :is(:hover, :active) in either state; :hover:active pressed only. `page`: a page's rule, not the market's. */
function statesOf(selector: string, page = true): Set<State> {
  const last = lastCompound(selector);
  const states = new Set<State>();
  if (holds(last, false, false, page)) states.add('drawn');
  if (holds(last, true, false, page)) states.add('hover');
  if (holds(last, true, true, page)) states.add('active');
  return states;
}

/** Whether a stylesheet nests a rule inside another (any block opened inside a block that is no at-rule). */
function nests(css: string): boolean {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack: boolean[] = []; // per open block: is it an at-rule
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') {
      const prelude = text.slice(start, i).trim();
      if (stack.length && !stack[stack.length - 1]) return true;
      stack.push(prelude.startsWith('@'));
      start = i + 1;
    } else if (text[i] === '}') { stack.pop(); start = i + 1; } else if (text[i] === ';') start = i + 1;
  }
  return false;
}

/** A page-wide button rule: any button anywhere, or in the market's pages or frames (each compound before it classes
 * all of SCOPES, or an :is() of classes naming one of them), maybe under a theme's :root or html. */
function pageWide(rule: Rule): boolean {
  const theme = /^(?::root|html)(?:\[[^\]]+\]|:[\w-]+)*\s+/;
  const selector = rule.selector.replace(theme, '');
  const button = /^button(?::[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?)*$/;
  const last = lastCompound(selector);
  if (!button.test(last)) return false;
  const scopes: string[] = [];
  let depth = 0, item = '';
  for (const c of selector.slice(0, -last.length)) { // compounds split at whitespace outside parentheses
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (depth === 0 && /\s/.test(c)) { if (item) scopes.push(item); item = ''; } else item += c;
  }
  if (item) scopes.push(item);
  return scopes.every(compound => {
    if (/^(\.[\w-]+)+$/.test(compound)) return compound.slice(1).split('.').every(name => SCOPES.has(name));
    const any = /^:is\(\s*(\.[\w-]+(?:\s*,\s*\.[\w-]+)*)\s*\)$/.exec(compound);
    return any !== null && any[1].split(',').some(name => SCOPES.has(name.trim().slice(1)));
  });
}

const shellRules = PAGE_WIDE.flatMap(file => rules(read(file))).filter(pageWide);
// Each file's rules with their own order: the market's rules compete with each other by it.
const market = rules(read('saas/market/market.css'));
const library = rules(read('saas/canvas-library.css'));

/** For every property the target must set and every one its rules set, in every state: the target has a rule for it,
 * and its best one outranks each page-wide rule that sets it. */
function outranks(target: Rule[], label: string, required: string[]) {
  const set = new Set([...required, ...target.flatMap(rule => [...rule.props])]);
  const best = (prop: string, state: State) => target.filter(rule => rule.props.has(prop) && statesOf(rule.selector, false).has(state))
    .reduce<Rule | null>((a, b) => (!a || compare(b.spec, a.spec) > 0 ? b : a), null);
  const problems: string[] = [];
  for (const prop of required) for (const state of STATES) if (!best(prop, state)) problems.push(`${label} ${state}: no rule sets ${prop}`);
  for (const shell of shellRules) {
    for (const prop of shell.props) {
      if (!set.has(prop)) continue;
      if (shell.important.has(prop)) { problems.push(`${label}: ${prop} of «${shell.selector}» is !important`); continue; }
      for (const state of statesOf(shell.selector)) {
        const own = best(prop, state);
        if (!own || compare(own.spec, shell.spec) <= 0) {
          problems.push(`${label} ${state}: ${prop} of «${shell.selector}» (${shell.spec}) is not outranked${own ? ` by «${own.selector}» (${own.spec})` : ''}`);
        }
      }
    }
  }
  return problems;
}

// The classes a rule's element must carry: its last compound's, not those inside :not().
const carries = (rule: Rule, name: string) => new RegExp(`\\.${name}(?![\\w-])`).test(lastCompound(rule.selector).replace(/:not\((?:[^()]|\([^()]*\))*\)/g, ''));
const isCard = (rule: Rule) => carries(rule, 'awwo-market-card');
const isSelected = (rule: Rule) => carries(rule, 'is-selected');
// What the pages' button rules set that a card and the primary button must set for themselves.
const CARD_PROPS = ['display', 'gap', 'min-height', 'padding', 'border-color', 'border-radius', 'background', 'color', 'font'];
const PRIMARY_PROPS = ['background', 'border-color', 'color'];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? tsxFiles(join(dir, entry.name))
    : entry.name.endsWith('.tsx') ? [join(dir, entry.name)] : []);
}

describe('the Agent market draws its own cards and primary button on every page', () => {
  it('finds the page-wide button rules it has to outrank', () => {
    const named = shellRules.map(rule => rule.selector);
    expect(named).toContain(':is(.saas-login, .saas-dashboard, .saas-notice) button');
    expect(named).toContain(':is(.saas-login, .saas-dashboard, .saas-notice) button:not(:disabled):hover');
    expect(named).toContain('.awwo-library button');
    expect(specificity(':is(.saas-login, .saas-dashboard, .saas-notice) button:not(:disabled):hover')).toEqual([0, 3, 1]);
    expect(specificity('.awwo-market-cards button.awwo-market-card:not(:disabled):is(:hover, :active)')).toEqual([0, 4, 1]);
    expect(specificity(':where(.a, #b) button')).toEqual([0, 0, 1]);
    expect([...statesOf('a button:not(:disabled):hover')!]).toEqual(['hover', 'active']);
    expect([...statesOf('a button:is(:hover, :active)')!]).toEqual(['hover', 'active']);
    expect([...statesOf('a button:hover:active')!]).toEqual(['active']);
    expect([...statesOf('a button:active')!]).toEqual(['active']);
    expect([...statesOf('a button:is(:hover:active)')]).toEqual(['active']);
    expect([...statesOf('a button:hover:not(:active)')]).toEqual(['hover']);
    expect([...statesOf('a button:not(:disabled, .is-selected)')]).toEqual(['drawn', 'hover', 'active']);
    expect(statesOf('a button:focus-visible').size).toBe(0);
    expect([...statesOf('a button:is(:hover:active, .is-selected)', false)]).toEqual(['active']);
    expect([...statesOf('a button:is(:hover:active, .is-selected)')]).toEqual(['drawn', 'hover', 'active']);
    expect(pageWide(rules('button:not(:disabled):hover { color: red }')[0])).toBe(true);
    expect(nests('.a { b { c: d } }')).toBe(true);
    expect(nests('@media (x) { .a { b: c } } @keyframes k { from { b: c } }')).toBe(false);
    expect(pageWide(rules(':root[data-theme="dark"] .saas-dashboard button { color: red }')[0])).toBe(true);
    expect(pageWide(rules('.saas-canvas-shell .awwo-workspace button:hover { color: red }')[0])).toBe(true);
    expect(pageWide(rules('.awwo-library.awwo-market button { color: red }')[0])).toBe(true);
    expect(pageWide(rules('.awwo-workspace.is-nav-compact button { color: red }')[0])).toBe(false);
    expect(pageWide(rules('.saas-account-actions .saas-card button { color: red }')[0])).toBe(false);
    expect(pageWide(rules(":root[data-theme='dark'] .awwo-view-tools button { color: red }")[0])).toBe(false);
    for (const file of PAGE_WIDE) expect(nests(read(file)), `${file} nests rules`).toBe(false);
  });

  it('names the list every card is rendered in', () => {
    const lists = new Set(market.filter(isCard).map(rule => rule.selector.slice(0, -lastCompound(rule.selector).length).trim()));
    expect([...lists]).toEqual(['.awwo-market-cards']);
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const renders = tsxFiles(SRC).map(file => code(readFileSync(file, 'utf8'))).filter(text => text.includes('<MarketAgentCard'));
    expect(renders.length).toBeGreaterThan(0);
    for (const text of renders) {
      for (let at = text.indexOf('<MarketAgentCard'); at >= 0; at = text.indexOf('<MarketAgentCard', at + 1)) {
        const open = text.lastIndexOf('<ul className="awwo-market-cards">', at);
        expect(open, 'a card outside the list its rules name').toBeGreaterThanOrEqual(0);
        expect(text.indexOf('</ul>', open), 'a card outside the list its rules name').toBeGreaterThan(at);
      }
    }
  });

  it('a card outranks them as drawn, hovered and pressed', () => {
    const card = market.filter(rule => isCard(rule) && !isSelected(rule));
    expect(card.length).toBeGreaterThan(0);
    expect(outranks(card, 'card', CARD_PROPS)).toEqual([]);
  });

  it('a selected card keeps its ring in every state', () => {
    const all = market.filter(isCard);
    for (const state of STATES) {
      const contenders = [...all, ...shellRules].filter(rule => rule.props.has('border-color') && statesOf(rule.selector, !market.includes(rule)).has(state));
      const top = contenders.reduce((a, b) => {
        const order = compare(b.spec, a.spec);
        if (order) return order > 0 ? b : a;
        // Equal: the market's own rules keep their file order; against a page-wide rule a tie is unsafe.
        return market.includes(a) && market.includes(b) ? (b.index > a.index ? b : a) : shellRules.includes(a) ? a : b;
      });
      expect(isSelected(top), `${state}: «${top.selector}» decides a selected card's border`).toBe(true);
    }
  });

  it('the library frame\'s primary button outranks them as drawn, hovered and pressed', () => {
    const primary = library.filter(rule => /\.awwo-library-primary(?![\w-])/.test(lastCompound(rule.selector)));
    expect(primary.length).toBeGreaterThan(0);
    expect(outranks(primary, 'primary', PRIMARY_PROPS)).toEqual([]);
  });
});
