// P3d — the per-agent conversation SSE route (gateway BFF, part 2c).
//
// POST /api/conversations/:companyId/agents/:agentId/messages streams a real
// conversation turn to the caller as Server-Sent Events. It composes the
// dispatcher (wake the specific hired agent via a dedicated issue) + the WS event
// source + the projector (via streamConversationTurn) into one SSE response for
// apps/web. Zero server/ change — everything rides already-mounted upstream /api
// primitives.
//
// Auth mirrors the mission/automation routers: loopback-only (per-request socket
// peer, not a spoofable header) + the gateway control token. The router refuses to
// construct without a token.

import { Router, json, type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import { isLoopbackRequest } from '../automation/routes.js';
import type { ConversationIndexStore } from './index-store.js';
import type { AgentConversationDispatcher } from './dispatcher.js';
import { ConversationOperationConflictError, isConversationOperationId } from './operation-store.js';
import { streamConversationTurn, type CompanyEventSource, type ConversationStreamDeps } from './stream.js';

const MAX_MESSAGE_LEN = 16_000;

export interface ConversationRouterDeps {
  dispatcher: ConversationStreamDeps['dispatcher'] & Partial<Pick<AgentConversationDispatcher,
    'cancelConversationRun' | 'settleConversationRun' | 'readConversationRun' | 'prepareConversationOperation' | 'readConversationOperation'>>;
  /** Opens a BUFFERING company event source (subscribe-before-wake). */
  openEventSource: (companyId: string) => CompanyEventSource;
  /** Shared secret required as `x-superclaw-gateway-token`. */
  controlToken: string;
  /** How long to wait for a queued run to become visible before reporting no_run. */
  runDiscoveryAttempts?: number;
  runDiscoveryDelayMs?: number;
  /** P3f: company-wide conversation index. Omitted → the index routes are not mounted and the
   *  send path simply stamps no label (conversations stay durable, just unindexed). */
  indexStore?: ConversationIndexStore;
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Write one SSE frame, respecting backpressure: if the socket send buffer is full
 *  (write() returns false), wait for 'drain' before continuing so a slow client
 *  can't make the gateway buffer an entire run in memory. Resolves early on abort
 *  (client gone) so we never hang waiting for a 'drain' that will never come. */
function writeFrame(res: Response, frame: string, signal: AbortSignal): Promise<void> {
  if (res.write(frame)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    res.once('drain', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createConversationRouter(deps: ConversationRouterDeps): Router {
  if (!deps.controlToken || !deps.controlToken.trim()) {
    throw new Error('conversation router requires a non-empty controlToken (the API must not be unauthenticated)');
  }
  const router = Router();

  // Loopback-only + token gate on every conversation route.
  router.use('/conversations', (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: 'conversation API is loopback-only' });
      return;
    }
    if (req.header('x-superclaw-gateway-token') !== deps.controlToken) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // P3f — COMPANY-WIDE conversation index (read-only). Rides the same loopback+token gate above.
  if (deps.indexStore) {
    const store = deps.indexStore;
    router.get('/conversations/:companyId', async (req: Request, res: Response) => {
      const companyId = String(req.params.companyId ?? '').trim();
      if (!companyId) {
        res.status(400).json({ error: 'companyId is required' });
        return;
      }
      try {
        res.json({ companyId, conversations: await store.listConversations(companyId) });
      } catch (err) {
        // Honest failure: an empty list here would be indistinguishable from "never talked".
        res.status(502).json({ error: 'index_unavailable', detail: err instanceof Error ? err.message : 'unknown' });
      }
    });

    router.get('/conversations/:companyId/issues/:issueId/messages', async (req: Request, res: Response) => {
      const companyId = String(req.params.companyId ?? '').trim();
      const issueId = String(req.params.issueId ?? '').trim();
      if (!companyId || !issueId) {
        res.status(400).json({ error: 'companyId and issueId are required' });
        return;
      }
      try {
        res.json({ issueId, messages: await store.listMessages(companyId, issueId), complete: true });
      } catch (err) {
        res.status(502).json({ error: 'transcript_unavailable', detail: err instanceof Error ? err.message : 'unknown' });
      }
    });
  }

  router.get('/conversations/:companyId/agents/:agentId/issues/:issueId/runs/:runId', async (req: Request, res: Response) => {
    if (!deps.dispatcher.readConversationRun) { res.status(503).json({ error: 'recovery_unavailable' }); return; }
    try {
      res.json(await deps.dispatcher.readConversationRun({
        companyId: String(req.params.companyId), agentId: String(req.params.agentId),
        issueId: String(req.params.issueId), runId: String(req.params.runId),
      }));
    } catch (error) {
      res.status(502).json({ error: 'recovery_unconfirmed', detail: error instanceof Error ? error.message : 'Run could not be read' });
    }
  });

  // Persist the caller-minted identity before the streaming request starts. This
  // endpoint performs no upstream mutation: a browser that refreshes after this
  // response can distinguish "prepared only" from "delivery may have started".
  router.post('/conversations/:companyId/agents/:agentId/operations/:operationId/prepare', json({ limit: '100kb' }), async (req: Request, res: Response) => {
    if (!deps.dispatcher.prepareConversationOperation) { res.status(503).json({ error: 'operation_recovery_unavailable' }); return; }
    const companyId = String(req.params.companyId ?? '').trim();
    const agentId = String(req.params.agentId ?? '').trim();
    const operationId = String(req.params.operationId ?? '').trim();
    const body = (req.body ?? {}) as { message?: unknown; issueId?: unknown };
    const message = typeof body.message === 'string' ? body.message : '';
    const issueId = typeof body.issueId === 'string' && body.issueId.trim() ? body.issueId.trim() : undefined;
    if (!companyId || !agentId) { res.status(400).json({ error: 'companyId and agentId are required' }); return; }
    if (!isConversationOperationId(operationId)) { res.status(400).json({ error: 'invalid_operation_id' }); return; }
    if (!message.trim()) { res.status(400).json({ error: 'message is required' }); return; }
    if (message.length > MAX_MESSAGE_LEN) { res.status(400).json({ error: `message exceeds ${MAX_MESSAGE_LEN} chars` }); return; }
    try {
      const prepared = await deps.dispatcher.prepareConversationOperation({ companyId, agentId, message, issueId, operationId });
      if (!prepared) throw new Error('Operation could not be prepared');
      res.status(prepared.created ? 201 : 200).json({
        operationId,
        prepared: true,
        mutationStarted: prepared.snapshot.mutationStarted,
        deliveryConfirmed: prepared.snapshot.deliveryConfirmed,
      });
    } catch (error) {
      if (error instanceof ConversationOperationConflictError) {
        res.status(409).json({ error: 'operation_conflict', detail: error.message });
        return;
      }
      res.status(503).json({ error: 'operation_claim_failed', detail: error instanceof Error ? error.message : 'Operation could not be claimed' });
    }
  });

  router.get('/conversations/:companyId/agents/:agentId/operations/:operationId', async (req: Request, res: Response) => {
    if (!deps.dispatcher.readConversationOperation) { res.status(503).json({ error: 'operation_recovery_unavailable' }); return; }
    const operationId = String(req.params.operationId ?? '').trim();
    if (!isConversationOperationId(operationId)) { res.status(400).json({ error: 'invalid_operation_id' }); return; }
    try {
      res.json(await deps.dispatcher.readConversationOperation({
        companyId: String(req.params.companyId), agentId: String(req.params.agentId), operationId,
      }));
    } catch (error) {
      if (error instanceof ConversationOperationConflictError) {
        res.status(409).json({ error: 'operation_conflict', detail: error.message });
        return;
      }
      res.status(502).json({ error: 'operation_recovery_unconfirmed', detail: error instanceof Error ? error.message : 'Operation could not be read' });
    }
  });

  router.post('/conversations/:companyId/agents/:agentId/issues/:issueId/settle', json({ limit: '2kb' }), async (req: Request, res: Response) => {
    const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
    if (!isConversationOperationId(runId)) { res.status(400).json({ confirmed: false, detail: 'a native run UUID is required' }); return; }
    if (!deps.dispatcher.settleConversationRun) { res.status(503).json({ confirmed: false, detail: 'native settlement is unavailable' }); return; }
    const result = await deps.dispatcher.settleConversationRun({
      companyId: String(req.params.companyId), agentId: String(req.params.agentId), issueId: String(req.params.issueId), runId,
    });
    res.status(result.confirmed ? 200 : 409).json(result);
  });

  router.post(
    '/conversations/:companyId/agents/:agentId/issues/:issueId/cancel',
    json({ limit: '2kb' }),
    async (req: Request, res: Response) => {
      const companyId = String(req.params.companyId ?? '').trim();
      const agentId = String(req.params.agentId ?? '').trim();
      const issueId = String(req.params.issueId ?? '').trim();
      const runId = typeof req.body?.runId === 'string' && req.body.runId.trim() ? req.body.runId.trim() : undefined;
      if (!companyId || !agentId || !issueId) {
        res.status(400).json({ error: 'companyId, agentId and issueId are required' });
        return;
      }
      if (!deps.dispatcher.cancelConversationRun) {
        res.status(503).json({ error: 'native_stop_unavailable' });
        return;
      }
      const result = await deps.dispatcher.cancelConversationRun({ companyId, agentId, issueId, runId });
      if (!result.ok) {
        res.status(502).json({ error: 'native_stop_unconfirmed', detail: result.detail });
        return;
      }
      res.json(result);
    },
  );

  router.post('/conversations/:companyId/agents/:agentId/messages', json({ limit: '100kb' }), async (req: Request, res: Response) => {
    const companyId = String(req.params.companyId ?? '').trim();
    const agentId = String(req.params.agentId ?? '').trim();
    const body = (req.body ?? {}) as { message?: unknown; issueId?: unknown; operationId?: unknown };
    const message = typeof body.message === 'string' ? body.message : '';
    const issueId = typeof body.issueId === 'string' && body.issueId.trim() ? body.issueId.trim() : undefined;
    const operationId = typeof body.operationId === 'string' && body.operationId.trim() ? body.operationId.trim() : undefined;

    if (!companyId || !agentId) {
      res.status(400).json({ error: 'companyId and agentId are required' });
      return;
    }
    if (!message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    if (message.length > MAX_MESSAGE_LEN) {
      res.status(400).json({ error: `message exceeds ${MAX_MESSAGE_LEN} chars` });
      return;
    }
    if (body.operationId !== undefined && (!operationId || !isConversationOperationId(operationId))) {
      res.status(400).json({ error: 'invalid_operation_id' });
      return;
    }

    // Re-check the immutable request identity before opening SSE. New Web clients already
    // called the prepare endpoint; this keeps direct/older clients safe and idempotent.
    if (operationId) {
      if (!deps.dispatcher.prepareConversationOperation) {
        res.status(503).json({ error: 'operation_recovery_unavailable' });
        return;
      }
      try {
        await deps.dispatcher.prepareConversationOperation({ companyId, agentId, message, issueId, operationId });
      } catch (error) {
        if (error instanceof ConversationOperationConflictError) {
          res.status(409).json({ error: 'operation_conflict', detail: error.message });
          return;
        }
        res.status(503).json({ error: 'operation_claim_failed', detail: error instanceof Error ? error.message : 'Operation could not be claimed' });
        return;
      }
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // don't let a proxy buffer the stream
    (res as { flushHeaders?: () => void }).flushHeaders?.();

    // Client disconnect → abort → the orchestrator closes its event source and the
    // loop ends promptly (the finally still cleans up regardless). Listen on the
    // RESPONSE, not the request: in modern Node `req` 'close' fires as soon as the
    // request body is fully received (not on disconnect), which would abort every
    // turn immediately. `res` 'close' with a not-yet-finished guard is the real
    // premature-disconnect signal.
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    // P3f: stamp the conversation label so this thread is findable in the company-wide index.
    // Only a FIRST turn creates an issue, so skip the lookup when resuming one. Fail-soft by
    // design — an unavailable label yields an unindexed conversation, never a dropped message.
    const labelIds =
      !issueId && deps.indexStore
        ? ((id) => (id ? [id] : undefined))(await deps.indexStore.ensureConversationLabel(companyId))
        : undefined;

    try {
      for await (const frame of streamConversationTurn(
        {
          dispatcher: deps.dispatcher,
          openEventSource: deps.openEventSource,
          runDiscoveryAttempts: deps.runDiscoveryAttempts,
          runDiscoveryDelayMs: deps.runDiscoveryDelayMs,
        },
        { companyId, agentId, message, issueId, labelIds, operationId },
        ac.signal,
      )) {
        if (ac.signal.aborted) break;
        await writeFrame(res, sseFrame(frame.event, frame), ac.signal);
      }
    } catch {
      // streamConversationTurn is fail-soft, but never let a stray throw crash the
      // response — surface an honest error frame if the client is still connected.
      if (!ac.signal.aborted) {
        try {
          res.write(sseFrame('error', { event: 'error', detail: 'conversation stream failed' }));
        } catch {
          /* client already gone */
        }
      }
    } finally {
      res.end();
    }
  });

  const invalidJson: ErrorRequestHandler = (error, _req, res, next) => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request_too_large' });
    } else if (error?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
    } else {
      next(error);
    }
  };
  router.use('/conversations', invalidJson);

  return router;
}
