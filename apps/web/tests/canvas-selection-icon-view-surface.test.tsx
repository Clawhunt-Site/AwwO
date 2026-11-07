// THE ICON VIEW ON THE REAL SURFACE (图标视图). Every component drawn as its own live icon, wired as the cards are, behind a
// toggle beside 收敛成一个图标. What is pinned here is what no look may change: it is a way of looking (the document never
// changes; the open or configured node stays its card; converged groups stay their icons), the icons are the cards'
// stand-ins for every hand on the board (a drag moves the node, a double-click opens it and adds nothing, Delete with the
// keyboard's focus on one deletes its node), the wires end on the icons' rims, the keyboard keeps one tab stop and never
// loses its focus to the page, and 多人同屏's marks ring each icon's round plate.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createFormNode, createSessionNode, type CanvasDocument, type CanvasEdge, type CanvasNode } from '../src/canvas/canvasDoc';
import { CONVERGED_GROUPS_KEY } from '../src/canvas/convergedGroups';
import { canvasText } from '../src/canvas/i18n';
import type { CanvasMultiplayerHost } from '../src/canvas/multiplayer/host';
import { boardBoxOf, MultiplayerBoardLayer } from '../src/canvas/multiplayer/MultiplayerBoardLayer';
import type { LiveParticipant, LiveState } from '../src/canvas/multiplayer/types';
import { ICON_VIEW_KEY, nodeIconBox, nodeIconWireBox } from '../src/canvas/nodeIcons';
import { portAnchorWorld } from '../src/canvas/ports';
import { resetAllSessions } from '../src/canvas/sessions';
import { WirePlane } from '../src/canvas/WirePlane';

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const zh = (key: Parameters<typeof canvasText>[1], values?: Record<string, string | number>) => canvasText('zh', key, values);
const wire = (from: string, to: string): CanvasEdge => ({ id: `${from}:result->${to}:context`, fromNode: from, fromPort: 'result', toNode: to, toPort: 'context', dataType: 'text' });
const at = (id: string, title: string, x: number, y: number): CanvasNode => ({ ...createSessionNode('llm', { x, y }), id, title });

function seed(): CanvasDocument {
  return {
    version: 2,
    updatedAt: 1,
    nodes: [at('a', '甲', 100, 100), at('b', '乙', 500, 100), at('c', '丙', 500, 400), at('d', '丁', 900, 250)],
    edges: [wire('a', 'b'), wire('a', 'c'), wire('b', 'c'), wire('c', 'd')],
    waypoints: [],
    view: { x: 0, y: 0, scale: 1 },
  };
}
const ICONS_ON = JSON.stringify({ v: 1, on: true });
const storedDoc = () => JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
const cards = () => [...document.querySelectorAll<HTMLElement>('.canvas-tile[data-node-id]')].map(tile => tile.dataset.nodeId!).sort();
const icons = () => [...document.querySelectorAll<HTMLElement>('[data-node-icon]')].map(icon => icon.dataset.nodeIcon!).sort();
const hitOf = (id: string) => screen.getByTestId(`node-icon-${id}`).querySelector<HTMLElement>('.awwo-node-icon-hit')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[data-icon-view-toggle]')!;
const announced = () => screen.getByTestId('converged-announcer').textContent?.trim();
/** The first point of a wire's path: where it leaves its source. */
const start = (d: string) => { const [, x, y] = /^M (\S+) (\S+)/.exec(d)!; return { x: Number(x), y: Number(y) }; };

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});

describe('the toggle', () => {
  it('draws every component as its icon and back, says so in the board\'s status region, and keeps the focus', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(cards()).toEqual(['a', 'b', 'c', 'd']));
    const button = toggle();
    expect(button.getAttribute('aria-label')).toBe(zh('nodeIcon.toggle'));
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.title).toBe(zh('nodeIcon.toggleTitle'));
    expect(button.disabled).toBe(false);
    // Beside 收敛成一个图标, in the view tools.
    expect(button.previousElementSibling?.hasAttribute('data-converge-toggle')).toBe(true);
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c', 'd']));
    expect(cards()).toEqual([]);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toBe(zh('nodeIcon.toggleTitleOn'));
    // Its name is fixed: aria-pressed says which way it is.
    expect(button.getAttribute('aria-label')).toBe(zh('nodeIcon.toggle'));
    expect(document.activeElement).toBe(button);
    expect(announced()).toBe(zh('nodeIcon.announce.on'));
    fireEvent.click(button);
    await waitFor(() => expect(cards()).toEqual(['a', 'b', 'c', 'd']));
    expect(icons()).toEqual([]);
    expect(document.activeElement).toBe(button);
    expect(announced()).toBe(zh('nodeIcon.announce.off'));
    // A way of looking: the document is as it was.
    await waitFor(() => expect(storedDoc().nodes.map(node => [node.id, node.x, node.y])).toEqual(seed().nodes.map(node => [node.id, node.x, node.y])));
    expect(storedDoc().edges).toHaveLength(4);
  });

  it('is kept for this person and canvas once it settles, and let go when off', async () => {
    const view = render(<CanvasSurface />);
    await waitFor(() => expect(cards()).toHaveLength(4));
    fireEvent.click(toggle());
    expect(localStorage.getItem(ICON_VIEW_KEY)).toBeNull();
    await waitFor(() => expect(localStorage.getItem(ICON_VIEW_KEY)).toBe(ICONS_ON));
    view.unmount();
    // Opened again, the canvas is drawn as icons from its first frame of cards on.
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c', 'd']));
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle());
    await waitFor(() => expect(localStorage.getItem(ICON_VIEW_KEY)).toBeNull());
  });

  it('is greyed out, with the reason, while the whole canvas is one icon, and the icon view comes back with the cards', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: true, groups: [] }));
    render(<CanvasSurface />);
    await screen.findByTestId('converged-icon-canvas');
    expect(icons()).toEqual([]);
    expect(cards()).toEqual([]);
    expect(toggle().disabled).toBe(true);
    expect(toggle().title).toBe(zh('nodeIcon.toggleConverged'));
    // The preference is still this person's: it is drawn again once the canvas is expanded.
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-converge-toggle]')!);
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c', 'd']));
    expect(toggle().disabled).toBe(false);
  });
});

describe('icons on the board', () => {
  it('keeps converged groups as their icons and draws the other components as theirs', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: false, groups: [{ id: 'g', members: ['b', 'c'] }] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toEqual(['a', 'd']));
    expect(screen.getByTestId('converged-icon-g')).toBeTruthy();
    expect(cards()).toEqual([]);
    // A wire into the group still ends on its icon, and one from a component on that component's rim.
    const d = screen.getByTestId('canvas-wire-a:result->b:context').getAttribute('d')!;
    expect(start(d)).toEqual(portAnchorWorld(nodeIconWireBox(seed().nodes[0]), 'result'));
  });

  it('ends every wire on the icons\' rims, on the band their ports sit on', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    const byId = new Map(seed().nodes.map(node => [node.id, node]));
    for (const edge of seed().edges) {
      const d = screen.getByTestId(`canvas-wire-${edge.id}`).getAttribute('d')!;
      const from = portAnchorWorld(nodeIconWireBox(byId.get(edge.fromNode)!), edge.fromPort)!;
      const to = portAnchorWorld(nodeIconWireBox(byId.get(edge.toNode)!), edge.toPort)!;
      expect(start(d)).toEqual(from);
      expect(d.endsWith(`${to.x} ${to.y}`)).toBe(true);
    }
    // Each icon's own handle sits where its wire leaves (the band's coordinates plus the band's place on the plate).
    const icon = screen.getByTestId('node-icon-a');
    const band = icon.querySelector<HTMLElement>('.awwo-node-icon-ports')!;
    const port = band.querySelector<HTMLElement>('.canvas-port[data-port-id="result"]')!;
    const anchor = portAnchorWorld(nodeIconWireBox(byId.get('a')!), 'result')!;
    const box = nodeIconBox(byId.get('a')!);
    expect(box.x + Number.parseFloat(port.style.left)).toBeCloseTo(anchor.x);
    expect(box.y + Number.parseFloat(band.style.top) + Number.parseFloat(port.style.top)).toBeCloseTo(anchor.y);
  });

  it('runs a feedback wire\'s lane above the icons, as above cards', () => {
    const a = nodeIconWireBox(at('a', '甲', 100, 100));
    const b = nodeIconWireBox(at('b', '乙', 500, 400));
    const feedback: CanvasEdge = { ...wire('b', 'a'), id: 'fb', kind: 'feedback' };
    render(<div><WirePlane nodes={[a, b]} edges={[feedback]} /></div>);
    // 52 above the higher plate (the icons' tops, not their bands' or their ports'), from the source's shoulder to the
    // target's.
    const lane = Math.min(a.laneTop!, b.laneTop!) - 52;
    const from = portAnchorWorld(b, 'result')!;
    const to = portAnchorWorld(a, 'context')!;
    expect(lane).toBe(108 - 52);
    expect(screen.getByTestId('canvas-wire-fb').getAttribute('d')).toBe(`M ${from.x} ${from.y} C ${from.x + 48} ${from.y}, ${from.x + 48} ${lane}, ${from.x + 48} ${lane} L ${to.x - 48} ${lane} C ${to.x - 48} ${lane}, ${to.x - 48} ${to.y}, ${to.x} ${to.y}`);
  });

  it('opens a component as its card on a double-click, adds no node, and takes the focus in and back out', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    fireEvent.doubleClick(hitOf('b'));
    await waitFor(() => expect(cards()).toEqual(['b']));
    expect(icons()).toEqual(['a', 'c', 'd']);
    // Not the board's double-click (which adds a node).
    expect(cards().length + icons().length).toBe(4);
    const close = screen.getByTestId('canvas-tile-b').querySelector<HTMLElement>('[data-collapse-node]')!;
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.click(close);
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c', 'd']));
    await waitFor(() => expect(document.activeElement).toBe(hitOf('b')));
    // Enter on an icon opens it as well, and Escape closes it back to its icon.
    act(() => hitOf('c').focus());
    fireEvent.keyDown(hitOf('c'), { key: 'Enter' });
    await waitFor(() => expect(cards()).toEqual(['c']));
    await waitFor(() => expect(document.activeElement?.closest('[data-node-id="c"]')).toBeTruthy());
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c', 'd']));
    await waitFor(() => expect(document.activeElement).toBe(hitOf('c')));
    await waitFor(() => expect(storedDoc().nodes).toHaveLength(4));
  });

  it('moves a component by a drag of its icon', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    fireEvent.pointerDown(hitOf('a'), { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 20, clientY: 10 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 40, clientY: 30 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 30 });
    await waitFor(() => expect(storedDoc().nodes.find(node => node.id === 'a')).toMatchObject({ x: 140, y: 130 }));
    // Its icon went with it.
    const moved = nodeIconBox({ ...seed().nodes[0], x: 140, y: 130 });
    expect(screen.getByTestId('node-icon-a').style.left).toBe(`${moved.x}px`);
    expect(screen.getByTestId('node-icon-a').classList.contains('canvas-tile--selected')).toBe(true);
  });
});

describe('the keyboard among icons', () => {
  it('reaches one icon by Tab (the selected one, else the first in reading order), and steps on with ⌘[ ]', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    const stops = () => [...document.querySelectorAll<HTMLElement>('.awwo-node-icon-hit')].filter(hit => hit.tabIndex === 0)
      .map(hit => hit.closest<HTMLElement>('[data-node-icon]')!.dataset.nodeIcon);
    expect(stops()).toEqual(['a']);
    fireEvent.pointerDown(hitOf('c'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    await waitFor(() => expect(stops()).toEqual(['c']));
    // The focus that comes to an icon selects it; ⌘] takes the focus on with the selection.
    act(() => hitOf('a').focus());
    await waitFor(() => expect(screen.getByTestId('node-icon-a').classList.contains('canvas-tile--selected')).toBe(true));
    fireEvent.keyDown(window, { key: ']', ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(hitOf('b')));
    expect(screen.getByTestId('node-icon-b').classList.contains('canvas-tile--selected')).toBe(true);
  });

  it('deletes the component whose icon has the focus, and gives the focus to the next icon, then to the toggle', async () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), nodes: seed().nodes.slice(0, 2), edges: [wire('a', 'b')] }));
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toEqual(['a', 'b']));
    act(() => hitOf('a').focus());
    await waitFor(() => expect(screen.getByTestId('node-icon-a').classList.contains('canvas-tile--selected')).toBe(true));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(icons()).toEqual(['b']));
    expect(document.activeElement).toBe(hitOf('b'));
    await waitFor(() => expect(storedDoc().nodes.map(node => node.id)).toEqual(['b']));
    expect(storedDoc().edges).toEqual([]);
    await waitFor(() => expect(screen.getByTestId('node-icon-b').classList.contains('canvas-tile--selected')).toBe(true));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(icons()).toEqual([]));
    expect(document.activeElement).toBe(toggle());
  });

  it('deletes once for a Delete held down, keeps a group the focus comes into, and lets Tab reach the ports of the stop alone', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    // The ports of the one stop are reached by Tab after its button; every other icon's wait for it to be the stop.
    const tabbablePorts = () => [...document.querySelectorAll<HTMLElement>('[data-node-icon] .canvas-port')].filter(port => port.tabIndex === 0)
      .map(port => port.closest<HTMLElement>('[data-node-icon]')!.dataset.nodeIcon);
    expect(new Set(tabbablePorts())).toEqual(new Set(['a']));
    // A group selected with the pointer stays selected when the keyboard's focus comes to one of its icons.
    fireEvent.pointerDown(hitOf('b'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.pointerDown(hitOf('c'), { button: 0, pointerId: 2, shiftKey: true });
    fireEvent.pointerUp(window, { pointerId: 2, shiftKey: true });
    const chosen = () => icons().filter(id => screen.getByTestId(`node-icon-${id}`).classList.contains('canvas-tile--selected'));
    await waitFor(() => expect(chosen()).toEqual(['b', 'c']));
    await new Promise(resolve => setTimeout(resolve, 0));
    act(() => hitOf('b').focus());
    expect(chosen()).toEqual(['b', 'c']);
    // Held down, Delete deletes the selection once; its repeats delete nothing more.
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(icons()).toEqual(['a', 'd']));
    for (let repeat = 0; repeat < 5; repeat++) fireEvent.keyDown(window, { key: 'Delete', repeat: true });
    fireEvent.keyDown(window, { key: 'Backspace', repeat: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(icons()).toEqual(['a', 'd']);
    await waitFor(() => expect(storedDoc().nodes.map(node => node.id)).toEqual(['a', 'd']));
  });

  it('gives the focus on when the focused icon goes another way (a redo of its deletion), and never takes it from elsewhere', async () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), nodes: seed().nodes.slice(0, 3), edges: [] }));
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c']));
    const undoKey = (shift = false) => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true });
    act(() => hitOf('b').focus());
    await waitFor(() => expect(screen.getByTestId('node-icon-b').classList.contains('canvas-tile--selected')).toBe(true));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(icons()).toEqual(['a', 'c']));
    undoKey();
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c']));
    act(() => hitOf('b').focus());
    // The redo takes b away again, not a deletion of this page's: the focus goes on to the next icon in reading order.
    undoKey(true);
    await waitFor(() => expect(icons()).toEqual(['a', 'c']));
    expect(document.activeElement).toBe(hitOf('c'));
    // With the focus taken elsewhere (the toggle), an icon going leaves it there.
    undoKey();
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c']));
    act(() => hitOf('b').focus());
    act(() => toggle().focus());
    undoKey(true);
    await waitFor(() => expect(icons()).toEqual(['a', 'c']));
    expect(document.activeElement).toBe(toggle());
  });
});

describe('the focus and the camera on a measured stage', () => {
  // jsdom measures nothing: the board's root is given a stage of 800 x 600 (as canvas-surface-fit does) and the camera
  // stays at 100 % from the origin (the seed's), so world and screen coordinates are the same.
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) }) as DOMRect;
  function stubStage(own: (element: Element) => DOMRect | null = () => null) {
    const real = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return own(this) ?? (this.classList.contains('canvas-root') ? rect(0, 0, 800, 600) : real.call(this));
    });
  }
  const camera = () => {
    const [, x, y, scale] = /^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/.exec(document.querySelector<HTMLElement>('.canvas-world')!.style.transform)!;
    return [Number(x), Number(y), Number(scale)];
  };

  it('takes the camera to an icon the keyboard focuses off the stage, and never for a press', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    // d's icon lies right of the stage (its plate from 974 to 1086).
    stubStage(element => element.classList.contains('awwo-node-icon-hit') && element.closest('[data-node-icon="d"]') ? rect(974, 258, 112, 112) : null);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    const start = camera();
    // A press's focus is the press's: the camera stays (a port at the stage's edge can be pressed).
    fireEvent.pointerDown(hitOf('d'), { button: 0, pointerId: 1 });
    act(() => hitOf('d').focus());
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(camera()).toEqual(start);
    act(() => hitOf('a').focus());
    await new Promise(resolve => setTimeout(resolve, 650));
    // The keyboard's: the camera centres the icon on the stage.
    act(() => hitOf('d').focus());
    await waitFor(() => expect(camera()).not.toEqual(start));
    const [x, y, scale] = camera();
    const plate = nodeIconBox(seed().nodes[3]);
    expect(x + (plate.x + 56) * scale).toBeCloseTo(400, 0);
    expect(y + (plate.y + 56) * scale).toBeCloseTo(300, 0);
  });

  it('gives the focus on to the next icon on the stage when the focused one goes, and leaves the camera', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    stubStage();
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    const start = camera();
    act(() => hitOf('b').focus());
    await waitFor(() => expect(screen.getByTestId('node-icon-b').classList.contains('canvas-tile--selected')).toBe(true));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(icons()).toEqual(['a', 'c', 'd']));
    // After b in reading order comes d (its row, right of the stage), then c, the next one on the stage.
    expect(document.activeElement).toBe(hitOf('c'));
    expect(camera()).toEqual(start);
  });
});

describe('the focus beside the board', () => {
  const undoKey = (shift = false) => fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true });

  it('lets the icon go when the focus leaves the board, so a later loss of the page\'s focus is never filled with one', async () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), nodes: seed().nodes.slice(0, 3), edges: [] }));
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c']));
    act(() => hitOf('b').focus());
    await waitFor(() => expect(screen.getByTestId('node-icon-b').classList.contains('canvas-tile--selected')).toBe(true));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(icons()).toEqual(['a', 'c']));
    undoKey();
    await waitFor(() => expect(icons()).toEqual(['a', 'b', 'c']));
    act(() => hitOf('b').focus());
    // The focus goes to a control beside the board (the assistant's box), which then goes (greyed out while it sends).
    const beside = document.createElement('button');
    document.body.append(beside);
    act(() => beside.focus());
    act(() => beside.remove());
    expect(document.activeElement).toBe(document.body);
    undoKey(true);
    await waitFor(() => expect(icons()).toEqual(['a', 'c']));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(document.body);
  });

  it('opens and steps from the icon with the focus, not the first of a group it is in', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    // d then b selected (d first); the keyboard's focus comes to b and keeps the group.
    fireEvent.pointerDown(hitOf('d'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.pointerDown(hitOf('b'), { button: 0, pointerId: 2, shiftKey: true });
    fireEvent.pointerUp(window, { pointerId: 2, shiftKey: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    act(() => hitOf('b').focus());
    // ⌘] steps on from b (to d, next in reading order), not from d (to c).
    fireEvent.keyDown(window, { key: ']', ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(hitOf('d')));
    // ⌘E opens the icon with the focus.
    act(() => hitOf('a').focus());
    fireEvent.pointerDown(hitOf('c'), { button: 0, pointerId: 3, shiftKey: true });
    fireEvent.pointerUp(window, { pointerId: 3, shiftKey: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    act(() => hitOf('c').focus());
    fireEvent.keyDown(document, { key: 'e', code: 'KeyE', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(cards()).toEqual(['c']));
  });

  it('takes the focus into a card opened by ⌘E from a control greyed out by the opening', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    fireEvent.pointerDown(hitOf('a'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    const converge = document.querySelector<HTMLButtonElement>('[data-converge-toggle]')!;
    act(() => converge.focus());
    fireEvent.keyDown(document, { key: 'e', code: 'KeyE', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(cards()).toEqual(['a']));
    // 收敛 is greyed out while a node is open: the focus it held goes into the card, on its close button.
    expect(converge.disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('canvas-tile-a').querySelector('[data-collapse-node]')));
  });

  it('takes the focus into a form opened from its icon on its close action, which says so', async () => {
    const form = { ...createFormNode({ x: 100, y: 100 }), id: 'f', title: '需求' };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), nodes: [form, ...seed().nodes.slice(1, 3)], edges: [] }));
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    render(<CanvasSurface />);
    await waitFor(() => expect(icons()).toEqual(['b', 'c', 'f']));
    act(() => hitOf('f').focus());
    fireEvent.keyDown(hitOf('f'), { key: 'Enter' });
    fireEvent.keyUp(window, { key: 'Enter' });
    await waitFor(() => expect(cards()).toEqual(['f']));
    const close = screen.getByTestId('canvas-tile-f').querySelector<HTMLElement>('[data-collapse-node]')!;
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(close.textContent).toBe(zh('tile.collapseNode'));
    fireEvent.click(close);
    await waitFor(() => expect(icons()).toEqual(['b', 'c', 'f']));
    await waitFor(() => expect(document.activeElement).toBe(hitOf('f')));
  });
});

describe('多人同屏 over icons', () => {
  const idle = (over: Partial<LiveState> = {}): LiveState => ({ selection: [], focus: null, cursor: null, status: null, ...over });
  // Made-up participants, in the shapes the API sends (canvas_live.go).
  const SELF: LiveParticipant = { id: 'page-self-0001', kind: 'human', port: 'web', name: 'Leon', color: '#2563eb', userId: 'user-0001', role: 'member', state: idle(), since: '2026-11-07T10:00:00Z' };
  const ADA: LiveParticipant = { id: 'page-ada-00001', kind: 'human', port: 'web', name: 'Ada Lovelace', color: '#f59e0b', userId: 'user-0002', role: 'member',
    state: idle({ selection: ['a'] }), since: '2026-11-07T10:00:00Z' };
  function boardHost() {
    const calls: ReadonlyArray<CanvasNode & { round?: boolean }>[] = [];
    const host: CanvasMultiplayerHost = {
      connect: () => undefined,
      presence: () => undefined,
      boardLayer: (nodes, scale) => {
        calls.push(nodes);
        return <MultiplayerBoardLayer participants={[SELF, ADA]} selfId={SELF.id} claims={[]} flashes={[]} now={Date.parse('2026-11-07T10:00:00Z')} scale={scale} nodes={nodes.map(boardBoxOf)} />;
      },
    };
    return { host, calls };
  }

  it('hands the layer each icon at its round plate, the same array while nothing changes, and its marks ring the plate', async () => {
    localStorage.setItem(ICON_VIEW_KEY, ICONS_ON);
    const live = boardHost();
    const view = render(<CanvasSurface multiplayer={live.host} />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    await waitFor(() => expect(live.calls.at(-1)?.every(node => node.round)).toBe(true));
    for (const node of live.calls.at(-1)!) {
      const original = seed().nodes.find(item => item.id === node.id)!;
      expect({ x: node.x, y: node.y, w: node.w, h: node.h }).toEqual(nodeIconBox(original));
    }
    const mark = document.querySelector<HTMLElement>('.awwo-multiplayer-mark[data-node="a"]')!;
    expect(mark.hasAttribute('data-round')).toBe(true);
    expect(mark.hasAttribute('data-tagged')).toBe(true);
    expect(mark.style.width).toBe('112px');
    const last = live.calls.at(-1);
    view.rerender(<CanvasSurface multiplayer={live.host} />);
    expect(live.calls.at(-1)).toBe(last);
    // As cards: no round mark, at the card's box.
    fireEvent.click(toggle());
    await waitFor(() => expect(cards()).toHaveLength(4));
    await waitFor(() => expect(document.querySelector('.awwo-multiplayer-mark[data-node="a"]')?.hasAttribute('data-round')).toBe(false));
    expect(live.calls.at(-1)!.some(node => node.round)).toBe(false);
  });

  it('maps a host\'s box with its roundness and nothing else', () => {
    const node = at('a', '甲', 10, 20);
    expect(boardBoxOf({ ...node, w: 260, h: 128 })).toEqual({ id: 'a', x: 10, y: 20, w: 260, h: 128 });
    expect(boardBoxOf({ ...node, x: 1, y: 2, w: 112, h: 112, round: true })).toEqual({ id: 'a', x: 1, y: 2, w: 112, h: 112, round: true });
    expect(Object.keys(boardBoxOf({ ...node, round: false }))).toEqual(['id', 'x', 'y', 'w', 'h']);
  });
});
