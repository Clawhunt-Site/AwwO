import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TilePorts, type WiringApi } from '../src/canvas/TilePorts';
import { SessionTile } from '../src/canvas/SessionTile';
import { NodeIconTile } from '../src/canvas/NodeIconTile';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';

afterEach(cleanup);
function node(): SessionNode {
  return { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'frontend', w: 400, h: 420,
    contract: { version: 1,
      inputs: [{ id: 'private_input_id', label: '用户需求与交互说明', type: 'markdown', required: true, value: '' }],
      outputs: [{ id: 'private_output_id', label: '前端页面', type: 'file', required: true, value: '' }],
    },
  };
}
function wiring(): WiringApi {
  return { pendingPort: null, wireDrag: null, interactive: true, wireCount: () => 0,
    clearPending: vi.fn(), cancelWiring: vi.fn(), onPortPointerDown: vi.fn(), onPortClick: vi.fn() };
}

describe('contract port labels', () => {
  it('names contract ports with their field labels, while retaining stable wiring ids', () => {
    render(<TilePorts node={node()} wiring={wiring()} />);
    const input = screen.getByRole('button', { name: '输入端口 用户需求与交互说明（文本），未连接' });
    const output = screen.getByRole('button', { name: '输出端口 前端页面（文件），未连接' });
    expect(input.getAttribute('title')).toBe('用户需求与交互说明 · 文本');
    expect(input.dataset.portId).toBe('in:private_input_id');
    expect(output.dataset.portId).toBe('out:private_output_id');
    expect(screen.getByText('前端页面')).toBeTruthy();
    expect(input.getAttribute('aria-label')).not.toContain('private_input_id');
  });

  it('keeps labels outside the original handle and expands their readable text on focus', () => {
    render(<TilePorts node={node()} wiring={wiring()} />);
    const input = screen.getByRole('button', { name: /输入端口 用户需求/ });
    const label = screen.getByText('用户需求与交互说明');
    expect(label.style.position).toBe('absolute');
    expect(label.style.pointerEvents).toBe('none');
    expect(label.style.maxWidth).toBe('96px');
    expect(input.style.left).toBe('0px');
    expect(input.style.top).toBe('210px');
    fireEvent.focus(input);
    expect(label.style.maxWidth).toBe('220px');
    fireEvent.blur(input);
    expect(label.style.maxWidth).toBe('96px');
  });

  it('draws a label the stage has no room for beside its port only while its port is hovered or focused, inside the tile, and outside at rest again once it has room', () => {
    const observers: { callback: IntersectionObserverCallback; init: IntersectionObserverInit; targets: Element[] }[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      readonly root: Element | null;
      private readonly entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback, init: IntersectionObserverInit) {
        this.root = (init.root as Element) ?? null;
        this.entry = { callback, init, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve(target: Element) { this.entry.targets = this.entry.targets.filter(item => item !== target); }
      disconnect() { this.entry.targets = []; }
    });
    try {
      const stage = document.createElement('div');
      stage.className = 'canvas-root';
      document.body.appendChild(stage);
      const { rerender } = render(<TilePorts node={node()} wiring={wiring()} />, { container: stage });
      const input = screen.getByRole('button', { name: /输入端口 用户需求/ });
      const output = screen.getByRole('button', { name: /输出端口 前端页面/ });
      // Read anew each time: a label not drawn is not in the document.
      const inputLabel = () => screen.queryByText('用户需求与交互说明');
      const outputLabel = () => screen.queryByText('前端页面');
      const watching = (port: Element) => observers.find(item => item.targets.includes(port))!;
      const left = watching(input);
      expect(left.init.root).toBe(stage);
      expect(left.init.rootMargin).toBe('0px 0px 0px -120px');
      expect(watching(output).init.rootMargin).toBe('0px -120px 0px 0px');
      expect(inputLabel()!.style.right).toBe('18px');
      const report = (observer: (typeof observers)[number], ratio: number) => act(() => observer.callback(
        [{ target: input, intersectionRatio: ratio } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
      report(left, 0.4);
      // No room beside its port: inside the tile it would cover the tile's content, so at rest it is not drawn; the
      // output port, which has room, keeps its label outside.
      expect(inputLabel()).toBeNull();
      expect(outputLabel()!.style.left).toBe('18px');
      // Its port's hover or focus draws it inside the tile, readable in full, for as long as that lasts.
      fireEvent.mouseEnter(input);
      expect(inputLabel()!.style.left).toBe('18px');
      expect(inputLabel()!.style.right).toBe('');
      expect(inputLabel()!.style.maxWidth).toBe('220px');
      fireEvent.mouseLeave(input);
      expect(inputLabel()).toBeNull();
      fireEvent.focus(input);
      expect(inputLabel()!.style.left).toBe('18px');
      fireEvent.blur(input);
      expect(inputLabel()).toBeNull();
      report(left, 1);
      expect(inputLabel()!.style.right).toBe('18px');
      // The label is drawn in the tile's own pixels, so at a zoom of 1.25 it takes 1.25 times its room on screen: the
      // handles move to new observers with that margin, and a render at the same zoom keeps them.
      rerender(<TilePorts node={node()} wiring={wiring()} scale={1.25} />);
      const zoomed = watching(input);
      expect(zoomed).not.toBe(left);
      expect(left.targets).toEqual([]);
      expect(zoomed.init.rootMargin).toBe('0px 0px 0px -150px');
      expect(watching(output).init.rootMargin).toBe('0px -150px 0px 0px');
      const made = observers.length;
      rerender(<TilePorts node={node()} wiring={wiring()} scale={1.25} />);
      expect(observers.length).toBe(made);
      expect(watching(input)).toBe(zoomed);
      expect(inputLabel()!.style.right).toBe('18px');
      report(zoomed, 0.4);
      expect(inputLabel()).toBeNull();
      fireEvent.focus(input);
      expect(inputLabel()!.style.left).toBe('18px');
      stage.remove();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes the original port spec through both gesture handlers', () => {
    const controls = wiring();
    render(<TilePorts node={node()} wiring={controls} />);
    const output = screen.getByRole('button', { name: /输出端口 前端页面/ });
    fireEvent.pointerDown(output, { button: 0, pointerId: 1 });
    fireEvent.click(output);
    expect(controls.onPortPointerDown).toHaveBeenCalledWith('frontend', expect.objectContaining({ id: 'out:private_output_id', dataType: 'file' }), expect.anything());
    expect(controls.onPortClick).toHaveBeenCalledWith('frontend', expect.objectContaining({ id: 'out:private_output_id', dataType: 'file' }), expect.anything());
  });
});

// The ports' field labels where the stage has no room for them beside the port (an opened node near the stage's edge):
// never at rest over the tile's content, shown inside only while the port is hovered, focused or a dragged wire's end.
describe('field labels without room beside their port', () => {
  type Watcher = { callback: IntersectionObserverCallback; init: IntersectionObserverInit; targets: Element[] };
  let observers: Watcher[] = [];
  let stage: HTMLDivElement;
  beforeEach(() => {
    observers = [];
    vi.stubGlobal('IntersectionObserver', class {
      readonly root: Element | null;
      private readonly entry: Watcher;
      constructor(callback: IntersectionObserverCallback, init: IntersectionObserverInit) {
        this.root = (init.root as Element) ?? null;
        this.entry = { callback, init, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve(target: Element) { this.entry.targets = this.entry.targets.filter(item => item !== target); }
      disconnect() { this.entry.targets = []; }
    });
    stage = document.createElement('div');
    stage.className = 'canvas-root';
    document.body.appendChild(stage);
  });
  afterEach(() => { stage.remove(); vi.unstubAllGlobals(); });
  // No room beside `port` (the stage would clip its label), or room again.
  const room = (port: Element, has: boolean) => act(() => observers.find(item => item.targets.includes(port))!.callback(
    [{ target: port, intersectionRatio: has ? 1 : 0.4 } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
  const inputPort = () => screen.getByRole('button', { name: /输入端口 用户需求/ });
  const outputPort = () => screen.getByRole('button', { name: /输出端口 前端页面/ });
  const inputLabel = () => screen.queryByText('用户需求与交互说明');
  const outputLabel = () => screen.queryByText('前端页面');

  it('keeps a focused port\'s label while the pointer leaves it, and gives it back after the pointer passes over another port', () => {
    render(<TilePorts node={node()} wiring={wiring()} />, { container: stage });
    room(inputPort(), false);
    act(() => inputPort().focus());
    expect(inputLabel()!.style.left).toBe('18px');
    fireEvent.mouseEnter(inputPort());
    fireEvent.mouseLeave(inputPort());
    expect(inputLabel()).not.toBeNull();
    fireEvent.mouseEnter(outputPort());
    expect(inputLabel()).toBeNull();
    fireEvent.mouseLeave(outputPort());
    expect(inputLabel()!.style.left).toBe('18px');
    act(() => inputPort().blur());
    expect(inputLabel()).toBeNull();
  });

  it('lets the label go when its port becomes inert while focused, and draws none on an inert or unwired port', () => {
    const { rerender } = render(<TilePorts node={node()} wiring={wiring()} />, { container: stage });
    room(inputPort(), false);
    act(() => inputPort().focus());
    expect(inputLabel()).not.toBeNull();
    // A run starts, or the board turns read-only: the tile's wiring goes inert.
    rerender(<TilePorts node={node()} wiring={{ ...wiring(), interactive: false }} />);
    expect(inputLabel()).toBeNull();
    rerender(<TilePorts node={node()} />);
    expect(inputLabel()).toBeNull();
    // The port that has room keeps its label outside, inert or not.
    expect(outputLabel()!.style.left).toBe('18px');
    // Wired again (the run ended): the label comes back only when the port is hovered or focused anew.
    rerender(<TilePorts node={node()} wiring={wiring()} />);
    expect(inputLabel()).toBeNull();
    fireEvent.mouseEnter(inputPort());
    expect(inputLabel()).not.toBeNull();
  });

  it('forgets a hovered port that goes away, so put back under the same key it does not show its label at rest', () => {
    const { rerender } = render(<TilePorts node={node()} wiring={wiring()} />, { container: stage });
    room(inputPort(), false);
    fireEvent.mouseEnter(inputPort());
    expect(inputLabel()).not.toBeNull();
    const without = node();
    without.contract = { ...without.contract!, inputs: [] };
    rerender(<TilePorts node={without} wiring={wiring()} />);
    expect(screen.queryByRole('button', { name: /输入端口 用户需求/ })).toBeNull();
    rerender(<TilePorts node={node()} wiring={wiring()} />);
    room(inputPort(), false);
    expect(inputLabel()).toBeNull();
  });

  it('names the ports a dragged wire may end on while the drag lasts', () => {
    const drag = (side: 'input' | 'output' | null) => ({ ...wiring(),
      wireDrag: side ? { from: { nodeId: 'other', portId: 'out:x' }, side, world: { x: 0, y: 0 } } : null });
    const { rerender } = render(<TilePorts node={node()} wiring={drag(null)} />, { container: stage });
    room(inputPort(), false);
    room(outputPort(), false);
    expect(inputLabel()).toBeNull();
    expect(outputLabel()).toBeNull();
    rerender(<TilePorts node={node()} wiring={drag('output')} />);
    expect(inputLabel()!.style.left).toBe('18px');
    expect(outputLabel()).toBeNull();
    rerender(<TilePorts node={node()} wiring={drag(null)} />);
    expect(inputLabel()).toBeNull();
  });

  it('draws an output port\'s label inside on its own side, and Escape puts a shown label away without passing the key on', () => {
    const escapes = vi.fn();
    window.addEventListener('keydown', escapes);
    try {
      render(<TilePorts node={node()} wiring={wiring()} />, { container: stage });
      room(outputPort(), false);
      expect(outputLabel()).toBeNull();
      act(() => outputPort().focus());
      // An output port is on the tile's right edge: inside, its label sits left of the handle.
      expect(outputLabel()!.style.right).toBe('18px');
      expect(outputLabel()!.style.left).toBe('');
      fireEvent.keyDown(outputPort(), { key: 'Escape' });
      expect(outputLabel()).toBeNull();
      expect(escapes).not.toHaveBeenCalled();
      // Nothing shown now: the next Escape is the canvas's.
      fireEvent.keyDown(outputPort(), { key: 'Escape' });
      expect(escapes).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', escapes);
    }
  });
});

describe('field label room beside a panel lying over the stage', () => {
  it('judges each side\'s room without what a panel covers, and makes anew only the observer of the side that changed', () => {
    const observers: { init: IntersectionObserverInit; targets: Element[] }[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      private readonly entry: { init: IntersectionObserverInit; targets: Element[] };
      constructor(_callback: IntersectionObserverCallback, init: IntersectionObserverInit) {
        this.entry = { init, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve(target: Element) { this.entry.targets = this.entry.targets.filter(item => item !== target); }
      disconnect() { this.entry.targets = []; }
    });
    const stage = document.createElement('div');
    stage.className = 'canvas-root';
    document.body.appendChild(stage);
    try {
      const { rerender } = render(<TilePorts node={node()} wiring={wiring()} cover={{ left: 200, right: 300 }} />, { container: stage });
      const input = screen.getByRole('button', { name: /输入端口 用户需求/ });
      const output = screen.getByRole('button', { name: /输出端口 前端页面/ });
      const watching = (port: Element) => observers.find(item => item.targets.includes(port))!;
      // The room is 120 px at a zoom of 1; the floating assistant covers 200 px of the left edge, the configuration
      // panel 300 px of the right.
      expect(watching(input).init.rootMargin).toBe('0px 0px 0px -320px');
      expect(watching(output).init.rootMargin).toBe('0px -420px 0px 0px');
      const left = watching(input);
      rerender(<TilePorts node={node()} wiring={wiring()} cover={{ left: 200, right: 0 }} />);
      expect(watching(input)).toBe(left);
      expect(watching(output).init.rootMargin).toBe('0px -120px 0px 0px');
      rerender(<TilePorts node={node()} wiring={wiring()} cover={{ left: 200, right: 0 }} scale={1.25} />);
      expect(watching(input).init.rootMargin).toBe('0px 0px 0px -350px');
    } finally {
      stage.remove();
      vi.unstubAllGlobals();
    }
  });
});

describe('field labels: Escape, blur and drags where they must not reach', () => {
  type Watcher = { callback: IntersectionObserverCallback; init: IntersectionObserverInit; targets: Element[] };
  let observers: Watcher[] = [];
  let stage: HTMLDivElement;
  beforeEach(() => {
    observers = [];
    vi.stubGlobal('IntersectionObserver', class {
      private readonly entry: Watcher;
      constructor(callback: IntersectionObserverCallback, init: IntersectionObserverInit) {
        this.entry = { callback, init, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve(target: Element) { this.entry.targets = this.entry.targets.filter(item => item !== target); }
      disconnect() { this.entry.targets = []; }
    });
    stage = document.createElement('div');
    stage.className = 'canvas-root';
    document.body.appendChild(stage);
  });
  afterEach(() => { stage.remove(); vi.unstubAllGlobals(); });
  const noRoom = (port: Element) => act(() => observers.find(item => item.targets.includes(port))!.callback(
    [{ target: port, intersectionRatio: 0.4 } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
  const inputPort = () => screen.getByRole('button', { name: /输入端口 用户需求/ });
  const outputPort = () => screen.getByRole('button', { name: /输出端口 前端页面/ });
  const inputLabel = () => screen.queryByText('用户需求与交互说明');
  const outputLabel = () => screen.queryByText('前端页面');

  it('passes Escape on to the canvas from a focused port whose label rests outside', () => {
    const escapes = vi.fn();
    window.addEventListener('keydown', escapes);
    try {
      render(<TilePorts node={node()} wiring={wiring()} />, { container: stage });
      act(() => outputPort().focus());
      fireEvent.keyDown(outputPort(), { key: 'Escape' });
      expect(escapes).toHaveBeenCalledTimes(1);
      expect(outputLabel()).not.toBeNull();
    } finally {
      window.removeEventListener('keydown', escapes);
    }
  });

  it('leaves the hovered port its label when focus leaves another port', () => {
    render(<TilePorts node={node()} wiring={wiring()} />, { container: stage });
    noRoom(inputPort());
    noRoom(outputPort());
    act(() => inputPort().focus());
    fireEvent.mouseEnter(outputPort());
    expect(outputLabel()).not.toBeNull();
    act(() => inputPort().blur());
    expect(outputLabel()).not.toBeNull();
    expect(inputLabel()).toBeNull();
  });

  it('names no port a dragged wire cannot end on: its own node\'s, or an input that takes one wire and has it', () => {
    const drag = (from: string, wires = 0) => ({ ...wiring(), wireCount: () => wires,
      wireDrag: { from: { nodeId: from, portId: 'out:x' }, side: 'output' as const, world: { x: 0, y: 0 } } });
    const { rerender } = render(<TilePorts node={node()} wiring={drag('other')} />, { container: stage });
    noRoom(inputPort());
    expect(inputLabel()).not.toBeNull();
    rerender(<TilePorts node={node()} wiring={drag('frontend')} />);
    expect(inputLabel()).toBeNull();
    rerender(<TilePorts node={node()} wiring={drag('other', 1)} />);
    expect(inputLabel()).toBeNull();
  });

  it('reaches the ports through a card and an icon: both hand the covered edges on', () => {
    const cover = { left: 50, right: 300 };
    const watching = (port: Element) => observers.find(item => item.targets.includes(port))!;
    const card = render(<SessionTile node={node()} scale={1} focused={false} onSend={vi.fn()} portCover={cover} />, { container: stage });
    expect(watching(inputPort()).init.rootMargin).toBe('0px 0px 0px -170px');
    expect(watching(outputPort()).init.rootMargin).toBe('0px -420px 0px 0px');
    card.unmount();
    // A stage of its own: the first one's root is unmounted.
    const iconStage = document.createElement('div');
    iconStage.className = 'canvas-root';
    document.body.appendChild(iconStage);
    try {
      render(<NodeIconTile node={node()} drawn={node()} run={null} live={false} scale={1} portCover={cover}
        selected={false} soleSelected={false} tabbable />, { container: iconStage });
      expect(watching(inputPort()).init.rootMargin).toBe('0px 0px 0px -170px');
      expect(watching(outputPort()).init.rootMargin).toBe('0px -420px 0px 0px');
    } finally {
      iconStage.remove();
    }
  });
});
