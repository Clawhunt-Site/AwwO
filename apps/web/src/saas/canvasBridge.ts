import { api, API_BASE, tenantPath, type Tenant } from './api';
import { readSseFrames } from '../sse';
import { canvasErrorMessage, canvasText } from './canvasErrors';

type CanvasScope = { tenant: Tenant; canvasId: string };
let active: CanvasScope | null = null;
let saveCanvas: (() => Promise<number | void>) | null = null;
export function configureSaaSCanvas(scope: CanvasScope): void { active = scope; }
export function configureSaaSCanvasSave(save: (() => Promise<number | void>) | null): void { saveCanvas = save; }
export function clearSaaSCanvas(): void { active = null; }
/** Capture a tenant/canvas scope once; an in-flight operation must not follow a workspace switch. */
export function currentSaaSCanvas(): CanvasScope | null { return active; }
export async function flushSaaSCanvas(): Promise<number | void> {
  if (!saveCanvas) throw new Error(canvasText('画布保存尚未就绪', 'Canvas saving is not ready.'));
  return saveCanvas();
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const operationStatus = (operationId: string, run?: any) => ({ operationId,
  state: !run ? 'not_started' : run.terminal ? 'terminal' : 'accepted',
  issueId: run?.sessionId ?? null, runId: run?.id ?? null, terminal: run?.terminal ?? false,
  status: run ? normalizeStatus(run.status) : null, output: run?.output ?? '',
  outputAvailable: run?.outputAvailable ?? false, detail: run?.error ? canvasErrorMessage(run.error) : null });
const normalizeStatus = (status: string) => status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'failed' : status;

/** Explicit adapter for the existing canvas protocols; never replaces global fetch. */
export async function canvasFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const scope = active;
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
      const runtime = await api<any>('/runtime', { signal: init.signal });
      return json([{ type: 'pi', loaded: true, disabled: false, supportsNodeTeams: true, modelsCount: runtime.models?.length || 0 }]);
    }
    if (/\/adapters\/[^/]+\/models$/.test(path)) return json((await api<any>('/runtime', { signal: init.signal })).models || []);
    if (path === '/canvas/planner') {
      const runtime = await api<any>('/runtime', { signal: init.signal });
      const available = runtime.available === true && runtime.plannerAvailable === true;
      return json({ available, provider: 'pi',
        ...(!available ? { error: (runtime.reason ? canvasErrorMessage(runtime.reason) : '') || canvasText('Pi 规划服务尚未就绪。', 'The Pi planning service is not ready.') } : {}) });
    }
    if (path === '/canvas/plan' && method === 'POST') {
      if (!saveCanvas) return json({ error: canvasText('画布保存尚未就绪', 'Canvas saving is not ready.') }, 409);
      await saveCanvas();
      const operationId = crypto.randomUUID();
      const run = await post(`/canvases/${encodeURIComponent(scope.canvasId)}/plan`, { prompt: body.prompt, context: body.context, operationId });
      const cancel = () => { void api(`${base}/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST', body: '{}' }).catch(() => {}); };
      init.signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (init.signal?.aborted) { cancel(); throw new Error(canvasText('已取消规划', 'Planning was cancelled.')); }
        const response = await fetch(`${API_BASE}${base}/runs/${encodeURIComponent(run.id)}/events`, { credentials: 'include', signal: init.signal });
        if (!response.ok || !response.body) throw new Error(canvasText('无法读取规划运行，请稍后重试。', 'The planning run could not be read. Please try again.'));
        let output = '';
        let completed = false;
        let failure = '';
        await readSseFrames(response.body, (_event, event: any) => {
          if (completed || failure) return;
          if (event.type === 'text_delta') output += event.delta || '';
          else if (event.type === 'completed') {
            if (typeof event.text === 'string') {
              if (!event.text.startsWith(output)) { failure = canvasText('规划结果与流式输出不一致。', 'The plan does not match the streamed output.'); return; }
              output = event.text;
            }
            completed = true;
          } else if (['failed', 'interrupted', 'cancelled'].includes(event.type)) failure = canvasErrorMessage(event.message, event.code) || canvasText('规划未完成，请重试。', 'Planning did not complete. Please try again.');
        });
        if (failure) throw new Error(failure);
        if (!completed) throw new Error(canvasText('规划连接中断；当前画布保持原样。', 'The planning connection was interrupted. The canvas has not changed.'));
        // The caller still applies its existing strict protocol and graph validation.
        try { return json({ plan: JSON.parse(output.trim()) }); }
        catch { throw new Error(canvasText('Pi 返回的规划不是有效 JSON；当前画布保持原样。', 'Pi returned an invalid JSON plan. The canvas has not changed.')); }
      } finally { init.signal?.removeEventListener('abort', cancel); }
    }
    if (/^\/companies\/[^/]+\/agent-hires$/.test(path)) {
      const { name, role, title, adapterType, adapterConfig } = body;
      const agent = await post('/agents', { name, role, title, adapterType, adapterConfig });
      return json({ agent: { ...agent, status: 'idle' } }, 201);
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
      return json({ complete: true, messages: result.items.map((item: any) => ({ body: item.content, ...(item.role === 'assistant' || item.role === 'agent' ? { authorAgentId: 'pi' } : {}) })) });
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
      const operationId = body.operationId || crypto.randomUUID();
      const existing = (await request(`/runs?operationId=${encodeURIComponent(operationId)}`)).items[0];
      let sessionId = existing?.sessionId || body.issueId;
      if (!sessionId) {
        const session = await post('/sessions', { canvasId: scope.canvasId,
          nodeId: new Headers(init.headers).get('X-Awwo-Node-Id') || decodeURIComponent(send[2]),
          agentId: decodeURIComponent(send[2]), title: body.message.slice(0, 80) });
        sessionId = session.id;
      }
      const run = await post('/runs', { sessionId, prompt: body.message, operationId });
      const upstream = await fetch(`${API_BASE}${base}/runs/${encodeURIComponent(run.id)}/events`, { credentials: 'include', signal: init.signal });
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
