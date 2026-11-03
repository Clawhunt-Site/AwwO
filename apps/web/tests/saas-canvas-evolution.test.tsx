// A canvas that evolves by itself (canvas_evolution.go): the page's driver (canvasEvolution.ts), which claims what the
// server says is due, makes it as a suggestion on the canvas, settles it once the canvas as saved holds it, and then asks
// the surface for the rerun of a run it saw end; the 经验 panel's 自动进化 section; and the API client's reading.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasEvolution } from '../src/canvas/CanvasSurface';
import { LessonsWorkbench, evolutionEntryText } from '../src/saas/CanvasLessons';
import { EVOLUTION_QUEUE_WAIT, EVOLUTION_RERUN_WAIT, EVOLUTION_SAVE_WAIT, evolutionNote, rerunNote, revertNote, useCanvasEvolution } from '../src/saas/canvasEvolution';
import { readCanvasEvolution, type CanvasEvolutionView, type EvolutionEntry, type EvolutionStep } from '../src/saas/evolutionApi';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Call = { url: string; method: string; body: any; signal?: AbortSignal | null };
function server(routes: (call: Call, calls: Call[]) => Response | undefined | Promise<Response | undefined>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, signal: init.signal };
    calls.push(call);
    return (await routes(call, calls)) ?? json({ error: { code: 'not_found', message: 'missing' } }, 404);
  }));
  return calls;
}
const zh = (zhText: string) => zhText;
const step = (patch: Partial<EvolutionStep> = {}): EvolutionStep => ({ lessonId: 'l1', nodeId: 'page', nodeTitle: '生成页面', kind: 'output_limit', proposal: 'lower_effort', seen: 2,
  from: '', effort: 'low', model: 'claude-opus-5-5', ...patch });
const entry = (patch: Partial<EvolutionEntry> = {}): EvolutionEntry => ({ id: 'e1', kind: 'effort', auto: true, nodeId: 'page', nodeTitle: '生成页面', lessonId: 'l1', graphId: 'g1',
  revertsId: null, rerunGraphId: null, from: 'medium', to: 'low', reason: '', createdAt: '2026-11-03T08:00:00Z', doneAt: '2026-11-03T08:00:05Z', state: 'done',
  reverted: false, standing: true, ...patch });
const evolution = (patch: Partial<Omit<CanvasEvolutionView, 'pending'>> & { pending?: Partial<CanvasEvolutionView['pending']> } = {}): CanvasEvolutionView => ({
  autoApply: { on: true, since: '2026-11-03T07:00:00Z' }, autoRerun: { on: true, since: '2026-11-03T07:00:00Z' },
  latestRun: { id: 'g1', status: 'failed', learnt: true, endedAt: '2026-11-03T08:00:00Z', autoRerun: false, rerunId: null },
  limits: { rerunsLastDay: 0, rerunsPerDay: 3, revertAfterRuns: 2, changeEveryHours: 24, changesPerWeek: 2 }, log: [], ...patch,
  pending: { apply: [], revert: [], rerun: null, ...patch.pending },
});
// The change the server claims for a step, from the node's own effort to the one it names.
const claimed = (patch: Partial<EvolutionEntry> = {}) => entry({ id: 'c1', from: '', to: 'low', state: 'claimed', doneAt: null, standing: false, ...patch });
const isClaim = (call: Call) => call.method === 'POST' && call.url.endsWith('/evolution/changes');
const isSettle = (call: Call) => call.method === 'POST' && /\/evolution\/changes\/[^/]+$/.test(call.url);
const settles = (calls: Call[]) => calls.filter(isSettle);
const rerun = { graphId: 'g1', operationId: 'autorerun:g1', scope: ['page', 'review'] };
const page = (effort: string) => ({ nodes: [{ id: 'page', kind: 'session', effort }] });
// The surface's queue, as useLessonEvolutions gives it: what the page hands over, and what it takes back.
const queueOf = (enqueue: (evolution: CanvasEvolution) => void, withdraw: (id: string) => boolean = () => true) => ({ enqueue, withdraw });

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the canvas evolution driver', () => {
  it('claims what is due when the canvas opens, makes it on the node as claimed, settles it once the canvas as saved holds it, and never reruns on opening', async () => {
    const calls = server(call => {
      if (call.url.endsWith('/canvases/canvas-a/evolution') && call.method === 'GET') return json(evolution({ pending: { apply: [step()], rerun } }));
      if (isClaim(call)) return json({ change: claimed(), evolution: evolution() });
      if (isSettle(call)) return json(evolution());
    });
    const enqueue = vi.fn<(evolution: CanvasEvolution) => void>();
    const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(enqueue), zh));
    await waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(calls.find(isClaim)?.body).toEqual({ graphId: 'g1', nodeId: 'page', lessonId: 'l1' });
    const taken = enqueue.mock.calls[0][0];
    // Asked before the claim went out: a node set since is left as it is.
    expect(taken.since).toBeLessThanOrEqual(performance.now());
    expect(calls.find(isClaim)).toBeDefined();
    // The efforts are the claim's: the plan runs only on a node still at the effort it was claimed from.
    expect(taken).toMatchObject({ nodeId: 'page', effort: 'low', expect: '', change: 'c1', model: 'claude-opus-5-5', note: evolutionNote(step(), { revertAfterRuns: 2 }, zh) });
    // Another suggestion's outcome is not the driver's.
    act(() => result.current.settled('lesson:l9:1', { applied: true }));
    act(() => result.current.settled(taken.id, { applied: true }));
    act(() => result.current.saved(page('')));
    expect(settles(calls)).toHaveLength(0);
    act(() => result.current.saved(page('low')));
    await waitFor(() => expect(settles(calls).map(call => [call.url.split('/').at(-1), call.body])).toEqual([['c1', { done: true }]]));
    act(() => result.current.saved(page('low')));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settles(calls)).toHaveLength(1);
    expect(result.current.autoRun).toBeNull();
  });

  it('after a canvas run it saw end, waits for it to be learnt from, settles its changes, then asks once for the rerun the server allows', async () => {
    let reads = 0;
    let settled = false;
    const calls = server(call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') {
        reads += 1;
        // Opening: nothing due. The run's end: not learnt yet, then learnt, then (the change settled) the rerun alone.
        if (reads === 1) return json(evolution({ latestRun: { id: 'g0', status: 'completed', learnt: true, endedAt: '2026-11-03T07:30:00Z', autoRerun: false, rerunId: null } }));
        if (reads === 2) return json(evolution({ latestRun: { id: 'g1', status: 'failed', learnt: false, endedAt: '2026-11-03T08:00:00Z', autoRerun: false, rerunId: null } }));
        return json(reads === 3 ? evolution({ pending: { apply: [step()] } })
          : evolution({ pending: { rerun }, limits: { rerunsLastDay: 1, rerunsPerDay: 3, revertAfterRuns: 2, changeEveryHours: 24, changesPerWeek: 2 } }));
      }
      if (isClaim(call)) return json({ change: claimed(), evolution: evolution() });
      if (isSettle(call)) { settled = true; return json(evolution()); }
    });
    const enqueue = vi.fn<(evolution: CanvasEvolution) => void>();
    const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(enqueue), zh));
    await waitFor(() => expect(reads).toBe(1));
    act(() => result.current.runEnded(['g1']));
    await waitFor(() => expect(enqueue).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(reads).toBe(3);
    // The rerun waits for the change's settle.
    act(() => result.current.saved(page('low')));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(result.current.autoRun).toBeNull();
    act(() => result.current.settled(enqueue.mock.calls[0][0].id, { applied: true }));
    await waitFor(() => expect(result.current.autoRun).toMatchObject({ scope: ['page', 'review'], operationId: 'autorerun:g1',
      note: rerunNote(2, { rerunsLastDay: 1, rerunsPerDay: 3 }, zh) }));
    expect(settled).toBe(true);
    const run = result.current.autoRun!;
    act(() => result.current.autoRunSettled(run.id, { started: true }));
    expect(result.current.autoRun).toBeNull();
    // The same rerun is asked for once, whatever ends after.
    act(() => result.current.runEnded(['g1']));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(5));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(result.current.autoRun).toBeNull();
    expect(calls.filter(isClaim)).toHaveLength(1);
  });

  it('reruns no run it did not see end, and nothing for work that names no canvas run', async () => {
    let reads = 0;
    server(call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') { reads += 1; return json(evolution({ pending: { rerun } })); }
    });
    const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(vi.fn()), zh));
    await waitFor(() => expect(reads).toBe(1));
    // A node's own message, or a run refused at admission: nothing to read.
    act(() => result.current.runEnded([]));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reads).toBe(1);
    // Another canvas run ended: the latest is not one this page saw end.
    act(() => result.current.runEnded(['g9']));
    await waitFor(() => expect(reads).toBe(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(result.current.autoRun).toBeNull();
  });

  it('skips a change the canvas did not make, makes nothing of a claim refused, and takes a person’s revert back as theirs', async () => {
    let refuse = false;
    const calls = server(call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') return json(evolution({ pending: { apply: [step()] } }));
      if (isClaim(call)) {
        if (refuse) return json({ error: { code: 'evolution_not_due', message: 'not due' } }, 409);
        return json({ change: call.body.revertsId ? claimed({ id: 'c2', kind: 'revert', auto: false, from: 'low', to: 'medium', revertsId: 'e1' }) : claimed(), evolution: evolution() });
      }
      if (isSettle(call)) return json(evolution());
    });
    const enqueue = vi.fn<(evolution: CanvasEvolution) => void>();
    const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(enqueue), zh));
    await waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    act(() => result.current.settled(enqueue.mock.calls[0][0].id, { applied: false, reason: ' 这个节点的推理强度在这之后改过了，这项调整没有应用。 ' }));
    await waitFor(() => expect(settles(calls).map(call => call.body)).toEqual([{ skipped: '这个节点的推理强度在这之后改过了，这项调整没有应用。' }]));
    // A person takes a change back: claimed as theirs, made on the node still at the effort it set.
    act(() => result.current.revert(entry()));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect(calls.filter(isClaim)[1].body).toEqual({ graphId: 'g1', nodeId: 'page', revertsId: 'e1', auto: false });
    const back = enqueue.mock.calls[1][0];
    expect(back).toMatchObject({ nodeId: 'page', effort: 'medium', expect: 'low', expectMark: 'e1', model: '', note: revertNote(entry(), zh) });
    act(() => result.current.settled(back.id, { applied: true }));
    act(() => result.current.saved(page('medium')));
    await waitFor(() => expect(settles(calls).map(call => call.url.split('/').at(-1))).toEqual(['c1', 'c2']));
    // A claim the server refuses (another tab took it, a person changed the node) hands nothing to the canvas.
    refuse = true;
    act(() => result.current.revert(entry()));
    await waitFor(() => expect(calls.filter(isClaim)).toHaveLength(3));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('waits for the next saved canvas when the server does not hold the change yet, sends again a settle the network lost, and reruns nothing after a change left unsettled', async () => {
    let unsaved = 1, lost = 1;
    let reads = 0;
    const calls = server(call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') {
        reads += 1;
        return json(reads === 1 ? evolution() : evolution({ pending: { apply: [step()], revert: [step({ lessonId: undefined, revertsId: 'e1', kind: 'revert', proposal: undefined, nodeId: 'brief', from: 'low', effort: '' })], rerun } }));
      }
      if (isClaim(call)) return json({ change: call.body.revertsId ? claimed({ id: 'c2', kind: 'revert', nodeId: 'brief', from: 'low', to: '', revertsId: 'e1' }) : claimed(), evolution: evolution() });
      if (isSettle(call) && call.url.endsWith('/c1')) {
        if (unsaved-- > 0) return json({ error: { code: 'evolution_unsaved', message: 'unsaved' } }, 409);
        if (lost-- > 0) throw new TypeError('Failed to fetch');
        return json(evolution());
      }
      // The revert's settle is refused for good: its claim stays the server's to let go.
      if (isSettle(call)) return json({ error: { code: 'evolution_settled', message: 'settled' } }, 409);
    });
    const enqueue = vi.fn<(evolution: CanvasEvolution) => void>();
    const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(enqueue), zh));
    await waitFor(() => expect(reads).toBe(1));
    act(() => result.current.runEnded(['g1']));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    const [revert, change] = enqueue.mock.calls.map(([item]) => item);
    expect(revert).toMatchObject({ nodeId: 'brief', effort: '', expect: 'low' });
    const both = { nodes: [{ id: 'page', kind: 'session', effort: 'low' }, { id: 'brief', kind: 'session', effort: '' }] };
    act(() => result.current.saved(both));
    // Already so in the canvas the cloud confirmed: settled at once (the server answers it does not hold it yet).
    act(() => result.current.settled(change.id, { applied: false, satisfied: true }));
    await waitFor(() => expect(settles(calls).filter(call => call.url.endsWith('/c1'))).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    // The next canvas the cloud confirms tries it again; the network loses it once, and it is sent again.
    act(() => result.current.saved(both));
    await waitFor(() => expect(settles(calls).filter(call => call.url.endsWith('/c1'))).toHaveLength(3), { timeout: 3000 });
    act(() => result.current.settled(revert.id, { applied: true }));
    await waitFor(() => expect(settles(calls).filter(call => call.url.endsWith('/c2'))).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(result.current.autoRun).toBeNull();
  });

  it('lets go of a claim answered after the page left, handing nothing to a canvas that is gone', async () => {
    let answer!: () => void;
    const held = new Promise<void>(resolve => { answer = resolve; });
    const calls = server(async call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') return json(evolution({ pending: { apply: [step()] } }));
      if (isClaim(call)) { await held; return json({ change: claimed(), evolution: evolution() }); }
      if (isSettle(call)) return json(evolution());
    });
    const enqueue = vi.fn();
    const { unmount } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(enqueue), zh));
    await waitFor(() => expect(calls.some(isClaim)).toBe(true));
    unmount();
    answer();
    await waitFor(() => expect(settles(calls).map(call => call.body)).toEqual([{ skipped: '页面离开了画布，这项调整没有做。' }]));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('takes what is due only once the page shows the canvas, not while it loads or shows its drafts', async () => {
    let reads = 0;
    server(call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') { reads += 1; return json(evolution({ pending: { apply: [step()] } })); }
      if (isClaim(call)) return json({ change: claimed(), evolution: evolution() });
    });
    const enqueue = vi.fn<(evolution: CanvasEvolution) => void>();
    const { rerender } = renderHook(({ ready }) => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(enqueue), zh, ready), { initialProps: { ready: false } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reads).toBe(0);
    rerender({ ready: true });
    await waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(reads).toBe(1);
  });

  it('takes back and skips a change the canvas does not take in time, and takes no word of the canvas on it after', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The skip's answer waits, to see the change while its skip is on its way.
      let release!: () => void;
      const answered = new Promise<void>(resolve => { release = resolve; });
      const calls = server(async call => {
        if (call.url.endsWith('/evolution') && call.method === 'GET') return json(evolution({ pending: { apply: [step()] } }));
        if (isClaim(call)) return json({ change: claimed(), evolution: evolution() });
        if (isSettle(call)) { await answered; return json(evolution()); }
      });
      const enqueue = vi.fn<(evolution: CanvasEvolution) => void>();
      const withdraw = vi.fn(() => true);
      const queue = queueOf(enqueue, withdraw);
      const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queue, zh));
      await waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
      const taken = enqueue.mock.calls[0][0];
      expect(taken.wanted?.()).toBe(true);
      // (The clock runs on by itself meanwhile: a margin.)
      await act(async () => { vi.advanceTimersByTime(EVOLUTION_QUEUE_WAIT - 2000); });
      expect(withdraw).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(2000); });
      expect(withdraw).toHaveBeenCalledWith(taken.id);
      await waitFor(() => expect(settles(calls).map(call => call.body)).toEqual([{ skipped: '画布没能及时做这项调整。' }]));
      // Taken back as its skip goes out: the surface, coming to it now, drops it, and its word on it is not taken.
      expect(taken.wanted?.()).toBe(false);
      act(() => result.current.settled(taken.id, { applied: true }));
      release();
      act(() => result.current.saved(page('low')));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settles(calls)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('on leaving, takes back and skips the changes the canvas has not taken, and leaves one it took to the server', async () => {
    const calls = server(call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') return json(evolution({ pending: { apply: [step(), step({ lessonId: 'l2', nodeId: 'brief', nodeTitle: '简报' })] } }));
      if (isClaim(call)) return json({ change: claimed({ id: call.body.nodeId === 'brief' ? 'c2' : 'c1', nodeId: call.body.nodeId }), evolution: evolution() });
      if (isSettle(call)) return json(evolution());
    });
    const enqueue = vi.fn<(evolution: CanvasEvolution) => void>();
    const withdraw = vi.fn(() => true);
    const queue = queueOf(enqueue, withdraw);
    const { result, unmount } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queue, zh));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    const byNode = Object.fromEntries(enqueue.mock.calls.map(([item]) => [item.nodeId, item]));
    act(() => result.current.settled(byNode.page.id, { applied: true }));
    unmount();
    expect(withdraw.mock.calls).toEqual([[byNode.brief.id]]);
    expect(byNode.page.wanted?.()).toBe(false);
    expect(byNode.brief.wanted?.()).toBe(false);
    await waitFor(() => expect(settles(calls).map(call => [call.url.split('/').at(-1), call.body])).toEqual([['c2', { skipped: '页面离开了画布，这项调整没有做。' }]]));
  });

  it('leaves to the server a change the canvas took and has not saved by the end of the wait, and reruns nothing after it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      const calls = server(call => {
        if (call.url.endsWith('/evolution') && call.method === 'GET') {
          reads += 1;
          return json(reads === 1 ? evolution() : evolution({ pending: { apply: [step()], rerun } }));
        }
        if (isClaim(call)) return json({ change: claimed(), evolution: evolution() });
        if (isSettle(call)) return json({ error: { code: 'evolution_unsaved', message: 'unsaved' } }, 409);
      });
      const enqueue = vi.fn<(evolution: CanvasEvolution) => void>();
      const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(enqueue), zh));
      await waitFor(() => expect(reads).toBe(1));
      act(() => result.current.runEnded(['g1']));
      await waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
      act(() => result.current.settled(enqueue.mock.calls[0][0].id, { applied: true }));
      await act(async () => { vi.advanceTimersByTime(EVOLUTION_SAVE_WAIT); });
      await waitFor(() => expect(settles(calls)).toHaveLength(1));
      await new Promise(resolve => setTimeout(resolve, 50));
      // A done settle the server refused as not saved yet, and no skip: the save that makes it settles it there.
      expect(settles(calls).map(call => call.body)).toEqual([{ done: true }]);
      expect(result.current.autoRun).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('leaves the canvas when the page stops showing it: the changes not taken are skipped, and the rerun asked for let go', async () => {
    let reads = 0;
    const calls = server(call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') {
        reads += 1;
        return json(reads === 1 ? evolution({ pending: { apply: [step()] } }) : evolution({ pending: { rerun } }));
      }
      if (isClaim(call)) return json({ change: claimed(), evolution: evolution() });
      if (isSettle(call)) return json(evolution());
    });
    const enqueue = vi.fn<(evolution: CanvasEvolution) => void>();
    const withdraw = vi.fn(() => true);
    const queue = queueOf(enqueue, withdraw);
    const { result, rerender } = renderHook(({ ready }) => useCanvasEvolution('tenant-a', 'canvas-a', queue, zh, ready), { initialProps: { ready: true } });
    await waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    const taken = enqueue.mock.calls[0][0];
    // The page shows its drafts: the change the canvas has not taken goes back, skipped.
    rerender({ ready: false });
    expect(withdraw).toHaveBeenCalledWith(taken.id);
    expect(taken.wanted?.()).toBe(false);
    await waitFor(() => expect(settles(calls).map(call => call.body)).toEqual([{ skipped: '页面离开了画布，这项调整没有做。' }]));
    // Shown again: a run it saw end asks for its rerun; the page stops showing the canvas before the surface takes it.
    rerender({ ready: true });
    await waitFor(() => expect(reads).toBe(2));
    act(() => result.current.runEnded(['g1']));
    await waitFor(() => expect(result.current.autoRun).toMatchObject({ operationId: 'autorerun:g1' }));
    rerender({ ready: false });
    expect(result.current.autoRun).toBeNull();
    // The canvas is free for the next opening.
    rerender({ ready: true });
    await waitFor(() => expect(reads).toBe(4));
  });

  it('lets the canvas go when the surface never says whether the rerun started', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      server(call => {
        if (call.url.endsWith('/evolution') && call.method === 'GET') { reads += 1; return json(evolution({ pending: { rerun } })); }
      });
      const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(vi.fn()), zh));
      await waitFor(() => expect(reads).toBe(1));
      act(() => result.current.runEnded(['g1']));
      await waitFor(() => expect(result.current.autoRun).toMatchObject({ operationId: 'autorerun:g1' }));
      // Another run's end waits behind the pass, which waits for the surface's word.
      act(() => result.current.runEnded(['g2']));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(reads).toBe(2);
      await act(async () => { vi.advanceTimersByTime(EVOLUTION_RERUN_WAIT); });
      await waitFor(() => expect(reads).toBe(3));
    } finally { vi.useRealTimers(); }
  });

  it('lets the canvas go at once when the page leaves with a read under way', async () => {
    let held = false;
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name: string, options: LockOptions, work: (lock: unknown) => Promise<void>) => {
      if (options.ifAvailable && held) return work(null);
      held = true;
      try { return await work({ name: 'evolution' }); } finally { held = false; }
    }) } });
    // The read never answers.
    const calls = server(call => call.url.endsWith('/evolution') && call.method === 'GET' ? new Promise<Response>(() => undefined) : undefined);
    try {
      const { unmount } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(vi.fn()), zh));
      await waitFor(() => expect(held).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(held).toBe(true);
      expect(calls[0].signal?.aborted).toBe(false);
      unmount();
      await waitFor(() => expect(held).toBe(false));
      // The read itself is let go too.
      expect(calls[0].signal?.aborted).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    }
  });

  it('waits for another tab to let the canvas go before it takes a run’s end, and takes no opening of it meanwhile', async () => {
    // One lock, held by another tab until it lets it go.
    let held = true;
    const waiting: (() => void)[] = [];
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name: string, options: LockOptions, work: (lock: unknown) => Promise<void>) => {
      if (options.ifAvailable && held) return work(null);
      if (held) await new Promise<void>(resolve => waiting.push(resolve));
      held = true;
      try { return await work({ name: 'evolution' }); } finally { held = false; }
    }) } });
    let reads = 0;
    server(call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') { reads += 1; return json(evolution({ pending: { rerun } })); }
    });
    try {
      const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(vi.fn()), zh));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(reads).toBe(0);
      act(() => result.current.runEnded(['g1']));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(reads).toBe(0);
      held = false;
      waiting.splice(0).forEach(resolve => resolve());
      await waitFor(() => expect(result.current.autoRun).toMatchObject({ operationId: 'autorerun:g1' }));
      expect(reads).toBe(1);
    } finally {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    }
  });

  it('does nothing for a canvas whose switches are off, nor when its evolution cannot be read', async () => {
    let reads = 0;
    server(call => {
      if (call.url.endsWith('/evolution') && call.method === 'GET') { reads += 1; return json(evolution({ autoApply: { on: false, since: null }, autoRerun: { on: false, since: null }, pending: { apply: [step()] } })); }
    });
    const enqueue = vi.fn();
    const { result } = renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(enqueue), zh));
    await waitFor(() => expect(reads).toBe(1));
    act(() => result.current.runEnded(['g1']));
    await waitFor(() => expect(reads).toBe(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(enqueue).not.toHaveBeenCalled();
    cleanup();
    server(() => json({ error: { code: 'not_found', message: 'missing' } }, 404));
    renderHook(() => useCanvasEvolution('tenant-a', 'canvas-a', queueOf(enqueue), zh));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('the 经验 panel’s 自动进化', () => {
  const routes = (view: () => CanvasEvolutionView, onPut?: (body: any) => CanvasEvolutionView) => (call: Call) => {
    if (call.url.endsWith('/canvases/canvas-a/lessons')) return json({ lessons: [], runs: [] });
    if (call.url.includes('/memory')) return json({ items: [] });
    if (call.url.endsWith('/canvases/canvas-a/evolution') && call.method === 'GET') return json(view());
    if (call.url.endsWith('/canvases/canvas-a/evolution') && call.method === 'PUT' && onPut) return json(onPut(call.body));
  };
  const panel = (props: Partial<Parameters<typeof LessonsWorkbench>[0]> = {}) =>
    render(<SaaSPreferencesProvider><LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} {...props} /></SaaSPreferencesProvider>);

  it('turns a switch on, lists what the canvas did, and takes back a change that stands', async () => {
    let current = evolution({ autoApply: { on: false, since: null }, autoRerun: { on: false, since: null },
      log: [entry({ id: 'e3', kind: 'rerun', nodeId: '', nodeTitle: '', lessonId: null, rerunGraphId: 'g2', from: '', to: '', standing: false }), entry(),
        entry({ id: 'e2', kind: 'skip', reason: '画布正在运行', standing: false }), entry({ id: 'e0', reverted: true, from: 'high', to: 'medium', standing: false }),
        entry({ id: 'e4', standing: false, from: 'low', to: 'medium' }), claimed({ id: 'e5' })] });
    const calls = server(routes(() => current, body => (current = { ...current, autoApply: { on: body.autoApply ?? current.autoApply.on, since: '2026-11-03T09:00:00Z' } })));
    const onRevert = vi.fn();
    panel({ onRevert });
    const section = within(await screen.findByRole('region', { name: '自动进化' }));
    const apply = section.getByRole('checkbox', { name: /自动应用建议/ });
    expect(apply).not.toBeChecked();
    expect(section.getByRole('checkbox', { name: /自动重跑没完成的节点/ })).not.toBeChecked();
    expect(section.getByText(/每 24 小时最多 3 次/)).toBeVisible();
    expect(section.getByText(/就马上自动改回（改回也算一次调整）/)).toBeVisible();
    fireEvent.click(apply);
    await waitFor(() => expect(apply).toBeChecked());
    expect(calls.find(call => call.method === 'PUT')?.body).toEqual({ autoApply: true });
    const log = within(section.getByRole('list', { name: '自动进化记录' }));
    expect(log.getByText('「生成页面」推理强度 medium → low')).toBeVisible();
    expect(log.getByText('「生成页面」没能自动调整：画布正在运行')).toBeVisible();
    expect(log.getByText('自动重跑了上次没完成的节点')).toBeVisible();
    expect(log.getByText('「生成页面」推理强度 high → medium（已改回）')).toBeVisible();
    expect(log.getByText('「生成页面」正在调整推理强度 模型默认 → low')).toBeVisible();
    // Only a change that stands can be taken back (one taken back, or changed since, cannot).
    const undo = log.getAllByRole('button', { name: '改回' });
    expect(undo).toHaveLength(1);
    fireEvent.click(undo[0]);
    expect(onRevert).toHaveBeenCalledWith(entry());
  });

  it('shows what the newest switch says, whatever an older read answers after it', async () => {
    let answer!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { answer = resolve; });
    let reads = 0;
    server(call => {
      if (call.url.endsWith('/canvases/canvas-a/lessons')) return json({ lessons: [], runs: [] });
      if (call.url.includes('/memory')) return json({ items: [] });
      if (call.url.endsWith('/canvases/canvas-a/evolution') && call.method === 'GET') {
        reads += 1;
        return reads === 1 ? held : json(evolution({ autoApply: { on: false, since: null } }));
      }
      if (call.url.endsWith('/canvases/canvas-a/evolution') && call.method === 'PUT') return json(evolution());
    });
    // React's development remount reads the section twice; the first read is held.
    render(<StrictMode><SaaSPreferencesProvider><LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} /></SaaSPreferencesProvider></StrictMode>);
    const section = within(await screen.findByRole('region', { name: '自动进化' }));
    const apply = section.getByRole('checkbox', { name: /自动应用建议/ });
    expect(apply).not.toBeChecked();
    fireEvent.click(apply);
    await waitFor(() => expect(apply).toBeChecked());
    // The held read answers last, with the switch off: the switch's answer stands.
    answer(json(evolution({ autoApply: { on: false, since: null } })));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(apply).toBeChecked();
    expect(reads).toBe(2);
  });

  it('shows a reader the switches without letting them change anything, and shows nothing it cannot read', async () => {
    server(routes(() => evolution({ log: [entry()] })));
    panel({ readOnly: true, onRevert: vi.fn() });
    const section = within(await screen.findByRole('region', { name: '自动进化' }));
    expect(section.getByRole('checkbox', { name: /自动应用建议/ })).toBeDisabled();
    expect(section.getByRole('checkbox', { name: /自动重跑没完成的节点/ })).toBeChecked();
    expect(section.queryByRole('button', { name: '改回' })).toBeNull();
    cleanup();
    server(call => call.url.endsWith('/evolution') ? json({ error: { code: 'not_found', message: 'missing' } }, 404) : routes(() => evolution())(call));
    panel();
    await screen.findByText(/还没有经验/);
    expect(screen.queryByRole('region', { name: '自动进化' })).toBeNull();
  });

  it('words each kind of entry', () => {
    expect(evolutionEntryText(entry({ kind: 'revert', from: 'low', to: 'medium' }), zh)).toBe('「生成页面」改回 medium：调整之后的运行都没完成');
    expect(evolutionEntryText(entry({ kind: 'revert', auto: false, from: 'low', to: '' }), zh)).toBe('「生成页面」被手动改回 模型默认');
    expect(evolutionEntryText(entry({ nodeTitle: '' }), zh)).toBe('「已不在画布上的节点」推理强度 medium → low');
    expect(evolutionEntryText(entry({ kind: 'revert', state: 'claimed', to: 'medium' }), zh)).toBe('「生成页面」正在改回 medium');
    expect(evolutionEntryText(entry({ state: 'expired' }), zh)).toBe('「生成页面」的调整没有完成：页面在完成前关闭了');
    expect(evolutionEntryText(entry({ kind: 'skip', reason: '' }), zh)).toBe('「生成页面」的调整没有完成：页面在完成前关闭了');
  });
});

describe('the evolution view', () => {
  it('reads a view whole, leaves out an entry of a kind or state it does not know, and refuses one it cannot read', async () => {
    server(call => call.url.endsWith('/canvases/canvas-a/evolution') ? json({ ...evolution({ log: [entry(), entry({ id: 'x', kind: 'future' as EvolutionEntry['kind'] }),
      entry({ id: 'y', state: 'later' as EvolutionEntry['state'] })] }) }) : undefined);
    const view = await readCanvasEvolution('tenant-a', 'canvas-a');
    expect(view.log.map(item => item.id)).toEqual(['e1']);
    for (const broken of [{ ...evolution(), pending: { apply: [{ ...step(), revertsId: 'e1' }], revert: [], rerun: null } },
      { ...evolution(), pending: { apply: [], revert: [], rerun: { graphId: 'g1', operationId: 'autorerun:g1', scope: [] } } },
      { ...evolution(), latestRun: { id: 'g1' } }, { ...evolution(), limits: { rerunsPerDay: 3 } },
      { ...evolution(), log: [{ ...entry(), standing: undefined }] }]) {
      cleanup(); vi.unstubAllGlobals();
      server(() => json(broken));
      await expect(readCanvasEvolution('tenant-a', 'canvas-a')).rejects.toMatchObject({ code: 'invalid_evolution_response' });
    }
  });
});
