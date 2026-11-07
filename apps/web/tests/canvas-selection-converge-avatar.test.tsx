// THE CONVERGED ICON AS ONE BOT AVATAR (2026-11-06, at the owner's request that all its components become one avatar,
// like a bot's), FLAT (2026-11-07, the owner's choice of the mockup's option B). The head is flat, in each style's orb colour, with two white
// eyes and a light at the chin; on a dark style a light rim keeps it apart from the plate. Its face says what the group is
// doing: the state the icon's words already say (groupStatus), never more. The eyes look at the arc of the member the icon
// names now (the frontier while it runs, the first failure once it failed), level or down, never up, and glance for a
// moment at a member seen failing while the rest run. It is decoration (aria-hidden): the label and the rows say the
// state in words. Only a working face blinks; a settling group hops or shakes once; nothing loops at rest; nothing moves
// under reduced motion; the colours read on every style (canvas-selection-converge-contrast.test.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AVATAR_EXPRESSION, AVATAR_FACES, AVATAR_LOOKS, eyeGaze, type AvatarExpression, type FacePart } from '../src/canvas/avatarFace';
import { createSessionNode, type CanvasNode } from '../src/canvas/canvasDoc';
import { arcMiddle, ConvergedIcon, GLANCE_MS, ringSegments } from '../src/canvas/ConvergedIcon';
import type { GroupState, MemberLiveState } from '../src/canvas/groupStatus';
import type { RunView } from '../src/canvas/RunTimeline';
import { resetAllSessions } from '../src/canvas/sessions';

const node = (id: string): CanvasNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id });
const box = { id: 'canvas', x: 0, y: 0, w: 160, h: 160, members: [] as string[] };
const named = (count: number) => Array.from({ length: count }, (_, index) => node(`m${index}`));

const props = (runs: Record<string, RunView>, members: CanvasNode[], scale = .75) => ({
  icon: { ...box, members: members.map(item => item.id) }, members, runs, depths: new Map<string, number>(), title: '整个画布',
  scale, selected: false, live: true, onSelect: vi.fn(), onExpand: vi.fn(), onAnnounce: vi.fn(),
});

function draw(runs: Record<string, RunView>, members: CanvasNode[] = [node('a'), node('b')]) {
  render(<ConvergedIcon {...props(runs, members)} />);
  const root = screen.getByTestId('converged-icon-canvas');
  return { root, face: root.querySelector('.awwo-converged-face') as SVGSVGElement };
}

/** Where the eyes look, as drawn: the gaze group's translate, in face units ("x, y" to two places). */
const gazeOf = (root: Element = screen.getByTestId('converged-icon-canvas')) => {
  const transform = (root.querySelector('.awwo-converged-gaze') as SVGGElement).style.transform;
  const match = transform.match(/^translate\((-?\d+\.\d\d)px, (-?\d+\.\d\d)px\)$/);
  if (!match) throw new Error(`unexpected gaze transform ${transform}`);
  return `${match[1]}, ${match[2]}`;
};

// The reader's reduced-motion setting, as matchMedia gives it, with its change events.
let reduce = false;
const changes = new Set<() => void>();
const setReduce = (value: boolean) => { reduce = value; act(() => { for (const notify of [...changes]) notify(); }); };
beforeEach(() => {
  cleanup();
  resetAllSessions();
  reduce = false;
  changes.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return reduce && query.includes('reduce'); }, media: query, onchange: null, dispatchEvent: () => false,
    addEventListener: (_: string, notify: () => void) => { changes.add(notify); },
    removeEventListener: (_: string, notify: () => void) => { changes.delete(notify); },
    addListener() {}, removeListener() {},
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
    // Exactly the two eyes that expression draws, in the eyes group inside the gaze group, and nothing else on the face.
    const shape = (part: FacePart) => part.shape === 'capsule' ? ['capsule', part.cx, part.cy, part.w, part.h, Math.min(part.w, part.h) / 2]
      : part.shape === 'fill' ? ['fill', part.d] : ['stroke', part.d, part.width];
    const drawn = (element: Element) => {
      if (element.tagName === 'rect') {
        const [x, y, w, h, rx] = ['x', 'y', 'width', 'height', 'rx'].map(name => Number(element.getAttribute(name)));
        return ['capsule', x + w / 2, y + h / 2, w, h, rx];
      }
      return element.classList.contains('is-fill') ? ['fill', element.getAttribute('d')]
        : ['stroke', element.getAttribute('d'), Number(element.getAttribute('stroke-width'))];
    };
    expect([...face.querySelectorAll('.awwo-converged-gaze > .awwo-converged-eyes > *')].map(drawn)).toEqual(AVATAR_FACES[expression].map(shape));
    expect(face.querySelectorAll('rect, path')).toHaveLength(2);
  });

  it('is decoration: hidden from a screen reader, which hears the state in words; the head holds no counts', () => {
    const { root, face } = draw({ a: { state: 'done' }, b: { state: 'failed' } });
    const head = root.querySelector('.awwo-converged-orb')!;
    expect(face.getAttribute('aria-hidden')).toBe('true');
    expect(head.getAttribute('aria-hidden')).toBe('true');
    expect(root.getAttribute('aria-label')).toContain('失败 1');
    // The counts are the rows' (「整个画布 · 2 个组件」, 「成功 1 · 失败 1」), not the head's.
    expect(head.textContent).toBe('');
    expect(root.querySelector('.awwo-converged-label')!.textContent).toContain('失败 1');
  });

  it('draws the head as its parts in order: the chin light, the rim, then the face (only the face hops or shakes)', () => {
    const { root } = draw({});
    const head = root.querySelector('.awwo-converged-orb')!;
    expect([...head.children].map(child => child.getAttribute('class'))).toEqual(['awwo-converged-crescent', 'awwo-converged-rim', 'awwo-converged-face']);
    const crescent = head.querySelector('.awwo-converged-crescent')!;
    expect(crescent.getAttribute('viewBox')).toBe('0 0 100 100');
    expect(crescent.getAttribute('aria-hidden')).toBe('true');
    // As the head clips it, the head (r 50 about 50, 50) less the same circle 8 units higher, from the eyes' line (y 46)
    // round the chin; its outer arc is drawn on r 52, past the head, so the clip draws the chin's edge.
    const d = crescent.querySelector('path')!.getAttribute('d')!;
    expect(d).toBe('M 0.7716 33.25 A 52 52 0 1 0 99.2284 33.25 A 50 50 0 1 1 0.7716 33.25 Z');
    const [x0, y0, outer, , , , , x1, y1, inner] = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    for (const [x, y] of [[x0, y0], [x1, y1]]) {
      expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(outer, 3);
      expect(Math.hypot(x - 50, y - 42)).toBeCloseTo(inner, 3);
    }
    expect(outer).toBeGreaterThan(50);
    // The higher circle has the head's own radius, so the two meet halfway between their centres, on the eyes' line
    // (y 46): the clipped crescent ends there, as before.
    expect(inner).toBe(50);
  });

  it('gives the eyes the shared phase, so every working face blinks together, and the face itself none', () => {
    // The phase is the clock modulo the blink's 4.4 s (two breaths), so two icons mounted at any times are in step.
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
      const view = render(<ConvergedIcon {...props({}, members)} />);
      now.mockReturnValue(1_003_000);
      view.rerender(<ConvergedIcon {...props({ a: { state: 'running' } }, members)} />);
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
    const members = [node('a'), node('b')];
    const view = render(<ConvergedIcon {...props({ a: { state: 'done' }, b: { state: 'running' } }, members)} />);
    const root = () => screen.getByTestId('converged-icon-canvas');
    view.rerender(<ConvergedIcon {...props({ a: { state: 'done' }, b: { state: 'done' } }, members)} />);
    expect(root().className).toContain('is-just-done');
    expect(root().querySelector('.awwo-converged-face')!.getAttribute('data-expression')).toBe('happy');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(root().className).not.toContain('is-just-done');
    view.rerender(<ConvergedIcon {...props({ a: { state: 'done' }, b: { state: 'running' } }, members)} />);
    view.rerender(<ConvergedIcon {...props({ a: { state: 'done' }, b: { state: 'failed' } }, members)} />);
    expect(root().className).toContain('is-just-failed');
    expect(root().querySelector('.awwo-converged-face')!.getAttribute('data-expression')).toBe('worried');
  });

  it('draws the face at the small size too', () => {
    render(<ConvergedIcon {...props({ a: { state: 'running' } }, [node('a'), node('b')], .3)} />);
    const root = screen.getByTestId('converged-icon-canvas');
    expect(root.getAttribute('data-tier')).toBe('M');
    expect(root.querySelector('.awwo-converged-face')!.getAttribute('data-expression')).toBe('working');
  });

  it('keeps the rim 2 px on screen at the farthest zoom: one screen pixel is --cv-px of the icon\'s units', () => {
    // At the board's least zoom (.05) the 160-unit icon is scaled up 5x to its 40 px floor: 1 / (.05 * 5) = 4 units a pixel.
    render(<ConvergedIcon {...props({}, [node('a'), node('b')], .05)} />);
    const root = screen.getByTestId('converged-icon-canvas');
    expect(root.style.getPropertyValue('--cv-k')).toBe('5');
    expect(root.style.getPropertyValue('--cv-px')).toBe('4');
  });
});

describe('where the eyes look', () => {
  it.each([
    // Six members: member i's arc is centred at (i + .5) / 6 of the circle, from 12 o'clock clockwise. An arc in the upper
    // half gets a level look (never up): the first, at 1 o'clock, a short look to the right.
    [0, '3.50, 0.00'], [1, '7.00, 0.00'], [2, '3.50, 5.20'], [3, '-3.50, 5.20'], [4, '-7.00, 0.00'], [5, '-3.50, 0.00'],
  ])('at work: at the running member\'s own arc (member %i of 6: %s)', (index, look) => {
    const members = named(6);
    draw({ [members[index].id]: { state: 'running' } }, members);
    expect(gazeOf()).toBe(look);
  });

  it('never looks up, whichever member of a big ring is at work', () => {
    const members = named(13);
    for (const member of members) {
      cleanup();
      draw({ [member.id]: { state: 'running' } }, members);
      expect(Number(gazeOf().split(', ')[1]), member.id).toBeGreaterThanOrEqual(0);
    }
  });

  it('of two running at once, at the frontier: the one that started later', () => {
    const members = named(6);
    draw({ m1: { state: 'running', startedAt: 2_000 }, m4: { state: 'running', startedAt: 1_000 } }, members);
    expect(gazeOf()).toBe('7.00, 0.00');
    cleanup();
    draw({ m1: { state: 'running', startedAt: 1_000 }, m4: { state: 'running', startedAt: 2_000 } }, members);
    expect(gazeOf()).toBe('-7.00, 0.00');
  });

  it('on a ring drawn one arc per state, at the arc of the running member\'s state, not where its own arc would be', () => {
    // 60 members are one arc per state: the running family is floored to 2.5% of the ring at the top, centred at 1.25%.
    const members = named(60);
    draw({ m30: { state: 'running' } }, members);
    expect(gazeOf()).toBe('0.55, 0.00');
  });

  it('once failed, at the first failure (the one upstream explains those below it)', () => {
    const members = named(6);
    draw({ m0: { state: 'done' }, m1: { state: 'done' }, m2: { state: 'failed' }, m3: { state: 'done' }, m4: { state: 'failed' }, m5: { state: 'done' } }, members);
    expect(screen.getByTestId('converged-icon-canvas').querySelector('.awwo-converged-face')!.getAttribute('data-expression')).toBe('worried');
    expect(gazeOf()).toBe('3.50, 5.20');
  });

  it.each([
    ['at rest', {}],
    ['queued (not work yet)', { m0: { state: 'done' }, m1: { state: 'waiting' } }],
    ['blocked (flat eyes turned aside would read as a side-eye)', { m0: { state: 'done' }, m1: { state: 'blocked' } }],
    ['done', { m0: { state: 'done' }, m1: { state: 'done' }, m2: { state: 'done' } }],
    ['reused', { m0: { state: 'cached' }, m1: { state: 'cached' }, m2: { state: 'cached' } }],
    ['stopped', { m0: { state: 'done' }, m1: { state: 'cancelled' } }],
  ] as Array<[string, Record<string, RunView>]>)('straight ahead %s', (_, runs) => {
    draw(runs, named(3));
    expect(gazeOf()).toBe('0.00, 0.00');
  });

  it('looks only from the faces that look', () => {
    expect(Object.entries(AVATAR_LOOKS).filter(([, looks]) => looks).map(([expression]) => expression).sort()).toEqual(['working', 'worried']);
  });

  it('toward a point of the ring: at most 7 across and 6 down, never up', () => {
    for (let share = 0; share <= 1; share += 1 / 360) {
      const [x, y] = eyeGaze(share);
      expect(Math.abs(x)).toBeLessThanOrEqual(7 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(6 + 1e-9);
    }
    expect(eyeGaze(.25)).toEqual([7, 0]);
    expect(eyeGaze(.5)[1]).toBeCloseTo(6, 9);
  });

  it('finds the arc drawn for a member, its own or its state\'s', () => {
    const states: MemberLiveState[] = ['done', 'running', 'idle'];
    expect(arcMiddle(ringSegments(states), states, 1)).toBeCloseTo(.5, 9);
    expect(arcMiddle(ringSegments(states), states, 3)).toBeNull();
    const many: MemberLiveState[] = Array.from({ length: 60 }, (_, index) => index === 7 ? 'failed' : 'done');
    const families = ringSegments(many);
    expect(families).toHaveLength(2);
    const failed = families.find(segment => segment.state === 'failed')!;
    expect(arcMiddle(families, many, 7)).toBeCloseTo((failed.from + failed.to) / 2, 9);
  });

  it('on a ring of state families as many as its members, still at the member\'s state\'s arc', () => {
    // A ring too small for one arc each draws its families in their own order (done, running, idle), one per member here.
    const states: MemberLiveState[] = ['idle', 'running', 'done'];
    const families = ringSegments(states, 3);
    expect(families.map(segment => segment.state)).toEqual(['done', 'running', 'idle']);
    expect(arcMiddle(families, states, 0)).toBeCloseTo(5 / 6, 9);
    expect(arcMiddle(families, states, 2)).toBeCloseTo(1 / 6, 9);
  });
});

describe('a glance at a member that fails while the rest run', () => {
  const four = named(4);
  const running = { m0: { state: 'done' }, m1: { state: 'running' } } as Record<string, RunView>;
  // Member 1 of 4 at work is centred at 135 degrees; member 2 at 225, member 3 at 315 (a level look, up there).
  const atWork = '4.95, 4.24';

  it('looks at the failure for a moment, then back at the work', () => {
    vi.useFakeTimers();
    const view = render(<ConvergedIcon {...props(running, four)} />);
    expect(gazeOf()).toBe(atWork);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe('-4.95, 4.24');
    act(() => { vi.advanceTimersByTime(GLANCE_MS - 1); });
    expect(gazeOf()).toBe('-4.95, 4.24');
    act(() => { vi.advanceTimersByTime(1); });
    expect(gazeOf()).toBe(atWork);
    expect(GLANCE_MS).toBe(950);
  });

  it('a later failure takes the eyes from an earlier one, for its own moment', () => {
    vi.useFakeTimers();
    const view = render(<ConvergedIcon {...props(running, four)} />);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' } }, four)} />);
    act(() => { vi.advanceTimersByTime(300); });
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' }, m3: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe('-4.95, 0.00');
    act(() => { vi.advanceTimersByTime(GLANCE_MS - 1); });
    expect(gazeOf()).toBe('-4.95, 0.00');
    act(() => { vi.advanceTimersByTime(1); });
    expect(gazeOf()).toBe(atWork);
  });

  it('lets no glance outlive the run, not even in the commit before its effect clears it', () => {
    vi.useFakeTimers();
    // What the board shows at each commit of the icon's parent, before passive effects run (a layout effect of the
    // parent runs after the icon's DOM is committed, and before the icon's own useEffect).
    const atCommit: string[] = [];
    function Watched({ runs }: { runs: Record<string, RunView> }) {
      useLayoutEffect(() => { atCommit.push(gazeOf()); });
      return <ConvergedIcon {...props(runs, four)} />;
    }
    const view = render(<Watched runs={running} />);
    view.rerender(<Watched runs={{ ...running, m3: { state: 'failed' } }} />);
    expect(gazeOf()).toBe('-4.95, 0.00');
    atCommit.length = 0;
    view.rerender(<Watched runs={{ m0: { state: 'done' }, m1: { state: 'done' }, m2: { state: 'failed' }, m3: { state: 'failed' } }} />);
    // The settled state's own commit already looks at the first failure, not at the glance's member.
    expect(atCommit).toEqual(['-4.95, 4.24']);
  });

  it('of several failing at once, at the first in pipeline order (the upstream one explains those below it)', () => {
    vi.useFakeTimers();
    const view = render(<ConvergedIcon {...props(running, four)} />);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' }, m3: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe('-4.95, 4.24');
  });

  it('not for a failure the icon was drawn with', () => {
    draw({ ...running, m2: { state: 'failed' } }, four);
    expect(gazeOf()).toBe(atWork);
  });

  it('not for a member that joins the group already failed', () => {
    vi.useFakeTimers();
    const view = render(<ConvergedIcon {...props(running, four.slice(0, 3))} />);
    view.rerender(<ConvergedIcon {...props({ ...running, m3: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe(atWork);
  });

  it('leaves the failure at once when that member is retried', () => {
    vi.useFakeTimers();
    const view = render(<ConvergedIcon {...props(running, four)} />);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe('-4.95, 4.24');
    act(() => { vi.advanceTimersByTime(200); });
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'waiting' } }, four)} />);
    expect(gazeOf()).toBe(atWork);
  });

  it('again for a member that is retried and fails again while the rest run', () => {
    vi.useFakeTimers();
    const view = render(<ConvergedIcon {...props(running, four)} />);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' } }, four)} />);
    act(() => { vi.advanceTimersByTime(GLANCE_MS); });
    expect(gazeOf()).toBe(atWork);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'waiting' } }, four)} />);
    expect(gazeOf()).toBe(atWork);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe('-4.95, 4.24');
  });

  it('stays on its failure through changes that bring no new one: another member retried, the members in a new order', () => {
    vi.useFakeTimers();
    // Member 3 failed before the icon was drawn (no news); member 2 then fails while member 1 runs.
    const view = render(<ConvergedIcon {...props({ ...running, m3: { state: 'failed' } }, four)} />);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' }, m3: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe('-4.95, 4.24');
    act(() => { vi.advanceTimersByTime(200); });
    // Member 3 is retried: the failed list changes with nothing new in it.
    const after = { ...running, m2: { state: 'failed' }, m3: { state: 'waiting' } } as Record<string, RunView>;
    view.rerender(<ConvergedIcon {...props(after, four)} />);
    expect(gazeOf()).toBe('-4.95, 4.24');
    // The members in another order (the board sorts them by depth, then place): member 2's arc is now the last.
    const reordered = [four[0], four[1], four[3], four[2]];
    view.rerender(<ConvergedIcon {...props(after, reordered)} />);
    expect(gazeOf()).toBe('-4.95, 0.00');
    act(() => { vi.advanceTimersByTime(GLANCE_MS - 201); });
    expect(gazeOf()).toBe('-4.95, 0.00');
    act(() => { vi.advanceTimersByTime(1); });
    expect(gazeOf()).toBe(atWork);
  });

  it('not under reduced motion', () => {
    reduce = true;
    const view = render(<ConvergedIcon {...props(running, four)} />);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe(atWork);
  });

  it('ends the moment the reader turns reduced motion on, and none starts until it is off again', () => {
    vi.useFakeTimers();
    // The icon alone: only its own subscription to the setting can draw it again.
    const view = render(<ConvergedIcon {...props(running, four)} />);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe('-4.95, 4.24');
    setReduce(true);
    expect(gazeOf()).toBe(atWork);
    view.rerender(<ConvergedIcon {...props({ ...running, m2: { state: 'failed' }, m3: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe(atWork);
    // Off again: a failure seen after that is news (the ones while it was on are not).
    setReduce(false);
    expect(gazeOf()).toBe(atWork);
    view.rerender(<ConvergedIcon {...props({ m0: { state: 'failed' }, m1: { state: 'running' }, m2: { state: 'failed' }, m3: { state: 'failed' } }, four)} />);
    // Member 0 of 4 is centred at 45 degrees: a level look to the right (never up).
    expect(gazeOf()).toBe('4.95, 0.00');
  });

  it('is gone in the very commit the setting turns on, before the icon\'s effects run', () => {
    vi.useFakeTimers();
    // A parent told of the same setting re-renders with the icon in one commit: its layout effect reads that commit's
    // DOM, before the icon's own effects run.
    const atCommit: string[] = [];
    const subscribe = (notify: () => void) => { changes.add(notify); return () => { changes.delete(notify); }; };
    function Watched({ runs }: { runs: Record<string, RunView> }) {
      useSyncExternalStore(subscribe, () => reduce);
      useLayoutEffect(() => { atCommit.push(gazeOf()); });
      return <ConvergedIcon {...props(runs, four)} />;
    }
    const view = render(<Watched runs={running} />);
    view.rerender(<Watched runs={{ ...running, m2: { state: 'failed' } }} />);
    expect(gazeOf()).toBe('-4.95, 4.24');
    setReduce(true);
    expect(atCommit.at(-1)).toBe(atWork);
  });

  it('ends when the group stops running: then the worried eyes look at the first failure, and nothing is left over', () => {
    vi.useFakeTimers();
    const view = render(<ConvergedIcon {...props(running, four)} />);
    view.rerender(<ConvergedIcon {...props({ ...running, m3: { state: 'failed' } }, four)} />);
    expect(gazeOf()).toBe('-4.95, 0.00');
    // The run ends with member 2 failed as well (no glance: nothing runs): the first failure is member 2's arc.
    const settled = { m0: { state: 'done' }, m1: { state: 'done' }, m2: { state: 'failed' }, m3: { state: 'failed' } } as Record<string, RunView>;
    view.rerender(<ConvergedIcon {...props(settled, four)} />);
    expect(gazeOf()).toBe('-4.95, 4.24');
    act(() => { vi.advanceTimersByTime(GLANCE_MS); });
    expect(gazeOf()).toBe('-4.95, 4.24');
    // A new run: at the work, with no glance kept from the last one.
    view.rerender(<ConvergedIcon {...props(running, four)} />);
    expect(gazeOf()).toBe(atWork);
  });
});

describe('the shapes', () => {
  /** Points along an eye: a capsule's box corners, a path's points sampled along each piece (an arc by its end). */
  function points(part: FacePart): Array<[number, number]> {
    if (part.shape === 'capsule') {
      const [x0, x1, y0, y1] = [part.cx - part.w / 2, part.cx + part.w / 2, part.cy - part.h / 2, part.cy + part.h / 2];
      return [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
    }
    const tokens = part.d.match(/[MQLHAZ]|-?\d+(?:\.\d+)?/g)!;
    const out: Array<[number, number]> = [];
    let at: [number, number] = [0, 0];
    for (let i = 0; i < tokens.length;) {
      const command = tokens[i++];
      const n = () => Number(tokens[i++]);
      if (command === 'M' || command === 'L') { at = [n(), n()]; out.push(at); }
      else if (command === 'H') { at = [n(), at[1]]; out.push(at); }
      else if (command === 'A') { i += 5; at = [n(), n()]; out.push(at); }
      else if (command === 'Q') {
        const c: [number, number] = [n(), n()];
        const end: [number, number] = [n(), n()];
        for (let s = 1; s <= 10; s++) {
          const t = s / 10;
          out.push([(1 - t) ** 2 * at[0] + 2 * (1 - t) * t * c[0] + t * t * end[0], (1 - t) ** 2 * at[1] + 2 * (1 - t) * t * c[1] + t * t * end[1]]);
        }
        at = end;
      } else if (command !== 'Z') throw new Error(`unexpected path command ${command} in ${part.d}`);
    }
    return out;
  }
  const expressions = Object.keys(AVATAR_FACES) as AvatarExpression[];

  it.each(expressions)('%s: two eyes on the upper face, inside the head wherever they look', expression => {
    const parts = AVATAR_FACES[expression];
    expect(parts).toHaveLength(2);
    for (const [index, part] of parts.entries()) {
      for (const [x, y] of points(part)) {
        // The left eye about x 35, the right about x 65, both about the line y 46.
        expect(Math.abs(x - (index ? 65 : 35)), `${expression} eye ${index} x ${x}`).toBeLessThanOrEqual(8);
        expect(y, `${expression} y`).toBeGreaterThanOrEqual(37);
        expect(y, `${expression} y`).toBeLessThanOrEqual(55);
        // Moved as far as the gaze moves them (7 across, 6 down), still well inside the head (r 50 about 50, 50).
        for (const [dx, dy] of [[-7, 0], [7, 0], [-7, 6], [7, 6], [0, 6]]) expect(Math.hypot(x + dx - 50, y + dy - 50)).toBeLessThan(40);
      }
    }
  });

  it('gives every expression its own still shape: under reduced motion, in a screenshot or at the small size, a working face is never the calm one', () => {
    expect(new Set(expressions.map(expression => JSON.stringify(AVATAR_FACES[expression]))).size).toBe(expressions.length);
    const eye = (expression: AvatarExpression) => AVATAR_FACES[expression][0] as Extract<FacePart, { shape: 'capsule' }>;
    // At rest the eyes are tall, at work round, on the same centres.
    expect(eye('working').h).toBeLessThanOrEqual(eye('calm').h - 5);
    expect([eye('working').cx, eye('working').cy]).toEqual([eye('calm').cx, eye('calm').cy]);
  });

  it('draws each pair as mirror images about the middle, upright (the half-shut one level with the other at the foot)', () => {
    for (const expression of expressions) {
      const [left, right] = AVATAR_FACES[expression].map(points);
      if (expression === 'thinking') {
        const [a, b] = AVATAR_FACES.thinking as ReadonlyArray<Extract<FacePart, { shape: 'capsule' }>>;
        expect(a.cx + b.cx).toBe(100);
        expect(a.cy + a.h / 2).toBe(b.cy + b.h / 2);
        expect(b.h).toBeLessThan(a.h);
        continue;
      }
      const mirrored = new Set(left.map(([x, y]) => `${(100 - x).toFixed(3)} ${y.toFixed(3)}`));
      expect(new Set(right.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`)), expression).toEqual(mirrored);
      // And what the points leave out: a line's width, an arc's radii and flags (the sweep flips in a mirror).
      const [a, b] = AVATAR_FACES[expression];
      if (a.shape === 'stroke' && b.shape === 'stroke') expect(b.width, expression).toBe(a.width);
      if (a.shape === 'capsule' && b.shape === 'capsule') expect([b.w, b.h], expression).toEqual([a.w, a.h]);
      if (a.shape === 'fill' && b.shape === 'fill') {
        const arc = (d: string) => d.match(/A (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+) ([01]) ([01])/)!.slice(1).map(Number);
        const [one, two] = [arc(a.d), arc(b.d)];
        expect(two.slice(0, 4), expression).toEqual(one.slice(0, 4));
        expect(two[4], expression).toBe(1 - one[4]);
      }
    }
  });

  it('says each state with the shape that means it', () => {
    const numbers = (part: FacePart) => (part as Extract<FacePart, { d: string }>).d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    // Shut in a smile (done; quieter when reused): each eye an arch, its middle above its ends.
    for (const expression of ['happy', 'content'] as const) {
      for (const eye of AVATAR_FACES[expression]) {
        const [, y0, , cy, , y1] = numbers(eye);
        expect(cy, expression).toBeLessThan(Math.min(y0, y1));
      }
    }
    // Shut when stopped: each eye a cup, its middle below its ends.
    for (const eye of AVATAR_FACES.asleep) {
      const [, y0, , cy, , y1] = numbers(eye);
      expect(cy).toBeGreaterThan(Math.max(y0, y1));
    }
    // A flat stare when blocked: each a level line.
    for (const eye of AVATAR_FACES.blank) expect((eye as Extract<FacePart, { shape: 'stroke' }>).d).toMatch(/^M \d+(?:\.\d+)? \d+(?:\.\d+)? H \d+(?:\.\d+)?$/);
    // Worried: each eye's top edge falls toward the outside of the face (the left eye's outer end is further left and
    // lower than its inner one, the right eye's further right and lower).
    const [left, right] = AVATAR_FACES.worried.map(numbers);
    expect(left[2]).toBeLessThan(left[0]);
    expect(left[3]).toBeGreaterThan(left[1]);
    expect(right[2]).toBeGreaterThan(right[0]);
    expect(right[3]).toBeGreaterThan(right[1]);
    // At rest tall eyes, at work round ones; waiting, one half shut.
    const capsule = (expression: AvatarExpression, index = 0) => AVATAR_FACES[expression][index] as Extract<FacePart, { shape: 'capsule' }>;
    expect(capsule('calm').h).toBeGreaterThan(capsule('calm').w);
    expect(capsule('working').h).toBe(capsule('working').w);
    expect(capsule('thinking', 1).h).toBeLessThanOrEqual(capsule('thinking', 0).h / 2);
  });
});

describe('the head in the stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/canvas/converged-icon.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const motion = css.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/)![1];
  const forced = css.match(/@media \(forced-colors: active\) \{([\s\S]*?)\n\}/)![1];
  const rule = (selector: string, source = css) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
    if (!match) throw new Error(`no rule ${selector}`);
    return match[1];
  };

  it('is flat: the orb core alone, no highlight, glow or shading', () => {
    const head = rule('.awwo-converged-orb');
    expect(head).toMatch(/background:\s*var\(--saas-orb-core, #12385a\);/);
    expect(head).not.toMatch(/gradient|box-shadow/);
  });

  it('clips its parts to its circle, so the clip, not the chin light\'s SVG, draws the chin\'s edge', () => {
    // Inside the zoomed board the crescent's SVG and the disc are rounded apart by up to two thirds of a board pixel; the
    // crescent's outer arc runs past the head (the parts test), and the clip cuts it at the head's own edge.
    const head = rule('.awwo-converged-orb');
    expect(head).toMatch(/overflow: hidden;/);
    expect(head).not.toMatch(/--cv-crescent-inset/);
  });

  it('keeps its rim for the dark styles, inset and 2 px on screen at every zoom, with the chin light 1 px under it', () => {
    expect(rule('.awwo-converged-rim')).toMatch(/^\s*display: none;\s*$/);
    const rim = rule("html:root[data-theme='dark'] .awwo-converged-rim");
    expect(rim).toMatch(/display: block;/);
    expect(rim).toMatch(/inset: 0;/);
    expect(rim).toMatch(/border-radius: 50%;/);
    expect(rim).toMatch(/box-shadow: inset 0 0 0 calc\(2px \* var\(--cv-px, 1\)\) /);
    // 1 screen px inside the head's edge, so most of the crescent shows inside the 2 px rim at the small size.
    expect(rule("html:root[data-theme='dark'] .awwo-converged-orb")).toMatch(/--cv-crescent-inset: calc\(1px \* var\(--cv-px, 1\)\);/);
    const crescent = rule('.awwo-converged-crescent');
    for (const side of ['left', 'top']) expect(crescent).toMatch(new RegExp(`${side}: var\\(--cv-crescent-inset, 0px\\);`));
    for (const size of ['width', 'height']) expect(crescent).toMatch(new RegExp(`${size}: calc\\(100% - 2 \\* var\\(--cv-crescent-inset, 0px\\)\\);`));
  });

  it('blinks only a working face\'s eyes, and only while motion is welcome; nothing looks about by itself', () => {
    expect(motion).toContain('.awwo-converged.is-running .awwo-converged-face .awwo-converged-eyes { animation: awwo-converged-blink 4.4s linear infinite; }');
    expect(css.split('\n').filter(line => /awwo-converged-blink \d/.test(line))).toHaveLength(1);
    expect(css).not.toMatch(/awwo-converged-look/);
    // A blink squashes the eyes about their own middle, not the face's top left corner (SVG's default origin).
    expect(css).toMatch(/\.awwo-converged-eyes \{ transform-box: fill-box; transform-origin: center; \}/);
  });

  it('glides the eyes to where they look only while motion is welcome, and puts them there at once when a group settles', () => {
    expect(motion).toContain('.awwo-converged-gaze { transition: transform .45s var(--saas-ease-in-out, ease-in-out); }');
    expect(css.split('\n').filter(line => /^\s*\.awwo-converged-gaze \{/.test(line))).toHaveLength(1);
    expect(motion).toContain('.awwo-converged:is(.is-just-done, .is-just-failed) .awwo-converged-gaze { transition: none; }');
  });

  it('draws the eyes in the head\'s white, filled or as open lines', () => {
    expect(rule('.awwo-converged-face :is(rect, .is-fill)')).toMatch(/fill: currentColor;/);
    expect(rule('.awwo-converged-face path:not(.is-fill)')).toMatch(/fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round;/);
    // A line's width is its own (avatarFace.ts): no rule sets one for the lines.
    expect(rule('.awwo-converged-face path:not(.is-fill)')).not.toMatch(/stroke-width/);
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

  it('in forced colours, draws the head in the text colour with eyes in the background\'s, and no chin light or rim', () => {
    expect(rule('.awwo-converged-orb', forced)).toMatch(/forced-color-adjust: none; background: CanvasText !important; color: Canvas !important;/);
    expect(rule('.awwo-converged-crescent, .awwo-converged-rim', forced)).toMatch(/display: none !important;/);
  });
});
