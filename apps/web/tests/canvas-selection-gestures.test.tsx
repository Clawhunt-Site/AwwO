import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CanvasViewport } from '../src/canvas/CanvasViewport';
import { Marquee, useMarquee } from '../src/canvas/Marquee';
import { CANVAS_STORAGE_KEY, createSessionNode } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

beforeEach(() => {
  resetAllSessions(); localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('compact card additive click', () => {
  it.each(['shiftKey', 'ctrlKey', 'metaKey'])('keeps %s selections after the actual button click and does not open a workbench', modifier => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ version: 2, updatedAt: 1,
      nodes: ['a', 'b'].map((id, index) => ({ ...createSessionNode('coding', { x: 100 + index * 350, y: 100 }), id, title: id })),
      edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } }));
    render(<CanvasSurface />);
    const selected = () => [...document.querySelectorAll('.canvas-tile--selected')].map(tile => (tile as HTMLElement).dataset.nodeId);
    const click = (id: string) => {
      const target = screen.getByRole('button', { name: `打开 ${id}`, exact: true });
      fireEvent.pointerDown(target, { button: 0, pointerId: 1, [modifier]: true });
      fireEvent.pointerUp(target, { button: 0, pointerId: 1, [modifier]: true });
      fireEvent.click(target, { [modifier]: true });
    };
    click('a'); click('b');
    expect(selected()).toEqual(['a', 'b']);
    expect(screen.queryAllByTestId('composer-input')).toHaveLength(0);
    click('b');
    expect(selected()).toEqual(['a']);
    expect(screen.queryAllByTestId('composer-input')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '打开 a', exact: true }));
    expect(screen.getAllByTestId('composer-input')).toHaveLength(1);
  });
});

function SelectionHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [selection, setSelection] = useState<string[]>(['previous']);
  const marquee = useMarquee({ enabled: true, rootRef, view,
    nodes: [{ ...createSessionNode('coding', { x: 40, y: 40 }), id: 'a', w: 60, h: 60 }],
    onSelect: ids => setSelection(ids) });
  return <div ref={rootRef} className="canvas-root">
    <output data-testid="view">{JSON.stringify(view)}</output><output data-testid="selection">{selection.join(',')}</output>
    <CanvasViewport view={view} onViewChange={setView} onBackgroundPointerDown={marquee.onBackgroundPointerDown}>
      <Marquee rect={marquee.rect} />
    </CanvasViewport>
  </div>;
}

function captureSpies(viewport: HTMLElement) {
  const captured = new Set<number>();
  const capture = vi.fn((id: number) => captured.add(id));
  const release = vi.fn((id: number) => captured.delete(id));
  Object.defineProperties(viewport, {
    setPointerCapture: { configurable: true, value: capture },
    releasePointerCapture: { configurable: true, value: release },
    hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
  });
  return { capture, release };
}

describe('marquee pointer ownership', () => {
  it('captures and releases its pointer without also starting viewport pan', () => {
    const { container } = render(<SelectionHarness />);
    const viewport = container.querySelector<HTMLElement>('.canvas-viewport')!;
    const { capture, release } = captureSpies(viewport);
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
    expect(capture).toHaveBeenCalledExactlyOnceWith(7);
    fireEvent.pointerMove(viewport, { pointerId: 7, clientX: 150, clientY: 150 });
    expect(screen.getByTestId('canvas-marquee')).toBeTruthy();
    fireEvent.pointerUp(viewport, { pointerId: 7, clientX: 150, clientY: 150 });
    expect(screen.getByTestId('selection')).toHaveTextContent('a');
    expect(screen.getByTestId('view')).toHaveTextContent('{"x":0,"y":0,"scale":1}');
    expect(screen.queryByTestId('canvas-marquee')).toBeNull();
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('cancels on lost capture without changing the selected group', () => {
    const { container } = render(<SelectionHarness />);
    const viewport = container.querySelector<HTMLElement>('.canvas-viewport')!;
    captureSpies(viewport);
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(viewport, { pointerId: 7, clientX: 150, clientY: 150 });
    fireEvent.lostPointerCapture(viewport, { pointerId: 7 });
    expect(screen.queryByTestId('canvas-marquee')).toBeNull();
    expect(screen.getByTestId('selection')).toHaveTextContent('previous');
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 150, clientY: 150 });
    expect(screen.getByTestId('selection')).toHaveTextContent('previous');
  });

  it('ignores other pointers and releases its own capture when unmounted', () => {
    const { container, unmount } = render(<SelectionHarness />);
    const viewport = container.querySelector<HTMLElement>('.canvas-viewport')!;
    const { release } = captureSpies(viewport);
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(window, { pointerId: 8 });
    expect(screen.getByTestId('canvas-marquee')).toBeTruthy();
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
  });
});
