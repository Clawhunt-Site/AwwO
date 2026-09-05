// P3g-a — pick a concrete, staffable agent inside a target company for a mission
// role. The mission matcher (matcher.ts) only outputs companyId (it discards
// agent ids when deriving capability); a real cross-company DELEGATION needs a
// specific named agent to assign the issue to. This closes that gap by reading
// the target company's roster and choosing an AVAILABLE agent whose mapped role
// fits — fail-closed (null when none is staffable, never invents an agent).
//
// The upstream is an opaque loopback HTTP dependency (same contract as the rest
// of the gateway) — we never import its source.
import { mapAgentRole } from './roles.js';
import type { MissionRole } from './types.js';

export interface PickedAgent {
  agentId: string;
  agentName: string;
  /** The agent's own mapped mission role (may differ from the requested role
   *  when we fall back to any available agent). */
  role: MissionRole;
  /** True when the pick's role matches the requested role exactly. */
  roleMatch: boolean;
}

/** Outcome of resolving an agent from a company's live roster. The two failure
 *  kinds are kept DISTINCT on purpose (honest reasons, not one blurred "null"):
 *  `empty_roster` = we read the roster and nobody is staffable (a real fact about
 *  the company); `roster_unreadable` = we could NOT read the roster (unknown —
 *  upstream unreachable / non-2xx / malformed), so the operator must not read it
 *  as "the company has no one". */
export type PickOutcome =
  | { kind: 'picked'; agent: PickedAgent }
  | { kind: 'empty_roster' }
  | { kind: 'roster_unreadable' };

// An agent cannot be staffed if it is one of the upstream's non-invokable
// statuses (mirrors mission/upstream-reader.ts). Default status is `idle` (a
// healthy staffable agent), so treating only `active` as available would drop the
// common case.
const UNAVAILABLE_AGENT_STATUSES = new Set(['paused', 'pending_approval', 'terminated', 'archived']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Pure: from a company's raw agent roster, pick a staffable agent for `role`.
 *  Prefer an available agent whose mapped role matches; else the first available
 *  agent (roleMatch=false); null when none is staffable. Exported for testing. */
export function pickAgentForRole(rawAgents: unknown, role: MissionRole): PickedAgent | null {
  if (!Array.isArray(rawAgents)) return null;
  const available: PickedAgent[] = [];
  for (const a of rawAgents as Array<Record<string, unknown>>) {
    const id = str(a?.id);
    const name = str(a?.name);
    if (!id || !name) continue;
    const status = str(a?.status) ?? 'idle'; // upstream default is idle
    if (UNAVAILABLE_AGENT_STATUSES.has(status)) continue; // not staffable
    const mapped = mapAgentRole(str(a?.role), str(a?.title));
    available.push({ agentId: id, agentName: name, role: mapped, roleMatch: mapped === role });
  }
  return available.find((a) => a.roleMatch) ?? available[0] ?? null;
}

/** Read the target company's roster and pick an agent for `role`. Fail-soft and
 *  HONEST about which failure happened (never throws):
 *   - `picked`            — a staffable agent was chosen.
 *   - `empty_roster`      — the roster read fine but nobody is staffable (a real
 *                           fact the operator can act on).
 *   - `roster_unreadable` — the roster could NOT be read (non-2xx / network /
 *                           malformed / timeout): UNKNOWN, so the caller must not
 *                           fabricate a dispatch nor claim "the company has no one". */
export async function fetchAndPickAgent(
  upstreamBaseUrl: string,
  companyId: string,
  role: MissionRole,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PickOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = upstreamBaseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(`${base}/api/companies/${encodeURIComponent(companyId)}/agents`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
      redirect: 'manual',
    });
    if (!res.ok) return { kind: 'roster_unreadable' };
    const body: unknown = await res.json();
    // A non-array body is a malformed/unexpected roster response — treat as
    // unreadable (unknown), NOT as "empty roster" (which would falsely assert the
    // company has nobody).
    if (!Array.isArray(body)) return { kind: 'roster_unreadable' };
    const picked = pickAgentForRole(body, role);
    return picked ? { kind: 'picked', agent: picked } : { kind: 'empty_roster' };
  } catch {
    return { kind: 'roster_unreadable' };
  } finally {
    clearTimeout(timer);
  }
}
