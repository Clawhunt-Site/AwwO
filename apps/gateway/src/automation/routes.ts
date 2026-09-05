// The chat-automation REST API (mounted on the gateway under /api). The composer's
// "设为定时任务" toggle calls POST here; the sidebar badge + management read GET; an
// operator approves a pending automation via POST .../approve.
//
// Governance (铁律3, fail-closed): a NEW automation is created `pending_approval` and the
// ticker will NOT fire it until a human approves. The classifier seam can auto-approve a
// provably-benign prompt later (PR4); the PR2 default is fail-closed — never auto-run.
//
// Auth (Codex finding): this is a persistent background-execution entry, not plain CRUD.
// Every route requires the gateway control token AND must originate from loopback — the
// automation API is a LOCAL control plane (the co-located composer calls it). The loopback
// check is enforced here per-request (defense in depth), independent of the gateway's bind
// host, so even a 0.0.0.0 front-door bind cannot expose this control plane to the network.
// The router also refuses to construct without a control token.

import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { computeNextRunAt } from './schedule.js';
import { type AutomationStore, PERSONAL_CHAT_COMPANY_ID } from './store.js';
import type { AutomationApprovalState, ChatAutomation } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// True iff the request came from the local host. Covers IPv4 loopback (127.0.0.0/8), IPv6
// loopback (::1) and IPv4-mapped IPv6 loopback (::ffff:127.x). Used to keep the automation
// control plane local-only even if the gateway front door binds a public interface.
// Exported for regression testing — must read the socket peer, NOT a spoofable header.
export function isLoopbackRequest(req: Pick<Request, 'socket'>): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return (
    addr === '::1' ||
    addr === '127.0.0.1' ||
    addr.startsWith('127.') ||
    addr.startsWith('::ffff:127.') ||
    addr === '::ffff:127.0.0.1'
  );
}
const MIN_INTERVAL_SEC = 60; // 1 min floor — guards against a local busy-loop DoS
const MAX_INTERVAL_SEC = 60 * 60 * 24 * 30; // 30 days ceiling
const MAX_PROMPT_LEN = 8_000;

export interface CreateAutomationInput {
  sessionIssueId: string;
  prompt: string;
  intervalSec: number;
  timezone?: string;
}

// Governance seam. PR2 is fail-closed: default 'pending_approval'. PR4 replaces this with a
// classifier that may auto-approve a provably-benign prompt (and keep scanning / payment /
// external-write 'pending_approval'). This is the ONLY place approval policy lives.
export type ApprovalClassifier = (input: CreateAutomationInput) => AutomationApprovalState;
const failClosedClassifier: ApprovalClassifier = () => 'pending_approval';

export interface AutomationRouterDeps {
  store: AutomationStore;
  // Required: the shared secret a caller must present as `x-superclaw-gateway-token`.
  controlToken: string;
  now?: () => number;
  idGen?: () => string;
  classifyApproval?: ApprovalClassifier;
}

// Pure constructor — validates and builds a ChatAutomation. Throws RangeError on invalid
// input (the route maps it to 400).
export function buildAutomation(
  input: CreateAutomationInput,
  deps: { now: number; id: string; approvalState: AutomationApprovalState },
): ChatAutomation {
  const sessionIssueId = typeof input.sessionIssueId === 'string' ? input.sessionIssueId.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!UUID_RE.test(sessionIssueId)) throw new RangeError('sessionIssueId must be a uuid (chat session issue id)');
  if (!prompt) throw new RangeError('prompt is required');
  if (prompt.length > MAX_PROMPT_LEN) throw new RangeError(`prompt exceeds ${MAX_PROMPT_LEN} chars`);
  if (
    typeof input.intervalSec !== 'number' ||
    !Number.isInteger(input.intervalSec) ||
    input.intervalSec < MIN_INTERVAL_SEC ||
    input.intervalSec > MAX_INTERVAL_SEC
  ) {
    throw new RangeError(`intervalSec must be an integer in [${MIN_INTERVAL_SEC}, ${MAX_INTERVAL_SEC}] seconds`);
  }
  const cadence = { kind: 'interval' as const, intervalSec: input.intervalSec };
  return {
    id: deps.id,
    sessionIssueId,
    chatAgentId: null, // upstream /chat/stream resolves + assigns the chat agent on fire
    companyId: PERSONAL_CHAT_COMPANY_ID,
    prompt,
    cadence,
    timezone: typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : 'UTC',
    enabled: true,
    nextRunAt: computeNextRunAt(cadence, deps.now, deps.now), // first slot one interval out
    lastFireKey: null,
    approvalState: deps.approvalState,
    lastFiredAt: null,
    lastOutcomeOk: null,
    lastError: null,
    createdAt: deps.now,
    updatedAt: deps.now,
  };
}

// Wrap an async handler so a thrown store/fs error becomes a clean 500 instead of an
// unhandled rejection (Express 4 does not catch async throws).
function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createAutomationRouter(deps: AutomationRouterDeps): Router {
  if (!deps.controlToken || !deps.controlToken.trim()) {
    throw new Error('automation router requires a non-empty controlToken (the API must not be unauthenticated)');
  }
  const router = Router();
  const now = deps.now ?? (() => Date.now());
  const idGen = deps.idGen ?? (() => randomUUID());
  const classify = deps.classifyApproval ?? failClosedClassifier;

  // Loopback-only + token gate on every automation route.
  router.use('/automations', (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: 'automation API is loopback-only' });
      return;
    }
    const token = req.header('x-superclaw-gateway-token');
    if (token !== deps.controlToken) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.post(
    '/automations',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Partial<CreateAutomationInput>;
      const input: CreateAutomationInput = {
        sessionIssueId: body.sessionIssueId as string,
        prompt: body.prompt as string,
        intervalSec: body.intervalSec as number,
        timezone: body.timezone,
      };
      let automation: ChatAutomation;
      try {
        automation = buildAutomation(input, { now: now(), id: idGen(), approvalState: classify(input) });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'invalid automation' });
        return;
      }
      await deps.store.put(automation);
      res.status(201).json(automation);
    }),
  );

  // Approve a pending automation (the human gate). Only flips pending → approved; idempotent.
  router.post(
    '/automations/:id/approve',
    asyncRoute(async (req, res) => {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      const updated = await deps.store.transaction((map) => {
        const a = map.get(id);
        if (!a) return null;
        if (a.approvalState === 'approved') return a; // idempotent: no needless write / updatedAt churn
        const next = { ...a, approvalState: 'approved' as AutomationApprovalState, updatedAt: now() };
        map.set(id, next);
        return next;
      });
      if (!updated) {
        res.status(404).json({ error: 'automation not found' });
        return;
      }
      res.json(updated);
    }),
  );

  router.get(
    '/automations',
    asyncRoute(async (req, res) => {
      const sessionIssueId = typeof req.query.sessionIssueId === 'string' ? req.query.sessionIssueId : null;
      const all = await deps.store.list();
      res.json(sessionIssueId ? all.filter((a) => a.sessionIssueId === sessionIssueId) : all);
    }),
  );

  router.delete(
    '/automations/:id',
    asyncRoute(async (req, res) => {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      await deps.store.delete(id);
      res.status(204).end();
    }),
  );

  return router;
}
