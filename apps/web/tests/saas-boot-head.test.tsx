// THE BOOT HEAD (2026-11-07, the owner: the blue ball in the middle of every loading page becomes the converged icon's
// animation). saas.html paints it before any script and BootSurface draws it in the app: a converged canvas's flat head at
// work, one arc going round its collar, the eyes following the arc and blinking. These tests keep the two drawings the
// same, the head the icon's own (its tokens, its working eyes, its chin light), the motion compositor-only and only while
// motion is welcome, the eyes on the arc at every moment of the turn, and every boot head in one phase.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AVATAR_CRESCENT, AVATAR_FACES, eyeGaze } from '../src/canvas/avatarFace';
import { BOOT_ARC, BootHead, BootSurface, lockBootPhase } from '../src/saas/BootSurface';

const html = readFileSync(resolve(process.cwd(), 'saas.html'), 'utf8');
const iconCss = readFileSync(resolve(process.cwd(), 'src/canvas/converged-icon.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const css = html.match(/<style>([\s\S]*?)<\/style>/)![1].replace(/\/\*[\s\S]*?\*\//g, '');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const lockScript = scripts.find(script => script.includes('getAnimations'))!;

/** The body of the block that opens at `start` (its `{`), braces balanced. */
function blockAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start + 1, i);
  }
  throw new Error('unbalanced');
}
const media = (query: string) => { const at = css.indexOf(`@media ${query}{`); if (at < 0) throw new Error(`no ${query}`); return blockAt(css, css.indexOf('{', at)); };
const keyframes = (name: string) => { const at = css.indexOf(`@keyframes ${name}{`); if (at < 0) throw new Error(`no ${name}`); return blockAt(css, css.indexOf('{', at)); };
/** The declarations of the first rule with exactly this selector (top level or in a media block). */
function rule(selector: string, within = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = within.match(new RegExp(`(?:^|[\\n}{])\\s*${escaped}\\s*\\{([^{}]*)\\}`));
  if (!match) throw new Error(`no rule ${selector}`);
  return match[1];
}
/** A keyframes block's stops in order: [at (0..1), declarations]. */
function stops(name: string): Array<[number, string]> {
  const body = keyframes(name);
  const out: Array<[number, string]> = [];
  for (const [, selectors, decls] of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of selectors.split(',')) {
      const at = selector.trim() === 'to' ? 1 : selector.trim() === 'from' ? 0 : Number.parseFloat(selector) / 100;
      out.push([at, decls]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}
/** y at x on cubic-bezier(x1, y1, x2, y2), by bisection on t. */
function bezier([x1, y1, x2, y2]: number[], x: number): number {
  const at = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (at(mid, x1, x2) < x) lo = mid; else hi = mid; }
  return at((lo + hi) / 2, y1, y2);
}
/** The value a keyframes block gives at progress p, `read` taking a stop's value from its declarations. */
function valueAt(name: string, read: (decls: string) => number, p: number): number {
  const list = stops(name);
  const index = list.findIndex(([at], i) => at <= p && p <= (list[i + 1]?.[0] ?? 1)) ;
  const [a, decls] = list[index];
  const [b, next] = list[index + 1] ?? list[index];
  if (b === a) return read(decls);
  const ease = decls.match(/animation-timing-function:cubic-bezier\(([^)]*)\)/);
  const u = (p - a) / (b - a);
  const eased = ease ? bezier(ease[1].split(',').map(Number), u) : u;
  return read(decls) + (read(next) - read(decls)) * eased;
}
/** A stop's offset in face units: a share of the face's own box (7% of a 100-unit face is 7 units), so any offset but
 *  0 must be in %. */
function inFaceUnits(value: string, unit: string): number {
  const number = Number.parseFloat(value);
  if (number !== 0 && unit !== '%') throw new Error(`a gaze offset in ${unit || 'no unit'}: ${value}${unit}`);
  return number;
}
/** The across-move: `translate:<x> 0` and nothing else moving the eyes (the second coordinate level, no other function). */
const gazeX = (decls: string) => {
  const moves = decls.split(';').filter(declaration => /^(translate|transform):/.test(declaration));
  const [, value, unit] = moves.length === 1 ? moves[0].match(/^translate:(-?[\d.]+)([a-z%]*) 0$/) ?? [] : [];
  if (value === undefined) throw new Error(`not an across-move alone: ${decls}`);
  return inFaceUnits(value, unit);
};
/** The down-move: `transform:translateY(<y>)` and nothing else moving the eyes. */
const gazeY = (decls: string) => {
  const moves = decls.split(';').filter(declaration => /^(translate|transform):/.test(declaration));
  const [, value, unit] = moves.length === 1 ? moves[0].match(/^transform:translateY\((-?[\d.]+)([a-z%]*)\)$/) ?? [] : [];
  if (value === undefined) throw new Error(`not a down-move alone: ${decls}`);
  return inFaceUnits(value, unit);
};

afterEach(() => cleanup());

describe('the boot head', () => {
  it('is drawn the same before the bundle runs (saas.html) and in the app (BootSurface)', () => {
    const head = renderToStaticMarkup(<BootHead />);
    expect(head.startsWith('<div class="awwo-boot-head" aria-hidden="true">')).toBe(true);
    expect(html).toContain(head);
    expect(renderToStaticMarkup(<BootSurface text="正在加载…" />)).toContain(head);
    // The middle column too, its text row empty on the page: the app's words take the row the page kept, so the head
    // stays where the page drew it when the app's surface takes its place.
    const column = renderToStaticMarkup(<BootSurface />).match(/<div class="awwo-boot-center">[\s\S]*?<\/p><\/div>/)![0];
    expect(column).toBe(`<div class="awwo-boot-center">${head}<p class="awwo-boot-text"></p></div>`);
    expect(html).toContain(column);
    expect(renderToStaticMarkup(<BootSurface text="正在加载…" />)).toContain(`${head}<p class="awwo-boot-text">正在加载…</p></div>`);
  });

  it('is a converged canvas at work: its working eyes, its chin light, its tokens', () => {
    const { container } = render(<BootHead />);
    const eyes = [...container.querySelectorAll('.awwo-boot-blink rect')].map(rect => ['x', 'y', 'width', 'height', 'rx'].map(name => Number(rect.getAttribute(name))));
    expect(eyes).toEqual(AVATAR_FACES.working.map(eye => {
      if (eye.shape !== 'capsule') throw new Error('the working eyes are capsules');
      return [eye.cx - eye.w / 2, eye.cy - eye.h / 2, eye.w, eye.h, Math.min(eye.w, eye.h) / 2];
    }));
    expect(container.querySelector('.awwo-boot-crescent path')?.getAttribute('d')).toBe(AVATAR_CRESCENT);
    // The icon's own tokens and sizes (converged-icon.css, measured on every style by canvas-selection-converge-contrast):
    // the head the orb core with white eyes, 2/3 of the box; the collar the orb edge, 11 wide at r 52; the arc the running
    // arc's colour, 7 wide; the plate a card's; the chin light and the dark styles' rim the same mixes.
    expect(rule('.awwo-boot-head>.awwo-boot-face')).toMatch(/inset:16\.67%;.*color:#fff;background:var\(--saas-orb-core,/);
    expect(container.querySelector('.awwo-boot-collar')?.getAttribute('r')).toBe('52');
    expect(rule('.awwo-boot-collar')).toMatch(/stroke:var\(--saas-orb-edge,[^;]*\);stroke-width:11/);
    expect(rule('.awwo-boot-arc')).toMatch(/stroke:var\(--saas-signal,[^;]*\);stroke-width:7/);
    expect(rule('.awwo-boot-plate')).toMatch(/background:var\(--bg-card,#fff\)/);
    expect(rule('.awwo-boot-crescent path')).toBe('fill:color-mix(in srgb,rgb(var(--saas-glow-1-rgb,95 227 232)) 40%,var(--saas-orb-core,#12385a))');
    expect(rule('html[data-theme=dark] .awwo-boot-face>.awwo-boot-rim'))
      .toMatch(/box-shadow:inset 0 0 0 2px color-mix\(in srgb,rgb\(var\(--saas-orb-hi-rgb,[^)]*\)\) 60%,var\(--bg-card,/);
    expect(rule('.awwo-boot-face>.awwo-boot-rim')).toBe('display:none');
    expect(rule('html[data-theme=dark] .awwo-boot-face>.awwo-boot-crescent')).toBe('inset:1px;width:calc(100% - 2px);height:calc(100% - 2px)');
  });

  it("takes the icon's own widths, inset and mixes (converged-icon.css), so a change to the icon shows here", () => {
    const icon = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = iconCss.match(new RegExp(`(?:^|[\\n}])\\s*${escaped}\\s*\\{([^{}]*)\\}`));
      if (!match) throw new Error(`no icon rule ${selector}`);
      return match[1];
    };
    const number = (decls: string, property: string) => Number.parseFloat(decls.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([\\d.]+)`))![1]);
    expect(number(rule('.awwo-boot-collar'), 'stroke-width')).toBe(number(icon('.awwo-converged-collar'), 'stroke-width'));
    expect(number(rule('.awwo-boot-arc'), 'stroke-width')).toBe(number(icon('.awwo-converged-arc'), 'stroke-width'));
    expect(icon('.awwo-converged-arc.is-running')).toMatch(/stroke:\s*var\(--saas-signal\b/);
    expect(number(rule('.awwo-boot-head>.awwo-boot-face'), 'inset')).toBe(number(icon('.awwo-converged-orb'), 'inset'));
    const squash = (text: string) => text.replace(/\s+/g, '').replace(/;$/, '');
    expect(squash(rule('.awwo-boot-crescent path'))).toBe(squash(icon('.awwo-converged-crescent path')));
    // The rim: the same share of the orb's highlight over the plate (the icon's --awwo-card is the style's --bg-card:
    // canvas-selection-converge-contrast.test.ts), as wide on screen.
    const rim = icon("html:root[data-theme='dark'] .awwo-converged-rim");
    expect(rim).toMatch(/inset 0 0 0 calc\(2px \* var\(--cv-px, 1\)\) color-mix\(in srgb, rgb\(var\(--saas-orb-hi-rgb[^)]*\)\) 60%, var\(--awwo-card\b/);
    expect(rule('html[data-theme=dark] .awwo-boot-face>.awwo-boot-rim')).toMatch(/inset 0 0 0 2px color-mix\(in srgb,rgb\(var\(--saas-orb-hi-rgb,[^)]*\)\) 60%,var\(--bg-card\b/);
    // The chin light 1 screen px inside the head's edge on a dark style, in both.
    expect(icon("html:root[data-theme='dark'] .awwo-converged-orb")).toMatch(/--cv-crescent-inset:\s*calc\(1px \* var\(--cv-px, 1\)\)/);
  });

  it('has no blue ball or line left', () => {
    // (awwo-boot-orb as a whole name: the arc's own layer is awwo-boot-orbit.)
    for (const gone of [/awwo-boot-orb\b/, /awwo-boot-line\b/, /awwo-boot-breathe\b/, /awwo-boot-slide\b/, /radial-gradient\(circle at 34% 30%/]) {
      expect(html, String(gone)).not.toMatch(gone);
      expect(renderToStaticMarkup(<BootSurface canvas text="x" />), String(gone)).not.toMatch(gone);
    }
  });

  it('moves only while motion is welcome, and only by transforms the compositor runs on its own', () => {
    const motion = media('(prefers-reduced-motion:no-preference)');
    expect(rule('.awwo-boot-orbit', motion)).toBe('animation:awwo-boot-orbit 2.2s linear infinite');
    expect(rule('.awwo-boot-gaze', motion)).toBe('animation:awwo-boot-gx 2.2s linear infinite,awwo-boot-gy 2.2s linear infinite');
    // A blink once in two turns.
    expect(rule('.awwo-boot-blink', motion)).toBe('animation:awwo-boot-blink 4.4s linear infinite');
    const still = css.replace(`@media (prefers-reduced-motion:no-preference){${motion}}`, '');
    for (const [, selector, decls] of still.matchAll(/([^{}]*awwo-boot[^{}]*)\{([^{}]*)\}/g)) {
      expect(decls, selector).not.toMatch(/animation|transition/);
      // At rest the eyes look straight ahead at the arc resting at the top.
      if (/awwo-boot-(gaze|orbit)\b/.test(selector)) expect(decls, selector).not.toMatch(/transform|translate|rotate/);
    }
    for (const name of ['awwo-boot-orbit', 'awwo-boot-gx', 'awwo-boot-gy', 'awwo-boot-blink']) {
      for (const [, decls] of stops(name)) {
        for (const declaration of decls.split(';').filter(Boolean)) {
          expect(declaration.split(':')[0], `${name}: ${declaration}`).toMatch(/^(transform|translate|animation-timing-function)$/);
        }
      }
    }
    expect(stops('awwo-boot-orbit')).toEqual([[1, 'transform:rotate(1turn)']]);
    expect(rule('.awwo-boot-blink')).toBe('transform-origin:50% 46%');
  });

  it('keeps the eyes on the arc all the way round, with the icon’s reach: across as the sine, down at the bottom, never up', () => {
    // eyeGaze's reach, on a smooth path for a turn that never stops: level at the top and its full reach across at the
    // sides, as eyeGaze; down at the sides half its reach (eyeGaze is level there, a kink a glide between two looks hides
    // and a steady turn would show), its full reach at the bottom.
    const across = eyeGaze(0.25)[0];
    const down = eyeGaze(0.5)[1];
    expect(eyeGaze(0)).toEqual([0, 0]);
    // The arc is a quarter of the collar centred on 12 o'clock, so its middle is at the turn's share of the circle.
    const [x0, y0, x1, y1] = BOOT_ARC.match(/-?[\d.]+/g)!.map(Number).filter((_, i) => [0, 1, 7, 8].includes(i));
    expect(Math.hypot(x0, y0)).toBeCloseTo(52, 1);
    expect(Math.hypot(x1, y1)).toBeCloseTo(52, 1);
    expect(Math.atan2(x0, -y0) / (2 * Math.PI)).toBeCloseTo(-1 / 8, 3);
    expect(Math.atan2(x1, -y1) / (2 * Math.PI)).toBeCloseTo(1 / 8, 3);
    for (let i = 0; i <= 200; i++) {
      const p = i / 200;
      const x = valueAt('awwo-boot-gx', gazeX, p);
      const y = valueAt('awwo-boot-gy', gazeY, p);
      expect(Math.abs(x - across * Math.sin(2 * Math.PI * p)), `x at ${p}`).toBeLessThan(0.12);
      expect(Math.abs(y - down / 2 * (1 - Math.cos(2 * Math.PI * p))), `y at ${p}`).toBeLessThan(0.12);
      expect(y, `never up at ${p}`).toBeGreaterThanOrEqual(-0.001);
    }
  });

  it('keeps the canvas frame its width while a canvas loads, and has forced-colour rules of its own', () => {
    expect(rule('.awwo-boot.is-canvas,html[data-boot=canvas] .awwo-boot')).toMatch(/display:block;place-items:normal;align-content:normal;/);
    const forced = media('(forced-colors:active)');
    expect(rule('.awwo-boot-head>.awwo-boot-face', forced)).toBe('forced-color-adjust:none;background:CanvasText!important;color:Canvas!important');
    expect(rule('.awwo-boot-arc', forced)).toBe('stroke:Highlight!important');
    expect(rule('.awwo-boot-collar', forced)).toBe('stroke:Canvas!important');
    // Above every style's own rules (html[data-theme=dark] .awwo-boot-arc outranks a plain .awwo-boot-arc), as
    // ConvergedIcon's forced rules are.
    for (const [, decls] of forced.matchAll(/\{([^{}]*)\}/g)) {
      for (const declaration of decls.split(';').filter(Boolean)) {
        if (!declaration.startsWith('forced-color-adjust:')) expect(declaration, declaration).toMatch(/!important$/);
      }
    }
    expect(rule('.awwo-boot-face>:is(.awwo-boot-crescent,.awwo-boot-rim)', forced)).toBe('display:none!important');
  });
});

describe('every boot head in one phase', () => {
  const fakes = () => [{ animationName: 'awwo-boot-orbit', startTime: 812 }, { animationName: 'awwo-boot-gx', startTime: null },
    { animationName: 'awwo-nav-progress', startTime: 40 }, { startTime: 7 }] as Array<{ animationName?: string; startTime: number | null }>;

  it("saas.html's script starts each of its loops at the page's time zero, and nothing else", () => {
    const animations = fakes();
    Object.defineProperty(document, 'getAnimations', { value: () => animations, configurable: true });
    try { new Function(lockScript)(); } finally { delete (document as { getAnimations?: unknown }).getAnimations; }
    expect(animations.map(item => item.startTime)).toEqual([0, 0, 40, 7]);
    // Where the browser has no getAnimations, nothing breaks.
    expect(() => new Function(lockScript)()).not.toThrow();
    // A loop whose start time the browser refuses keeps its own phase; the others are still locked.
    const refusing = { animationName: 'awwo-boot-orbit', get startTime() { return 5; }, set startTime(_: number) { throw new DOMException('no', 'NotSupportedError'); } };
    const after = { animationName: 'awwo-boot-blink', startTime: 77 as number | null };
    Object.defineProperty(document, 'getAnimations', { value: () => [refusing, after], configurable: true });
    try { expect(() => new Function(lockScript)()).not.toThrow(); } finally { delete (document as { getAnimations?: unknown }).getAnimations; }
    expect(after.startTime).toBe(0);
  });

  it('saas.html starts them at time zero again when the reader turns motion on, which makes them anew', () => {
    const animations = fakes();
    const listeners: Array<[string, string, () => void]> = [];
    const query = (media: string) => ({ media, matches: false, addEventListener: (type: string, listener: () => void) => listeners.push([media, type, listener]) });
    Object.defineProperty(document, 'getAnimations', { value: () => animations, configurable: true });
    const before = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { value: query, configurable: true, writable: true });
    try {
      new Function(lockScript)();
      expect(listeners.map(([media, type]) => [media, type])).toEqual([['(prefers-reduced-motion: no-preference)', 'change']]);
      animations.push({ animationName: 'awwo-boot-blink', startTime: 5031 }, { animationName: 'awwo-nav-progress', startTime: 9 });
      listeners[0][2]();
      expect(animations.map(item => item.startTime)).toEqual([0, 0, 40, 7, 0, 9]);
    } finally {
      delete (document as { getAnimations?: unknown }).getAnimations;
      Object.defineProperty(window, 'matchMedia', { value: before, configurable: true, writable: true });
    }
  });

  it('the app does the same for its own, when it mounts', () => {
    const animations = fakes();
    const asked: unknown[] = [];
    const proto = HTMLElement.prototype as { getAnimations?: unknown };
    proto.getAnimations = function (this: Element, options?: unknown) { asked.push([this.className, options]); return animations; };
    try { render(<BootSurface text="正在加载…" />); } finally { delete proto.getAnimations; }
    expect(asked).toEqual([['awwo-boot-head', { subtree: true }]]);
    expect(animations.map(item => item.startTime)).toEqual([0, 0, 40, 7]);
    expect(() => lockBootPhase(null)).not.toThrow();
    expect(() => lockBootPhase(document.createElement('div'))).not.toThrow();
  });

  it('a browser that refuses a start time takes nothing down: the other loops still start at time zero', () => {
    const refusing = { animationName: 'awwo-boot-orbit', get startTime() { return 5; }, set startTime(_: number) { throw new DOMException('no', 'NotSupportedError'); } };
    const after = { animationName: 'awwo-boot-blink', startTime: 77 as number | null };
    const root = { getAnimations: () => [refusing, after] } as unknown as Element;
    expect(() => lockBootPhase(root)).not.toThrow();
    expect(after.startTime).toBe(0);
    expect(() => lockBootPhase({ getAnimations: () => { throw new Error('no'); } } as unknown as Element)).not.toThrow();
    const proto = HTMLElement.prototype as { getAnimations?: unknown };
    proto.getAnimations = () => [refusing];
    try { expect(() => render(<BootSurface text="正在加载…" />)).not.toThrow(); } finally { delete proto.getAnimations; }
  });

  it('the app starts them at time zero again when the reader turns motion on, and stops listening once gone', () => {
    const animations = fakes();
    const added: Array<[string, string, () => void]> = [];
    const removed: Array<[string, () => void]> = [];
    const query = (media: string) => ({ media, matches: false,
      addEventListener: (type: string, listener: () => void) => added.push([media, type, listener]),
      removeEventListener: (type: string, listener: () => void) => removed.push([type, listener]) });
    const proto = HTMLElement.prototype as { getAnimations?: unknown };
    proto.getAnimations = () => animations;
    const before = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { value: query, configurable: true, writable: true });
    try {
      const view = render(<BootHead />);
      expect(added.map(([media, type]) => [media, type])).toEqual([['(prefers-reduced-motion: no-preference)', 'change']]);
      animations.push({ animationName: 'awwo-boot-orbit', startTime: 5031 });
      added[0][2]();
      expect(animations.map(item => item.startTime)).toEqual([0, 0, 40, 7, 0]);
      view.unmount();
      expect(removed).toEqual([['change', added[0][2]]]);
    } finally {
      delete proto.getAnimations;
      Object.defineProperty(window, 'matchMedia', { value: before, configurable: true, writable: true });
    }
  });
});
