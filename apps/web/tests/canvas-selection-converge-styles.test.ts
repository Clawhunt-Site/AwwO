// The converged icon wears the card skin (canvas-tile awwo-node is-<state>) and must stay round under every skin, and
// still under reduced motion. Pinned at the stylesheet source: each skin's card rule that rounds a card's corners is
// outranked by the icon's round reset, and nothing of the icon loops outside a no-preference block.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs with cwd = apps/web.
const SRC = resolve(process.cwd(), 'src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
const ICON = read('canvas/converged-icon.css');

/** CSS specificity of a simple selector list item: [ids, classes + attributes + pseudo-classes, elements]. */
function specificity(selector: string): [number, number, number] {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (selector.replace(/\[[^\]]+\]|\.[\w-]+|#[\w-]+|:[\w-]+(\([^)]*\))?/g, ' ').match(/[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, elements];
}
const outranks = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The selectors of the icon's rule that sets border-radius: 50%. */
function roundReset(): string[] {
  const match = /([^{}]+)\{[^{}]*border-radius:\s*50%[^{}]*\}/.exec(ICON.replace(/\/\*[\s\S]*?\*\//g, ''));
  expect(match).toBeTruthy();
  return match![1].split(',').map(selector => selector.trim()).filter(Boolean);
}

describe('the converged icon stays round under every skin', () => {
  // Each skin's card rule that sets a card's corner radius, as written in its stylesheet (read 2026-11-06).
  const CARD_RULES: Array<{ file: string; selector: string }> = [
    { file: 'canvas/awwo-node.css', selector: '.canvas-root .canvas-tile.awwo-node' },
    { file: 'canvas/ios-theme.css', selector: '.awwo-workspace .canvas-root .canvas-tile.awwo-node' },
    { file: 'canvas/ios-theme.css', selector: ":root[data-theme='dark'] .awwo-workspace .canvas-root .canvas-tile.awwo-node" },
    // The hosted skin nests its cards in html:root .saas-canvas-shell { … }.
    { file: 'saas/design/canvas.css', selector: 'html:root .saas-canvas-shell .canvas-root .canvas-tile.awwo-node' },
  ];

  it('still finds every card rule it has to outrank', () => {
    for (const rule of CARD_RULES) {
      const source = read(rule.file);
      const bare = rule.selector.replace(/^html:root \.saas-canvas-shell /, '');
      expect(source.includes(bare), `${rule.file}: ${bare}`).toBe(true);
    }
    expect(read('saas/design/canvas.css')).toContain('html:root .saas-canvas-shell {');
  });

  it('outranks each of them with a reset that applies in the same place', () => {
    const reset = roundReset();
    for (const rule of CARD_RULES) {
      const scope = rule.selector.replace(/\.canvas-root \.canvas-tile\.awwo-node$/, '');
      const ours = reset.find(selector => selector === `${scope}.canvas-root .canvas-tile.awwo-node.awwo-converged`.replace(/^ +/, ''));
      expect(ours, `no reset for ${rule.selector}`).toBeTruthy();
      expect(outranks(specificity(ours!), specificity(rule.selector)), `${ours} vs ${rule.selector}`).toBeGreaterThan(0);
    }
  });
});

describe('the converged icon under reduced motion', () => {
  it('stops every animation and transition of the icon, whatever a skin shortens', () => {
    const reduce = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(ICON);
    expect(reduce).toBeTruthy();
    expect(reduce![1]).toMatch(/\.canvas-root \.awwo-converged, \.canvas-root \.awwo-converged \* \{ animation: none !important; transition: none !important; \}/);
  });

  it('loops only inside a no-preference block, and only while running', () => {
    const outside = ICON.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\n\}/, '');
    expect(outside).not.toMatch(/infinite/);
    const inside = /@media \(prefers-reduced-motion: no-preference\)\s*\{([\s\S]*?)\n\}/.exec(ICON)![1];
    for (const line of inside.split('\n').filter(item => /infinite/.test(item))) expect(line).toContain('.is-running');
  });

  it('breathes the running arcs in width, never in colour or opacity, so they keep their contrast at every moment', () => {
    const breathe = /@keyframes awwo-converged-breathe \{([\s\S]*?)\}\s*\n/.exec(ICON);
    expect(breathe).toBeTruthy();
    expect(breathe![1]).toMatch(/stroke-width/);
    expect(breathe![1]).not.toMatch(/opacity|stroke:|color|filter/);
    // The live layer's arcs take its phase (set on the layer at mount): one shared breath.
    expect(ICON).toMatch(/\.awwo-converged-live \.awwo-converged-arc \{ animation: awwo-converged-breathe [^}]*animation-delay: inherit;/);
  });
});

describe('the converged icon\'s count badge', () => {
  it('sets its type in longhands, so a missing family token (the index.html entry loads no tokens.css) voids nothing else', () => {
    // In the font shorthand, var(--saas-font, inherit) with no token voids the whole declaration: the count took the
    // icon's 26.67-unit, regular type. As longhands only the family falls back.
    const badge = /\n\.awwo-converged-badge \{([^}]*)\}/.exec(ICON.replace(/\/\*[\s\S]*?\*\//g, ''));
    expect(badge).toBeTruthy();
    expect(badge![1]).not.toMatch(/(^|[\s;])font:/);
    expect(badge![1]).toMatch(/font-weight: 700;/);
    expect(badge![1]).toMatch(/font-size: max\(11px, calc\(10px \* var\(--cv-px, 1\)\)\);/);
    expect(badge![1]).toMatch(/line-height: 1;/);
    expect(badge![1]).toMatch(/font-family: var\(--saas-font, inherit\);/);
  });
});

describe('the converged icon in forced colours', () => {
  it('paints every arc, the collar and the badge in system colours above every state rule', () => {
    const forced = /@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/.exec(ICON);
    expect(forced).toBeTruthy();
    // A media query adds no specificity, and the state rules (.awwo-converged-arc.is-done …) outrank a bare class: every
    // colour set here is !important, or it would lose to them (SVG keeps its own strokes in forced colours).
    const colours = [...forced![1].matchAll(/\b(stroke|background|color|box-shadow):\s*([^;]+);/g)];
    expect(colours.length).toBeGreaterThanOrEqual(5);
    for (const [, property, value] of colours) expect(value, `${property}: ${value}`).toMatch(/!important$/);
    expect(forced![1]).toMatch(/\.awwo-converged-arc\.is-running \{ stroke: Highlight !important; \}/);
  });
});
