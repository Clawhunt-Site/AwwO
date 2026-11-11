import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMemo, useRef } from 'react';
import { TilePorts, useWiring, type WiringApi } from '../src/canvas/TilePorts';
import { SessionTile } from '../src/canvas/SessionTile';
import { NodeIconTile } from '../src/canvas/NodeIconTile';
import { createSessionNode, type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import type { ContractFieldType } from '../src/canvas/nodeContracts';
import type { PortSpec } from '../src/canvas/ports';

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
  return { pendingPort: null, wireDrag: null, interactive: true, wireCount: () => 0, canEndDrag: () => false,
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

  it('names the ports the wiring says a dragged wire may end on, while the drag lasts', () => {
    const asked: [string, string][] = [];
    // A stand-in for the wiring's answer (the real one asks canConnect, below): every port of the other side.
    const drag = (side: 'input' | 'output' | null) => ({ ...wiring(),
      wireDrag: side ? { from: { nodeId: 'other', portId: 'out:x' }, side, world: { x: 0, y: 0 } } : null,
      canEndDrag: (nodeId: string, port: PortSpec) => { asked.push([nodeId, port.id]); return side !== null && port.side !== side; } });
    const { rerender } = render(<TilePorts node={node()} wiring={drag(null)} />, { container: stage });
    room(inputPort(), false);
    room(outputPort(), false);
    expect(inputLabel()).toBeNull();
    expect(outputLabel()).toBeNull();
    // Nothing dragged: nothing asked.
    expect(asked).toEqual([]);
    rerender(<TilePorts node={node()} wiring={drag('output')} />);
    expect(inputLabel()!.style.left).toBe('18px');
    expect(outputLabel()).toBeNull();
    expect(asked).toContainEqual(['frontend', 'in:private_input_id']);
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

  it('names no port the wiring says a dragged wire cannot end on, and none on an inert board', () => {
    const drag = (ends: boolean, interactive = true) => ({ ...wiring(), interactive, canEndDrag: () => ends,
      wireDrag: { from: { nodeId: 'other', portId: 'out:x' }, side: 'output' as const, world: { x: 0, y: 0 } } });
    const { rerender } = render(<TilePorts node={node()} wiring={drag(true)} />, { container: stage });
    noRoom(inputPort());
    expect(inputLabel()).not.toBeNull();
    rerender(<TilePorts node={node()} wiring={drag(false)} />);
    expect(inputLabel()).toBeNull();
    // A run starts mid-drag, or the board turns read-only: its ports are inert and name nothing.
    rerender(<TilePorts node={node()} wiring={drag(true, false)} />);
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

// What a drag names is the wiring's own judgement (useWiring, with canConnect), the one its release acts on: every
// port without room beside it here, so a label is drawn only while a dragged wire may end on its port.
describe('the ports a dragged wire may end on, as the wiring judges them', () => {
  let observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
  let stage: HTMLDivElement;
  beforeEach(() => {
    observers = [];
    vi.stubGlobal('IntersectionObserver', class {
      private readonly entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, targets: [] };
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
  afterEach(() => {
    stage.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, 'elementFromPoint');
  });
  type Field = [id: string, label: string, type: ContractFieldType];
  const contractNode = (id: string, x: number, inputs: Field[], outputs: Field[]): SessionNode => ({
    ...createSessionNode('coding', { x, y: 0 }), id, w: 400, h: 420,
    contract: { version: 1,
      inputs: inputs.map(([field, label, type]) => ({ id: field, label, type, required: true, value: '' })),
      outputs: outputs.map(([field, label, type]) => ({ id: field, label, type, required: true, value: '' })) },
  });
  // The scorer takes a number and gives a number and a file; the writer takes words, a number and a file and gives
  // words; the counter gives a number. The painter is an image node: it has no fields, so no labels of its own, and its
  // result is a picture, which canFeed lets feed words.
  const SCORER = contractNode('scorer', 0, [['seed', '种子', 'number']], [['score', '评分', 'number'], ['sheet', '评分表', 'file']]);
  const WRITER = contractNode('writer', 600, [['brief', '写作要求', 'markdown'], ['count', '字数', 'number'], ['notes', '参考文件', 'file']],
    [['draft', '初稿', 'markdown']]);
  const COUNTER = contractNode('counter', 1200, [], [['n', '计数', 'number']]);
  const PAINTER: SessionNode = { ...createSessionNode('image', { x: 1800, y: 0 }), id: 'painter' };
  // The writer's number input already takes the counter's number: an input that takes one wire, and has it.
  const COUNTED: CanvasEdge = { id: 'counter:out:n->writer:in:count', fromNode: 'counter', fromPort: 'out:n', toNode: 'writer',
    toPort: 'in:count', dataType: 'number' };
  function Board({ nodes, edges, onConnect }: { nodes: SessionNode[]; edges: CanvasEdge[]; onConnect: () => void }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const view = useMemo(() => ({ x: 0, y: 0, scale: 1 }), []);
    const wiring = useWiring({ nodes, edges, onConnect, rootRef, view });
    return <div ref={rootRef}><div className="canvas-viewport">
      {nodes.map(node => <TilePorts key={node.id} node={node} wiring={wiring} />)}
    </div></div>;
  }
  const port = (nodeId: string, portId: string) => stage.querySelector(`[data-node-id="${nodeId}"][data-port-id="${portId}"]`)!;
  // The ports of the nodes with fields: only those have labels (each one's room is watched).
  const fieldPorts = () => [...stage.querySelectorAll('.canvas-port')].filter(each => observers.some(item => item.targets.includes(each)));
  const named = () => [...stage.querySelectorAll('.canvas-port-field-label')].map(label => label.textContent);
  const draw = (nodes = [SCORER, WRITER], edges: CanvasEdge[] = [], onConnect = vi.fn()) => {
    render(<Board nodes={nodes} edges={edges} onConnect={onConnect} />, { container: stage });
    for (const each of fieldPorts()) {
      act(() => observers.find(item => item.targets.includes(each))!.callback(
        [{ target: each, intersectionRatio: 0.4 } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    }
    return onConnect;
  };
  const dragFrom = (nodeId: string, portId: string) => {
    fireEvent.pointerDown(port(nodeId, portId), { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 40, clientY: 0 });
  };
  const cancel = () => fireEvent.pointerCancel(window, { pointerId: 1 });

  it('names, of another node, only the ports of the dragged one\'s data type on the other side', () => {
    draw();
    expect(named()).toEqual([]);
    dragFrom('scorer', 'out:score');
    // Not 写作要求 (words) or 参考文件 (a file), not the scorer's own 种子, not an output.
    expect(named()).toEqual(['字数']);
    cancel();
    expect(named()).toEqual([]);
    dragFrom('scorer', 'out:sheet');
    expect(named()).toEqual(['参考文件']);
    cancel();
    // Dragged back from an input: the outputs that may feed it.
    dragFrom('writer', 'in:count');
    expect(named()).toEqual(['评分']);
    cancel();
    dragFrom('writer', 'in:brief');
    expect(named()).toEqual([]);
    cancel();
  });

  it('names a words input for a media node\'s result, which canFeed lets feed words, and no input of another type', () => {
    draw([SCORER, WRITER, PAINTER]);
    dragFrom('painter', 'result');
    // A picture: into words, as canFeed allows a media node's result; not into a number or a file.
    expect(named()).toEqual(['写作要求']);
    cancel();
    // The writer's words may feed the painter's words, but the painter has no fields to name.
    dragFrom('writer', 'out:draft');
    expect(named()).toEqual([]);
    cancel();
  });

  it('names no input that takes one wire and has it, whichever node feeds it', () => {
    draw([SCORER, WRITER, COUNTER], [COUNTED]);
    // The writer's number input has the counter's wire, so the scorer's number may not end there.
    dragFrom('scorer', 'out:score');
    expect(named()).toEqual([]);
    cancel();
    // The counter's own wire is there already; the scorer's number input is free.
    dragFrom('counter', 'out:n');
    expect(named()).toEqual(['种子']);
    cancel();
    // Dragged back from the input that has its wire: any wire it would make lands on an input that has one.
    dragFrom('writer', 'in:count');
    expect(named()).toEqual([]);
    cancel();
  });

  it('names exactly the ports where letting go reports a wire, on a board with a wire and a media node', () => {
    // As canConnect judges it: the board itself may still refuse a wire for a moment (a setup, a node streaming), and
    // then its ports are mostly inert, so they name nothing.
    const onConnect = draw([SCORER, WRITER, COUNTER, PAINTER], [COUNTED]);
    const found: Record<string, number> = {};
    const starts = [['scorer', 'out:score'], ['scorer', 'out:sheet'], ['writer', 'in:count'], ['writer', 'in:brief'], ['writer', 'out:draft'],
      ['painter', 'result'], ['counter', 'out:n']];
    for (const [nodeId, portId] of starts) {
      const start = `${nodeId} ${portId}`;
      found[start] = 0;
      for (const target of fieldPorts()) {
        dragFrom(nodeId, portId);
        const label = target.querySelector('.canvas-port-field-label');
        if (label) found[start] += 1;
        onConnect.mockClear();
        Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 0 });
        expect([`${start} -> ${target.getAttribute('data-node-id')} ${target.getAttribute('data-port-id')}`, onConnect.mock.calls.length])
          .toEqual([expect.any(String), label ? 1 : 0]);
      }
    }
    // The scorer's number has no free input of its kind and the writer's number input has its wire; only the painter
    // feeds the writer's words, and it has no field; nothing with fields takes words. Every drop ended its drag.
    expect(found).toEqual({ 'scorer out:score': 0, 'scorer out:sheet': 1, 'writer in:count': 0, 'writer in:brief': 0,
      'writer out:draft': 0, 'painter result': 1, 'counter out:n': 1 });
    expect(named()).toEqual([]);
  });
});
