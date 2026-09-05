// P3g-a — the mission DISPATCH route (mutation): POST /api/missions/dispatch
// delegates ONE approved track to a matched company's agent (board-executed,
// zero server/). Kept SEPARATE from the read-only mission planner router so the
// mutation surface is explicit. Auth mirrors mission/automation: loopback-only
// (per-request socket peer, not a spoofable header) + the gateway control token.
// The route only fires AFTER the operator approved this delegation in the UI —
// the gateway never auto-dispatches (fail-closed, human-in-the-loop).
import { Router, type NextFunction, type Request, type Response } from 'express';
import { isLoopbackRequest } from '../automation/routes.js';
import { dispatchTrack, type DispatchTrackResult } from './dispatch.js';
import type { AgentConversationDispatcher } from '../conversation/dispatcher.js';
import { isMissionRole } from './roles.js';
import type { MissionRole } from './types.js';

const MAX_TASK_LEN = 8_000;

/**
 * P3g — how many AUTONOMOUS dispatches one source may fire per window. Human-approved
 * dispatches are self-limiting (someone has to click); autonomous ones are not, so a
 * looping or prompt-injected agent could otherwise fan out without bound. Human-gated
 * dispatches are never counted or refused by this budget.
 */
const AUTONOMY_MAX_PER_WINDOW = 20;
const AUTONOMY_WINDOW_MS = 60_000;

export interface MissionDispatchRouterDeps {
  dispatcher: Pick<AgentConversationDispatcher, 'dispatch'>;
  upstreamBaseUrl: string;
  controlToken: string;
  fetchImpl?: typeof fetch;
  /**
   * P3g switch. When false (the default), a request that declares itself `autonomous`
   * is refused — leaving exactly today's human-in-the-loop behaviour. Requests that do
   * NOT declare autonomy are unaffected either way, so the operator-approved canvas
   * path behaves identically whether this is on or off.
   */
  crossCompanyAutonomy?: boolean;
  /** Injectable clock so the rate-limit window is testable without real time. */
  now?: () => number;
}

export interface ParsedDispatchRequest {
  companyId: string;
  role: MissionRole;
  task: string;
  agentId?: string;
  agentName?: string;
  title?: string;
  /**
   * The caller ASSERTS this dispatch has no human in the loop. Absent/false = the
   * operator-approved path (unchanged). It is a self-declaration, not a credential —
   * everything reaching this route already holds loopback + the control token — so its
   * value is that autonomy is explicit, auditable and separately budgeted rather than
   * indistinguishable from an operator click.
   */
  autonomous: boolean;
}

/** Pure request validation. Throws RangeError (→ 400) on bad input. */
export function parseDispatchRequest(body: unknown): ParsedDispatchRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const companyId = typeof b.companyId === 'string' ? b.companyId.trim() : '';
  if (!companyId) throw new RangeError('companyId is required');
  if (!isMissionRole(b.role)) throw new RangeError('role must be one of explore|plan|implement|verify|review');
  const task = typeof b.task === 'string' ? b.task : '';
  if (!task.trim()) throw new RangeError('task is required');
  if (task.length > MAX_TASK_LEN) throw new RangeError(`task exceeds ${MAX_TASK_LEN} chars`);
  const agentId = typeof b.agentId === 'string' && b.agentId.trim() ? b.agentId.trim() : undefined;
  const agentName = typeof b.agentName === 'string' && b.agentName.trim() ? b.agentName.trim() : undefined;
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : undefined;
  // Strictly boolean `true`. A truthy string ("false", "0") must NOT read as autonomy.
  const autonomous = b.autonomous === true;
  return { companyId, role: b.role, task, agentId, agentName, title, autonomous };
}

/** Fixed-window budget for autonomous dispatch, keyed by source. Exported for tests. */
export function createAutonomyBudget(now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    /** Records an attempt; false = over budget for this window (caller must refuse). */
    take(key: string): boolean {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.start >= AUTONOMY_WINDOW_MS) {
        windows.set(key, { start: t, count: 1 });
        return true;
      }
      if (w.count >= AUTONOMY_MAX_PER_WINDOW) return false;
      w.count += 1;
      return true;
    },
  };
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createMissionDispatchRouter(deps: MissionDispatchRouterDeps): Router {
  const autonomyBudget = createAutonomyBudget(deps.now);
  if (!deps.controlToken || !deps.controlToken.trim()) {
    throw new Error('mission dispatch router requires a non-empty controlToken (the API must not be unauthenticated)');
  }
  const router = Router();

  router.use('/missions/dispatch', (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: 'mission dispatch is loopback-only' });
      return;
    }
    if (req.header('x-superclaw-gateway-token') !== deps.controlToken) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.post(
    '/missions/dispatch',
    asyncRoute(async (req, res) => {
      let parsed: ParsedDispatchRequest;
      try {
        parsed = parseDispatchRequest(req.body);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'invalid dispatch request' });
        return;
      }
      // P3g gate. Only a request that DECLARES autonomy is affected; the operator-approved
      // canvas path (no `autonomous` field) behaves exactly as before, flag on or off.
      if (parsed.autonomous) {
        if (!deps.crossCompanyAutonomy) {
          res.status(403).json({
            error: 'autonomy_disabled',
            detail:
              'Autonomous cross-company dispatch is off. Enable SUPERCLAW_GATEWAY_CROSS_COMPANY_AUTONOMY=on, or dispatch through the operator-approved path.',
          });
          return;
        }
        if (!autonomyBudget.take(parsed.companyId)) {
          res.status(429).json({
            error: 'autonomy_rate_limited',
            detail: `Autonomous dispatch budget exhausted for this company (max ${AUTONOMY_MAX_PER_WINDOW} per ${AUTONOMY_WINDOW_MS / 1000}s).`,
          });
          return;
        }
      }
      // Audit: autonomy has no human who can later say what they approved, so the decision
      // itself is the record. Task TEXT is deliberately not logged (it can carry injected
      // content); its length and the resolved target are enough to reconstruct a fan-out.
      console.log(
        JSON.stringify({
          evt: 'mission.dispatch',
          decision: parsed.autonomous ? 'autonomous' : 'human_approved',
          companyId: parsed.companyId,
          role: parsed.role,
          agentId: parsed.agentId ?? null,
          taskLen: parsed.task.length,
          autonomyEnabled: deps.crossCompanyAutonomy === true,
        }),
      );
      const result: DispatchTrackResult = await dispatchTrack(
        { dispatcher: deps.dispatcher, upstreamBaseUrl: deps.upstreamBaseUrl, fetchImpl: deps.fetchImpl },
        parsed,
      );
      // dispatched / queued / no_agent are all HONEST real outcomes (200); only a
      // real upstream failure is 502. no_agent is NOT an error — it's "nothing to
      // dispatch to", surfaced so the UI reconciles (never a fabricated success).
      if (result.status === 'error') {
        res.status(502).json(result);
        return;
      }
      res.json(result);
    }),
  );

  return router;
}
