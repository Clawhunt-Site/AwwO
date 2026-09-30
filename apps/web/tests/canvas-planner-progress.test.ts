import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDocument } from '../src/canvas/canvasDoc';
import { observedProgress, requestCanvasPlan, type PlanProgress } from '../src/canvas/canvasPlanning';
import {
  PLAN_OPEN_TIMEOUT_MS, PLAN_STALL_TIMEOUT_MS, clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave,
  countPlannedEdges, countPlannedNodes,
} from '../src/saas/canvasBridge';

const tenant = { id: 'tenant', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 } as const;
const plan = { version: 1, summary: '增加数据与后端节点', operations: [
  { type: 'add_node', ref: 'data', templateId: 'data', title: '数据', persona: '', inputValues: {} },
  { type: 'add_node', ref: 'backend', templateId: 'backend', title: '后端', persona: '', inputValues: {} },
  { type: 'connect', fromNode: 'data', fromField: 'schema', toNode: 'backend', toField: 'schema' },
] };
const planText = JSON.stringify(plan);

/** A progress row exactly as the Go host writes it for a planner run: counts, never the plan. */
const hostProgress = (stage: 'thinking' | 'streaming', counts: Partial<Record<'characters' | 'nodes' | 'edges' | 'reasoning', number>> & { template?: string } = {}) =>
  ({ type: 'progress', stage, characters: 0, nodes: 0, edges: 0, reasoning: 0, ...counts });

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
const stages = (seen: PlanProgress[]) => seen.map(item => item.stage).filter((stage, index, all) => stage !== all[index - 1]);
afterEach(() => { clearSaaSCanvas(); configureSaaSCanvasSave(null); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('canvas planning reports observed progress instead of an indeterminate wait', () => {
  it('follows the host from queued through thinking and writing to validation, with its real counts', async () => {
    online();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      // Exactly the rows Go writes: no proposal fragment appears before the completed event.
      : sse(frames(
        { type: 'queued' },
        { type: 'running' },
        hostProgress('thinking', { reasoning: 320 }),
        hostProgress('streaming', { characters: 60, reasoning: 320 }),
        hostProgress('streaming', { characters: 120, nodes: 1, reasoning: 320, template: 'data' }),
        // Node 2 has been declared but has not named its template yet.
        hostProgress('streaming', { characters: 150, nodes: 2, reasoning: 320 }),
        hostProgress('streaming', { characters: 200, nodes: 2, reasoning: 320, template: 'backend' }),
        hostProgress('streaming', { characters: 260, nodes: 2, edges: 1, reasoning: 320, template: 'backend' }),
        { type: 'completed', text: planText },
      ))));
    const seen: PlanProgress[] = [];
    await expect(requestCanvasPlan('做数据到后端的流程', emptyDocument(), [], new AbortController().signal, 'zh',
      progress => seen.push({ ...progress }))).resolves.toMatchObject({ version: 1, summary: plan.summary });

    // Every distinct stage the run really passed through is reported, in order.
    expect(stages(seen)).toEqual(['queued', 'running', 'thinking', 'streaming', 'validating']);
    expect(seen.find(item => item.stage === 'thinking')).toMatchObject({ reasoning: 320, characters: 0 });
    expect(seen.map(item => item.template).filter(Boolean)).toEqual(expect.arrayContaining(['data', 'backend']));
    // Node 2 is never shown under node 1's template while its own is still unwritten.
    expect(seen.some(item => item.nodes === 2 && item.template === 'data')).toBe(false);
    // The final totals are settled on the whole proposal, never a coalesced partial.
    expect(seen.at(-1)).toMatchObject({ stage: 'validating', characters: [...planText].length, nodes: 2, edges: 1, attempt: 1 });
    // Counts only ever move forward, so the surface cannot appear to lose progress.
    for (const key of ['characters', 'nodes', 'edges'] as const) {
      expect(seen.map(item => item[key])).toEqual([...seen.map(item => item[key])].sort((a, b) => a - b));
    }
  });

  it('keeps only measured fields and forwards a template only as an identifier', async () => {
    online();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      : sse(frames(
        hostProgress('streaming', { characters: 40, nodes: 1, template: 'data' }),
        { ...hostProgress('streaming', { characters: 80, nodes: 1 }), template: '<img src=x onerror=alert(1)>' },
        { ...hostProgress('streaming', { characters: 90, nodes: 1 }), characters: -5, nodes: 'many', percent: 50 },
        { type: 'completed', text: planText },
      ))));
    const seen: PlanProgress[] = [];
    await requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh', progress => seen.push({ ...progress }));
    for (const progress of seen) {
      expect(Object.keys(progress).filter(key => key !== 'template').sort()).toEqual(['attempt', 'characters', 'edges', 'nodes', 'reasoning', 'stage']);
      expect(progress).not.toHaveProperty('percent');
      if (progress.template !== undefined) expect(progress.template).toBe('data');
    }
    // A malformed count keeps the last real one instead of erasing or inventing work.
    expect(seen.some(item => item.characters < 0)).toBe(false);
  });

  it('follows the operation the host reports and names a node only as a closed-set template', async () => {
    online();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      // Rows in the order a real model wrote them, several inside one coalescing interval.
      : sse(frames(
        { ...hostProgress('streaming', { characters: 60, nodes: 1, template: 'data' }), operation: 'add_node', target: 'data' },
        { ...hostProgress('streaming', { characters: 120, nodes: 2, template: 'backend' }), operation: 'add_node', target: 'backend' },
        { ...hostProgress('streaming', { characters: 150, nodes: 2, template: 'backend' }), operation: 'set_input', target: 'backend' },
        { ...hostProgress('streaming', { characters: 170, nodes: 2, template: 'backend' }), operation: 'set_input', target: 'api-node' },
        { ...hostProgress('streaming', { characters: 180, nodes: 2, template: 'backend' }), operation: 'exec', target: 'data' },
        { ...hostProgress('streaming', { characters: 190, nodes: 2, template: 'backend' }), target: 'data' },
        { ...hostProgress('streaming', { characters: 200, nodes: 2, template: 'backend' }), operation: 'set_input', target: 'data' },
        { ...hostProgress('streaming', { characters: 260, nodes: 2, edges: 1, template: 'backend' }), operation: 'connect' },
        { type: 'completed', text: planText },
      ))));
    const seen: PlanProgress[] = [];
    await requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh', progress => seen.push({ ...progress }));
    const steps = seen.filter(item => item.stage === 'streaming').map(item => `${item.operation ?? ''}:${item.target ?? ''}`)
      .filter((step, index, all) => step !== all[index - 1]);
    // Every operation change reaches the reader, however close together the rows were written.
    expect(steps).toEqual(['add_node:data', 'add_node:backend', 'set_input:backend', 'set_input:', ':', 'set_input:data', 'connect:', ':']);
    for (const item of seen) {
      // A target never stands without the operation it was reported for, and nothing outside the
      // closed sets (a ref, an unknown operation) is ever forwarded.
      if (item.target !== undefined) expect(item.operation).toBeDefined();
      expect([undefined, 'add_node', 'set_input', 'connect']).toContain(item.operation);
      expect([undefined, 'data', 'backend']).toContain(item.target);
      expect(Object.keys(item).filter(key => !['template', 'operation', 'target'].includes(key)).sort())
        .toEqual(['attempt', 'characters', 'edges', 'nodes', 'reasoning', 'stage']);
    }
    // Once the whole proposal has arrived, the operation being written is over.
    expect(seen.at(-1)).toMatchObject({ stage: 'validating', nodes: 2, edges: 1 });
    expect(seen.at(-1)?.operation).toBeUndefined();
    expect(seen.at(-1)?.target).toBeUndefined();
  });

  it('merges an operation over what was observed only as a whole snapshot', () => {
    const start: PlanProgress = { stage: 'streaming', characters: 10, nodes: 1, edges: 0, reasoning: 0, attempt: 1 };
    const filling = observedProgress({ type: 'progress', stage: 'streaming', characters: 20, nodes: 1, operation: 'set_input', target: 'users' }, start);
    expect(filling).toMatchObject({ operation: 'set_input', target: 'users' });
    // A row without an operation means none is observed; the previous one must not stand in.
    expect(observedProgress({ type: 'progress', stage: 'streaming', characters: 30, nodes: 1 }, filling).operation).toBeUndefined();
    expect(observedProgress({ type: 'progress', stage: 'streaming', characters: 30, nodes: 1, target: 'users' }, filling).target).toBeUndefined();
    expect(observedProgress({ type: 'progress', stage: 'streaming', characters: 30, nodes: 1, operation: 'set_input', target: 'Users' }, filling))
      .not.toHaveProperty('target');
    expect(observedProgress({ type: 'progress', stage: 'streaming', characters: 30, nodes: 1, operation: 'set_execution' }, filling).operation)
      .toBe('set_execution');
    // A connection concerns two nodes, so a target beside one is never kept.
    const connecting = observedProgress({ type: 'progress', stage: 'streaming', characters: 40, nodes: 2, edges: 1, operation: 'connect', target: 'users' }, filling);
    expect(connecting.operation).toBe('connect');
    expect(connecting).not.toHaveProperty('target');
  });

  it('forwards a target from the host only beside an operation on one node', async () => {
    online();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      : sse(frames(
        { ...hostProgress('streaming', { characters: 60, nodes: 2, edges: 1 }), operation: 'connect', target: 'data' },
        { ...hostProgress('streaming', { characters: 80, nodes: 2, edges: 1 }), operation: 'disconnect', target: 'backend' },
        { type: 'completed', text: planText },
      ))));
    const seen: PlanProgress[] = [];
    await requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh', progress => seen.push({ ...progress }));
    expect(seen.map(item => item.operation).filter(Boolean)).toEqual(expect.arrayContaining(['connect', 'disconnect']));
    expect(seen.some(item => item.target !== undefined)).toBe(false);
  });

  it('forwards a template only beside the node count the host reported it with', async () => {
    online();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      : sse(frames(hostProgress('streaming', { characters: 40, nodes: 1, template: 'data' }),
        { type: 'progress', stage: 'streaming', characters: 60, template: 'backend' },
        { type: 'progress', stage: 'streaming', characters: 70, nodes: '2', template: 'backend' },
        { type: 'completed', text: planText }))));
    const seen: PlanProgress[] = [];
    await requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh', progress => seen.push({ ...progress }));
    expect(seen.some(item => item.nodes === 1 && item.template === 'backend')).toBe(false);
  });

  it('never carries a template onto a node that arrived after the last coalesced row', async () => {
    online();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      // The last row the host wrote named node 1; node 2 was written before the next row was due.
      : sse(frames(hostProgress('streaming', { characters: 90, nodes: 1, template: 'data' }), { type: 'completed', text: planText }))));
    const seen: PlanProgress[] = [];
    await requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh', progress => seen.push({ ...progress }));
    expect(seen.some(item => item.nodes === 2 && item.template === 'data')).toBe(false);
    expect(seen.at(-1)).toMatchObject({ stage: 'validating', nodes: 2 });
  });

  it('merges a host frame over what was observed, keeping real counts when a field is malformed', () => {
    const previous: PlanProgress = { stage: 'streaming', characters: 50, nodes: 2, edges: 1, reasoning: 9, template: 'data', attempt: 2 };
    // A malformed template is never shown, and never replaced by the previous node's either.
    expect(observedProgress({ stage: 'invented', characters: 'x', nodes: 3.9, edges: -1, reasoning: Infinity, template: 'Bad Id' }, previous))
      .toEqual({ stage: 'streaming', characters: 50, nodes: 3, edges: 0, reasoning: 9, attempt: 2 });
    // An identifier outside the closed template set is dropped just the same.
    expect(observedProgress({ stage: 'streaming', nodes: 3, template: 'private_role' }, previous)).not.toHaveProperty('template');
    // A template is only kept beside the node count it was reported with.
    for (const nodes of [undefined, '3', -1, Number.NaN]) {
      expect(observedProgress({ stage: 'streaming', nodes, template: 'users' }, previous)).not.toHaveProperty('template');
    }
    // A frame is a whole snapshot: no template means the newest node has not named one yet.
    expect(observedProgress({ stage: 'streaming', characters: 60, nodes: 3 }, previous)).not.toHaveProperty('template');
    expect(observedProgress({ stage: 'streaming', nodes: 3, template: 'users' }, previous)).toMatchObject({ nodes: 3, template: 'users' });
  });

  it('marks every report of the single retry as the second attempt', async () => {
    online();
    let runs = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/plan')) { runs += 1; return new Response(JSON.stringify({ id: `planning-run-${runs}` }), { status: 202 }); }
      // The first run completes with text that is not a plan; the retry succeeds.
      return sse(runs === 1
        ? frames({ type: 'running' }, hostProgress('streaming', { characters: 12 }), { type: 'completed', text: '{"version":1,' })
        : frames({ type: 'running' }, hostProgress('streaming', { characters: 30, nodes: 1 }), { type: 'completed', text: planText }));
    }));
    const seen: PlanProgress[] = [];
    await expect(requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh',
      progress => seen.push({ ...progress }))).resolves.toMatchObject({ version: 1 });
    const retryAt = seen.findIndex(item => item.stage === 'retrying');
    expect(retryAt).toBeGreaterThan(0);
    expect(seen.slice(0, retryAt).every(item => item.attempt === 1)).toBe(true);
    // The retry starts its counts over and says so on every report until it ends.
    expect(seen[retryAt]).toMatchObject({ characters: 0, nodes: 0, edges: 0, attempt: 2 });
    expect(seen.slice(retryAt).every(item => item.attempt === 2)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ stage: 'validating', attempt: 2 });
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
    for (const frame of [hostProgress('thinking', { reasoning: 90 }), hostProgress('streaming', { characters: 60 }), hostProgress('streaming', { characters: 200, nodes: 2 })]) {
      await vi.advanceTimersByTimeAsync(PLAN_STALL_TIMEOUT_MS - 5_000);
      stream.push(frame);
      await vi.advanceTimersByTimeAsync(0);
    }
    stream.push({ type: 'completed', text: planText });
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
      : sse(frames({ type: 'queued' }, { type: 'running' }, hostProgress('streaming', { characters: 12, nodes: 1 })))));
    await expect(requestCanvasPlan('做流程', document, [], new AbortController().signal, 'zh')).rejects.toThrow(/连接中断/);
    expect(document).toMatchObject({ updatedAt: 99, nodes: [], edges: [] });
  });

  it('reads a local planner progress stream with the same stages and counts', async () => {
    // No SaaS scope: the native gateway streams the same frame vocabulary when it can.
    vi.stubGlobal('fetch', vi.fn(async () => sse(frames(
      { type: 'progress', stage: 'running', characters: 0, nodes: 0, edges: 0, reasoning: 0 },
      { type: 'progress', stage: 'thinking', characters: 0, nodes: 0, edges: 0, reasoning: 45 },
      { type: 'progress', stage: 'streaming', characters: planText.length, nodes: 2, edges: 1, reasoning: 45, template: 'backend' },
      { type: 'plan', plan, provider: 'codex' },
    ))));
    const seen: PlanProgress[] = [];
    await expect(requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh',
      progress => seen.push({ ...progress }))).resolves.toMatchObject({ version: 1 });
    expect(stages(seen)).toEqual(['running', 'thinking', 'streaming', 'validating']);
    expect(seen.at(-1)).toMatchObject({ nodes: 2, edges: 1, reasoning: 45, template: 'backend' });
  });

  it('keeps the non-streaming planner working and reports only what it can observe', async () => {
    // No SaaS scope: an older native gateway answers with one JSON body and no run events.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ plan }), { headers: { 'Content-Type': 'application/json' } })));
    const seen: PlanProgress[] = [];
    await expect(requestCanvasPlan('做流程', emptyDocument(), [], new AbortController().signal, 'zh',
      progress => seen.push(progress))).resolves.toMatchObject({ version: 1 });
    expect(seen.map(item => item.stage)).toEqual(['validating']);
  });
});

describe('planned-structure counting measures the proposal, not incidental text', () => {
  it('counts whole quoted operation literals only', () => {
    expect(countPlannedNodes('')).toBe(0);
    expect(countPlannedNodes(planText)).toBe(2);
    expect(countPlannedEdges(planText)).toBe(1);
    // "disconnect" must not read as "connect", and a field's own type value is not an operation.
    const other = JSON.stringify({ operations: [
      { type: 'disconnect', edgeId: 'e1' },
      { type: 'add_field', nodeId: 'n', side: 'output', field: { id: 'f', type: 'markdown' } },
    ] });
    expect(countPlannedNodes(other)).toBe(0);
    expect(countPlannedEdges(other)).toBe(0);
    // A partial proposal counts the operations whose marker has fully arrived.
    expect(countPlannedNodes('{"operations":[{"type":"add_node","ref":"a"},{"type":"add_n')).toBe(1);
  });
});
