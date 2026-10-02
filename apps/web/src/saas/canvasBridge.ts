import { api, API_BASE, SaaSApiError, sessionFetch, tenantPath, type Tenant, type SaaSAgent } from './api';
import { modelEffortCapability, runtimeDefinitions, runtimeModels, type SaaSRuntimeStatus } from './runtimeCatalog';
import { readSseFrames } from '../sse';
import { canvasErrorMessage, canvasText } from './canvasErrors';
import type { CanvasDocument } from '../canvas/canvasDoc';
import { AGENT_TEMPLATE_IDS } from '../canvas/agentTemplates';
import { CANVAS_PLAN_NODE_OPERATION_TYPES, CANVAS_PLAN_OPERATION_TYPES } from '../canvas/canvasPlan';
import { plannerRecovery, planningRecoveryRequired, type PlannerRun } from './plannerRecovery';

type CanvasScope = { tenant: Tenant; canvasId: string };
let active: CanvasScope | null = null;
let knowledgeSelection: { scope: CanvasScope; revisionIds: string[] } | null = null;
const knowledgeListeners = new Set<{ scope: CanvasScope; listener: () => void }>();
/** A mounted canvas observes only its own knowledge changes; old views cannot follow a switch. */
export function subscribeCanvasKnowledge(listener: () => void): () => void {
  if (!active) return () => {};
  const subscription = { scope: active, listener };
  knowledgeListeners.add(subscription);
  return () => { knowledgeListeners.delete(subscription); };
}
/** A selection belongs to the exact mounted canvas. The API resolves immutable revisions again. */
export function configureCanvasKnowledge(revisionIds: readonly string[]): void {
  if (!active) throw new Error('Canvas is not ready');
  if (revisionIds.length > 8 || revisionIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Select up to eight knowledge revisions');
  const previous = canvasKnowledgeRevisionIds().sort();
  knowledgeSelection = { scope: active, revisionIds: [...new Set(revisionIds)] };
  if (JSON.stringify(previous) !== JSON.stringify([...knowledgeSelection.revisionIds].sort())) {
    for (const subscription of knowledgeListeners) if (subscription.scope === active) subscription.listener();
  }
}
export function canvasKnowledgeRevisionIds(): string[] {
  return knowledgeSelection?.scope === active ? [...knowledgeSelection.revisionIds] : [];
}
let initializeCanvas: ((scope?: readonly string[], signal?: AbortSignal) => Promise<CanvasDocument>) | null = null;
export function configureSaaSCanvasInitialize(initialize: typeof initializeCanvas): void { initializeCanvas = initialize; }
export async function initializeSaaSCanvas(scope?: readonly string[], signal?: AbortSignal): Promise<CanvasDocument> {
  const captured = active;
  if (!captured || !initializeCanvas) throw new Error(canvasText('画布初始化尚未就绪，请稍后重试。', 'Canvas setup is not ready. Please try again.'));
  const document = await initializeCanvas(scope, signal);
  if (active !== captured || signal?.aborted) throw new Error(canvasText('工作区已切换，请在当前画布重新运行。', 'The workspace changed. Run from the current canvas.'));
  return document;
}
let saveCanvas: (() => Promise<number | void>) | null = null;
const planningCancellations = new WeakMap<AbortSignal, Promise<void>>();
/** Wait only for the cancellation owned by this exact request, never the canvas's newer run. */
export async function confirmSaaSPlanningCancellation(signal: AbortSignal): Promise<boolean> {
  const pending = planningCancellations.get(signal);
  if (!pending) return false;
  await pending;
  return true;
}
export function configureSaaSCanvas(scope: CanvasScope): void { active = scope; }
export function configureSaaSCanvasSave(save: (() => Promise<number | void>) | null): void { saveCanvas = save; }
export function clearSaaSCanvas(): void { active = null; knowledgeSelection = null; saveCanvas = null; initializeCanvas = null; }
/** Capture a tenant/canvas scope once; an in-flight operation must not follow a workspace switch. */
export function currentSaaSCanvas(): CanvasScope | null { return active; }
export async function flushSaaSCanvas(): Promise<number | void> {
  if (!saveCanvas) throw new Error(canvasText('画布保存尚未就绪', 'Canvas saving is not ready.'));
  return saveCanvas();
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** Backstop for a dead event stream, NOT a model deadline. The server already bounds the work
 * itself (Go `RunTimeout` defaults to 180s, the Pi model call to 120s) and reports `failed` when
 * it expires, so this window is deliberately set above those defaults: a slow first token must
 * never be mistaken for a dead run. It only fires when no event arrives at all — meaning the
 * stream, not the model, stopped — and then cancels the run rather than spinning forever.
 * Both server deadlines are environment-configurable; raising them past this window would make
 * this backstop fire first, so keep it above whatever `AWWO_RUN_TIMEOUT` is deployed. */
export const PLAN_STALL_TIMEOUT_MS = 240_000;
/** Opening the event stream is a single request, not model work, so it gets a much shorter bound. */
export const PLAN_OPEN_TIMEOUT_MS = 30_000;
/** Progress frames are coalesced: the host reports about once a second, and a stage change,
 * a newly declared node or connection is always forwarded immediately. */
export const PLAN_PROGRESS_INTERVAL_MS = 250;
// Whole quoted JSON literals only, so "disconnect" never counts as "connect" and a field's
// `type` value (text/markdown/number/boolean/file/html) can never collide with an operation name.
const ADD_NODE_MARKER = /"add_node"/g;
const CONNECT_MARKER = /"connect"/g;
/** Nodes a proposal has declared — a measurement, not an estimate. */
export const countPlannedNodes = (text: string): number => text.match(ADD_NODE_MARKER)?.length ?? 0;
/** Connections a proposal has declared — a measurement, not an estimate. */
export const countPlannedEdges = (text: string): number => text.match(CONNECT_MARKER)?.length ?? 0;
type PlanStreamProgress = { stage: 'queued' | 'running' | 'thinking' | 'streaming'; characters: number; nodes: number;
  edges: number; reasoning: number; template?: string; operation?: string; target?: string };

/** Marks a `file` deliverable whose bytes the server actually holds, rather than a bare path. */
export const ARTIFACT_REF_PREFIX = 'awwo-file:';
// Server ids are "a" + base64url (RawURLEncoding of 24 bytes). Validated rather than interpolated
// blindly, so a malformed deliverable value can never build a request to another path.
const ARTIFACT_ID = /^a[A-Za-z0-9_-]{8,128}$/;

/** Resolve a stored deliverable to its download URL, or null when this value is not a stored file
 * (a native/local reference, or no cloud workspace is active). Never guesses an id. */
export function storedArtifactUrl(value: string): string | null {
  const scope = active;
  if (!scope || typeof value !== 'string' || !value.startsWith(ARTIFACT_REF_PREFIX)) return null;
  const id = value.slice(ARTIFACT_REF_PREFIX.length).trim();
  if (!ARTIFACT_ID.test(id)) return null;
  return `${API_BASE}${tenantPath(scope.tenant.id)}/artifacts/${encodeURIComponent(id)}`;
}

const operationStatus = (operationId: string, run?: any) => ({ operationId,
  state: !run ? 'not_started' : run.terminal ? 'terminal' : 'accepted',
  issueId: run?.sessionId ?? null, runId: run?.id ?? null, terminal: run?.terminal ?? false,
  status: run ? normalizeStatus(run.status) : null, output: run?.output ?? '',
  outputAvailable: run?.outputAvailable ?? false, detail: run?.error ? canvasErrorMessage(run.error) : null });
const normalizeStatus = (status: string) => status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'failed' : status;

/** Explicit adapter for the existing canvas protocols; never replaces global fetch. */
export async function canvasFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const scope = active;
  const knowledgeRevisionIds = canvasKnowledgeRevisionIds();
  if (!scope) return fetch(input, init);
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.origin);
  const path = url.pathname.replace(/^\/(paperclip-api|gateway-api)/, '');
  const method = (init.method || 'GET').toUpperCase();
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
  const base = tenantPath(scope.tenant.id);
  const request = (suffix: string, options: RequestInit = {}) => api<any>(`${base}${suffix}`, { signal: init.signal, ...options });
  const post = (suffix: string, value: unknown) => request(suffix, { method: 'POST', body: JSON.stringify(value) });
  try {
    const companyScope = /^\/companies\/([^/]+)\//.exec(path);
    if (companyScope && decodeURIComponent(companyScope[1]) !== scope.tenant.id) return json({ error: canvasText('租户与当前画布不一致', 'The workspace does not match the current canvas.') }, 403);
    if (path === '/companies') return json([{ id: scope.tenant.id, name: scope.tenant.name, status: scope.tenant.status }]);
    if (path === '/adapters') {
      const runtime: SaaSRuntimeStatus = await request('/runtime');
      return json(runtimeDefinitions(runtime).map(item => ({ type: item.id,
        loaded: item.available && item.configured, disabled: !item.available || !item.configured,
        supportsNodeTeams: true, supportsModelSelection: true, supportsEffortSelection: item.supportsEffortSelection,
        modelCatalogSource: 'saas_runtime', tools: item.tools, modelsCount: runtimeModels(runtime, item.id).length,
        ...(item.reason ? { reason: item.reason } : {}) })));
    }
    const modelCatalog = /\/adapters\/([^/]+)\/models$/.exec(path);
    if (modelCatalog) {
      const runtime: SaaSRuntimeStatus = await request('/runtime');
      const selected = runtimeDefinitions(runtime).find(item => item.id === decodeURIComponent(modelCatalog[1]));
      if (!selected) return json({ error: canvasText('所选执行框架不在服务目录中。', 'The selected runtime is absent from the service catalog.') }, 404);
      // Models carry their own effort contract so the picker scopes levels to the chosen model.
      return json({ source: 'saas_runtime', models: runtimeModels(runtime, selected.id).map(model => ({ id: model.id, ...(model.label ? { label: model.label } : {}), ...modelEffortCapability(model) })) });
    }
    if (path === '/canvas/planner') {
      const runtime: SaaSRuntimeStatus = await request('/runtime');
      const available = runtime.available === true && runtime.plannerAvailable === true;
      return json({ available, provider: runtime.plannerRuntime || 'pi',
        ...(!available ? { error: (runtime.reason ? canvasErrorMessage(runtime.reason) : '') || canvasText('请先连接你的执行引擎。', 'Connect your personal engine first.') } : {}) });
    }
    if (path === '/canvas/plan/recovery' && method === 'GET') {
      const recovery = plannerRecovery(scope, knowledgeRevisionIds);
      const entry = recovery.read();
      return json(entry ? { pending: true, operationId: entry.operationId, prompt: entry.prompt, matches: recovery.matches(entry, url.searchParams.get('revision') ?? '') } : { pending: false });
    }
    if (path === '/canvas/plan/recovery/cancel' && method === 'POST') {
      await plannerRecovery(scope, knowledgeRevisionIds).cancelMatching(typeof body.operationId === 'string' ? body.operationId : '', init.signal ?? undefined);
      return json({ confirmed: true });
    }
    if (path === '/canvas/plan' && method === 'POST') {
      if (!saveCanvas) return json({ error: canvasText('画布保存尚未就绪', 'Canvas saving is not ready.') }, 409);
      await saveCanvas();
      if (active !== scope || init.signal?.aborted) throw new Error(canvasText('工作区已切换或操作已取消。', 'The workspace changed or the operation was cancelled.'));
      const recovery = plannerRecovery(scope, knowledgeRevisionIds);
      const { entry, run } = await recovery.begin(body.prompt, body.revision ?? body.context ?? '', body.context, init.signal ?? undefined,
        typeof body.recoveryOperationId === 'string' ? body.recoveryOperationId : undefined);
      // A user cancel and the stall backstop can land together; cancelling once keeps that race
      // from issuing a second request the server would only have to discard.
      let cancelRequest: Promise<void> | undefined;
      const cancel = () => {
        cancelRequest ??= recovery.cancel(entry);
        if (init.signal) planningCancellations.set(init.signal, cancelRequest);
        // Abort handlers cannot await; failed confirmation deliberately keeps the durable journal.
        void cancelRequest.catch(() => {});
        return cancelRequest;
      };
      init.signal?.addEventListener('abort', cancel, { once: true });
      // The stall watchdog aborts only this event read, so a caller cancel and a lost stream stay
      // distinguishable; the caller's own signal is relayed rather than reused.
      let reader = new AbortController();
      const relay = () => reader.abort();
      init.signal?.addEventListener('abort', relay, { once: true });
      const release = () => {
        init.signal?.removeEventListener('abort', cancel);
        init.signal?.removeEventListener('abort', relay);
      };
      // Opening the event stream is bounded too: a proxy that accepts the connection and never
      // answers must not leave the caller waiting without limit either.
      const openEvents = async () => {
        reader = new AbortController();
        const opening = setTimeout(() => reader.abort(), PLAN_OPEN_TIMEOUT_MS);
        try {
          if (init.signal?.aborted) { cancel(); throw new Error(canvasText('已取消规划', 'Planning was cancelled.')); }
          const response = await sessionFetch(`${API_BASE}${base}/runs/${encodeURIComponent(run.id)}/events`, { credentials: 'include', signal: reader.signal });
          if (!response.ok || !response.body) throw new Error(canvasText('无法读取规划运行，请稍后重试。', 'The planning run could not be read. Please try again.'));
          return response.body;
        } finally { clearTimeout(opening); }
      };
      const encoder = new TextEncoder();
      // Progress is reported as a stream so the caller can show what the run is really doing.
      // The terminal frame is the proposal itself, or an explicit error — never an empty plan.
      const stream = new ReadableStream<Uint8Array>({ async start(controller) {
        let closed = false;
        let output = '';
        let observed: PlanStreamProgress = { stage: 'queued', characters: 0, nodes: 0, edges: 0, reasoning: 0 };
        let lastEmit = 0;
        let lastKey = '';
        let completed = false;
        let terminalObserved = false;
        let failure = '';
        // The code is kept beside the message because the caller decides whether to retry, and a
        // localized sentence is not something to match on. Only a malformed plan is worth retrying.
        let failureCode = '';
        let stalled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // A caller that stops reading cancels the stream, after which enqueue/close throw. Progress
        // reporting must never turn that into an unhandled stream error.
        const emit = (frame: unknown) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)); }
          catch { closed = true; }
        };
        // Coalescing must never hide a stage change, a newly declared node or connection, or the
        // final measured totals, so those bypass it.
        const progress = (force: boolean) => {
          const now = Date.now();
          const key = `${observed.stage}:${observed.nodes}:${observed.edges}:${observed.template ?? ''}:${observed.operation ?? ''}:${observed.target ?? ''}`;
          if (!force && key === lastKey && now - lastEmit < PLAN_PROGRESS_INTERVAL_MS) return;
          lastEmit = now;
          lastKey = key;
          emit({ type: 'progress', ...observed });
        };
        const count = (value: unknown, fallback: number) =>
          typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
        const watch = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; reader.abort(); }, PLAN_STALL_TIMEOUT_MS); };
        const observe = (event: any) => {
            if (completed || failure) return;
            watch(); // Any frame proves the run is still observably alive.
            if (event.type === 'progress') {
              // The host withholds the proposal until it is validated and reports counts instead:
              // how much is written, how many nodes and connections, how much the model reasoned.
              // Each row is a whole snapshot, so a missing template means the newest node has not
              // named one yet; keeping the previous node's would put the wrong name on it.
              observed = { stage: event.stage === 'thinking' || event.stage === 'streaming' ? event.stage : observed.stage,
                characters: count(event.characters, observed.characters), nodes: count(event.nodes, observed.nodes),
                edges: count(event.edges, observed.edges), reasoning: count(event.reasoning, observed.reasoning),
                // Only a member of the closed template set is forwarded, never other model text, and
                // only beside the node count it was reported with.
                ...(typeof event.template === 'string' && AGENT_TEMPLATE_IDS.has(event.template)
                  && typeof event.nodes === 'number' && Number.isFinite(event.nodes) && event.nodes >= 0 ? { template: event.template } : {}),
                // The operation being written and the node it concerns, as members of the closed
                // operation and template sets; a target only ever beside an operation on one node.
                ...(typeof event.operation === 'string' && CANVAS_PLAN_OPERATION_TYPES.has(event.operation) ? { operation: event.operation,
                  ...(CANVAS_PLAN_NODE_OPERATION_TYPES.has(event.operation) && typeof event.target === 'string'
                    && AGENT_TEMPLATE_IDS.has(event.target) ? { target: event.target } : {}) } : {}) };
              progress(false);
            } else if (event.type === 'queued' || event.type === 'running') {
              observed = { ...observed, stage: event.type };
              progress(true);
            } else if (event.type === 'completed') {
              if (typeof event.text === 'string') output = event.text;
              // Progress rows are coalesced, so settle the totals on the whole proposal. The last
              // reported template still names the newest node only if no node arrived after it; the
              // operation being written is over, so it is not carried into the settled totals.
              const { template, operation: _operation, target: _target, ...counts } = observed;
              const nodes = countPlannedNodes(output);
              observed = { ...counts, characters: [...output].length, nodes, edges: countPlannedEdges(output),
                ...(template && nodes === observed.nodes ? { template } : {}) };
              completed = true;
              terminalObserved = true;
              reader.abort();
            } else if (['failed', 'interrupted', 'cancelled'].includes(event.type)) {
              terminalObserved = true;
              failure = canvasErrorMessage(event.message, event.code) || canvasText('规划未完成，请重试。', 'Planning did not complete. Please try again.');
              failureCode = typeof event.code === 'string' ? event.code : '';
              reader.abort();
            }
        };
        const settle = (snapshot: PlannerRun) => {
          if (recovery.terminal(snapshot)) observe({ type: snapshot.status, text: snapshot.output, code: snapshot.error });
        };
        try {
          progress(true);
          settle(run);
          // Reconnect at most once per explicit request, always to the already admitted run.
          // A transport failure never allocates a new operation or makes another model request.
          for (let attempt = 0; attempt < 2 && !completed && !failure; attempt++) {
            if (active !== scope || init.signal?.aborted) break;
            try {
              const upstream = await openEvents();
              watch();
              await readSseFrames(upstream, (_event, event: any) => observe(event));
            } catch { /* The authoritative GET below distinguishes a lost observer from a failed run. */ }
            finally { clearTimeout(timer); }
            if (completed || failure || stalled || init.signal?.aborted || active !== scope) break;
            try { settle(await recovery.lookup(entry, init.signal ?? undefined)); }
            catch (error) {
              failure = error instanceof SaaSApiError ? canvasErrorMessage(error) : planningRecoveryRequired().message;
              failureCode = error instanceof SaaSApiError ? error.code : 'planning_recovery_required';
              break;
            }
          }
        } finally { clearTimeout(timer); }
        try {
          if (stalled) {
            // Only an acknowledged stop can be described as stopped. Failed acknowledgement
            // keeps the original identity available to the explicit recovery/stop controls.
            try {
              await cancel();
              emit({ type: 'error', error: canvasText(
              `规划已超过 ${Math.round(PLAN_STALL_TIMEOUT_MS / 1000)} 秒没有任何进展，已停止本次运行；当前画布保持原样。`,
              `Planning reported no progress for ${Math.round(PLAN_STALL_TIMEOUT_MS / 1000)} seconds and the run was stopped. The canvas has not changed.`) });
            } catch (error) {
              emit({ type: 'error', code: error instanceof SaaSApiError ? error.code : 'planning_recovery_required', error: canvasErrorMessage(error) || planningRecoveryRequired().message });
            }
          } else if (failure) {
            // Only server terminal events release the journal; read/auth/transport failures do not.
            if (terminalObserved) await recovery.clear(entry);
            emit({ type: 'error', error: failure, ...(failureCode ? { code: failureCode } : {}) });
          }
          else if (!completed) {
            const error = planningRecoveryRequired();
            emit({ type: 'error', code: error.code, error: error.message });
          } else {
            if (active !== scope || init.signal?.aborted) return;
            await recovery.clear(entry);
            if (active !== scope || init.signal?.aborted) return;
            progress(true); // Report the true final totals, which coalescing may have withheld.
            // The caller still applies its existing strict protocol and graph validation.
            let plan: unknown;
            let parsed = false;
            try { plan = JSON.parse(output.trim()); parsed = true; } catch { parsed = false; }
            if (parsed) emit({ type: 'plan', plan });
            // Same cause as the server's own rejection — the model's structure, not the request — so
            // it carries the same code and the caller may retry it on the same terms.
            else emit({ type: 'error', code: 'invalid_canvas_plan', error: canvasText('Pi 返回的规划不是有效 JSON；当前画布保持原样。', 'Pi returned an invalid JSON plan. The canvas has not changed.') });
          }
        } catch (error) {
          emit({ type: 'error', code: error instanceof SaaSApiError ? error.code : 'planning_recovery_required', error: canvasErrorMessage(error) });
        } finally {
          release();
          if (!closed) { closed = true; try { controller.close(); } catch { /* already cancelled by the caller */ } }
        }
      } });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (/^\/companies\/[^/]+\/agent-hires$/.test(path)) {
      const { name, role, title, adapterType, adapterConfig } = body;
      const agent: SaaSAgent = await post('/agents', { name, role, title, adapterType, adapterConfig });
      return json({ agent: { ...agent, adapterType: agent.runtime || 'pi', status: 'idle' } }, 201);
    }
    const instructions = /^\/agents\/([^/]+)\/instructions-bundle\/file$/.exec(path);
    if (instructions) return json(await request(`/agents/${instructions[1]}/instructions`, { method: 'PUT', body: JSON.stringify({ content: body.content }) }));
    const op = /^\/conversations\/([^/]+)\/agents\/([^/]+)\/operations\/([^/]+)(\/prepare)?$/.exec(path);
    if (op) {
      if (decodeURIComponent(op[1]) !== scope.tenant.id) return json({ error: canvasText('租户与当前画布不一致', 'The workspace does not match the current canvas.') }, 403);
      if (op[4]) return json({ prepared: true }); // Run insertion owns durable idempotency.
      const result = await request(`/runs?operationId=${encodeURIComponent(decodeURIComponent(op[3]))}`);
      return json(operationStatus(decodeURIComponent(op[3]), result.items[0]));
    }
    const history = /^\/conversations\/([^/]+)\/issues\/([^/]+)\/messages$/.exec(path);
    if (history) {
      if (decodeURIComponent(history[1]) !== scope.tenant.id) return json({ error: canvasText('租户与当前画布不一致', 'The workspace does not match the current canvas.') }, 403);
      const result = await request(`/sessions/${history[2]}/messages`);
      return json({ complete: true, messages: result.items.map((item: any) => ({ body: item.content, runId: item.runId,
        ...(item.collaboration ? { collaboration: item.collaboration } : {}),
        ...(Object.hasOwn(item, 'presentation') ? { presentation: item.presentation } : {}),
        ...(item.role === 'assistant' || item.role === 'agent' ? { authorAgentId: 'pi' } : {}) })) });
    }
    const index = /^\/conversations\/([^/]+)$/.exec(path);
    if (index) {
      if (decodeURIComponent(index[1]) !== scope.tenant.id) return json({ error: canvasText('租户与当前画布不一致', 'The workspace does not match the current canvas.') }, 403);
      const query = new URLSearchParams({ canvasId: scope.canvasId });
      if (url.searchParams.has('issueId')) query.set('sessionId', url.searchParams.get('issueId')!);
      if (url.searchParams.has('cursor')) query.set('cursor', url.searchParams.get('cursor')!);
      const result = await request(`/sessions?${query}`);
      return json({ conversations: result.items.map((item: any) => ({ issueId: item.id, agentId: item.agentId, title: item.title, updatedAt: item.createdAt })), nextCursor: result.nextCursor ?? null });
    }
    const runPath = /^\/conversations\/([^/]+)\/agents\/([^/]+)\/issues\/([^/]+)\/(runs\/([^/]+)|cancel)$/.exec(path);
    if (runPath) {
      if (decodeURIComponent(runPath[1]) !== scope.tenant.id) return json({ error: canvasText('租户与当前画布不一致', 'The workspace does not match the current canvas.') }, 403);
      let runId = runPath[5] || body.runId;
      if (!runId) {
        const runs = await request(`/runs?sessionId=${runPath[3]}&active=true`);
        runId = runs.items.find((item: any) => item.sessionId === decodeURIComponent(runPath[3]) && !item.terminal)?.id;
      }
      if (!runId) return json({ confirmed: false, cancelled: false, status: 'unknown', detail: canvasText('找不到需要停止的运行', 'No active run was found to stop.') }, 409);
      let run = await request(`/runs/${encodeURIComponent(runId)}`);
      if (run.sessionId !== decodeURIComponent(runPath[3])) return json({ error: canvasText('Session 与运行不一致', 'The session does not match the run.') }, 409);
      if (method === 'POST') {
        run = await post(`/runs/${encodeURIComponent(runId)}/cancel`, {});
        return json({ confirmed: run.terminal === true, cancelled: run.status === 'cancelled', status: normalizeStatus(run.status) });
      }
      return json({ ...run, errorCode: run.error, error: run.error ? canvasErrorMessage(run.error) : run.error, runId: run.id, status: normalizeStatus(run.status) });
    }
    const send = /^\/conversations\/([^/]+)\/agents\/([^/]+)\/messages$/.exec(path);
    if (send && method === 'POST') {
      if (decodeURIComponent(send[1]) !== scope.tenant.id) return json({ error: canvasText('租户与当前画布不一致', 'The workspace does not match the current canvas.') }, 403);
      if (!saveCanvas) return json({ error: canvasText('画布保存尚未就绪', 'Canvas saving is not ready.') }, 409);
      await saveCanvas();
      if (active !== scope || init.signal?.aborted) throw new Error(canvasText('工作区已切换或操作已取消。', 'The workspace changed or the operation was cancelled.'));
      const operationId = body.operationId || crypto.randomUUID();
      const existing = (await request(`/runs?operationId=${encodeURIComponent(operationId)}`)).items[0];
      let sessionId = existing?.sessionId || body.issueId;
      if (!sessionId) {
        const session = await post('/sessions', { canvasId: scope.canvasId,
          nodeId: new Headers(init.headers).get('X-Awwo-Node-Id') || decodeURIComponent(send[2]),
          agentId: decodeURIComponent(send[2]), title: body.message.slice(0, 80) });
        sessionId = session.id;
      }
      let run: { id: string };
      try {
        run = await post('/runs', { sessionId, prompt: body.message, operationId, ...(knowledgeRevisionIds.length ? { knowledgeRevisionIds } : {}) });
      } catch (error) {
        // Only a definite rejection of this new operation proves no run was admitted.
        // An existing/conflicting identity, lost response or 5xx still needs recovery.
        // Keep this boundary before event streaming: an events 4xx can follow a paid run.
        if (!existing && error instanceof SaaSApiError && error.status >= 400 && error.status < 500
          && error.code !== 'request_failed' && error.code !== 'idempotency_conflict') {
          return json({ code: error.code, error: canvasErrorMessage(error), admissionRejected: true }, error.status);
        }
        throw error;
      }
      const upstream = await sessionFetch(`${API_BASE}${base}/runs/${encodeURIComponent(run.id)}/events`, { credentials: 'include', signal: init.signal });
      if (!upstream.ok || !upstream.body) return json({ error: canvasText('无法连接运行事件，请刷新后恢复。', 'Run events could not be reached. Reload to restore the run.') }, upstream.status || 502);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({ async start(controller) {
        let ended = false;
        let output = '';
        const emit = (frame: unknown) => { if (!ended) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)); };
        try {
          emit({ event: 'accepted', issueId: sessionId, runId: run.id, runVisible: true, operationId });
          await readSseFrames(upstream.body!, (_event, event: any) => {
            if (event.type === 'text_delta') { output += event.delta || ''; emit({ event: 'delta', text: event.delta || '' }); }
            else if (event.type === 'completed') {
              if (typeof event.text === 'string') {
                if (!event.text.startsWith(output)) throw new Error('Stream output disagrees with completed run');
                if (event.text.length > output.length) emit({ event: 'delta', text: event.text.slice(output.length) });
              }
              emit({ event: 'done', status: 'succeeded' });
            }
            else if (event.type === 'failed' || event.type === 'interrupted') {
              emit({ event: 'phase', phase: 'failed', message: canvasErrorMessage(event.message, event.code) || canvasText('执行失败', 'Execution failed.') });
              emit({ event: 'done', status: 'failed' });
            } else if (event.type === 'cancelled') emit({ event: 'done', status: 'cancelled' });
            else if (event.type === 'queued' || event.type === 'running') emit({ event: 'status', status: event.type });
          });
        } catch { emit({ event: 'error', detail: canvasText('运行连接中断，请恢复运行状态。', 'The run connection was interrupted. Restore the run state.') }); }
        finally { ended = true; controller.close(); }
      } });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return json({ code: 'unsupported_operation', error: canvasText(`该功能尚未接入 SaaS：${path}`, `This feature is not connected to SaaS: ${path}`) }, 501);
  } catch (error) {
    return json({ code: (error as { code?: string })?.code || 'request_failed', error: canvasErrorMessage(error) }, (error as { status?: number })?.status || 502);
  }
}
