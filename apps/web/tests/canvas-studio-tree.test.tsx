// The 成果 studio's file tree follows the studio's own width, not the window's (owner 2026-10-16:
// 「把文件树也改成按工作台宽度」). Inline in the 成果 view the studio can be far narrower than the window: beside the
// assistant's panel, at 1244 px, the tree opened at 280 of its ~500 px because the window was wide. Wider than 760 px it
// sits beside the file and starts open; at 760 px or below it lies over the file (studio.css, read by
// canvas-stage-cover.test.ts) and starts closed. Crossing 760 px folds it away, or brings back what the reader last chose
// while it sat beside the file; picking a file, or a step in the 成果 view, closes it only where it lies over the file;
// closing it with focus inside moves focus to its toggle.
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionNode, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { DeliverableStudio } from '../src/canvas/studio/DeliverableStudio';

const at = Date.now();
const node = (id: string, text: string): SessionNode => ({
  ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id,
  contract: { version: 1, inputs: [], outputs: [{ id: 'notes', label: 'Notes', type: 'markdown', required: true, value: '' }] },
  lastOutput: { text: JSON.stringify({ notes: text }), at, source: 'run' },
});
const nodes: CanvasNode[] = [node('first', '# One'), node('second', '# Two')];

// The studio's own width as a browser lays it out (jsdom lays nothing out): its root's clientWidth, the resize
// deliveries' content box, and the stylesheet's tree, over the file at 760 px or less. A studio in a dialog that is not
// open measures 0, as a closed <dialog> lays out nothing.
let studioWidth = 1000;
let deliveries: Array<(entries: unknown[]) => void> = [];
let disconnected = 0;
beforeEach(() => {
  studioWidth = 1000;
  deliveries = [];
  disconnected = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('awwo-studio')) return 0;
    const dialog = this.closest('dialog');
    // A browser rounds clientWidth to whole pixels; the container query and the resize entries keep the fraction.
    return dialog && !dialog.hasAttribute('open') ? 0 : Math.round(studioWidth);
  });
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const style = real(element, pseudo);
    if (!element.classList?.contains('awwo-studio-tree')) return style;
    return new Proxy(style, { get: (target, key) => {
      if (key === 'position') return studioWidth <= 760 ? 'absolute' : 'static';
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: (entries: unknown[]) => void) { deliveries.push(callback); }
    observe() {} unobserve() {} disconnect() { disconnected += 1; }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tree = () => document.querySelector('nav.awwo-studio-tree');
const toggle = () => document.querySelector<HTMLButtonElement>('.awwo-studio-header > button.awwo-studio-icon')!;
const resize = (width: number) => {
  studioWidth = width;
  act(() => { deliveries.forEach(deliver => deliver([{ contentBoxSize: [{ inlineSize: width, blockSize: 600 }] }])); });
};
const studio = (focusNodeId?: string) => <DeliverableStudio nodes={nodes} edges={[]} title="Results" variant="embedded" focusNodeId={focusNodeId} />;
/** A file row other than the open one. */
const otherFile = () => [...document.querySelectorAll<HTMLButtonElement>('nav.awwo-studio-tree button.awwo-studio-item-open')]
  .find(button => button.getAttribute('aria-current') !== 'true')!;

describe('the 成果 studio’s file tree follows the studio’s own width', () => {
  it('starts open beside the file in a studio wider than 760 px, closed in one of 760 px or less, whatever the window', () => {
    // jsdom's window is 1024 px wide: by the window alone the tree would start open in both.
    expect(window.innerWidth).toBeGreaterThan(760);
    render(studio());
    expect(tree(), 'a 1000 px studio').not.toBeNull();
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    cleanup();
    studioWidth = 760;
    render(studio());
    expect(tree(), 'a 760 px studio').toBeNull();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  });

  it('folds away when the studio narrows past 760 px and comes back when it widens; the toggle decides in between', () => {
    render(studio());
    resize(760.5);
    expect(tree(), '760.5 px: wider than 760').not.toBeNull();
    resize(760);
    expect(tree(), '760 px').toBeNull();
    resize(500);
    expect(tree(), 'narrower still').toBeNull();
    fireEvent.click(toggle());
    expect(tree(), 'opened by hand while narrow').not.toBeNull();
    resize(480);
    expect(tree(), 'a resize that stays narrow keeps it').not.toBeNull();
    resize(900);
    expect(tree(), 'wide again').not.toBeNull();
    fireEvent.click(toggle());
    expect(tree(), 'closed by hand while wide').toBeNull();
    resize(1200);
    expect(tree(), 'a resize that stays wide keeps it closed').toBeNull();
  });

  it('decides at a fractional width as the stylesheet does, not by the rounded clientWidth', () => {
    // At 760.4 px the container query lays the tree beside the file while clientWidth reads 760 (found in review: a
    // 96vw dialog in a 792 px window): the tree stays, and picking a file keeps it.
    render(studio());
    resize(760.4);
    expect(tree(), '760.4 px').not.toBeNull();
    fireEvent.click(otherFile());
    expect(tree(), 'a file picked at 760.4 px').not.toBeNull();
  });

  it('brings back what the reader last chose while it sat beside the file', () => {
    // Closed by hand beside the file, it stays closed through a narrowing and a widening (found in review: every
    // widening reopened it); opened again beside the file, it comes back after the next narrowing.
    render(studio());
    fireEvent.click(toggle());
    resize(500);
    resize(1000);
    expect(tree(), 'closed by hand before').toBeNull();
    fireEvent.click(toggle());
    resize(500);
    expect(tree(), 'folded while narrow').toBeNull();
    resize(1000);
    expect(tree(), 'opened by hand before').not.toBeNull();
  });

  it('closes after a file is picked only where it lies over the file, and leaves focus on its toggle', () => {
    render(studio());
    fireEvent.click(otherFile());
    expect(tree(), 'beside the file').not.toBeNull();
    resize(600);
    fireEvent.click(toggle());
    const file = otherFile();
    file.focus();
    fireEvent.click(file);
    expect(tree(), 'over the file').toBeNull();
    // Its buttons left with it: focus is on the toggle, not the page's body (found in review).
    expect(document.activeElement).toBe(toggle());
  });

  it('moves focus to the toggle when a narrowing folds the tree away with focus inside', () => {
    render(studio());
    otherFile().focus();
    resize(600);
    expect(tree()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it('closes when a step in the 成果 view is picked, where the tree lies over the file', () => {
    studioWidth = 600;
    const view = render(studio('first'));
    fireEvent.click(toggle());
    expect(tree()).not.toBeNull();
    view.rerender(studio('second'));
    expect(tree(), 'the second step picked').toBeNull();
  });

  it('keeps the window’s guess until a studio not laid out yet has a width, then follows it', () => {
    // A studio laid out nowhere (0 px) keeps the 1024 px window's guess, and its first width decides.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('awwo-studio') ? 0 : 0;
    });
    render(studio());
    expect(tree(), 'not laid out, a 1024 px window').not.toBeNull();
    resize(700);
    expect(tree(), 'first width: 700 px').toBeNull();
  });

  it('measures a dialog’s studio once the dialog is open, before anything is drawn', () => {
    // The dialog opens in a layout effect, before the studio measures: a 700 px dialog starts the tree closed with no
    // resize delivered (in review: it opened after the studio measured 0 px, and the tree showed for a frame).
    studioWidth = 700;
    render(<DeliverableStudio nodes={nodes} edges={[]} title="Results" variant="dialog" onClose={() => undefined} />);
    expect(document.querySelector('dialog.awwo-studio-dialog')).toHaveAttribute('open');
    expect(tree(), 'a 700 px dialog').toBeNull();
  });

  it('stops observing its width when it leaves the page', () => {
    const view = render(studio());
    expect(deliveries).toHaveLength(1);
    view.unmount();
    expect(disconnected).toBe(1);
  });
});
