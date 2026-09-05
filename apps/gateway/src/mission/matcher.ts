import type { CompanyCapability, MissionMatch, MissionPlan, MissionRole } from './types.js';

// The matcher: SuperClaw's "找需要的 company 对齐" — bind each plan track to the
// best real company that can cover its role. Pure and deterministic.
//
// Selection per track:
//   1. Candidates = companies whose `strengths` include the track's role.
//   2. Prefer the company assigned the FEWEST tracks so far in THIS mission
//      (spread work across houses — keeps balancing even after every candidate
//      has been used once, so parallel branches land on different houses when
//      the houses are otherwise equal), then the one with the most available
//      agents (a rough capacity heuristic), then a stable tiebreak on companyId
//      (deterministic output for the same input).
//   3. No candidate → the track is unmatched (companyId null). Unmatched roles
//      are collected and returned — the mission is NOT silently made to look
//      staffed when it is not (that would be a fake-coverage lie, and it is the
//      seam where P2 proposes a NEW company under the human gate).

export interface MatchResult {
  matches: MissionMatch[];
  companies: string[];
  unmatchedRoles: MissionRole[];
  fullyMatched: boolean;
}

export function matchTracks(plan: MissionPlan, companies: CompanyCapability[]): MatchResult {
  const loadThisMission = new Map<string, number>(); // companyId → tracks assigned so far
  const matches: MissionMatch[] = [];
  const unmatched = new Set<MissionRole>();

  for (const t of plan.tracks) {
    const candidates = companies.filter((c) => c.strengths.includes(t.role));
    const pick = [...candidates].sort((a, b) => {
      const la = loadThisMission.get(a.companyId) ?? 0;
      const lb = loadThisMission.get(b.companyId) ?? 0;
      if (la !== lb) return la - lb; // least-loaded THIS mission first
      if (a.availableAgents !== b.availableAgents) return b.availableAgents - a.availableAgents; // more capacity first
      return a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0; // stable
    })[0];

    if (!pick) {
      unmatched.add(t.role);
      matches.push({ trackId: t.trackId, role: t.role, label: t.label, companyId: null, companyName: null });
      continue;
    }
    loadThisMission.set(pick.companyId, (loadThisMission.get(pick.companyId) ?? 0) + 1);
    matches.push({
      trackId: t.trackId,
      role: t.role,
      label: t.label,
      companyId: pick.companyId,
      companyName: pick.companyName,
    });
  }

  const companiesTouched: string[] = [];
  for (const m of matches) if (m.companyId && !companiesTouched.includes(m.companyId)) companiesTouched.push(m.companyId);

  return {
    matches,
    companies: companiesTouched,
    unmatchedRoles: [...unmatched],
    fullyMatched: unmatched.size === 0,
  };
}
