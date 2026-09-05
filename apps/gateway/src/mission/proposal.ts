import type { MissionRole } from './types.js';
import { roleLabel } from './roles.js';

// Company proposal generation (P2, read-only). When a mission has roles no
// existing company can staff (unmatchedRoles), SuperClaw PROPOSES founding a new
// company that would cover them — a persona (name + mandate) plus a roster spec
// (one agent per uncovered role). This is a PROPOSAL only: it creates nothing.
// Turning a proposal into a real company + hired agents is a separate,
// human-gated mutation (approve on the canvas → POST /companies + agent-hires,
// which itself rides the kernel's hire_agent approval) — deliberately NOT here.

/** A proposed agent slot for a new company: the role it covers + a persona title. */
export interface ProposedAgent {
  role: MissionRole;
  title: string;
}

/** A proposed new company to cover a mission's uncovered roles. Persona + roster
 *  only — no ids, nothing created. */
export interface CompanyProposal {
  /** Suggested display name for the new company. */
  name: string;
  /** One-line charter describing what the company is chartered for. */
  mandate: string;
  /** The roles this proposal exists to cover (the mission's unmatchedRoles). */
  coversRoles: MissionRole[];
  /** Proposed roster — one agent per covered role. */
  roster: ProposedAgent[];
}

// Persona title per role for a proposed roster (Chinese, matches the canvas
// persona voice). Deterministic — no LLM.
const ROLE_TITLE: Record<MissionRole, string> = {
  explore: '首席探路官',
  plan: '规划参谋',
  implement: '主工程官',
  verify: '验证官',
  review: '评审官',
};

// A short mandate phrase per role, joined into the company's charter line.
const ROLE_MANDATE: Record<MissionRole, string> = {
  explore: '情报勘探',
  plan: '架构规划',
  implement: '实现交付',
  verify: '验证质检',
  review: '评审把关',
};

/** Propose a new company covering exactly the given uncovered roles. Returns null
 *  when there is nothing to cover (a fully-matched mission needs no proposal).
 *  Pure and deterministic — the same uncovered set always yields the same
 *  proposal, so it is safe to recompute and to test. */
export function proposeCompany(unmatchedRoles: MissionRole[]): CompanyProposal | null {
  // De-dupe while preserving first-seen order (a fan-out can list a role twice).
  const roles: MissionRole[] = [];
  for (const r of unmatchedRoles) if (!roles.includes(r)) roles.push(r);
  if (roles.length === 0) return null;

  const mandate = `特遣补位 · ${roles.map((r) => ROLE_MANDATE[r]).join(' · ')}`;
  const roster: ProposedAgent[] = roles.map((r) => ({ role: r, title: ROLE_TITLE[r] }));
  const coverLabels = roles.map((r) => roleLabel(r)).join('、');
  return {
    name: `特遣补位队（${coverLabels}）`,
    mandate,
    coversRoles: roles,
    roster,
  };
}
