// THE CONVERGED ICON AS ONE BOT AVATAR (2026-11-06, the owner's 「把这里所有的组件，转变成一个groKbot里面那种头像」). The AwwO
// orb is the head and its face says what the group is doing: the state the icon's words already say (groupStatus), never
// more. It is decoration (aria-hidden): the label and the rows say the state in words. Only a working face moves (it
// looks about and blinks); a settling group hops or shakes once; nothing loops at rest; the face sits clear of the head's
// specular spot and above its rim light, in white that reads on every style (canvas-selection-converge-contrast.test.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AVATAR_EXPRESSION, AVATAR_FACES, type AvatarExpression, type FacePart } from '../src/canvas/avatarFace';
import { createSessionNode, type CanvasNode } from '../src/canvas/canvasDoc';
import { ConvergedIcon } from '../src/canvas/ConvergedIcon';
import type { GroupState } from '../src/canvas/groupStatus';
import type { RunView } from '../src/canvas/RunTimeline';
import { resetAllSessions } from '../src/canvas/sessions';

const node = (id: string): CanvasNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id });
const box = { id: 'canvas', x: 0, y: 0, w: 160, h: 160, members: [] as string[] };

function draw(runs: Record<string, RunView>, members: CanvasNode[] = [node('a'), node('b')]) {
  render(<ConvergedIcon icon={{ ...box, members: members.map(item => item.id) }} members={members} runs={runs}
    depths={new Map()} title="整个画布" scale={.75} selected={false} live onSelect={vi.fn()} onExpand={vi.fn()} onAnnounce={vi.fn()} />);
  const root = screen.getByTestId('converged-icon-canvas');
  return { root, face: root.querySelector('.awwo-converged-face') as SVGSVGElement };
}

beforeEach(() => { cleanup(); resetAllSessions(); });

describe('the face for each state', () => {
  it('has one expression per group state, as the words say it', () => {
    expect(AVATAR_EXPRESSION).toEqual({
      idle: 'calm', delivered: 'calm', running: 'working', waiting: 'thinking', done: 'happy', cached: 'content',
      failed: 'worried', blocked: 'blank', cancelled: 'asleep',
    } satisfies Record<GroupState, AvatarExpression>);
  });

  it.each([
    ['nothing run yet', {}, 'calm', 'is-idle'],
    ['a run going', { a: { state: 'done' }, b: { state: 'running' } }, 'working', 'is-running'],
    // The badge, the keyline and 「失败 1」 say the failure at once; the face says the group still works.
    ['a failure while the rest run', { a: { state: 'failed' }, b: { state: 'running' } }, 'working', 'is-running'],
    ['queued', { a: { state: 'waiting' } }, 'thinking', 'is-waiting'],
    ['every member done', { a: { state: 'done' }, b: { state: 'done' } }, 'happy', 'is-done'],
    ['everything reused', { a: { state: 'cached' }, b: { state: 'cached' } }, 'content', 'is-cached'],
    ['a failure, nothing running', { a: { state: 'done' }, b: { state: 'failed' } }, 'worried', 'is-failed'],
    ['blocked', { a: { state: 'done' }, b: { state: 'blocked' } }, 'blank', 'is-blocked'],
    ['stopped', { a: { state: 'done' }, b: { state: 'cancelled' } }, 'asleep', 'is-cancelled'],
  ] as Array<[string, Record<string, RunView>, AvatarExpression, string]>)('%s: %s', (_, runs, expression, stateClass) => {
    const { root, face } = draw(runs);
    expect(root.className).toContain(stateClass);
    expect(face.getAttribute('data-expression')).toBe(expression);
    // Exactly the shapes that expression draws, where it draws them: its eyes in the eyes group, then its brows and mouth.
    const shape = (part: FacePart) => part.shape === 'ellipse' ? ['ellipse', part.cx, part.cy, part.rx, part.ry] : ['path', part.d];
    const drawn = (element: Element) => element.tagName === 'ellipse'
      ? ['ellipse', ...['cx', 'cy', 'rx', 'ry'].map(name => Number(element.getAttribute(name)))] : ['path', element.getAttribute('d')];
    const parts = AVATAR_FACES[expression];
    expect([...face.querySelectorAll('.awwo-converged-eyes > *')].map(drawn)).toEqual(parts.filter(part => part.kind === 'eye').map(shape));
    expect([...face.querySelectorAll(':scope > path')].map(drawn)).toEqual(parts.filter(part => part.kind !== 'eye').map(shape));
  });

  it('is decoration: hidden from a screen reader, which hears the state in words; the head holds no counts', () => {
    const { root, face } = draw({ a: { state: 'done' }, b: { state: 'failed' } });
    expect(face.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.awwo-converged-orb')!.getAttribute('aria-hidden')).toBe('true');
    expect(root.getAttribute('aria-label')).toContain('失败 1');
    // The counts are the rows' (「整个画布 · 2 个组件」, 「成功 1 · 失败 1」), not the head's.
    expect(root.querySelector('.awwo-converged-orb')!.textContent).toBe('');
    expect(root.querySelector('.awwo-converged-label')!.textContent).toContain('失败 1');
  });

  it('gives the eyes the shared phase, so every working face looks about together, and the face itself none', () => {
    // The phase is the clock modulo the look's 4.4 s (two breaths), so two icons mounted at any times are in step.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_003_000);
    try {
      const { face } = draw({ a: { state: 'running' } });
      const eyes = face.querySelector('.awwo-converged-eyes') as SVGGElement;
      expect(Number.parseFloat(eyes.style.animationDelay)).toBe(-(1_003_000 % 4400));
      // The face's own one-shot hop or shake starts from its beginning: no delay of its own.
      expect(face.getAttribute('style')).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it('takes the phase when a run starts, not when the icon was drawn, so one converged before its run is in step too', () => {
    // The loops start with is-running, so a phase taken at mount would put an icon converged before its run out of step.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const members = [node('a'), node('b')];
      const props = (runs: Record<string, RunView>) => ({ icon: { ...box, members: ['a', 'b'] }, members, runs, depths: new Map(),
        title: '整个画布', scale: .75, selected: false, live: true, onSelect: vi.fn(), onExpand: vi.fn(), onAnnounce: vi.fn() });
      const view = render(<ConvergedIcon {...props({})} />);
      now.mockReturnValue(1_003_000);
      view.rerender(<ConvergedIcon {...props({ a: { state: 'running' } })} />);
      const root = screen.getByTestId('converged-icon-canvas');
      const eyes = root.querySelector('.awwo-converged-eyes') as SVGGElement;
      const live = root.querySelector('.awwo-converged-live') as SVGSVGElement;
      expect(Number.parseFloat(eyes.style.animationDelay)).toBe(-(1_003_000 % 4400));
      expect(Number.parseFloat(live.style.animationDelay)).toBe(-(1_003_000 % 2200));
    } finally {
      now.mockRestore();
    }
  });

  it('marks a group that settles while watched, once, for the hop or the shake', () => {
    vi.useFakeTimers();
    try {
      const members = [node('a'), node('b')];
      const props = (runs: Record<string, RunView>) => ({ icon: { ...box, members: ['a', 'b'] }, members, runs, depths: new Map(),
        title: '整个画布', scale: .75, selected: false, live: true, onSelect: vi.fn(), onExpand: vi.fn(), onAnnounce: vi.fn() });
      const view = render(<ConvergedIcon {...props({ a: { state: 'done' }, b: { state: 'running' } })} />);
      const root = () => screen.getByTestId('converged-icon-canvas');
      view.rerender(<ConvergedIcon {...props({ a: { state: 'done' }, b: { state: 'done' } })} />);
      expect(root().className).toContain('is-just-done');
      expect(root().querySelector('.awwo-converged-face')!.getAttribute('data-expression')).toBe('happy');
      act(() => { vi.advanceTimersByTime(1000); });
      expect(root().className).not.toContain('is-just-done');
      view.rerender(<ConvergedIcon {...props({ a: { state: 'done' }, b: { state: 'running' } })} />);
      view.rerender(<ConvergedIcon {...props({ a: { state: 'done' }, b: { state: 'failed' } })} />);
      expect(root().className).toContain('is-just-failed');
      expect(root().querySelector('.awwo-converged-face')!.getAttribute('data-expression')).toBe('worried');
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws the face at the small size too', () => {
    render(<ConvergedIcon icon={{ ...box, members: ['a', 'b'] }} members={[node('a'), node('b')]} runs={{ a: { state: 'running' } }}
      depths={new Map()} title="整个画布" scale={.3} selected={false} live onSelect={vi.fn()} onExpand={vi.fn()} onAnnounce={vi.fn()} />);
    const root = screen.getByTestId('converged-icon-canvas');
    expect(root.getAttribute('data-tier')).toBe('M');
    expect(root.querySelector('.awwo-converged-face')!.getAttribute('data-expression')).toBe('working');
  });
});

describe('the shapes', () => {
  /** Points along a part: an ellipse's bounding points, a path's points sampled along each straight or quadratic piece. */
  function points(part: FacePart): Array<[number, number]> {
    if (part.shape === 'ellipse') return [[part.cx - part.rx, part.cy], [part.cx + part.rx, part.cy], [part.cx, part.cy - part.ry], [part.cx, part.cy + part.ry]];
    const tokens = part.d.match(/[MQLH]|-?\d+(?:\.\d+)?/g)!;
    const out: Array<[number, number]> = [];
    let at: [number, number] = [0, 0];
    for (let i = 0; i < tokens.length;) {
      const command = tokens[i++];
      const n = () => Number(tokens[i++]);
      if (command === 'M') { at = [n(), n()]; out.push(at); }
      else if (command === 'L') { at = [n(), n()]; out.push(at); }
      else if (command === 'H') { at = [n(), at[1]]; out.push(at); }
      else if (command === 'Q') {
        const c: [number, number] = [n(), n()];
        const end: [number, number] = [n(), n()];
        for (let s = 1; s <= 10; s++) {
          const t = s / 10;
          out.push([(1 - t) ** 2 * at[0] + 2 * (1 - t) * t * c[0] + t * t * end[0], (1 - t) ** 2 * at[1] + 2 * (1 - t) * t * c[1] + t * t * end[1]]);
        }
        at = end;
      } else throw new Error(`unexpected path command ${command} in ${part.d}`);
    }
    return out;
  }

  it.each(Object.keys(AVATAR_FACES) as AvatarExpression[])('%s: two eyes and a mouth, where the head keeps them readable', expression => {
    const parts = AVATAR_FACES[expression];
    expect(parts.filter(part => part.kind === 'eye')).toHaveLength(2);
    expect(parts.filter(part => part.kind === 'mouth')).toHaveLength(1);
    for (const part of parts) {
      for (const [x, y] of points(part)) {
        expect(x, `${expression} ${part.kind} x`).toBeGreaterThanOrEqual(20);
        expect(x, `${expression} ${part.kind} x`).toBeLessThanOrEqual(80);
        // Eyes and brows on the upper face, the mouth between 58 and 72: above the rim light (contrast test).
        if (part.kind === 'mouth') { expect(y).toBeGreaterThanOrEqual(58); expect(y).toBeLessThanOrEqual(72); }
        else { expect(y).toBeGreaterThanOrEqual(30); expect(y).toBeLessThanOrEqual(56); }
        // Clear of the specular spot (27% 19%, gone by 11%): white on white would vanish.
        expect(Math.hypot(x - 27, y - 19), `${expression} ${part.kind} near the specular spot`).toBeGreaterThan(12);
      }
    }
  });

  it('gives every expression its own still shape: under reduced motion, in a screenshot or at the small size, a working face is never the calm one', () => {
    const expressions = Object.keys(AVATAR_FACES) as AvatarExpression[];
    expect(new Set(expressions.map(expression => JSON.stringify(AVATAR_FACES[expression]))).size).toBe(expressions.length);
    const eye = (expression: AvatarExpression) => AVATAR_FACES[expression].find(part => part.kind === 'eye') as Extract<FacePart, { shape: 'ellipse' }>;
    // At work the eyes are narrowed and turned aside; at rest they are round and straight ahead.
    expect(eye('working').ry).toBeLessThan(eye('calm').ry - 2);
    expect(eye('working').cx).not.toBe(eye('calm').cx);
    // And its mouth is set, not a smile.
    const workingMouth = AVATAR_FACES.working.find(part => part.kind === 'mouth') as Extract<FacePart, { shape: 'path' }>;
    expect(workingMouth.d).not.toMatch(/Q/);
  });

  it('draws brows only on the worried face, and its mouth turns down', () => {
    for (const [expression, parts] of Object.entries(AVATAR_FACES)) {
      expect(parts.some(part => part.kind === 'brow'), expression).toBe(expression === 'worried');
    }
    const mouth = (expression: AvatarExpression) => AVATAR_FACES[expression].find(part => part.kind === 'mouth') as Extract<FacePart, { shape: 'path' }>;
    // A quadratic mouth's control point below its ends smiles, above them frowns.
    const bend = (expression: AvatarExpression) => { const [, y0, , cy] = mouth(expression).d.match(/-?\d+(?:\.\d+)?/g)!.map(Number); return cy - y0; };
    expect(bend('happy')).toBeGreaterThan(0);
    expect(bend('calm')).toBeGreaterThan(0);
    expect(bend('worried')).toBeLessThan(0);
  });
});

describe('the face in the stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/canvas/converged-icon.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('moves only a working face, and only while motion is welcome', () => {
    const motion = css.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/)![1];
    const look = motion.split('\n').find(line => line.includes('awwo-converged-look'))!;
    // On the eyes alone (the mouth never squashes in a blink), of a running icon.
    expect(look).toMatch(/^\s*\.awwo-converged\.is-running \.awwo-converged-face \.awwo-converged-eyes \{ animation:/);
    expect(look).toMatch(/awwo-converged-look 4\.4s .*? infinite, awwo-converged-blink 4\.4s linear infinite;/);
    // The look and the blink are used nowhere else.
    expect(css.split('\n').filter(line => /awwo-converged-(look|blink) \d/.test(line))).toEqual([look]);
    // At the small size the look steps, as the running arcs do, rather than repainting every frame; the blink stays.
    expect(motion).toMatch(/\.awwo-converged\[data-tier='M'\]\.is-running \.awwo-converged-face \.awwo-converged-eyes \{ animation-timing-function: steps\(6, jump-none\), linear; \}/);
    // A blink squashes the eyes about their own middle, not the face's top left corner (SVG's default origin).
    expect(css).toMatch(/\.awwo-converged-eyes \{ transform-box: fill-box; transform-origin: center; \}/);
  });

  it('draws the face as open lines and filled eyes, and the head without the orb\'s planet ring, which would cross the eyes', () => {
    expect(css).toMatch(/\.awwo-converged-face path \{ fill: none; stroke: currentColor; stroke-width: 4\.6; stroke-linecap: round; stroke-linejoin: round; \}/);
    expect(css).not.toMatch(/\.awwo-converged-orb::after/);
  });

  it('hops once when a group is done while watched and shakes once when it fails, never looping', () => {
    const hop = css.split('\n').find(line => line.includes('animation: awwo-converged-hop'))!;
    const shake = css.split('\n').find(line => line.includes('animation: awwo-converged-shake'))!;
    expect(hop).toContain('.is-just-done .awwo-converged-face');
    expect(shake).toContain('.is-just-failed .awwo-converged-face');
    for (const line of [hop, shake]) expect(line).not.toMatch(/infinite/);
  });

  it('keeps the head still under reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.canvas-root \.awwo-converged, \.canvas-root \.awwo-converged \* \{ animation: none !important; transition: none !important; \}/);
  });
});
