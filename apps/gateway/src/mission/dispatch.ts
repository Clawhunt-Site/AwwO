// P3g-a — dispatch ONE mission track as a real cross-company delegation
// (gateway BFF, ZERO server/ change). This is the human-approved, board-executed
// half of "companies collaborate": the operator approves sending a planned
// track's work to a matched company, and the gateway — acting as the local board
// (which the kernel already lets read/write any company) — creates a real issue
// in that company assigned to one of ITS agents and wakes it.
//
// It reuses the P3d conversation dispatcher UNCHANGED (dispatch is company-
// agnostic) and the mission agent-picker to resolve the concrete agent the
// matcher dropped. Honest outcomes only: dispatched / queued / no_agent / error —
// never a fabricated "delegated" when nothing landed. This is board-orchestrated
// delegation, NOT an A-agent autonomously commanding B (the kernel forbids that).
import type { AgentConversationDispatcher } from '../conversation/dispatcher.js';
import { fetchAndPickAgent } from './agent-picker.js';
import type { MissionRole } from './types.js';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export interface DispatchTrackInput {
  /** The matched target company to delegate this track to. */
  companyId: string;
  /** The track's role — used to auto-pick a fitting agent when none is given. */
  role: MissionRole;
  /** The work to delegate (becomes the issue body the woken agent executes). */
  task: string;
  /** Operator override: dispatch to THIS specific agent instead of auto-picking. */
  agentId?: string;
  agentName?: string;
  /** Title for the conversation/delegation issue. */
  title?: string;
}

interface AgentRef {
  id: string;
  name: string;
  /** True when the picked agent's role matched the track role (false = fallback
   *  to any available agent; unknown for an operator override → false, honestly). */
  roleMatch: boolean;
}

export type DispatchTrackResult =
  | { status: 'dispatched'; companyId: string; agent: AgentRef; issueId: string; runId: string }
  | { status: 'queued'; companyId: string; agent: AgentRef; issueId: string; detail: string }
  // Nothing delegated — HONEST about which reason: `empty_roster` (company has
  // nobody staffable) vs `roster_unreadable` (upstream unreachable → unknown).
  | { status: 'no_agent'; companyId: string; reason: 'empty_roster' | 'roster_unreadable'; detail: string }
  | { status: 'error'; detail: string };

export interface DispatchTrackDeps {
  dispatcher: Pick<AgentConversationDispatcher, 'dispatch'>;
  upstreamBaseUrl: string;
  fetchImpl?: typeof fetch;
}

/** Resolve the target agent (operator override or auto-pick) and delegate the
 *  track's task to it via the conversation dispatcher. Never throws. */
export async function dispatchTrack(
  deps: DispatchTrackDeps,
  input: DispatchTrackInput,
): Promise<DispatchTrackResult> {
  const companyId = str(input.companyId);
  const task = str(input.task);
  if (!companyId) return { status: 'error', detail: 'missing companyId' };
  if (!task) return { status: 'error', detail: 'empty task' };

  let agent: AgentRef;
  const overrideId = str(input.agentId);
  if (overrideId) {
    // Operator picked a specific agent — trust it; role fit is unknown here.
    agent = { id: overrideId, name: str(input.agentName) ?? overrideId, roleMatch: false };
  } else {
    const outcome = await fetchAndPickAgent(deps.upstreamBaseUrl, companyId, input.role, {
      fetchImpl: deps.fetchImpl,
    });
    if (outcome.kind !== 'picked') {
      // Fail-closed: nothing to dispatch to. Surface the HONEST reason so the
      // operator reconciles — never fabricate a delegation. The two reasons are
      // materially different: `empty_roster` is a fact about the company (staff
      // someone), `roster_unreadable` is UNKNOWN (upstream unreachable — retry).
      const detail =
        outcome.kind === 'empty_roster'
          ? 'the target company has no staffable agent for this role (nobody available)'
          : 'the target company roster could not be read (upstream unreachable) — nothing dispatched';
      return { status: 'no_agent', companyId, reason: outcome.kind, detail };
    }
    agent = { id: outcome.agent.agentId, name: outcome.agent.agentName, roleMatch: outcome.agent.roleMatch };
  }

  const r = await deps.dispatcher.dispatch({ companyId, agentId: agent.id, message: task, title: input.title });
  if (r.status === 'error') return { status: 'error', detail: r.detail };
  if (r.status === 'dispatched') return { status: 'dispatched', companyId, agent, issueId: r.issueId, runId: r.run.runId };
  return { status: 'queued', companyId, agent, issueId: r.issueId, detail: r.detail };
}
