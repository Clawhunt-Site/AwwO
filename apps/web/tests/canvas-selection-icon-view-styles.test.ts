// The icon view's icons (图标视图, node-icon.css) wear the card skin (canvas-tile awwo-node is-<state>) for their plate and
// the converged icon's part classes for their head: they must stay round under every skin, move only by transforms, loop
// only while running and only where motion is welcome, keep their contrast in forced colours, and 多人同屏's marks must ring
// their round plates. Pinned at the stylesheet source.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs with cwd = apps/web.
const SRC = resolve(process.cwd(), 'src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const ICON = strip(read('canvas/node-icon.css'));
const MARKS = strip(read('canvas/multiplayer/multiplayer.css'));

/** A selector's specificity: [ids, classes + attributes + pseudo-classes, elements]. `:not()`, `:is()` and `:where()`
 *  count as their most specific argument (`:where()` as nothing), as the browser counts them. */
function specificity(selector: string): [number, number, number] {
  const logical = /:(not|is|where)\(([^()]*)\)/;
  let rest = selector;
  let total: [number, number, number] = [0, 0, 0];
  for (let match = logical.exec(rest); match; match = logical.exec(rest)) {
    if (match[1] !== 'where') {
      const most = match[2].split(',').map(item => specificity(item.trim())).sort((a, b) => outranks(b, a))[0];
      total = [total[0] + most[0], total[1] + most[1], total[2] + most[2]];
    }
    rest = rest.slice(0, match.index) + ' ' + rest.slice(match.index + match[0].length);
  }
  const ids = (rest.match(/#[\w-]+/g) ?? []).length;
  const classes = (rest.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (rest.replace(/\[[^\]]+\]|\.[\w-]+|#[\w-]+|:[\w-]+(\([^)]*\))?/g, ' ').match(/[a-z][\w-]*/gi) ?? []).length;
  return [total[0] + ids, total[1] + classes, total[2] + elements];
}
const outranks = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const block = (css: string, at: string) => {
  const start = css.indexOf(at);
  expect(start, at).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index++) {
    if (css[index] === '{') depth++;
    else if (css[index] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, index);
  }
  throw new Error(`unclosed ${at}`);
};
/** The selectors of the icon's rule that sets border-radius: 50% on the plate. */
function roundReset(): { selectors: string[]; body: string } {
  const match = /([^{}]+)\{([^{}]*display:\s*block;[^{}]*border-radius:\s*50%[^{}]*)\}/.exec(ICON);
  expect(match).toBeTruthy();
  return { selectors: match![1].split(',').map(selector => selector.trim()).filter(Boolean), body: match![2] };
}

describe('the icon stays round under every skin', () => {
  // Each skin's card rule, as written in its stylesheet (read 2026-11-08), with what a card adds to it the reset must
  // outrank too: a running card's breathe (the hosted skin's &.is-running), and in the hosted skin the settle ripple
  // (motion.css: .is-just-* with a :not() that counts as one class more).
  const CARD_RULES: Array<{ file: string; selector: string; animated: string[] }> = [
    { file: 'canvas/awwo-node.css', selector: '.canvas-root .canvas-tile.awwo-node', animated: ['.is-running'] },
    { file: 'canvas/ios-theme.css', selector: '.awwo-workspace .canvas-root .canvas-tile.awwo-node', animated: ['.is-running'] },
    { file: 'canvas/ios-theme.css', selector: ":root[data-theme='dark'] .awwo-workspace .canvas-root .canvas-tile.awwo-node", animated: ['.is-running'] },
    { file: 'saas/design/canvas.css', selector: 'html:root .saas-canvas-shell .canvas-root .canvas-tile.awwo-node',
      animated: ['.is-running', '.is-just-done:not(.canvas-tile--selected, .canvas-tile--focus)', '.is-just-failed:not(.canvas-tile--selected, .canvas-tile--focus)'] },
  ];

  it('still finds every card rule it has to outrank', () => {
    for (const rule of CARD_RULES) {
      const bare = rule.selector.replace(/^html:root \.saas-canvas-shell /, '');
      expect(read(rule.file).includes(bare), `${rule.file}: ${bare}`).toBe(true);
    }
    expect(read('saas/design/canvas.css')).toMatch(/&\.is-running \{[^}]*animation: awwo-signal-breathe/);
    const motion = strip(read('saas/design/motion.css'));
    for (const state of ['done', 'failed']) {
      expect(motion).toContain(`html:root .saas-canvas-shell .canvas-root .canvas-tile.awwo-node.is-just-${state}:not(.canvas-tile--selected, .canvas-tile--focus) {\n    animation: awwo-node-${state}-ping`);
    }
  });

  it('counts :not() as its most specific argument, as the browser does', () => {
    expect(specificity('.a:not(.b, .c)')).toEqual([0, 2, 0]);
    expect(specificity('.a:not(#b, .c)')).toEqual([1, 1, 0]);
    expect(specificity('html:root .a:where(.b)')).toEqual([0, 2, 1]);
  });

  it('outranks each of them, what a card adds included, with a reset that applies in the same place', () => {
    const { selectors } = roundReset();
    for (const rule of CARD_RULES) {
      const scope = rule.selector.replace(/\.canvas-root \.canvas-tile\.awwo-node$/, '');
      const ours = selectors.find(selector => selector.startsWith(`${scope}.canvas-root .canvas-tile.awwo-node.awwo-node-icon`.trim()));
      expect(ours, `no reset for ${rule.selector}`).toBeTruthy();
      expect(ours!.replace(/(\.awwo-node-icon)+$/, '')).toBe(`${scope}.canvas-root .canvas-tile.awwo-node`.trim());
      for (const added of rule.animated) {
        expect(outranks(specificity(ours!), specificity(`${rule.selector}${added}`)), `${ours} vs ${rule.selector}${added}`).toBeGreaterThan(0);
      }
    }
  });

  it('turns the breathe off, and leaves the card\'s padding and border alone (the drawer math reads them)', () => {
    const { body } = roundReset();
    expect(body).toMatch(/animation:\s*none;/);
    expect(body).toMatch(/overflow:\s*visible;/);
    expect(body).not.toMatch(/padding|border(-width)?:/);
  });

  it('is never the converged icon: its sheet loads after the converged icon\'s and claims none of its classes', () => {
    const tile = read('canvas/NodeIconTile.tsx');
    expect(tile.indexOf("import './converged-icon.css';")).toBeGreaterThan(0);
    expect(tile.indexOf("import './node-icon.css';")).toBeGreaterThan(tile.indexOf("import './converged-icon.css';"));
    expect(ICON).not.toMatch(/\.awwo-converged(\s|\.|,|\{|:)/);
    expect(ICON).not.toMatch(/\.canvas-tile-(title|dot)/);
  });
});

describe('its motion', () => {
  it('loops only inside a no-preference block, and only while it runs', () => {
    const inside = block(ICON, '@media (prefers-reduced-motion: no-preference)');
    const outside = ICON.replace(inside, '');
    expect(outside).not.toMatch(/infinite/);
    const loops = inside.split('\n').filter(line => /infinite/.test(line));
    expect(loops.length).toBe(3);
    for (const line of loops) expect(line).toContain('.awwo-node-icon.is-running ');
  });

  it('moves only by transforms, the arc and the eyes in the 2.2 s of one turn', () => {
    for (const name of ['awwo-node-icon-orbit', 'awwo-node-icon-gx', 'awwo-node-icon-gy']) {
      const frames = block(ICON, `@keyframes ${name}`);
      const properties = [...frames.matchAll(/([a-z-]+)\s*:/g)].map(match => match[1]).filter(property => property !== 'animation-timing-function');
      expect(properties.length, name).toBeGreaterThan(0);
      for (const property of properties) expect(['transform', 'translate'], `${name}: ${property}`).toContain(property);
    }
    const inside = block(ICON, '@media (prefers-reduced-motion: no-preference)');
    expect(inside).toMatch(/\.awwo-node-icon\.is-running \.awwo-node-icon-orbit \{ animation: awwo-node-icon-orbit 2\.2s linear infinite; \}/);
    expect(inside).toMatch(/\.awwo-node-icon\.is-running \.awwo-node-icon-gaze \{ animation: awwo-node-icon-gx 2\.2s linear infinite, awwo-node-icon-gy 2\.2s linear infinite; \}/);
    // The eyes' glance on a state change eases, a transition of translate alone; the hop and the shake are the
    // converged icon's own (transforms too).
    expect(inside).toMatch(/\.awwo-node-icon-gaze \{ transition: translate /);
    expect(inside).toMatch(/\.awwo-node-icon\.is-just-done \.awwo-converged-orb \{ animation: awwo-converged-hop /);
    expect(inside).toMatch(/\.awwo-node-icon\.is-just-failed \.awwo-converged-orb \{ animation: awwo-converged-shake /);
  });

  it('holds still under reduced motion: no arc going round, the full ring instead, nothing animated', () => {
    const reduce = block(ICON, '@media (prefers-reduced-motion: reduce)');
    expect(reduce).toMatch(/\.awwo-node-icon-orbit \{ display: none; \}/);
    expect(reduce).toMatch(/\.awwo-node-icon-still \{ display: inline; \}/);
    expect(reduce).toMatch(/\.canvas-root \.awwo-node-icon, \.canvas-root \.awwo-node-icon \* \{ animation: none !important; transition: none !important; \}/);
    // The still ring is hidden by default, outside any media block.
    expect(ICON.replace(reduce, '')).toMatch(/\.awwo-node-icon-still \{ display: none; \}/);
  });
});

describe('its ports, rows and contrast', () => {
  it('takes a press only on the ports themselves, and names a port\'s field only beside the one pointed at or focused', () => {
    expect(ICON).toMatch(/\.awwo-node-icon-ports \{[^}]*pointer-events: none;/);
    expect(ICON).toMatch(/\.awwo-node-icon-ports \.canvas-port \{ pointer-events: auto; \}/);
    expect(ICON).toMatch(/\.awwo-node-icon \.canvas-port:not\(:hover\):not\(:focus-visible\) \.canvas-port-field-label \{ display: none; \}/);
  });

  it('caps its rows at the room between two icons and keeps a wire under them from cutting the words, in every edition', () => {
    const label = /\.awwo-node-icon-label \{([^}]*)\}/.exec(ICON)![1];
    expect(label).toMatch(/max-width: min\(calc\(280px \* var\(--cv-px, 1\)\), 320px\);/);
    // The hosted skin's board token, else the board's own page colour (the local edition defines no --saas-canvas).
    const halos = [...label.matchAll(/var\(--saas-canvas, var\(--page, #e9ecea\)\)/g)];
    expect(halos).toHaveLength(2);
    expect(label).not.toMatch(/var\(--saas-canvas, #/);
    // The halo is let past the rows' edges: clipped there, never hidden (the ellipsis stays).
    expect(ICON).toMatch(/\.awwo-node-icon \.awwo-node-icon-label > span \{ overflow: clip; overflow-clip-margin: calc\(3px \* var\(--cv-px, 1\)\); \}/);
    expect(ICON).toMatch(/\.awwo-node-icon-label \.awwo-converged-name \{ pointer-events: auto; \}/);
    // The cursor is the card's (move, grabbing while pressed): the sheet sets none that would outrank it.
    expect(ICON).not.toMatch(/cursor:/);
  });

  it('outlines a selected icon and paints its token in system colours above every state rule in forced colours', () => {
    const forced = block(ICON, '@media (forced-colors: active)');
    const declarations = [...forced.matchAll(/\b(outline|outline-offset|stroke|text-shadow):\s*([^;]+);/g)];
    expect(declarations.length).toBe(4);
    for (const [, property, value] of declarations) expect(value, `${property}: ${value}`).toMatch(/!important$/);
    // Not the one with the keyboard's focus: its focus ring shows instead, so a selected group says which has the focus.
    expect(forced).toMatch(/\.awwo-node-icon\.canvas-tile--selected \.awwo-node-icon-hit:not\(:focus-visible\) \{ outline: [^;]*Highlight !important;/);
    expect(ICON.replace(forced, '')).toMatch(/\.awwo-node-icon-hit:focus-visible \{\s*outline: calc\(3px \* var\(--cv-px, 1\)\) solid/);
    expect(forced).toMatch(/\.awwo-node-icon-token path \{ stroke: Canvas !important; \}/);
  });
});

describe('多人同屏\'s marks on a round plate', () => {
  it('ring the plate, and centre the names over it with a claim\'s badge above them', () => {
    expect(MARKS).toMatch(/\.awwo-multiplayer-mark\[data-round\] \{ --mp-node-radius: 50%; \}/);
    // The rings and the glow round off from --mp-node-radius, so a round plate rounds them all.
    expect(MARKS).toMatch(/\.awwo-multiplayer-ring \{[^}]*border-radius: calc\(var\(--mp-node-radius\) \+ var\(--mp-gap\)\);/);
    expect(MARKS).toMatch(/\.awwo-multiplayer-flash \{[^}]*border-radius: calc\(var\(--mp-node-radius\)/);
    expect(MARKS).toMatch(/\.awwo-multiplayer-mark\[data-round\] \.awwo-multiplayer-tags,\s*\.awwo-multiplayer-mark\[data-round\] \.awwo-multiplayer-claim \{ left: 50%; right: auto; translate: -50% 0; transform-origin: 50% 100%; \}/);
    expect(MARKS).toMatch(/\.awwo-multiplayer-mark\[data-round\]\[data-tagged\] \.awwo-multiplayer-claim \{ margin-bottom: calc\(\(30px \+ 4px \* var\(--mp-rings, 0\)\) \* var\(--mp-inv\)\); \}/);
    // A card's marks are as they were: names on the left, the badge on the right.
    expect(MARKS).toMatch(/\.awwo-multiplayer-tags \{ left: calc\(-4px \* var\(--mp-inv\)\);/);
    expect(MARKS).toMatch(/\.awwo-multiplayer-claim \{\s*right: calc\(-4px \* var\(--mp-inv\)\);/);
  });
});
