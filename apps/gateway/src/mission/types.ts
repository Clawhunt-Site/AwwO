import type { CompanyProposal } from './proposal.js';

// Mission API domain types (gateway-owned contract).
//
// A "mission" is one conversation/task SuperClaw leads: it is planned into a
// topology of role TRACKS, and each track is matched to a real company from the
// upstream kernel by capability. This is the durable, server-side home of the
// "SuperClaw lead 规划成多条线 + 找 company 对齐" capability — replacing the
// canvas's dependency on the retiring Python /api/goals planner. It is
// READ-ONLY: planning + matching create nothing. Turning a matched mission into
// real issues/runs is a separate, human-gated concern (P2), not this endpoint.

/** The five worker roles, canonical pipeline order (mirrors the kernel's
 *  WorkerRole and the canvas role model so the projection is 1:1). */
export type MissionRole = 'explore' | 'plan' | 'implement' | 'verify' | 'review';

export const MISSION_ROLES: readonly MissionRole[] = ['explore', 'plan', 'implement', 'verify', 'review'];

/** Plan shapes. LINEAR is serial; the others fan a role out concurrently. Kept
 *  identical to the canvas topologies so a client maps them without translation. */
export type MissionTopology = 'linear' | 'implement_fanout' | 'explore_fanout' | 'review_consensus';

export const MISSION_TOPOLOGIES: readonly MissionTopology[] = [
  'linear',
  'implement_fanout',
  'explore_fanout',
  'review_consensus',
];

/** One unit of work in a mission plan. `dependsOn` are track ids that must
 *  finish first; `depth` is the topological depth (0 = first); `lane`
 *  distinguishes concurrent tracks at the same depth. */
export interface MissionTrack {
  trackId: string;
  role: MissionRole;
  label: string;
  dependsOn: string[];
  depth: number;
  lane: number;
  fanout?: { branches: number };
}

export interface MissionPlan {
  topology: MissionTopology;
  tracks: MissionTrack[];
}

/** A real company as the matcher sees it: the roles its AVAILABLE agents can
 *  cover, plus a headcount used as a load tiebreak. Derived from the upstream
 *  /companies + /companies/:id/agents reads. */
export interface CompanyCapability {
  companyId: string;
  companyName: string;
  /** Roles covered by at least one available (active) agent. */
  strengths: MissionRole[];
  /** Count of available agents (load tiebreak; spread work across houses). */
  availableAgents: number;
}

/** A track bound to a matched company, or explicitly unmatched. */
export interface MissionMatch {
  trackId: string;
  role: MissionRole;
  label: string;
  /** Null when no company covers this role → a "needs a new company" signal
   *  (the P2 proposal seam). Never silently dropped. */
  companyId: string | null;
  companyName: string | null;
}

/** The full plan+match result returned by POST /api/missions/plan. */
export interface MissionPlanResult {
  prompt: string;
  plan: MissionPlan;
  matches: MissionMatch[];
  /** Distinct company ids the mission touches, first-touch order. */
  companies: string[];
  /** Roles no company could staff — the mission is NOT fully coverable as-is.
   *  Surfaced honestly so the client can refuse / propose a new company (P2). */
  unmatchedRoles: MissionRole[];
  /** Company ids whose roster read failed (capability unknown, excluded from
   *  matching). Non-empty means the match is PARTIAL — coverage cannot be
   *  proven, so fullyMatched is false even if every track happened to bind. */
  unreadableCompanies: string[];
  /** True iff every track matched a company AND every company's roster was
   *  readable (unmatchedRoles empty AND unreadableCompanies empty). An unproven
   *  roster must never let this read true — that would be fake success. */
  fullyMatched: boolean;
  /** A PROPOSED new company to cover the unmatchedRoles (P2, read-only). Present
   *  only when unmatchedRoles is non-empty. It is a proposal — nothing is
   *  created; the human approves it on the canvas to actually found the company. */
  proposal?: CompanyProposal;
}

// Re-export the proposal types so consumers can get them from the types barrel.
export type { CompanyProposal, ProposedAgent } from './proposal.js';
