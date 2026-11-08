// THE ICON VIEW'S GEOMETRY (图标视图, nodeIcons.ts). Every component drawn as its own live icon, wired as the cards are.
// What is pinned here is what a look cannot change: the preference is the person's (never the document's), an icon sits
// where its closed card's middle is, its ports and every wire end sit on its round rim, apart, on one band the wires and
// the ports share, a feedback wire's lane runs above the plate, and the board's boxes keep their identity while nothing
// changes (the memoised tiles, wires and marks re-render only for what moved).
import { describe, expect, it } from 'vitest';
import { createAssembleNode, createEditNode, createFormNode, createSessionNode, type CanvasNode } from '../src/canvas/canvasDoc';
import { configureCanvasStorage } from '../src/canvas/canvasStorage';
import {
  ICON_VIEW_KEY, loadIconView, NODE_ICON_LINE_MIN_PX, NODE_ICON_NAME_MIN_PX, NODE_ICON_WORLD, nodeIconBox, nodeIconGeometry,
  nodeIconLabelWidth, nodeIconTier, nodeIconWireBox, saveIconView, withIconGeometry,
} from '../src/canvas/nodeIcons';
import { laneTopOf, portAnchorWorld, portsFor, type WireGeometry } from '../src/canvas/ports';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    data, writes,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(`set ${key}`); data.set(key, value); },
    removeItem: (key: string) => { writes.push(`remove ${key}`); data.delete(key); },
  };
}

const session = (id: string, x = 0, y = 0, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ ...createSessionNode('llm', { x, y }), id, title: id, ...extra } as CanvasNode);

describe('the icon view as a stored view preference', () => {
  it('reads only its own exact entry, and cards for anything else', () => {
    expect(loadIconView(memoryStorage({ [ICON_VIEW_KEY]: '{"v":1,"on":true}' }))).toBe(true);
    for (const raw of ['{"v":1,"on":false}', '{"v":2,"on":true}', '{"on":true}', '{"v":1,"on":"true"}', '[1]', 'true', 'null', '{not json', '']) {
      expect(loadIconView(memoryStorage({ [ICON_VIEW_KEY]: raw })), raw).toBe(false);
    }
    expect(loadIconView(memoryStorage())).toBe(false);
    expect(loadIconView(null)).toBe(false);
    expect(loadIconView({ getItem: () => { throw new Error('denied'); } })).toBe(false);
  });

  it('writes the exact entry when on, removes it when off, and writes only on a change', () => {
    const storage = memoryStorage();
    saveIconView(true, storage);
    expect(storage.data.get(ICON_VIEW_KEY)).toBe('{"v":1,"on":true}');
    saveIconView(true, storage);
    expect(storage.writes).toEqual([`set ${ICON_VIEW_KEY}`]);
    saveIconView(false, storage);
    expect(storage.data.has(ICON_VIEW_KEY)).toBe(false);
    saveIconView(false, storage);
    expect(storage.writes).toEqual([`set ${ICON_VIEW_KEY}`, `remove ${ICON_VIEW_KEY}`]);
    // Storage that refuses keeps the page's choice (no throw).
    expect(() => saveIconView(true, { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => {} })).not.toThrow();
  });
});

describe('where an icon sits', () => {
  it('is a 112-unit square on the middle of the closed card: a session\'s compact card, any other kind at its saved size', () => {
    expect(NODE_ICON_WORLD).toBe(112);
    // A session opened or enlarged earlier (its saved w/h 900 x 600) still has its icon where its compact card's middle is.
    expect(nodeIconBox({ kind: 'session', x: 100, y: 200, w: 900, h: 600 })).toEqual({ x: 100 + 130 - 56, y: 200 + 64 - 56, w: 112, h: 112 });
    const form = createFormNode({ x: 40, y: 60 });
    expect(nodeIconBox(form)).toEqual({ x: 40 + 150 - 56, y: 60 + 100 - 56, w: 112, h: 112 });
    const edit = createEditNode({ x: -320, y: 0 });
    expect(nodeIconBox(edit)).toEqual({ x: -320 + 160 - 56, y: 120 - 56, w: 112, h: 112 });
  });
});

describe('the band its ports and wires use', () => {
  const band = (node: CanvasNode) => nodeIconWireBox(node);

  it('is centred on the icon, as tall as the busier side needs, a fifth of the icon at least and the icon at most', () => {
    const llm = session('a', 100, 200);
    const icon = nodeIconBox(llm);
    const wire = band(llm);
    // One port a side: 18 x 2.
    expect(wire).toMatchObject({ x: icon.x, w: 112, h: 36, round: true, laneTop: icon.y });
    expect(wire.y + wire.h / 2).toBeCloseTo(icon.y + 56);
    expect(band({ ...createSessionNode('image', { x: 0, y: 0 }), id: 'i' }).h).toBe(54);
    expect(band({ ...createSessionNode('video', { x: 0, y: 0 }), id: 'v' }).h).toBe(72);
    expect(band(createEditNode({ x: 0, y: 0 })).h).toBe(90);
    // Six inputs would need 126: the icon's own height caps it.
    const assemble = createAssembleNode({ x: 0, y: 0 });
    const six = { ...assemble, contract: { ...assemble.contract, inputs: Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, label: `M${index}`, type: 'text' as const, required: false, value: '' })) } };
    expect(band(six).h).toBe(112);
    // A component with no ports yet (an assemble node with an empty contract) keeps a band a fifth of the icon tall.
    const bare = { ...assemble, id: 'bare', contract: { ...assemble.contract, inputs: [], outputs: [] } };
    expect(portsFor(bare)).toEqual([]);
    expect(band(bare).h).toBeCloseTo(112 / 5);
    // The node keeps everything else it is (its kind, its ports): only its box is the band's.
    expect(wire.id).toBe('a');
    expect(portsFor(wire)).toEqual(portsFor(llm));
  });

  it('puts every port on the rim, inputs on the left and outputs on the right, at least 16 apart for up to five a side', () => {
    const assemble = createAssembleNode({ x: 0, y: 0 });
    const shapes: CanvasNode[] = [session('s'), { ...createSessionNode('video', { x: 0, y: 0 }), id: 'v' }, createFormNode({ x: 0, y: 0 }), createEditNode({ x: 0, y: 0 }),
      ...[1, 2, 3, 4, 5].map(count => ({ ...assemble, id: `as${count}`, contract: { ...assemble.contract,
        inputs: Array.from({ length: count }, (_, index) => ({ id: `m${index}`, label: `M${index}`, type: 'text' as const, required: false, value: '' })) } }))];
    for (const node of shapes) {
      const wire = band(node);
      const cx = wire.x + wire.w / 2;
      const cy = wire.laneTop! + 56;
      for (const side of ['input', 'output'] as const) {
        const anchors = portsFor(node).filter(port => port.side === side).map(port => portAnchorWorld(wire, port.id)!);
        for (const anchor of anchors) {
          expect(Math.hypot(anchor.x - cx, anchor.y - cy), `${node.id} ${side}`).toBeCloseTo(56, 0);
          expect(side === 'input' ? anchor.x < cx : anchor.x > cx).toBe(true);
        }
        for (let index = 1; index < anchors.length; index++) {
          expect(Math.hypot(anchors[index].x - anchors[index - 1].x, anchors[index].y - anchors[index - 1].y), `${node.id} ${side} ${index}`).toBeGreaterThanOrEqual(16);
        }
      }
    }
  });

  it('runs a feedback wire\'s lane above the plate, as above a card; a card\'s own box is unchanged', () => {
    const node = session('a', 100, 200);
    expect(laneTopOf(band(node))).toBe(nodeIconBox(node).y);
    expect(laneTopOf(node)).toBe(200);
    // A card (no `round`) keeps its ports on its edges.
    const card = { ...node, w: 260, h: 128 };
    expect(portAnchorWorld(card, 'context')).toEqual({ x: 100, y: 264 });
    expect(portAnchorWorld(card, 'result')).toEqual({ x: 360, y: 264 });
    expect(portAnchorWorld({ ...card, round: false } as CanvasNode & WireGeometry, 'result')).toEqual({ x: 360, y: 264 });
  });
});

describe('the board\'s boxes', () => {
  it('keep one geometry per node object, and a new one only for a changed node', () => {
    const node = session('a', 100, 200);
    const first = nodeIconGeometry(node);
    expect(nodeIconGeometry(node)).toBe(first);
    expect(first.wire).toBe(nodeIconGeometry(node).wire);
    expect(first.plate).toMatchObject({ id: 'a', ...nodeIconBox(node), round: true });
    const moved = { ...node, x: 140 };
    expect(nodeIconGeometry(moved)).not.toBe(first);
    expect(nodeIconGeometry(moved).icon.x).toBe(first.icon.x + 40);
  });

  it('hand back the very array while nothing is an icon, and only the icons\' boxes otherwise', () => {
    const nodes = [session('a', 0, 0), session('b', 400, 0), session('c', 800, 0)];
    expect(withIconGeometry(nodes, new Set(), 'wire')).toBe(nodes);
    expect(withIconGeometry(nodes, new Set(), 'plate')).toBe(nodes);
    const icons = new Set(['b']);
    const wires = withIconGeometry(nodes, icons, 'wire');
    expect(wires[0]).toBe(nodes[0]);
    expect(wires[2]).toBe(nodes[2]);
    expect(wires[1]).toBe(nodeIconGeometry(nodes[1]).wire);
    const plates = withIconGeometry(nodes, icons, 'plate');
    expect(plates[1]).toBe(nodeIconGeometry(nodes[1]).plate);
    // The same objects again for the same nodes: the wires and the marks see no change.
    expect(withIconGeometry(nodes, icons, 'wire')[1]).toBe(wires[1]);
  });
});

describe('the rows under an icon', () => {
  it('may be no wider than the card the icon replaces, so two icons\' rows cannot meet', () => {
    // A session's icon stands on its compact card (260 wide), whatever its saved size: an enlarged one does not give
    // its rows more room than the card they replace.
    expect(nodeIconLabelWidth({ kind: 'session', w: 900 })).toBe(260);
    expect(nodeIconLabelWidth({ kind: 'session', w: 260 })).toBe(260);
    const form = createFormNode({ x: 0, y: 0 });
    expect(nodeIconLabelWidth(form)).toBe(form.w);
    const assemble = createAssembleNode({ x: 0, y: 0 });
    expect(nodeIconLabelWidth(assemble)).toBe(assemble.w);
    const edit = createEditNode({ x: 0, y: 0 });
    expect(nodeIconLabelWidth(edit)).toBe(edit.w);
    // Two cards side by side do not overlap, so neither do rows no wider than them: the gap between the icons' middles
    // is at least the two half-widths.
    const left = session('a', 0, 0);
    const right = session('b', 500, 0);
    const gap = (nodeIconBox(right).x + 56) - (nodeIconBox(left).x + 56);
    expect(gap).toBeGreaterThanOrEqual((nodeIconLabelWidth(left) + nodeIconLabelWidth(right)) / 2);
    // The geometry carries it, memoised with the rest.
    const geometry = nodeIconGeometry(left);
    expect(geometry.labelWidth).toBe(260);
    expect(nodeIconGeometry(left).labelWidth).toBe(geometry.labelWidth);
    expect(nodeIconGeometry(form).labelWidth).toBe(form.w);
  });

  it('shows nothing under 20 px on screen, the name from there, and the state line from 44 px', () => {
    expect([NODE_ICON_NAME_MIN_PX, NODE_ICON_LINE_MIN_PX]).toEqual([20, 44]);
    expect(nodeIconTier(19.9 / 112)).toBe('S');
    expect(nodeIconTier(20 / 112)).toBe('M');
    // A canvas fitted on screen (24 %: a 27 px icon) is named.
    expect(nodeIconTier(.24)).toBe('M');
    expect(nodeIconTier(43.9 / 112)).toBe('M');
    expect(nodeIconTier(44 / 112)).toBe('L');
    expect(nodeIconTier(1)).toBe('L');
    // A zoom that is not a number reads as 100 %.
    expect(nodeIconTier(Number.NaN)).toBe('L');
    expect(nodeIconTier(0)).toBe('L');
  });
});

// Last in this file: it scopes the canvas storage for the rest of the file's module.
describe('the preference\'s place', () => {
  it('is kept per person, workspace and canvas, beside the canvas cache', () => {
    const storage = memoryStorage();
    configureCanvasStorage('user-0001', 'tenant-0001', 'canvas-0001');
    saveIconView(true, storage);
    expect([...storage.data.keys()]).toEqual([`awwo.saas:user-0001:tenant-0001:canvas-0001:${ICON_VIEW_KEY}`]);
    expect(loadIconView(storage)).toBe(true);
    // Another canvas of the same person is drawn as cards until it is turned on there.
    configureCanvasStorage('user-0001', 'tenant-0001', 'canvas-0002');
    expect(loadIconView(storage)).toBe(false);
  });
});
