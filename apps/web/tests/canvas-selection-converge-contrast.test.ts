// THE CONVERGED ICON ON EVERY STYLE. Its states are told by colour on its dark collar (and by shape: widths, dashes, the
// keyline), so each of the eight presets' colours must read there: an arc at least 3:1 on the collar (WCAG non-text
// contrast), a failed arc on its keyline and the keyline on the collar, the badge's digit 4.5:1 on its fill, and the words
// under it 4.5:1 on the board. The values are read from themes.css, as saas-themes.test.tsx reads them; which token
// paints which part is read from the icon's own stylesheet, so a change of token is checked here too.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AWWO_THEMES } from '../src/saas/themes';

const themes = readFileSync(resolve(process.cwd(), 'src/saas/design/themes.css'), 'utf8');
const tokens = readFileSync(resolve(process.cwd(), 'src/saas/design/tokens.css'), 'utf8');
const iconCss = readFileSync(resolve(process.cwd(), 'src/canvas/converged-icon.css'), 'utf8');

/** The custom properties a style's own block declares (html:root[data-awwo-theme='<id>'], ...). */
function block(id: string): Record<string, string> {
  const match = themes.match(new RegExp(`html:root\\[data-awwo-theme='${id}'\\][^{]*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no block for ${id}`);
  return Object.fromEntries([...match[1].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** a at `share` over b: color-mix(in srgb, a share, b), or rgb(a / share) painted on b. */
const mix = (a: string, b: string, share: number) => '#' + rgb(a).map((v, i) => Math.round(v * share + rgb(b)[i] * (1 - share)).toString(16).padStart(2, '0')).join('');
const fromTriplet = (triplet: string) => '#' + triplet.split(/\s+/).map(n => Number(n).toString(16).padStart(2, '0')).join('');

/** The declarations of the first rule with exactly this selector in the icon's stylesheet. */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = iconCss.match(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no rule ${selector}`);
  return match[1];
}

describe('which token paints each part of the icon', () => {
  it('is the one this test measures', () => {
    expect(declarations('.awwo-converged-collar')).toMatch(/stroke:\s*var\(--saas-orb-edge\b/);
    // The base arc is the idle track: a component with no result yet.
    expect(declarations('.awwo-converged-arc')).toMatch(/stroke:\s*rgb\(var\(--saas-orb-hi-rgb[^)]*\)\s*\/\s*40%\)/);
    expect(declarations('.awwo-converged-arc.is-done')).toMatch(/stroke:\s*var\(--saas-success-dot\b/);
    expect(declarations('.awwo-converged-arc:is(.is-cached, .is-delivered)')).toMatch(/stroke:\s*var\(--saas-success-dot\b/);
    expect(declarations('.awwo-converged-arc.is-running')).toMatch(/stroke:\s*var\(--saas-signal\b/);
    expect(declarations('.awwo-converged-arc.is-waiting')).toMatch(/stroke:\s*var\(--saas-signal\b/);
    expect(declarations('.awwo-converged-keyline')).toMatch(/stroke:\s*rgb\(var\(--saas-orb-hi-rgb[^)]*\)\s*\/\s*92%\)/);
    // On a dark style the keyline is the red itself: a failure is a thicker red arc there.
    expect(declarations("html:root[data-theme='dark'] .awwo-converged-keyline")).toMatch(/stroke:\s*var\(--saas-danger\b/);
    expect(declarations('.awwo-converged-arc.is-failed')).toMatch(/stroke:\s*var\(--saas-danger\b/);
    expect(declarations('.awwo-converged-arc.is-blocked')).toMatch(/stroke:\s*var\(--saas-warning-dot\b/);
    expect(declarations('.awwo-converged-arc.is-cancelled')).toMatch(/stroke:\s*rgb\(var\(--saas-orb-hi-rgb[^)]*\)\s*\/\s*60%\)[\s\S]*stroke-dasharray/);
    expect(declarations('.awwo-converged-badge.is-failed')).toMatch(/background:\s*var\(--saas-danger\b[\s\S]*color:\s*#fff/);
    expect(declarations('.awwo-converged-badge.is-blocked')).toMatch(/background:\s*var\(--saas-warning-dot\b[\s\S]*color:\s*var\(--saas-text\b/);
    expect(declarations("html:root[data-theme='dark'] .awwo-converged-badge:is(.is-failed, .is-blocked)")).toMatch(/color:\s*var\(--saas-canvas\b/);
    expect(declarations('.awwo-converged-name')).toMatch(/color:\s*var\(--saas-text\b/);
    expect(declarations('.awwo-converged-state, .awwo-converged-now')).toMatch(/color:\s*var\(--saas-muted\b/);
    expect(declarations('.awwo-converged-state .is-failed')).toMatch(/color:\s*color-mix\(in srgb, var\(--saas-danger\b[^;]*\) 80%, var\(--saas-text\b/);
    expect(declarations('.awwo-converged-state .is-blocked')).toMatch(/color:\s*color-mix\(in srgb, var\(--saas-warning\b[^;]*\) 80%, var\(--saas-text\b/);
    // And those tokens are the presets' own colours.
    for (const [token, own] of [['--saas-signal', '--agent-running'], ['--saas-danger', '--danger-bg'], ['--saas-warning', '--warn'],
      ['--saas-text', '--text-primary'], ['--saas-muted', '--text-secondary']]) {
      expect(tokens).toMatch(new RegExp(`${token}:\\s*var\\(${own}\\);`));
    }
    expect(themes).toContain('--saas-canvas: color-mix(in srgb, var(--bg-base) 96%, var(--text-primary));');
    expect(themes).toContain('--saas-canvas: color-mix(in srgb, var(--bg-base) 72%, #000);');
  });
});

describe('the icon on each of the eight styles', () => {
  it.each(AWWO_THEMES.map(theme => [theme.id, theme.scheme] as const))('%s: every state reads on the collar, and the badge and words read', (id, scheme) => {
    const v = block(id);
    const collar = v['--saas-orb-edge'];
    const hi = fromTriplet(v['--saas-orb-hi-rgb']);
    // Light styles keyline a failure in the orb's highlight; dark ones in the red itself (see the rules above).
    const keyline = scheme === 'light' ? mix(hi, collar, 0.92) : v['--danger-bg'];
    const board = scheme === 'light' ? mix(v['--bg-base'], v['--text-primary'], 0.96) : mix(v['--bg-base'], '#000000', 0.72);
    const arcs: Array<[string, string]> = [
      ['no result yet (the idle track)', mix(hi, collar, 0.4)],
      ['done, reused and earlier results', v['--saas-success-dot']],
      // Running arcs breathe in width, never in colour (canvas-selection-converge-styles.test.ts): this is every moment.
      ['running and waiting', v['--agent-running']],
      ['blocked', v['--saas-warning-dot']],
      ['cancelled', mix(hi, collar, 0.6)],
      ['the failure keyline', keyline],
    ];
    for (const [part, colour] of arcs) expect(contrast(colour, collar), `${id} ${part} ${colour} on the collar ${collar}`).toBeGreaterThanOrEqual(3);
    // Where the keyline is lighter than the red, the red must read on it too (on a dark style they are one colour).
    if (scheme === 'light') expect(contrast(v['--danger-bg'], keyline), `${id} failed arc on its keyline`).toBeGreaterThanOrEqual(3);
    // On a light board the dark collar is what outlines the icon.
    if (scheme === 'light') expect(contrast(collar, board), `${id} collar on the board`).toBeGreaterThanOrEqual(3);
    // The badge's digit on its fill: white (light styles) or the board's colour (dark ones) on red; the ink or the board on amber.
    const failedInk = scheme === 'light' ? '#ffffff' : board;
    const blockedInk = scheme === 'light' ? v['--text-primary'] : board;
    expect(contrast(failedInk, v['--danger-bg']), `${id} failed badge digit`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(blockedInk, v['--saas-warning-dot']), `${id} blocked badge digit`).toBeGreaterThanOrEqual(4.5);
    // The rows under it, on the board.
    const counted = (ink: string) => mix(ink, v['--text-primary'], 0.8);
    for (const [part, colour] of [['name', v['--text-primary']], ['state line', v['--text-secondary']], ['failed count', counted(v['--danger-bg'])],
      ['blocked count', counted(v['--warn'])]]) {
      expect(contrast(colour, board), `${id} ${part} ${colour} on the board ${board}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
