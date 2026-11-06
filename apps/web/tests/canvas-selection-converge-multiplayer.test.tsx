// CONVERGED VIEW under 多人同屏 (docs/awwo-canvas-live-collaboration.md, The canvas page). The board layer marks the
// cards the board draws. A member converged into an icon has no place on this person's board (converging is their own
// way of looking, and the wires' stand-in for a member is the icon's middle, its face): it wears no ring, name, claim
// badge or glow, over the icon or anywhere, so none of them crosses the icon's face, AwwO's own Agents on its members
// included. The 同屏 panel still says who is on it (the people bar, who is here), and naming it there opens it in its
// place, marked again. People's pointers stay where their hands are.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createFormNode, createSessionNode, type CanvasDocument, type CanvasEdge, type CanvasNode } from '../src/canvas/canvasDoc';
import { CONVERGED_GROUPS_KEY } from '../src/canvas/convergedGroups';
import type { CanvasMultiplayerHost, CanvasMultiplayerSurface } from '../src/canvas/multiplayer/host';
import { MultiplayerBoardLayer, type BoardFlash } from '../src/canvas/multiplayer/MultiplayerBoardLayer';
import type { LiveClaim, LiveParticipant, LiveState } from '../src/canvas/multiplayer/types';
import { resetAllSessions } from '../src/canvas/sessions';

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Every id here is made up; the participants and claims have the shapes the API sends them in (canvas_live.go).
const SINCE = '2026-11-06T10:00:00Z';
const NOW = Date.parse(SINCE);
const state = (over: Partial<LiveState> = {}): LiveState => ({ selection: [], focus: null, cursor: null, status: null, ...over });
const SELF: LiveParticipant = { id: 'page-self-0001', kind: 'human', port: 'web', name: 'Leon', color: '#2563eb', userId: 'user-0001', role: 'member', state: state(), since: SINCE };
// Ada has two members inside icons selected first, then the two cards the board draws; her pointer is over the board.
const ADA: LiveParticipant = { id: 'page-ada-00001', kind: 'human', port: 'web', name: 'Ada Lovelace', color: '#f59e0b', userId: 'user-0002', role: 'member',
  state: state({ selection: ['b', 'd', 'a', 'f'], cursor: { x: 640, y: 300 } }), since: SINCE };
// AwwO's own Agents on the members a run has taken, one running and one queued (canvas_live.go liveAwwoAgents).
const RUNNING: LiveParticipant = { id: 'run_example0001', kind: 'awwo', port: 'awwo', name: '乙', color: '#10b981', model: 'claude-opus-5-5',
  state: state({ selection: ['b'], focus: 'b', status: 'running' }), since: SINCE };
const QUEUED: LiveParticipant = { id: 'run_example0002', kind: 'awwo', port: 'awwo', name: '丁', color: '#0ea5e9', model: 'claude-opus-5-5',
  state: state({ selection: ['d'], focus: 'd', status: 'queued' }), since: SINCE };
const CLAUDE: LiveParticipant = { id: 't_00000000000000aa', kind: 'agent', port: 'mcp', name: 'Claude Code', color: '#7c3aed', userId: 'user-0001',
  state: state({ focus: 'e', status: '正在写后端接口' }), since: SINCE };
const PARTICIPANTS = [SELF, ADA, RUNNING, QUEUED, CLAUDE];
// One claim on a member inside an icon (e), one on a card (f).
const CLAIMS: LiveClaim[] = [
  { nodeId: 'e', participantId: CLAUDE.id, holderKind: 'agent', name: 'Claude Code', note: '写接口', expiresAt: '2026-11-06T10:10:00Z' },
  { nodeId: 'f', participantId: CLAUDE.id, holderKind: 'agent', name: 'Claude Code', note: '', expiresAt: '2026-11-06T10:10:00Z' },
];
// Two nodes someone just changed: a member inside an icon (c) and a card (a).
const FLASHES: BoardFlash[] = [{ nodeId: 'c', color: CLAUDE.color, until: NOW + 60_000 }, { nodeId: 'a', color: CLAUDE.color, until: NOW + 60_000 }];

const wire = (from: string, to: string): CanvasEdge => ({ id: `${from}:result->${to}:context`, fromNode: from, fromPort: 'result', toNode: to, toPort: 'context', dataType: 'text' });
/** Six components in a line; b and c, and d and e, can each be one icon, with a and f cards beside them. */
function seed(scale = 1): CanvasDocument {
  const at = (id: string, title: string, x: number, y: number) => ({ ...createSessionNode('llm', { x, y }), id, title });
  return {
    version: 2, updatedAt: 1,
    nodes: [at('a', '甲', 100, 100), at('b', '乙', 500, 100), at('c', '丙', 500, 400), at('d', '丁', 900, 100), at('e', '戊', 900, 400), at('f', '己', 1300, 250)],
    edges: [wire('a', 'b'), wire('b', 'c'), wire('c', 'd'), wire('d', 'e'), wire('e', 'f')],
    waypoints: [], view: { x: 0, y: 0, scale },
  };
}
const TWO_ICONS = { v: 1, canvas: false, groups: [{ id: 'g1', members: ['b', 'c'] }, { id: 'g2', members: ['d', 'e'] }] };

/** Two bound Agents fed by a form: enough to pass preflight and start a real run (as canvas-selection-converge-surface
 *  and canvas-run-lock do). */
function seedRunnable() {
  const agent = (id: string, x: number) => ({ ...createSessionNode('llm', { x, y: 0 }), id, title: id, runtime: 'claude_local',
    binding: { companyId: 'c1', agentId: `agent-${id}`, agentName: id }, issueId: `iss-${id}` });
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), nodes: [{ ...createFormNode({ x: 0, y: 0 }), id: 'f1', title: '需求表单' },
    agent('s1', 500), agent('s2', 900)], edges: [] }));
}
/** A reply the server finished: accepted on a new thread, one delta, done (the gateway's SSE frames). */
const finishedReply = (issueId: string, text: string) => [
  `event: accepted\ndata: {"event":"accepted","issueId":"${issueId}","runId":"run-1","runVisible":true}\n\n`,
  `event: delta\ndata: {"event":"delta","text":"${text}"}\n\n`, 'event: done\ndata: {"event":"done","status":"succeeded"}\n\n'].join('');
/** A reply kept open, which rejects (as a real fetch does) once the run is stopped. */
function heldOpen(signal?: AbortSignal) {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
  });
}
const storedDoc = () => JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;

/** A host as the hosted app's is (useCanvasMultiplayer.tsx MultiplayerBoard): the board's nodes as boxes, under the live
 *  state; it keeps every nodes array it was given and the surface that connected. */
function boardHost(participants = PARTICIPANTS) {
  let surface: CanvasMultiplayerSurface | null = null;
  const calls: ReadonlyArray<CanvasNode>[] = [];
  const host: CanvasMultiplayerHost = {
    connect: next => { surface = next; },
    presence: () => undefined,
    boardLayer: (nodes, scale) => {
      calls.push(nodes);
      return <MultiplayerBoardLayer participants={participants} selfId={SELF.id} claims={CLAIMS} flashes={FLASHES} now={NOW} scale={scale}
        nodes={nodes.map(node => ({ id: node.id, x: node.x, y: node.y, w: node.w, h: node.h }))} />;
    },
  };
  return { host, calls, given: () => [...(calls.at(-1) ?? [])].map(node => node.id).sort(), surface: () => surface! };
}

const mounted = () => [...document.querySelectorAll<HTMLElement>('.canvas-tile')].map(tile => tile.dataset.nodeId).filter(Boolean).sort();
const board = () => document.querySelector<HTMLElement>('.awwo-multiplayer-board')!;
const nodeOf = (element: Element) => element.closest<HTMLElement>('[data-node]')!.dataset.node!;
const marked = () => [...board().querySelectorAll<HTMLElement>('.awwo-multiplayer-mark')].map(mark => mark.dataset.node!).sort();
const mark = (id: string) => board().querySelector<HTMLElement>(`.awwo-multiplayer-mark[data-node="${id}"]`);
const tags = (id: string) => [...board().querySelectorAll(`[data-node="${id}"] .awwo-multiplayer-tag`)].map(tag => tag.textContent);
const rings = (id: string) => [...board().querySelectorAll<HTMLElement>(`[data-node="${id}"] .awwo-multiplayer-ring`)].map(ring => ring.dataset.participant);

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});

describe('others on a converged board (多人同屏)', () => {
  it('marks the cards the board draws and nothing of the members inside its icons', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify(TWO_ICONS));
    const live = boardHost();
    const view = render(<CanvasSurface multiplayer={live.host} />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'f']));
    expect(screen.getByTestId('converged-icon-g1')).toBeTruthy();
    expect(screen.getByTestId('converged-icon-g2')).toBeTruthy();
    // The layer is given the drawn cards alone (host.ts: the nodes the board draws), never a member at its icon's
    // wire band (the icon's full width across its middle).
    await waitFor(() => expect(live.given()).toEqual(['a', 'f']));
    for (const icon of ['g1', 'g2']) {
      const box = screen.getByTestId(`converged-icon-${icon}`);
      const band = { x: parseFloat(box.style.left), w: parseFloat(box.style.width) };
      expect(live.calls.at(-1)!.some(node => node.x === band.x && node.w === band.w)).toBe(false);
    }
    expect(marked()).toEqual(['a', 'f']);
    // Nothing over either icon: no ring, name, claim or glow of a member, the running and queued AwwO Agents included.
    for (const id of ['b', 'c', 'd', 'e']) expect(mark(id)).toBeNull();
    expect(board().textContent).not.toContain('AwwO Agent');
    expect([...board().querySelectorAll('.awwo-multiplayer-claim')].map(nodeOf)).toEqual(['f']);
    expect([...board().querySelectorAll('.awwo-multiplayer-flash')].map(nodeOf)).toEqual(['a']);
    // A card keeps every mark, at the box it is drawn at (a closed card's size, not the document's).
    expect(mark('a')!.style.transform).toBe('translate(100px, 100px)');
    expect(mark('a')!.style.width).toBe('260px');
    expect(mark('a')!.style.height).toBe('128px');
    expect(rings('a')).toEqual([ADA.id]);
    // Ada is named on both cards she has: what she has inside the icons does not count toward the three named.
    expect(tags('a')).toEqual(['Ada Lovelace']);
    expect(tags('f')).toEqual(['Ada Lovelace']);
    expect(board().querySelector('[data-node="f"] .awwo-multiplayer-claim')).toHaveTextContent('Claude Code 正在处理');
    // Her pointer is where her hand is, icons or not.
    expect(board().querySelector<HTMLElement>(`.awwo-multiplayer-cursor[data-participant="${ADA.id}"]`)!.style.transform).toBe('translate(640px, 300px)');
    // While converged too, a render that changes nothing hands the layer the very array it had.
    const last = live.calls.at(-1);
    view.rerender(<CanvasSurface multiplayer={live.host} />);
    expect(live.calls.at(-1)).toBe(last);
  });

  it('puts no AwwO Agent over a converged canvas with AwwO\'s Agents on its members, at its smallest size too', async () => {
    // Zoomed far out: the icon at its 40 px floor (tier M), its drawing scaled up about its centre.
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed(0.1)));
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: true, groups: [] }));
    const live = boardHost();
    render(<CanvasSurface multiplayer={live.host} />);
    const icon = await screen.findByTestId('converged-icon-canvas');
    expect(icon.dataset.tier).toBe('M');
    await waitFor(() => expect(board()).not.toBeNull());
    expect(live.given()).toEqual([]);
    expect(board().querySelectorAll('.awwo-multiplayer-mark')).toHaveLength(0);
    expect(board().textContent).not.toContain('AwwO Agent');
    // The layer itself stays: a person's pointer is still drawn, at its size on screen.
    expect(board().style.getPropertyValue('--mp-inv')).toBe('10');
    expect(board().querySelector(`.awwo-multiplayer-cursor[data-participant="${ADA.id}"]`)).not.toBeNull();
  });

  it('marks a member in its own place again once it is shown as the 同屏 panel\'s chip shows it, and leaves the other icon unmarked', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify(TWO_ICONS));
    const live = boardHost();
    render(<CanvasSurface multiplayer={live.host} />);
    await waitFor(() => expect(live.given()).toEqual(['a', 'f']));
    // The panel's node chip (onFocusNode, SaaSApp → useCanvasMultiplayer focusNode) shows the node through the surface;
    // tests/saas-multiplayer-canvas.test.tsx clicks the chip itself.
    await act(async () => { live.surface().focus('b'); });
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'f']));
    expect(live.given()).toEqual(['a', 'b', 'c', 'f']);
    // b at its own card, as big as it is drawn there (opened), not across an icon's middle.
    const tile = screen.getByTestId('canvas-tile-b');
    expect(mark('b')!.style.transform).toBe(`translate(${tile.style.left}, ${tile.style.top})`);
    expect([mark('b')!.style.width, mark('b')!.style.height]).toEqual([tile.style.width, tile.style.height]);
    expect(rings('b')).toEqual([ADA.id, RUNNING.id]);
    // Ada is now on three drawn cards (d is still inside its icon), so she is named on each.
    expect(tags('b')).toEqual(['Ada Lovelace', 'AwwO Agent']);
    expect(tags('a')).toEqual(['Ada Lovelace']);
    expect(tags('f')).toEqual(['Ada Lovelace']);
    expect([...board().querySelectorAll('.awwo-multiplayer-flash')].map(nodeOf).sort()).toEqual(['a', 'c']);
    // d and e are still inside their icon: still nothing of them.
    expect(mark('d')).toBeNull();
    expect(mark('e')).toBeNull();
    expect([...board().querySelectorAll('.awwo-multiplayer-claim')].map(nodeOf)).toEqual(['f']);
  });

  it('gives the layer the board\'s own cards when nothing is converged, the same array from one render to the next', async () => {
    const live = boardHost();
    const view = render(<CanvasSurface multiplayer={live.host} />);
    await waitFor(() => expect(live.given()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']));
    const before = live.calls.length;
    const last = live.calls.at(-1);
    // A render that changes nothing on the board hands the layer the very array it had (its boxes and marks memoised).
    view.rerender(<CanvasSurface multiplayer={live.host} />);
    expect(live.calls.length).toBeGreaterThan(before);
    expect(live.calls.at(-1)).toBe(last);
    // As before 多人同屏 met the converged view: Ada, on four cards, is named on her first; the running Agent on its own.
    expect(mark('b')!.style.transform).toBe('translate(500px, 100px)');
    expect(tags('b')).toEqual(['Ada Lovelace', 'AwwO Agent']);
    expect(tags('a')).toEqual([]);
  });

  it('keeps every mark off the icon while this page runs the converged canvas itself', async () => {
    seedRunnable();
    // The first reply finishes; the other stays open, so the run is still under way while the board is looked at.
    let replies = 0;
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: { method?: string; signal?: AbortSignal }) => {
      const url = String(input);
      if (url.endsWith('/prepare')) return Promise.resolve({ ok: true, status: 200 });
      if (url.endsWith('/settle')) return Promise.resolve({ ok: true, json: async () => ({ confirmed: true, status: 'succeeded', holdId: 'hold-1' }) });
      if (!url.includes('/messages')) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      if (init?.method === 'POST' && replies++ === 0) return Promise.resolve(new Response(finishedReply('iss-new', '第一份结果'), { headers: { 'content-type': 'text/event-stream' } }));
      return heldOpen(init?.signal);
    }));
    // This page's own run, as the server lists it to everyone: an AwwO Agent on each member it has taken; Ada on s2.
    const runner = (id: string, node: string): LiveParticipant => ({ ...RUNNING, id, name: node, state: state({ selection: [node], focus: node, status: 'running' }) });
    const live = boardHost([SELF, { ...ADA, state: state({ selection: ['s2'], cursor: { x: 640, y: 300 } }) }, runner('run_example0003', 's1'), runner('run_example0004', 's2')]);
    render(<CanvasSurface multiplayer={live.host} />);
    await waitFor(() => expect(mounted()).toEqual(['f1', 's1', 's2']));
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await screen.findByTestId('converged-icon-canvas');
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    fireEvent.click(screen.getByTestId('cmdbar-row-run'));
    await waitFor(() => expect(storedDoc().nodes.some(node => node.lastOutput?.text === '第一份结果')).toBe(true));
    expect(['running', 'waiting']).toContain(screen.getByTestId('converged-icon-canvas').dataset.state);
    // The page is running: the layer is still given the cards it draws, none, and draws nothing over the icon.
    expect(live.given()).toEqual([]);
    expect(board().querySelectorAll('.awwo-multiplayer-mark')).toHaveLength(0);
    expect(board().textContent).not.toContain('AwwO Agent');
    expect(board().querySelector(`.awwo-multiplayer-cursor[data-participant="${ADA.id}"]`)).not.toBeNull();
  });

  it('marks the cards of a stored group the board does not draw as an icon (a form and one component do not converge)', async () => {
    // A group of a form and one component is kept but is no icon (convergeView counts components, and a form is an
    // input): both stay cards, and wear every mark.
    const doc = seed();
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...doc, nodes: [...doc.nodes, { ...createFormNode({ x: 100, y: 500 }), id: 'f0', title: '需求表单' }] }));
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: false, groups: [{ id: 'g1', members: ['b', 'c'] }, { id: 'pair', members: ['f0', 'a'] }] }));
    const live = boardHost();
    render(<CanvasSurface multiplayer={live.host} />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'd', 'e', 'f', 'f0']));
    expect(screen.queryByTestId('converged-icon-pair')).toBeNull();
    await waitFor(() => expect(live.given()).toEqual(['a', 'd', 'e', 'f', 'f0']));
    expect(mark('a')!.style.transform).toBe('translate(100px, 100px)');
    expect(rings('a')).toEqual([ADA.id]);
    expect([...board().querySelectorAll('.awwo-multiplayer-flash')].map(nodeOf)).toEqual(['a']);
  });
});
