// The mission API (mounted on the gateway under /api). POST /api/missions/plan
// takes a prompt + topology, plans it into role tracks, reads the REAL companies
// from the upstream, and matches each track to a company by capability. It is
// READ-ONLY: it creates no issues, runs, or companies — turning a mission into
// real work is a separate, human-gated concern (P2). This endpoint replaces the
// canvas's dependency on the retiring Python /api/goals planner.
//
// Auth mirrors the automation router: this is a LOCAL control plane the
// co-located canvas calls, so every route requires the gateway control token AND
// must originate from loopback (checked per-request from the socket peer, not a
// spoofable header) — even a 0.0.0.0 front-door bind cannot expose it. The
// router refuses to construct without a control token.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { isLoopbackRequest } from '../automation/routes.js';
import { MISSION_TOPOLOGIES, type MissionTopology } from './types.js';
import { planMissionResult } from './plan.js';
import type { UpstreamCompanyReader } from './upstream-reader.js';

const MAX_PROMPT_LEN = 8_000;

export interface MissionRouterDeps {
  reader: UpstreamCompanyReader;
  /** Shared secret required as `x-superclaw-gateway-token` (same token as the
   *  automation API — the gateway owns one control token). */
  controlToken: string;
}

export interface ParsedMissionRequest {
  prompt: string;
  topology: MissionTopology;
}

/** Pure request validation. Throws RangeError (→ 400) on bad input. Topology
 *  defaults to 'linear' when omitted. */
export function parseMissionRequest(body: unknown): ParsedMissionRequest {
  const b = (body ?? {}) as { prompt?: unknown; topology?: unknown };
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) throw new RangeError('prompt is required');
  if (prompt.length > MAX_PROMPT_LEN) throw new RangeError(`prompt exceeds ${MAX_PROMPT_LEN} chars`);
  let topology: MissionTopology = 'linear';
  if (b.topology !== undefined && b.topology !== null) {
    if (typeof b.topology !== 'string' || !(MISSION_TOPOLOGIES as readonly string[]).includes(b.topology)) {
      throw new RangeError(`topology must be one of ${MISSION_TOPOLOGIES.join(', ')}`);
    }
    topology = b.topology as MissionTopology;
  }
  return { prompt, topology };
}

function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createMissionRouter(deps: MissionRouterDeps): Router {
  if (!deps.controlToken || !deps.controlToken.trim()) {
    throw new Error('mission router requires a non-empty controlToken (the API must not be unauthenticated)');
  }
  const router = Router();

  // Loopback-only + token gate on every mission route.
  router.use('/missions', (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: 'mission API is loopback-only' });
      return;
    }
    if (req.header('x-superclaw-gateway-token') !== deps.controlToken) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.post(
    '/missions/plan',
    asyncRoute(async (req, res) => {
      let parsed: ParsedMissionRequest;
      try {
        parsed = parseMissionRequest(req.body);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'invalid mission request' });
        return;
      }
      try {
        const result = await planMissionResult(parsed.prompt, parsed.topology, deps.reader);
        res.json(result);
      } catch (err) {
        // Upstream unreadable (companies fetch failed) → 502, not a fake empty
        // plan. The canvas falls back to its local planner and flags offline.
        res.status(502).json({ error: err instanceof Error ? err.message : 'upstream unavailable' });
      }
    }),
  );

  return router;
}
