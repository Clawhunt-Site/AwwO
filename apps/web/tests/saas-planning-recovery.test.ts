import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDocument } from '../src/canvas/canvasDoc';
import { configureCanvasStorage } from '../src/canvas/canvasStorage';
import { cancelCanvasPlanRecovery, readCanvasPlanRecovery, requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { onSessionEnded, trackSignedInSession } from '../src/saas/api';
import { PLAN_STALL_TIMEOUT_MS } from '../src/saas/canvasBridge';
import { plannerRecovery } from '../src/saas/plannerRecovery';

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
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (value.includes('"runId"')) throw new DOMException('Full', 'QuotaExceededError'); set(key, value); });
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
});
