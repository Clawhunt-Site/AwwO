import { Router, json, type ErrorRequestHandler, type Response } from 'express';
import { isLoopbackRequest } from '../automation/routes.js';
import { PlannerError, type CanvasPlanner, type PlannerProgress, type PlanningRequest } from './provider.js';
import type { CodexModelCatalog } from './model-catalog.js';

const ERRORS = {
  unavailable: { status: 503, error: 'AI 画布规划暂不可用，请检查本机 Codex 安装与登录状态。' },
  cancelled: { status: 499, error: '已取消本次画布规划。' },
  timeout: { status: 504, error: 'AI 规划超时，请缩小需求后重试。' },
  invalid_output: { status: 502, error: 'AI 未返回有效的画布方案，请重试或补充需求。' },
  execution_failed: { status: 502, error: 'AI 规划未完成，请检查本机 Codex 登录或模型可用性后重试。' },
  usage_limit_exceeded: { status: 429, code: 'usage_limit_exceeded', error: '当前 Codex 账户的使用额度已耗尽，请在额度恢复或补充额度后重试。' },
};

// The model streams per token, but a reader needs a readable refresh rate. A stage change
// or a newly declared node is still reported at once.
const PROGRESS_INTERVAL_MS = 250;
// Keeps idle intermediaries from closing a stream while a model reasons in silence.
const HEARTBEAT_MS = 15000;

export function parsePlanningRequest(body: unknown): PlanningRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid input');
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'prompt' && key !== 'context')) throw new Error('invalid input');
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 8000) throw new Error('invalid input');
  if (typeof value.context !== 'string' || !value.context.trim() || value.context.length > 120000) throw new Error('invalid input');
  return { prompt: value.prompt.trim(), context: value.context };
}

export function createCanvasPlannerRouter(deps: { provider: CanvasPlanner; controlToken: string; modelCatalog?: CodexModelCatalog }): Router {
  if (!deps.controlToken.trim()) throw new Error('canvas planner requires a non-empty controlToken');
  const router = Router();
  let active = false;
  router.use('/canvas', (req, res, next) => {
    if (!isLoopbackRequest(req)) { res.status(403).json({ error: '画布规划仅允许本机访问。' }); return; }
    if (req.header('x-superclaw-gateway-token') !== deps.controlToken) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  });
  router.get('/canvas/planner', (_req, res) => {
    void deps.provider.status().then(status => res.json(status)).catch(() => res.json({ available: false, provider: 'codex', error: ERRORS.unavailable.error }));
  });
  router.get('/canvas/runtimes/codex_local/models', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!deps.modelCatalog) throw new Error('catalog unavailable');
      const catalog = await deps.modelCatalog.read();
      if (!res.destroyed) res.json(catalog);
    } catch {
      if (!res.destroyed) res.status(503).json({ code: 'codex_catalog_unavailable', error: '暂时无法读取服务器 Codex 模型目录，请确认运行环境后重试。' });
    }
  });
  router.post('/canvas/plan', json({ limit: '200kb' }), async (req, res) => {
    let request: PlanningRequest;
    try { request = parsePlanningRequest(req.body); }
    catch { res.status(400).json({ error: '请提供有效需求和画布上下文（需求最多 8000 字符，上下文最多 120000 字符）。' }); return; }
    if (active) { res.status(429).json({ error: '已有画布方案正在生成，请完成或取消后重试。' }); return; }
    active = true;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      const status = await deps.provider.status();
      if (!status.available) throw new PlannerError('unavailable');
      if (req.accepts(['application/json', 'text/event-stream']) === 'text/event-stream') {
        await streamPlan(deps.provider, request, controller.signal, status.provider, res);
        return;
      }
      const plan = await deps.provider.plan(request, controller.signal);
      if (!controller.signal.aborted) res.json({ plan, provider: status.provider });
    } catch (error) {
      if (!controller.signal.aborted && !res.headersSent) {
        const { status, ...failure } = error instanceof PlannerError ? ERRORS[error.code] : ERRORS.execution_failed;
        res.status(status).json(failure);
      }
    } finally {
      active = false;
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  });
  const invalidJson: ErrorRequestHandler = (error, _req, res, _next) => {
    const tooLarge = error?.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? '画布上下文超过请求大小限制，请缩小后重试。' : '请求必须是有效 JSON。' });
  };
  router.use('/canvas', invalidJson);
  return router;
}

/** Answer as a progress stream. From its first byte the transport status is 200, so its
 * own frames carry the outcome: exactly one plan or one error, never an empty plan. */
async function streamPlan(provider: CanvasPlanner, request: PlanningRequest, signal: AbortSignal, name: string, res: Response): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (frame: unknown) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(frame)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n'); }, HEARTBEAT_MS);
  heartbeat.unref();
  let last: PlannerProgress = { stage: 'running', characters: 0, nodes: 0, edges: 0, reasoning: 0 };
  let lastAt = Date.now();
  // The planner accepted the request and is starting: say so before it reports anything.
  send({ type: 'progress', ...last });
  const report = (progress: PlannerProgress) => {
    // A new stage, node, connection or template is what a reader waits for.
    const urgent = progress.stage !== last.stage || progress.nodes !== last.nodes || progress.edges !== last.edges || progress.template !== last.template;
    const same = !urgent && progress.characters === last.characters && progress.reasoning === last.reasoning;
    if (same || (!urgent && Date.now() - lastAt < PROGRESS_INTERVAL_MS)) return;
    last = { ...progress };
    lastAt = Date.now();
    send({ type: 'progress', ...last });
  };
  try {
    const plan = await provider.plan(request, signal, report);
    if (!signal.aborted) send({ type: 'plan', plan, provider: name });
  } catch (error) {
    if (!signal.aborted) {
      const code = error instanceof PlannerError ? error.code : 'execution_failed';
      const { status: _status, ...failure } = error instanceof PlannerError ? ERRORS[error.code] : ERRORS.execution_failed;
      send({ type: 'error', code, ...failure });
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}
