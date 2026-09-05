import type { MissionRole } from './types.js';
import { MISSION_ROLES } from './types.js';

// Map a kernel agent's free-text role/title onto one of the five mission roles.
// The kernel's `role` defaults to "general" (server/packages/db schema), so
// titles carry most of the signal. This is the SERVER-side capability heuristic
// — the durable single source for mission matching (the canvas has a parallel
// copy for its local projection; convergence onto this server match is the
// intended direction). Order matters: the first pattern that hits wins, so the
// more specific roles are tested before the catch-all implement.
const ROLE_KEYWORDS: ReadonlyArray<readonly [MissionRole, RegExp]> = [
  ['explore', /explor|research|scout|discover|analys|invest|勘探|调研|侦察|探索|研究|情报/i],
  ['verify', /verif|test|qa\b|quality|validat|验证|测试|质检|质量/i],
  ['review', /review|audit|critic|评审|审计|审查|复核/i],
  ['plan', /plan|ceo|chief|manager|lead|director|product|strateg|architect|规划|总监|经理|产品|战略|主管|架构|负责人/i],
  ['implement', /implement|engineer|develop|build|code|coder|实现|工程|开发|编码/i],
];

export function mapAgentRole(role: string | null | undefined, title: string | null | undefined): MissionRole {
  const hay = `${typeof role === 'string' ? role : ''} ${typeof title === 'string' ? title : ''}`;
  for (const [id, re] of ROLE_KEYWORDS) if (re.test(hay)) return id;
  return 'implement';
}

/** Localized short label per role, for track naming. */
const ROLE_LABEL: Record<MissionRole, string> = {
  explore: '勘探',
  plan: '规划',
  implement: '实现',
  verify: '验证',
  review: '评审',
};

export function roleLabel(role: MissionRole): string {
  return ROLE_LABEL[role];
}

export function isMissionRole(v: unknown): v is MissionRole {
  return typeof v === 'string' && (MISSION_ROLES as readonly string[]).includes(v);
}
