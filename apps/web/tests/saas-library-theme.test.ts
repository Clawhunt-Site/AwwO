// The skill libraries' and the Agent market's frame (canvas-library.css) on the hosted pages without a canvas: the
// workspace home's market and the settings centre's libraries. Its colours came only from the canvas workspace's
// variables (--awwo-*), which those pages lack, so in a dark theme it was a light frame under the page's light heading
// and label colours, unreadable (2026-10-31: 1.1:1 in Night dive), and a primary button kept white text on a dark
// theme's light accent (2.85:1). The rules are pinned at the stylesheet's source; jsdom resolves no custom property.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs with cwd = apps/web.
const css = readFileSync(resolve(process.cwd(), 'src/saas/canvas-library.css'), 'utf8');
const block = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} is in canvas-library.css`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};

describe('the library frame on a page without a canvas', () => {
  it("takes a canvas page's colours first, then the page theme's own", () => {
    const frame = block('.awwo-library');
    for (const [name, canvas, page] of [['ink', 'ink', 'text'], ['muted', 'muted', 'muted'], ['border', 'border', 'border'],
      ['surface', 'surface', 'card'], ['bg', 'bg', 'bg'], ['accent', 'accent', 'accent']]) {
      expect(frame, `--library-${name}`).toMatch(new RegExp(`--library-${name}: var\\(--awwo-${canvas}, var\\(--saas-${page}[,)]`));
    }
  });

  it("gives a primary button black or white text by its accent's own lightness, hovered and pressed too", () => {
    const at = css.indexOf('@supports (color: oklch(from red l c h))');
    expect(at, 'the relative-colour block is in canvas-library.css').toBeGreaterThanOrEqual(0);
    const supports = css.slice(at);
    const rule = supports.slice(0, supports.indexOf('}') + 1);
    expect(rule).toContain('.awwo-library .awwo-library-primary');
    expect(rule).toContain('.awwo-library button.awwo-library-primary:not(:disabled):is(:hover, :active)');
    expect(rule).toMatch(/color: oklch\(from var\(--library-accent\) clamp\(0, \(0\.64 - l\) \* 1000, 1\) 0 0\);/);
    // It comes after the rules that set white text, so at their specificity it wins.
    expect(css.indexOf('@supports (color: oklch(from red l c h))')).toBeGreaterThan(css.indexOf('.awwo-library button.awwo-library-primary:not(:disabled):is(:hover, :active) {'));
  });

  it("mixes a proposal badge's amber with the ink, so it reads on a dark frame", () => {
    expect(block('.awwo-library-badge.is-proposed')).toMatch(/color: color-mix\(in srgb, #c08a1e \d+%, var\(--library-ink\)\)/);
  });
});
