import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { emptyDocument } from '../src/canvas/canvasDoc';
import { applyCanvasPlan, canvasPlanRevision, planContextCondensed, planNewNodeModel } from '../src/canvas/canvasPlan';
import { canvasStorageKey, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { buildPlanningContext, cancelCanvasPlanRecovery, fitPlanningContext, readCanvasPlanRecovery, requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { canvasFetch, clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { onSessionEnded, trackSignedInSession } from '../src/saas/api';
import { PLAN_STALL_TIMEOUT_MS } from '../src/saas/canvasBridge';
import { plannerRecovery } from '../src/saas/plannerRecovery';
import { gzipSync, strFromU8, strToU8 } from 'fflate';

const tenant = { id: 'recovery-tenant', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const proposal = { version: 1, summary: 'Recovered original proposal', operations: [] };
const run = { id: 'original-plan', status: 'running', terminal: false };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const events = (...values: unknown[]) => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
function online(user = 'recovery-user', canvasId = 'recovery-canvas') {
  configureCanvasStorage(user, tenant.id, canvasId);
  configureSaaSCanvas({ tenant, canvasId });
  configureSaaSCanvasSave(async () => 1);
}
const request = (prompt = 'Build a report') => requestCanvasPlan(prompt, emptyDocument(), [], new AbortController().signal, 'en');
beforeEach(() => { localStorage.clear(); trackSignedInSession(false); document.documentElement.lang = 'en'; online(); });
afterEach(() => { clearSaaSCanvas(); trackSignedInSession(false); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('accepted planner run recovery', () => {
  it('recovers the completed proposal through GET after an event stream ends early, without a second admission', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/plan')) return json(run, 202);
      if (url.endsWith('/events')) return events({ type: 'running' });
      return json({ ...run, status: 'completed', terminal: true, output: JSON.stringify(proposal) });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).resolves.toEqual(proposal);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/runs/original-plan'))).toBe(true);
  });

  it('keeps the accepted run across a canvas remount and only resumes that run on the next request', async () => {
    let completed = false;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/plan')) return json(run, 202);
      if (url.endsWith('/events')) return events({ type: 'running' });
      return json(completed ? { ...run, status: 'completed', terminal: true, output: JSON.stringify(proposal) } : run);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    clearSaaSCanvas(); online(); completed = true;
    await expect(request()).resolves.toEqual(proposal);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('refuses admission if the recovery pointer cannot be stored', async () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : events({ type: 'completed', text: JSON.stringify(proposal) }));
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_storage' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the accepted run when opening its event stream fails', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/plan')) return json(run, 202);
      if (url.endsWith('/events')) throw new TypeError('Connection lost');
      return json({ ...run, status: 'completed', terminal: true, output: JSON.stringify(proposal) });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).resolves.toEqual(proposal);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('reconnects an active run once and consumes its durable terminal event', async () => {
    let streams = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/plan')) return json(run, 202);
      if (url.endsWith('/events')) return ++streams === 1 ? events({ type: 'running' }) : events({ type: 'completed', text: JSON.stringify(proposal) });
      return json(run);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).resolves.toEqual(proposal);
    expect(streams).toBe(2);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
    expect(await readCanvasPlanRecovery(emptyDocument())).toEqual({ pending: false });
  });

  it('does not submit changed intent or a changed graph while a prior run is unresolved', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : url.endsWith('/events') ? events() : json(run));
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    await expect(request('A different task')).rejects.toMatchObject({ code: 'planning_recovery_required' });
    const changed = { ...emptyDocument(), execution: { mode: 'review' as const, maxRounds: 2 } };
    await expect(requestCanvasPlan('Build a report', changed, [], new AbortController().signal, 'en')).rejects.toMatchObject({ code: 'planning_recovery_required' });
    expect(await readCanvasPlanRecovery(changed)).toMatchObject({ pending: true, matches: false, prompt: 'Build a report' });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('ignores appended conversation errors when recovering the same intent and graph', async () => {
    let completed = false;
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : url.endsWith('/events') ? events()
      : json(completed ? { ...run, status: 'completed', output: JSON.stringify(proposal) } : run));
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    completed = true;
    await expect(requestCanvasPlan('Build a report', emptyDocument(), [{ id: 'connection-error', role: 'assistant', content: 'Connection lost', status: 'error' }], new AbortController().signal, 'en')).resolves.toEqual(proposal);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('uses the persisted operationId if admission committed but its response was lost', async () => {
    let operationId = '';
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/plan')) { operationId = JSON.parse(init.body as string).operationId; throw new TypeError('Response lost'); }
      expect(url).toContain(`operationId=${operationId}`);
      return json({ items: [{ ...run, status: 'completed', output: JSON.stringify(proposal) }] });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    clearSaaSCanvas(); online();
    await expect(request()).resolves.toEqual(proposal);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('explicitly recovers a never-admitted request with its exact original payload and idempotency key', async () => {
    const payloads: string[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/plan')) {
        payloads.push(init.body as string);
        if (payloads.length === 1) throw new TypeError('Offline before admission');
        return json(run, 202);
      }
      if (url.endsWith('/events')) return events({ type: 'completed', text: JSON.stringify(proposal) });
      return json({ items: [] });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    clearSaaSCanvas(); online();
    await expect(requestCanvasPlan('Build a report', emptyDocument(), [{ id: 'new-error', role: 'assistant', content: 'Changed history' }], new AbortController().signal, 'en')).resolves.toEqual(proposal);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(await readCanvasPlanRecovery(emptyDocument())).toEqual({ pending: false });
  });

  it('does not admit an unknown operation merely to cancel it', async () => {
    const fetch = vi.fn(async (url: string) => { if (url.endsWith('/plan')) throw new TypeError('Unknown admission'); return json({ items: [] }); });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    await expect(cancelCanvasPlanRecovery((await readCanvasPlanRecovery(emptyDocument())).operationId!)).rejects.toMatchObject({ code: 'planning_recovery_required' });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
    expect(await readCanvasPlanRecovery(emptyDocument())).toMatchObject({ pending: true });
  });

  it('keeps an uncertain admission when replay reports an idempotency conflict', async () => {
    let submissions = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/plan')) {
        if (++submissions === 1) throw new TypeError('Response lost');
        return json({ error: { code: 'idempotency_conflict', message: 'Conflict' } }, 409);
      }
      return json({ items: [] });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    await expect(request()).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await readCanvasPlanRecovery(emptyDocument())).toMatchObject({ pending: true });
  });

  it('retains the admission operation if saving its returned run id fails', async () => {
    const set = localStorage.setItem.bind(localStorage);
    let writes = 0;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (++writes === 2) throw new DOMException('Full', 'QuotaExceededError'); set(key, value); });
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : json({ items: [{ ...run, status: 'completed', output: JSON.stringify(proposal) }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_storage' });
    vi.restoreAllMocks(); clearSaaSCanvas(); online();
    await expect(request()).resolves.toEqual(proposal);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('does not expose a prior user or canvas recovery record', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : url.endsWith('/events') ? events() : json(run));
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    online('other-user');
    expect(await readCanvasPlanRecovery(emptyDocument())).toEqual({ pending: false });
    online('recovery-user', 'other-canvas');
    expect(await readCanvasPlanRecovery(emptyDocument())).toEqual({ pending: false });
    online();
    expect(await readCanvasPlanRecovery(emptyDocument())).toMatchObject({ pending: true, matches: true });
  });

  it('preserves the journal and triggers the ordinary signed-out flow on recovery GET 401', async () => {
    trackSignedInSession(true);
    const ended = vi.fn();
    const unsubscribe = onSessionEnded(ended);
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : url.endsWith('/events') ? events()
      : json({ error: { code: 'unauthorized', message: 'Expired' } }, 401));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(request()).rejects.toMatchObject({ code: 'unauthorized' });
      expect(ended).toHaveBeenCalledOnce();
      expect(await readCanvasPlanRecovery(emptyDocument())).toMatchObject({ pending: true });
      expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
    } finally { unsubscribe(); }
  });

  it('keeps a run recoverable until cancellation has an authoritative terminal acknowledgement', async () => {
    let confirm = false;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/plan')) return json(run, 202);
      if (url.endsWith('/events')) return events();
      if (url.endsWith('/cancel')) return confirm ? json({ ...run, status: 'cancelled', terminal: true }) : json({ error: { code: 'unavailable' } }, 503);
      return json(run);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    await expect(cancelCanvasPlanRecovery((await readCanvasPlanRecovery(emptyDocument())).operationId!)).rejects.toMatchObject({ code: 'planning_recovery_required' });
    expect(await readCanvasPlanRecovery(emptyDocument())).toMatchObject({ pending: true });
    confirm = true;
    await expect(cancelCanvasPlanRecovery((await readCanvasPlanRecovery(emptyDocument())).operationId!)).resolves.toBeUndefined();
    expect(await readCanvasPlanRecovery(emptyDocument())).toEqual({ pending: false });
  });

  it('does not claim a stalled run was stopped if cancellation fails', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/plan')) return json(run, 202);
      if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))); } }));
      if (url.endsWith('/cancel')) return json({ error: { code: 'unavailable' } }, 503);
      return json(run);
    });
    vi.stubGlobal('fetch', fetch);
    const pending = request();
    const assertion = expect(pending).rejects.toMatchObject({ code: 'planning_recovery_required' });
    await vi.advanceTimersByTimeAsync(PLAN_STALL_TIMEOUT_MS + 1);
    await assertion;
    expect(await readCanvasPlanRecovery(emptyDocument())).toMatchObject({ pending: true });
  });

  it('preserves a terminal failure code and releases only the finished operation', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : url.endsWith('/events') ? events()
      : json({ ...run, status: 'failed', terminal: true, error: 'runtime_unavailable' }));
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'runtime_unavailable' });
    expect(await readCanvasPlanRecovery(emptyDocument())).toEqual({ pending: false });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('does not apply a recovered result after the caller aborts or changes canvas', async () => {
    let resolve!: (value: Response) => void;
    const waiting = new Promise<Response>(done => { resolve = done; });
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : url.endsWith('/events') ? events() : waiting);
    vi.stubGlobal('fetch', fetch);
    const pending = request();
    const assertion = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/runs/original-plan'))).toBe(true));
    online('other-user', 'other-canvas');
    resolve(json({ ...run, status: 'completed', output: JSON.stringify(proposal) }));
    await assertion;
    expect(await readCanvasPlanRecovery(emptyDocument())).toEqual({ pending: false });
    online();
    expect(await readCanvasPlanRecovery(emptyDocument())).toMatchObject({ pending: true });
  });

  it('pins the original knowledge revisions and blocks recovery under a changed selection', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/plan')) {
        expect(JSON.parse(init.body as string).knowledgeRevisionIds).toEqual(['knowledge-a', 'knowledge-b']);
        return json(run, 202);
      }
      return json(run);
    });
    vi.stubGlobal('fetch', fetch);
    const scope = { tenant, canvasId: 'recovery-canvas' };
    const original = plannerRecovery(scope, ['knowledge-b', 'knowledge-a']);
    await original.begin('Task', 'revision', 'Original context');
    const changed = plannerRecovery(scope, ['knowledge-c']);
    expect(changed.matches(changed.read()!, 'revision')).toBe(false);
    await expect(changed.begin('Task', 'revision', 'Changed context')).rejects.toMatchObject({ code: 'planning_recovery_required' });
    await expect(plannerRecovery(scope, ['knowledge-a', 'knowledge-b']).begin('Task', 'revision', 'Updated conversation')).resolves.toMatchObject({ recovering: true, run });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('does not retry an old malformed plan in the newly selected workspace', async () => {
    let resolve!: (value: Response) => void;
    const waiting = new Promise<Response>(done => { resolve = done; });
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : url.endsWith('/events') ? events() : waiting);
    vi.stubGlobal('fetch', fetch);
    const pending = request();
    const assertion = expect(pending).rejects.toMatchObject({ code: 'planning_scope_changed' });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/runs/original-plan'))).toBe(true));
    online('other-user', 'other-canvas');
    resolve(json({ ...run, status: 'failed', error: 'invalid_canvas_plan' }));
    await assertion;
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('serializes simultaneous admissions from two writers of the same canvas', async () => {
    let resolve!: (value: Response) => void;
    const waiting = new Promise<Response>(done => { resolve = done; });
    const fetch = vi.fn(async () => waiting);
    vi.stubGlobal('fetch', fetch);
    const scope = { tenant, canvasId: 'recovery-canvas' };
    const first = plannerRecovery(scope).begin('Task A', 'revision', 'Context');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(plannerRecovery(scope).begin('Task B', 'revision', 'Other context')).rejects.toMatchObject({ code: 'planning_recovery_required' });
    resolve(json(run, 202));
    await expect(first).resolves.toMatchObject({ run });
    expect(fetch).toHaveBeenCalledOnce();
    expect(plannerRecovery(scope).read()?.prompt).toBe('Task A');
  });

  it('does not apply a plan if progress handling changes workspace at validation', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : events({ type: 'completed', text: JSON.stringify(proposal) }));
    vi.stubGlobal('fetch', fetch);
    await expect(requestCanvasPlan('Build a report', emptyDocument(), [], new AbortController().signal, 'en', progress => {
      if (progress.stage === 'validating') online('other-user', 'other-canvas');
    })).rejects.toMatchObject({ code: 'planning_scope_changed' });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
  });

  it('fails visibly before admission when cross-tab locking is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')!;
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_storage' });
      expect(fetch).not.toHaveBeenCalled();
      expect(await readCanvasPlanRecovery(emptyDocument())).toEqual({ pending: false });
    } finally { Object.defineProperty(navigator, 'locks', descriptor); }
  });

  it('does not create an uncertain operation when the caller is already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(requestCanvasPlan('Build a report', emptyDocument(), [], controller.signal, 'en')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(await readCanvasPlanRecovery(emptyDocument())).toEqual({ pending: false });
  });

  it('never creates a new operation from a stale explicit recovery after another tab cleared the journal', async () => {
    let submissions = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/plan')) { submissions++; return json(run, 202); }
      if (url.endsWith('/events')) return submissions > 1 ? events({ type: 'completed', text: JSON.stringify(proposal) }) : events();
      return json(run);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(request()).rejects.toMatchObject({ code: 'planning_recovery_required' });
    const recovery = plannerRecovery({ tenant, canvasId: 'recovery-canvas' });
    const original = recovery.read()!;
    await recovery.clear(original); // The other page consumed the terminal result.
    await expect(requestCanvasPlan('Build a report', emptyDocument(), [], new AbortController().signal, 'en', undefined,
      { recoveryOperationId: original.operationId })).rejects.toMatchObject({ code: 'planning_recovery_required' });
    expect(submissions).toBe(1);
  });

  it('refuses stale explicit recovery and stop when another tab has replaced the operation', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : url.endsWith('/events') ? events()
      : json({ ...run, status: 'completed', output: JSON.stringify(proposal) }));
    vi.stubGlobal('fetch', fetch);
    const recovery = plannerRecovery({ tenant, canvasId: 'recovery-canvas' });
    const { entry: original } = await recovery.begin('Build a report', 'original-revision', 'Context');
    await recovery.clear(original);
    const { entry: replacement } = await recovery.begin('Build a report', 'original-revision', 'Context');
    const calls = fetch.mock.calls.length;
    await expect(recovery.begin('Build a report', 'original-revision', 'Context', undefined, original.operationId))
      .rejects.toMatchObject({ code: 'planning_recovery_required' });
    await expect(cancelCanvasPlanRecovery(original.operationId)).rejects.toMatchObject({ code: 'planning_recovery_required' });
    expect(fetch.mock.calls).toHaveLength(calls);
    expect(recovery.read()?.operationId).toBe(replacement.operationId);
  });

  it('sends a shorter view of the canvas, as a new operation, once the API says how much of it fits', async () => {
    const node = { ...createAgentTemplate('frontend', { x: 0, y: 0 }, 'en'), id: 'long', persona: 'A long brief. '.repeat(3000) };
    const doc = { ...emptyDocument(), nodes: [node] };
    const plans: Array<{ context: string; operationId: string }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/plan')) {
        plans.push(JSON.parse(String(init!.body)));
        return plans.length === 1
          ? json({ error: { code: 'context_limit', message: 'The canvas context is too large for this plan', details: { contextRoom: 30000 } } }, 413)
          : json(run, 202);
      }
      if (url.endsWith('/events')) return events({ type: 'completed', text: JSON.stringify(proposal) });
      return json({ ...run, status: 'completed', terminal: true, output: JSON.stringify(proposal) });
    });
    vi.stubGlobal('fetch', fetch);
    const plan = await requestCanvasPlan('Build a report', doc, [], new AbortController().signal, 'en');
    expect(plan).toEqual(proposal);
    expect(plans).toHaveLength(2);
    expect(new TextEncoder().encode(plans[1].context).length).toBeLessThanOrEqual(30000);
    expect(plans[1].context).toContain('more characters not shown; kept as they are]');
    expect(plans[1].operationId).not.toBe(plans[0].operationId);
    expect(planContextCondensed(plan)?.get('long')).toEqual(new Set(['persona']));
  });

  it('never sends a hosted plan a context past its bounds, and keeps what the view cut with the journal through a resume', async () => {
    const long = { ...createAgentTemplate('frontend', { x: 0, y: 0 }, 'en'), id: 'long', persona: 'A long brief. '.repeat(10000) };
    const doc = { ...emptyDocument(), nodes: [long] };
    const plans: Array<{ context: string }> = [];
    let completed = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/plan')) { plans.push(JSON.parse(String(init!.body))); return json(run, 202); }
      if (url.endsWith('/events')) return events({ type: 'running' });
      return json(completed ? { ...run, status: 'completed', terminal: true, output: JSON.stringify(proposal) } : run);
    });
    vi.stubGlobal('fetch', fetch);
    // The stream ends before the plan: the run is kept for recovery, made from the shortened request.
    await expect(requestCanvasPlan('Build a report', doc, [], new AbortController().signal, 'en')).rejects.toMatchObject({ code: 'planning_recovery_required' });
    expect(plans).toHaveLength(1);
    expect(new TextEncoder().encode(plans[0].context).length).toBeLessThanOrEqual(120000 - 256);
    const kept = plannerRecovery({ tenant, canvasId: 'recovery-canvas' }, []).read();
    const operationId = kept?.operationId;
    expect(operationId).toBeTruthy();
    // Kept as version 2: a page of an earlier release, which reads only version 1, refuses it rather than applying its
    // plan as one of the whole canvas.
    expect(kept?.version).toBe(2);
    // Resumed: this call's own view is the whole canvas, but the plan is the shortened request's, and says so.
    completed = true;
    const plan = await requestCanvasPlan('Build a report', doc, [], new AbortController().signal, 'en', undefined, { recoveryOperationId: operationId });
    expect(plan).toEqual(proposal);
    expect(plans).toHaveLength(1);
    expect(planContextCondensed(plan)?.get('long')).toEqual(new Set(['persona']));
  });

  // The planner sized the nodes it adds for the model the request its run was made from named (planning_limits.go), and
  // the plan says that one ("default" for nodes that run the workspace default), a resume's too, not one the reader chose
  // since, so its nodes take what they were sized for (CanvasSurface, planComponentModel).
  it('says the model a plan sized its new nodes for, as its own request named it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/plan')) return json(run, 202);
      if (url.endsWith('/events')) return events({ type: 'running' });
      return json({ ...run, status: 'completed', terminal: true, output: JSON.stringify(proposal) });
    }));
    for (const model of ['qwen', 'default']) {
      expect(planNewNodeModel(await requestCanvasPlan('Build a report', emptyDocument(), [], new AbortController().signal, 'en', undefined, { newNodeModel: model })))
        .toBe(model);
    }
  });

  it.each([['bedrock.claude-opus-5-5', 'qwen'], ['default', 'bedrock.claude-opus-5-5']])(
    'says the model a resumed plan sized its new nodes for, as its stored request named it (%s, then %s chosen)', async (asked, since) => {
      let completed = false;
      const fetch = vi.fn(async (url: string) => {
        if (url.endsWith('/plan')) return json(run, 202);
        if (url.endsWith('/events')) return events({ type: 'running' });
        return json(completed ? { ...run, status: 'completed', terminal: true, output: JSON.stringify(proposal) } : run);
      });
      vi.stubGlobal('fetch', fetch);
      const models = [{ id: 'qwen', name: 'Qwen' }, { id: 'bedrock.claude-opus-5-5', name: 'Claude Opus 5.5' }];
      await expect(requestCanvasPlan('Build a report', emptyDocument(), [], new AbortController().signal, 'en', undefined, { models, newNodeModel: asked }))
        .rejects.toMatchObject({ code: 'planning_recovery_required' });
      const operationId = plannerRecovery({ tenant, canvasId: 'recovery-canvas' }, []).read()?.operationId;
      completed = true;
      const plan = await requestCanvasPlan('Build a report', emptyDocument(), [], new AbortController().signal, 'en', undefined,
        { models, newNodeModel: since, recoveryOperationId: operationId });
      expect(plan).toEqual(proposal);
      expect(planNewNodeModel(plan)).toBe(asked);
      expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
    });

  it('keeps a set of any size with its request, and refuses one that is not a set before a run is admitted', async () => {
    // A node of 250 inputs, more than the journal once kept for one node: the set used to be dropped, and its plan
    // applied as one of the whole canvas.
    const wide = { ...createAgentTemplate('frontend', { x: 0, y: 0 }, 'en'), id: 'wide' };
    wide.contract = { ...wide.contract!, inputs: Array.from({ length: 250 }, (_, i) => ({ id: `field-${i}`, label: `Field ${i}`, type: 'text' as const, required: false,
      value: 'A long value. '.repeat(50) })) };
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202) : events({ type: 'completed', text: JSON.stringify(proposal) }));
    vi.stubGlobal('fetch', fetch);
    const plan = await requestCanvasPlan('Build a report', { ...emptyDocument(), nodes: [wide] }, [], new AbortController().signal, 'en');
    expect(planContextCondensed(plan)?.get('wide')?.size).toBe(250);
    fetch.mockClear();
    const refused = await canvasFetch('/gateway-api/canvas/plan', { method: 'POST',
      body: JSON.stringify({ prompt: 'Build a report', context: 'Context', revision: 'revision', condensed: [['wide', 'persona']] }) });
    expect(refused.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(plannerRecovery({ tenant, canvasId: 'recovery-canvas' }).read()).toBeNull();
  });

  it('reads a journal whose set cannot be read, or whose version does not say whether it has one, as unreadable', () => {
    const key = canvasStorageKey(`awwo.canvas.planning.run.v1:${encodeURIComponent(tenant.id)}:${encodeURIComponent('recovery-canvas')}`);
    const entry = { tenantId: tenant.id, canvasId: 'recovery-canvas', operationId: 'kept', prompt: 'Build a report', context: 'Context', revision: 'revision' };
    // Stored as the journal stores an entry: gzip in a version 2 envelope (plannerRecovery.ts encode).
    const read = (stored: Record<string, unknown>) => {
      const bytes = strToU8(JSON.stringify({ ...entry, ...stored }));
      localStorage.setItem(key, JSON.stringify({ version: 2, encoding: 'gzip', bytes: bytes.length, data: btoa(strFromU8(gzipSync(bytes, { level: 9, mtime: 0 }), true)) }));
      try { return plannerRecovery({ tenant, canvasId: 'recovery-canvas' }).read(); } catch (error) { return error; }
    };
    for (const stored of [{ version: 2, condensed: [['long', 'persona']] }, { version: 1, condensed: [['long', ['persona']]] }, { version: 2 }, { version: 3 }]) {
      expect(read(stored), JSON.stringify(stored)).toMatchObject({ code: 'planning_recovery_storage' });
    }
    expect(read({ version: 2, condensed: [['long', ['persona']]] })).toMatchObject({ version: 2, condensed: [['long', ['persona']]] });
    expect(read({ version: 1 })).toMatchObject({ version: 1 });
  });

  it('applies a run of the whole canvas that another tab started as one, even where this tab’s own view is shortened', async () => {
    const sized = (persona: string) => ({ ...emptyDocument(), nodes: [{ ...createAgentTemplate('frontend', { x: 0, y: 0 }, 'en'), id: 'long', persona }] });
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    // About 114,000 bytes of canvas: whole, it fits a hosted plan; with ten turns of conversation, even cut, it does not.
    const doc = sized('A long brief. '.repeat(Math.floor((114_000 - bytes(buildPlanningContext(sized('x'), [], 'en'))) / 14)));
    const longTurns = Array.from({ length: 10 }, (_, i) => ({ id: `turn-${i}`, role: 'user' as const, content: 'A long turn. '.repeat(1000) }));
    expect(fitPlanningContext(doc, longTurns, 'en', [], {}, 120_000 - 256)?.condensed.get('long')).toEqual(new Set(['persona']));
    const rewrite = { version: 1, summary: 'Rewrite the brief', operations: [{ type: 'update_node', nodeId: 'long', persona: 'A new brief' }] };
    const fetch = vi.fn(async (url: string) => url.endsWith('/plan') ? json(run, 202)
      : url.endsWith('/events') ? events({ type: 'completed', text: JSON.stringify(rewrite) }) : json(run));
    vi.stubGlobal('fetch', fetch);
    // The other tab asked with no conversation: the whole canvas fits, and its run is kept with no fields shown in part.
    await plannerRecovery({ tenant, canvasId: 'recovery-canvas' }).begin('Build a report', canvasPlanRevision(doc), buildPlanningContext(doc, [], 'en'));
    const other = plannerRecovery({ tenant, canvasId: 'recovery-canvas' }).read();
    expect(other?.version).toBe(1);
    expect(other?.condensed).toBeUndefined();
    // This tab's ten long turns would cut the brief; the plan it reads is the other tab's, made from the whole canvas.
    const plan = await requestCanvasPlan('Build a report', doc, longTurns, new AbortController().signal, 'en');
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/plan'))).toHaveLength(1);
    expect(planContextCondensed(plan)).toBeUndefined();
    expect((applyCanvasPlan(doc, plan, 'en').doc.nodes[0] as { persona?: string }).persona).toBe('A new brief');
  });

  it('sends a hosted canvas whole while it fits the bounds in characters, as its workers count them, and no view past them', async () => {
    const sized = (persona: string) => ({ ...emptyDocument(), nodes: [{ ...createAgentTemplate('frontend', { x: 0, y: 0 }), id: 'long', persona }] });
    const contexts: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/plan')) {
        contexts.push(JSON.parse(String(init?.body)).context);
        return json({ ...run, id: `plan-${contexts.length}` }, 202);
      }
      return url.endsWith('/events') ? events({ type: 'completed', text: JSON.stringify(proposal) }) : json(run);
    });
    vi.stubGlobal('fetch', fetch);
    // 50,000 Chinese characters are 150,000 bytes, past the 120,000 the bounds once counted: the canvas goes whole, its
    // conversation too (a shortened view would cut a turn this long).
    const wide = sized('很长的职责说明。'.repeat(6_250));
    const turns = [{ id: 'turn', role: 'user' as const, content: '很长的一轮对话。'.repeat(250) }];
    expect(planContextCondensed(await requestCanvasPlan('整理这个项目', wide, turns, new AbortController().signal, 'zh'))).toBeUndefined();
    expect(contexts[0]).toBe(buildPlanningContext(wide, turns, 'zh'));
    expect(new TextEncoder().encode(contexts[0]).length).toBeGreaterThan(150_000);
    // 130,000 characters are past them: the view sent is within them, and the plan knows it was made from one.
    const wider = sized('很长的职责说明。'.repeat(16_250));
    const shortened = await requestCanvasPlan('整理这个项目', wider, [], new AbortController().signal, 'zh');
    expect(planContextCondensed(shortened)?.get('long')).toEqual(new Set(['persona']));
    expect(contexts[1].length).toBeLessThanOrEqual(120_000 - 256);
    expect(contexts).toHaveLength(2);
  });
});
