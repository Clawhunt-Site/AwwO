// The jump to a noted line (ArtifactPreview) brings the line into view in the drawer around the source pane, not only in
// the pane: the signed-in check of 2026-11-09 found a line selected below the drawer's visible box. The boxes here are
// a model of the real geometry: an opened node is drawn inside the canvas's scaled world, a box's rectangle is its
// layout size times the zoom, scrollBy really moves the line and stops at the box's ends, and the canvas stage around
// the drawer clips without scrolling, so a loop that never settles, or a line left outside the stage, would show.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVEAL_MAX_CORRECTIONS, revealLine } from '../src/canvas/revealLine';

const innerHeightOf = Object.getOwnPropertyDescriptor(window, 'innerHeight');
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  if (innerHeightOf) Object.defineProperty(window, 'innerHeight', innerHeightOf);
});

const fakeFrames = () => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });

/** A drawer (.awwo-deliverables-like scroll box) holding a 62vh source pane with the line in it, in a world drawn at
 *  `zoom` from screen y `originY`, inside a stage (the canvas, which clips and does not scroll) and a window. Layout
 *  numbers are the box's own pixels; rectangles, the stage and the window are screen pixels. Numbers close to a drawer
 *  at 1440 x 900 (the signed-in check measured 505 px of 882 on its film page): the drawer shows 493 px of 882, the
 *  pane is 558 px tall and starts 205 px into the drawer's content. */
function world(opts: { zoom?: number; originY?: number; fade?: number } = {}) {
  const w = { zoom: opts.zoom ?? 1, originY: opts.originY ?? 0, drawerTop: 304, drawerHeight: 493, drawerContent: 882, drawerScroll: 0,
    paneOffset: 205, paneHeight: 558, paneContent: 900, paneScroll: 0, lineOffset: 690, lineHeight: 13, fade: opts.fade ?? 0, gone: false,
    stageTop: -1e6, stageBottom: 1e6, viewport: 1e6 };
  const stage = document.createElement('div');
  stage.setAttribute('style', 'overflow-y: hidden');
  const drawer = document.createElement('div');
  drawer.setAttribute('style', `overflow-y: auto${w.fade ? `; --awwo-scroll-fade: ${w.fade}px` : ''}`);
  const pane = document.createElement('pre');
  pane.setAttribute('style', 'overflow-y: auto'); // what a browser computes for the pane's overflow: auto (jsdom does not)
  stage.append(drawer);
  drawer.append(pane);
  document.body.append(stage);
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => w.viewport });
  const screen = (layoutY: number) => w.originY + w.zoom * layoutY;
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  const paneTop = () => w.drawerTop + w.paneOffset - w.drawerScroll;
  const calls = { drawer: 0, pane: 0, stage: 0 };
  const box = (el: HTMLElement, size: () => [number, number], scroll: { get: () => number; set: (v: number) => void }, top: () => number, key: 'drawer' | 'pane') => {
    Object.defineProperty(el, 'clientHeight', { get: () => size()[0], configurable: true });
    Object.defineProperty(el, 'offsetHeight', { get: () => size()[0], configurable: true });
    Object.defineProperty(el, 'scrollHeight', { get: () => size()[1], configurable: true });
    Object.defineProperty(el, 'clientTop', { get: () => 0, configurable: true });
    Object.defineProperty(el, 'scrollTop', { get: scroll.get, set: scroll.set, configurable: true });
    el.getBoundingClientRect = () => rect(screen(top()), w.zoom * size()[0]);
    Object.defineProperty(el, 'scrollBy', { configurable: true, value: (o: { top: number }) => {
      calls[key] += 1;
      scroll.set(Math.max(0, Math.min(size()[1] - size()[0], scroll.get() + o.top)));
    } });
  };
  box(drawer, () => [w.drawerHeight, w.drawerContent], { get: () => w.drawerScroll, set: v => { w.drawerScroll = v; } }, () => w.drawerTop, 'drawer');
  box(pane, () => [w.paneHeight, w.paneContent], { get: () => w.paneScroll, set: v => { w.paneScroll = v; } }, paneTop, 'pane');
  stage.getBoundingClientRect = () => rect(w.stageTop, w.stageBottom - w.stageTop);
  /** Gives the stage the sizes of one whose content (the scaled world) overflows it, as the canvas root's does. */
  const overflowingStage = (scrollTop: number) => {
    Object.defineProperty(stage, 'clientHeight', { get: () => w.stageBottom - w.stageTop, configurable: true });
    Object.defineProperty(stage, 'scrollHeight', { get: () => 5000, configurable: true });
    Object.defineProperty(stage, 'scrollTop', { get: () => scrollTop, configurable: true });
    Object.defineProperty(stage, 'scrollBy', { configurable: true, value: () => { calls.stage += 1; } });
  };
  const line = () => (w.gone ? null : rect(screen(paneTop() + w.lineOffset - w.paneScroll), w.zoom * w.lineHeight));
  /** Whether a stretch of screen rows can be seen: inside the pane, what the drawer shows (its fade excluded), the
   *  stage and the window. */
  const inSight = (top: number, bottom: number) => {
    const d = drawer.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    return top >= d.top && bottom <= d.top + w.zoom * (w.drawerHeight - w.fade) && top >= p.top && bottom <= p.bottom
      && top >= Math.max(0, w.stageTop) && bottom <= Math.min(w.viewport, w.stageBottom);
  };
  /** Whether the line can be seen, all of it. */
  const seen = () => {
    const l = line();
    return !!l && inSight(l.top, l.bottom);
  };
  /** Whether the line's first row (13 px) can be seen, for a line taller than what a box shows. */
  const firstRowSeen = () => {
    const l = line();
    return !!l && inSight(l.top, l.top + w.zoom * 13);
  };
  return { w, drawer, pane, stage, line, seen, firstRowSeen, calls, overflowingStage };
}

describe('revealLine at the moment of the press', () => {
  it('brings a line the pane scrolled to into the drawer at 100 %', () => {
    const m = world();
    expect(m.seen()).toBe(false);
    revealLine(m.pane, m.line, 0);
    expect(m.seen()).toBe(true);
    expect(m.calls.drawer).toBe(1);
  });

  it('brings it in at a canvas zoom of 207 % and of 80 %, with one scroll of the drawer each', () => {
    for (const zoom of [2.07, 0.8]) {
      const m = world({ zoom, originY: -300 });
      revealLine(m.pane, m.line, 0);
      expect(m.seen(), `zoom ${zoom}`).toBe(true);
      expect(m.calls.drawer, `zoom ${zoom}`).toBe(1);
    }
  });

  it('puts the line a third of the way down the pane and then the drawer, at any zoom: distances are in layout pixels', () => {
    for (const zoom of [2, 0.8]) {
      const m = world({ zoom });
      m.w.drawerContent = 3000; // room enough that no box stops at its end
      m.w.paneContent = 3000;
      m.w.paneOffset = 700;
      m.w.lineOffset = 1500;
      revealLine(m.pane, m.line, 0);
      const l = m.line()!;
      const p = m.pane.getBoundingClientRect();
      const d = m.drawer.getBoundingClientRect();
      expect(l.top - p.top, `zoom ${zoom}`).toBeCloseTo(p.height / 3, 0);
      expect(l.top - d.top, `zoom ${zoom}`).toBeCloseTo(d.height / 3, 0);
      expect(m.calls.drawer, `zoom ${zoom}`).toBe(1);
    }
  });

  it("counts the drawer's bottom fade as not shown", () => {
    const m = world({ fade: 44 });
    m.w.paneContent = m.w.paneHeight; // the pane cannot scroll the line up itself
    m.w.lineOffset = 250; // so it lands in the drawer's last 44 px: drawn, but faded out
    revealLine(m.pane, m.line, 0);
    expect(m.seen()).toBe(true);
    expect(m.calls.drawer).toBe(1);
  });

  it('counts only what the window shows', () => {
    const m = world();
    m.w.viewport = 450; // the window ends 146 px below the drawer's top
    m.w.drawerContent = 1500;
    revealLine(m.pane, m.line, 0);
    expect(m.seen()).toBe(true);
  });

  it('brings the line inside the canvas stage when a zoomed-in drawer reaches past it, and never scrolls the stage', () => {
    // At 400 %, panned: the drawer's top is 1000 px above the window, its note still on the stage near the bottom. The
    // stage starts lower in the window than the window's own top, so only the stage can say what is out of sight.
    const m = world({ zoom: 4, originY: -2216 });
    m.w.stageTop = 400;
    m.w.stageBottom = 900;
    m.w.drawerScroll = 389;
    m.overflowingStage(1000); // as the canvas root, which holds the overflowing world and could be scrolled by script
    revealLine(m.pane, m.line, 0);
    expect(m.seen()).toBe(true);
    expect(m.calls.stage).toBe(0);
  });

  it('leaves the drawer alone when the line is already in view', () => {
    const m = world();
    m.w.lineOffset = 200;
    revealLine(m.pane, m.line, 0);
    expect(m.seen()).toBe(true);
    expect(m.calls.drawer).toBe(0);
  });

  it('skips boxes that fit, and does nothing without a line', () => {
    const m = world();
    m.w.drawerContent = m.w.drawerHeight; // the drawer's content fits: it cannot scroll
    revealLine(m.pane, m.line, 0);
    expect(m.calls.drawer).toBe(0);
    const n = world();
    n.w.gone = true;
    revealLine(n.pane, n.line, 0);
    expect(n.calls.pane + n.calls.drawer).toBe(0);
  });
});

describe('revealLine while the layout settles', () => {
  it('keeps the line in view through the refit a laptop-sized window makes, and settles', () => {
    fakeFrames();
    const m = world();
    revealLine(m.pane, m.line);
    expect(m.seen()).toBe(true);
    // The canvas refits the opened node: it moves down 56 px and is made shorter, so its drawer shows 150 px, above
    // the line.
    m.w.drawerTop += 56;
    m.w.drawerHeight = 150;
    expect(m.seen()).toBe(false);
    vi.advanceTimersByTime(16 * 3);
    expect(m.seen()).toBe(true);
    const settled = m.calls.drawer;
    vi.advanceTimersByTime(900);
    expect(m.calls.drawer).toBe(settled); // nothing scrolls once it is in view
    expect(m.seen()).toBe(true);
  });

  it('never flips back and forth, at 207 % or at any other zoom', () => {
    for (const zoom of [0.6, 0.8, 1, 1.5, 2.07, 4]) {
      fakeFrames();
      document.body.innerHTML = '';
      const m = world({ zoom, originY: -200, fade: 44 });
      revealLine(m.pane, m.line);
      let unseenFrames = 0;
      for (let t = 0; t < 900; t += 16) {
        vi.advanceTimersByTime(16);
        if (!m.seen()) unseenFrames += 1;
      }
      expect(unseenFrames, `zoom ${zoom}`).toBe(0);
      expect(m.calls.drawer, `zoom ${zoom}`).toBe(1); // the press's one scroll, and no correction after it
      vi.useRealTimers();
    }
  });

  it('keeps a line taller than two thirds of what the drawer shows with its first row in view, through the refit', () => {
    fakeFrames();
    const m = world();
    m.w.lineHeight = 400; // one long source line, wrapped: more than two thirds of the drawer's 493 px
    m.w.paneContent = 1200;
    revealLine(m.pane, m.line);
    expect(m.firstRowSeen()).toBe(true);
    expect(m.calls.drawer).toBe(1);
    m.w.paneOffset += 40; // what sits above the pane in the drawer grows: the line's start stays in the top half
    m.w.drawerContent += 40;
    vi.advanceTimersByTime(16 * 9); // the canvas refits after about 150 ms: it must still be settling then
    expect(m.calls.drawer).toBe(1);
    m.w.drawerTop += 56; // the refit: the node moves down and is made shorter, and what sits above the pane grows
    m.w.drawerHeight -= 120;
    m.w.paneOffset += 200;
    m.w.drawerContent += 200;
    expect(m.firstRowSeen()).toBe(false);
    vi.advanceTimersByTime(16 * 3);
    expect(m.firstRowSeen()).toBe(true);
    expect(m.calls.drawer).toBe(2); // the press, and the one correction after the refit
    vi.advanceTimersByTime(16 * 3);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // still settling past 200 ms
  });

  it('never spends a correction on a scroll a box has no room for', () => {
    fakeFrames();
    const m = world();
    m.w.stageTop = 0; // the stage ends 296 px into the drawer
    m.w.stageBottom = 600;
    m.w.lineOffset = 887; // the source's last line: neither the pane nor the drawer can scroll it any higher
    revealLine(m.pane, m.line);
    expect(m.seen()).toBe(false);
    vi.advanceTimersByTime(16 * 9);
    m.w.drawerContent += 200; // what sits below the pane grows, which gives the drawer room
    vi.advanceTimersByTime(16 * 3);
    expect(m.seen()).toBe(true);
  });

  it('leaves a box with nothing of it in sight to the boxes around it', () => {
    fakeFrames();
    const m = world();
    m.w.viewport = 800;
    revealLine(m.pane, m.line);
    expect(m.seen()).toBe(true);
    const pane = m.calls.pane;
    // An outer box grows and jumps to its end (as the canvas assistant's log does for a new message): the pane leaves
    // the window entirely. The outer box brings the line back; the pane, which shows nothing, is not scrolled.
    m.w.drawerContent += 800;
    m.w.drawerScroll += 800;
    vi.advanceTimersByTime(16);
    expect(m.seen()).toBe(true);
    expect(m.calls.pane).toBe(pane);
  });

  it('stops the moment the person scrolls, touches, presses or types, even where the canvas stops the event bubbling', () => {
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      fakeFrames();
      document.body.innerHTML = '';
      const m = world();
      m.drawer.addEventListener(type, event => event.stopPropagation()); // as the tile does for wheels in its drawer
      revealLine(m.pane, m.line);
      const before = m.calls.drawer;
      m.pane.dispatchEvent(new Event(type, { bubbles: true }));
      m.w.drawerHeight = 150; // the line leaves the drawer's view afterwards
      vi.advanceTimersByTime(100);
      expect(m.calls.drawer, type).toBe(before);
      vi.useRealTimers();
    }
  });

  it('stops when something else scrolls a box it moved, while the box keeps its size', () => {
    fakeFrames();
    const m = world();
    revealLine(m.pane, m.line);
    const before = m.calls.drawer;
    m.w.drawerScroll = 0; // another script scrolls the drawer back to its top; the box kept its size
    vi.advanceTimersByTime(100);
    expect(m.calls.drawer).toBe(before);
  });

  it('stops when something else scrolls a box it did not need to move', () => {
    fakeFrames();
    const m = world();
    m.w.paneContent = m.w.paneHeight; // the pane cannot scroll
    m.w.drawerScroll = 300;
    m.w.lineOffset = 105; // 10 px below what the drawer shows from its top: in view at the press
    revealLine(m.pane, m.line);
    expect(m.seen()).toBe(true);
    expect(m.calls.drawer).toBe(0);
    m.w.drawerScroll = 389; // another script scrolls the drawer to its end, which takes the line above its view
    vi.advanceTimersByTime(100);
    expect(m.seen()).toBe(false);
    expect(m.calls.drawer).toBe(0);
  });

  it("takes a scroll that came with a change of the box's size for the layout's, and keeps settling", () => {
    fakeFrames();
    const m = world();
    revealLine(m.pane, m.line);
    m.w.drawerContent -= 100; // what sits below the pane collapses: the drawer's end moves up, and with it its scroll
    m.w.drawerScroll = Math.min(m.w.drawerScroll, m.w.drawerContent - m.w.drawerHeight);
    vi.advanceTimersByTime(16 * 2);
    expect(m.seen()).toBe(true);
    m.w.drawerHeight -= 250; // then the node is made shorter, which hides the line
    expect(m.seen()).toBe(false);
    vi.advanceTimersByTime(16 * 2);
    expect(m.seen()).toBe(true);
    expect(m.calls.drawer).toBe(2);
  });

  it('notes a box afresh after it stopped scrolling for a while', () => {
    fakeFrames();
    const m = world();
    revealLine(m.pane, m.line);
    const content = m.w.drawerContent;
    m.w.drawerContent = m.w.drawerHeight; // the drawer's content fits for a moment: the browser puts it at its top
    m.w.drawerScroll = 0;
    vi.advanceTimersByTime(16 * 2);
    m.w.drawerContent = content; // and scrolls again at its old size, the line now below its view
    expect(m.seen()).toBe(false);
    vi.advanceTimersByTime(16 * 2);
    expect(m.seen()).toBe(true);
  });

  it('stops when the line is gone (its text replaced or removed)', () => {
    fakeFrames();
    const m = world();
    revealLine(m.pane, m.line);
    const before = m.calls.pane + m.calls.drawer;
    m.w.gone = true;
    vi.advanceTimersByTime(100);
    m.w.gone = false;
    m.w.drawerHeight = 150;
    vi.advanceTimersByTime(100);
    expect(m.calls.pane + m.calls.drawer).toBe(before);
  });

  it(`corrects one box at most ${REVEAL_MAX_CORRECTIONS} times, then gives up`, () => {
    fakeFrames();
    const m = world();
    m.w.drawerContent = 3000; // room to move either way on every frame
    revealLine(m.pane, m.line);
    for (let i = 0; i < 20; i += 1) {
      // A layout that throws the line out of view again after every correction, 100 px above what the drawer shows
      // and then 100 px below it, by moving what sits above the pane.
      const y = i % 2 === 0 ? m.w.drawerTop - 100 : m.w.drawerTop + m.w.drawerHeight + 100;
      m.w.paneOffset = y - m.w.drawerTop + m.w.drawerScroll - (m.w.lineOffset - m.w.paneScroll);
      vi.advanceTimersByTime(16);
    }
    expect(m.calls.drawer).toBeLessThanOrEqual(REVEAL_MAX_CORRECTIONS + 1);
    expect(vi.getTimerCount()).toBe(0); // it gave up: no frame is waiting
  });

  it('stops on its own after the settle time, and when its clean-up runs', () => {
    fakeFrames();
    const m = world();
    revealLine(m.pane, m.line, 800);
    vi.advanceTimersByTime(900);
    const before = m.calls.drawer;
    m.w.drawerHeight = 150;
    vi.advanceTimersByTime(100);
    expect(m.calls.drawer).toBe(before);
    const n = world();
    const stop = revealLine(n.pane, n.line);
    stop();
    const after = n.calls.drawer;
    n.w.drawerHeight = 150;
    vi.advanceTimersByTime(100);
    expect(n.calls.drawer).toBe(after);
  });
});
