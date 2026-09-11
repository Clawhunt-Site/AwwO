import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDocument } from '../src/canvas/canvasDoc';
import { requestCanvasPlan, type PlanProgress } from '../src/canvas/canvasPlanning';
import {
  PLAN_OPEN_TIMEOUT_MS, PLAN_STALL_TIMEOUT_MS, clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave,
  countPlannedNodes, createPlannedNodeCounter,
} from '../src/saas/canvasBridge';

const tenant = { id: 'tenant', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 } as const;
const plan = { version: 1, summary: '增加数据与后端节点', operations: [
  { type: 'add_node', ref: 'data', templateId: 'data', title: '数据', persona: '', inputValues: {} },
  { type: 'add_node', ref: 'backend', templateId: 'backend', title: '后端', persona: '', inputValues: {} },
  { type: 'connect', fromNode: 'data', fromField: 'schema', toNode: 'backend', toField: 'schema' },
] };

const frames = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const sse = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
/** A run that opens its event stream and then never reports anything, like a wedged runtime.
 * The body errors when the signal aborts because that is what a real fetch body does: aborting the
 * signal passed to fetch() rejects an already-pending read on an open, idle body with AbortError.
 * That platform behaviour was verified directly against a live HTTP server, not assumed — it is
 * what lets the stall backstop interrupt the read at all. */
const silent = (signal?: AbortSignal) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
  },
}), { headers: { 'Content-Type': 'text/event-stream' } });

// The host's own copy follows the document language, so pin it where the message is asserted.
/** A run whose events are pushed on demand, so a test can hold the stream open across time. */
function controllable(signal?: AbortSignal) {
  const encoder = new TextEncoder();
  let push!: (event: unknown) => void;
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      push = event => { if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
      finish = () => { if (open) { open = false; controller.close(); } };
      signal?.addEventListener('abort', () => {
        if (!open) return;
        open = false;
        controller.error(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    },
  });
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), push, finish };
}

const online = (lang = 'zh-CN') => {
  document.documentElement.lang = lang;
  configureSaaSCanvas({ tenant, canvasId: 'canvas' });
  configureSaaSCanvasSave(async () => {});
};
afterEach(() => { clearSaaSCanvas(); configureSaaSCanvasSave(null); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('canvas planning reports observed progress instead of an indeterminate wait', () => {
  it('surfaces queued, running and streaming stages with the real measured counts', async () => {
    online();
    const text = JSON.stringify(plan);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      : sse(frames(
        { type: 'queued' },
        { type: 'running' },
        { type: 'text_delta', delta: text.slice(0, 40) },
        { type: 'text_delta', delta: text.slice(40) },
        { type: 'completed', text },
      ))));
    const seen: PlanProgress[] = [];
    await expect(requestCanvasPlan('做数据到后端的流程', emptyDocument(), [], new AbortController().signal, 'zh',
      progress => seen.push(progress))).resolves.toMatchObject({ version: 1, summary: plan.summary });

    // Every distinct stage the run really passed through is reported, in order.
    expect(seen.map(item => item.stage).filter((stage, index, all) => stage !== all[index - 1]))
      .toEqual(['queued', 'running', 'streaming', 'validating']);
    // The final measured totals are the true ones, never a coalesced partial or a reset.
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ stage: 'validating', characters: text.length, nodes: 2 });
    // Counts only ever move forward, so the UI cannot appear to lose progress.
    expect(seen.map(item => item.characters)).toEqual([...seen.map(item => item.characters)].sort((a, b) => a - b));
  });

  it('reports no fabricated completion ratio, only measurements the run actually produced', async () => {
    online();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      : sse(frames({ type: 'completed', text: JSON.stringify(plan) }))));
    const seen: PlanProgress[] = [];
    await requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh', progress => seen.push(progress));
    for (const progress of seen) {
      expect(Object.keys(progress).sort()).toEqual(['characters', 'nodes', 'stage']);
      expect(progress).not.toHaveProperty('percent');
    }
  });

  it('stops a planning run that reports nothing at all, and leaves the canvas unchanged', async () => {
    vi.useFakeTimers();
    online();
    const document = { ...emptyDocument(), updatedAt: 4321 };
    const cancelled: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/plan')) return new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 });
      if (url.endsWith('/cancel')) { cancelled.push(url); return new Response(JSON.stringify({ id: 'planning-run', status: 'cancelled', terminal: true })); }
      return silent(init.signal ?? undefined);
    }));
    const seen: PlanProgress[] = [];
    const pending = requestCanvasPlan('做流程', document, [], new AbortController().signal, 'zh', progress => seen.push(progress));
    const settled = expect(pending).rejects.toThrow(/没有任何进展/);
    await vi.advanceTimersByTimeAsync(PLAN_STALL_TIMEOUT_MS + 1_000);
    await settled;

    // The caller learned the run was accepted before it went silent.
    expect(seen.map(item => item.stage)).toContain('queued');
    // A run the caller can no longer observe is cancelled, so it neither bills nor blocks a retry.
    expect(cancelled).toEqual(['/api/v1/tenants/tenant/runs/planning-run/cancel']);
    expect(document).toMatchObject({ updatedAt: 4321, nodes: [], edges: [] });
  });

  it('keeps the stall backstop above the server deadlines it is meant to outlast', () => {
    // The server bounds the work: Go `RunTimeout` defaults to 180s and the Pi model call to 120s,
    // and a run that exceeds them is reported as `failed`. If this client backstop were shorter it
    // would cancel healthy slow runs before the server ever got to answer — the failure mode this
    // pins. Raising AWWO_RUN_TIMEOUT past this value must come with raising this too.
    expect(PLAN_STALL_TIMEOUT_MS).toBeGreaterThan(180_000);
    // Opening a stream is one request, not model work, so it must not wait a whole run deadline.
    expect(PLAN_OPEN_TIMEOUT_MS).toBeLessThan(PLAN_STALL_TIMEOUT_MS);
  });

  it('does not stop a slow run that keeps reporting, however long the model takes overall', async () => {
    vi.useFakeTimers();
    online();
    const text = JSON.stringify(plan);
    const cancelled: string[] = [];
    let stream!: ReturnType<typeof controllable>;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/plan')) return new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 });
      if (url.endsWith('/cancel')) { cancelled.push(url); return new Response(JSON.stringify({ status: 'cancelled' })); }
      stream = controllable(init.signal ?? undefined);
      return stream.response;
    }));
    const pending = requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh');
    await vi.advanceTimersByTimeAsync(0);

    // Total elapsed time far exceeds one stall window; each individual gap stays inside it.
    for (const chunk of [text.slice(0, 20), text.slice(20, 60), text.slice(60)]) {
      await vi.advanceTimersByTimeAsync(PLAN_STALL_TIMEOUT_MS - 5_000);
      stream.push({ type: 'text_delta', delta: chunk });
      await vi.advanceTimersByTimeAsync(0);
    }
    stream.push({ type: 'completed', text });
    stream.finish();
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toMatchObject({ version: 1, summary: plan.summary });
    expect(cancelled).toEqual([]);
  });

  it('treats a stream that ends without a proposal as a failure, never as an empty plan', async () => {
    online();
    const document = { ...emptyDocument(), updatedAt: 99 };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      : sse(frames({ type: 'queued' }, { type: 'running' }, { type: 'text_delta', delta: '{"version":1' }))));
    await expect(requestCanvasPlan('做流程', document, [], new AbortController().signal, 'zh')).rejects.toThrow(/连接中断/);
    expect(document).toMatchObject({ updatedAt: 99, nodes: [], edges: [] });
  });

  it('keeps the non-streaming planner working and reports only what it can observe', async () => {
    // No SaaS scope: the native gateway answers with one JSON body and no run events.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ plan }), { headers: { 'Content-Type': 'application/json' } })));
    const seen: PlanProgress[] = [];
    await expect(requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh',
      progress => seen.push(progress))).resolves.toMatchObject({ version: 1 });
    expect(seen.map(item => item.stage)).toEqual(['validating']);
  });
});

describe('planned-node counting measures the proposal, not incidental text', () => {
  it('counts whole quoted operation literals only', () => {
    expect(countPlannedNodes('')).toBe(0);
    expect(countPlannedNodes(JSON.stringify(plan))).toBe(2);
    // "disconnect" must not read as "connect", and a field's own type value is not an operation.
    expect(countPlannedNodes(JSON.stringify({ operations: [
      { type: 'disconnect', edgeId: 'e1' },
      { type: 'add_field', nodeId: 'n', side: 'output', field: { id: 'f', type: 'markdown' } },
    ] }))).toBe(0);
    // A partially streamed proposal counts the nodes whose marker has fully arrived.
    expect(countPlannedNodes('{"operations":[{"type":"add_node","ref":"a"},{"type":"add_n')).toBe(1);
  });

  it('counts each marker exactly once however the stream is chunked', () => {
    const text = JSON.stringify(plan);
    // Every possible split point must agree with counting the whole text at once, so a marker
    // straddling a chunk boundary is neither missed nor double counted.
    for (let cut = 0; cut <= text.length; cut += 1) {
      const count = createPlannedNodeCounter();
      count(text.slice(0, cut));
      expect(count(text.slice(cut))).toBe(2);
    }
    // Also correct when chunks are smaller than the marker itself, one character at a time.
    const perCharacter = createPlannedNodeCounter();
    let last = 0;
    for (const character of text) last = perCharacter(character);
    expect(last).toBe(2);
    // An empty chunk reports the running total without disturbing the boundary window.
    const counter = createPlannedNodeCounter();
    counter('{"type":"add_no');
    expect(counter('')).toBe(0);
    expect(counter('de","ref":"a"}')).toBe(1);
  });
});
