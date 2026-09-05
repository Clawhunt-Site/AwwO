import type { MissionPlan, MissionRole, MissionTopology, MissionTrack } from './types.js';
import { roleLabel } from './roles.js';

// Deterministic mission planner: a prompt + topology → a topology of role
// TRACKS. Mirrors TaskGraph.from_goal (packages/superclaw models.py) and the
// canvas planner 1:1 so a client renders it without translation.
//
// It is intentionally deterministic (no LLM): the canvas needs a faithful
// role-track structure to match against real companies, not a bespoke semantic
// decomposition. A smarter (LLM-driven) planner can later sit behind the SAME
// endpoint without changing the contract. `prompt` is accepted for that future
// and to keep the endpoint's shape stable; the deterministic planner does not
// branch on its content.

function track(
  trackId: string,
  role: MissionRole,
  labelSuffix: string,
  depth: number,
  lane: number,
  dependsOn: string[],
  fanout?: { branches: number },
): MissionTrack {
  const base = roleLabel(role);
  return {
    trackId,
    role,
    label: labelSuffix ? `${base} · ${labelSuffix}` : base,
    dependsOn,
    depth,
    lane,
    ...(fanout ? { fanout } : {}),
  };
}

export function planMission(_prompt: string, topology: MissionTopology): MissionPlan {
  switch (topology) {
    case 'implement_fanout': {
      return {
        topology,
        tracks: [
          track('t1', 'explore', '', 0, 0, []),
          track('t2', 'plan', '', 1, 0, ['t1']),
          track('t3', 'implement', '主线', 2, 0, ['t2']),
          track('t4', 'implement', '加固', 2, 1, ['t2']),
          track('t5', 'verify', '', 3, 0, ['t3', 't4']),
          track('t6', 'review', '', 4, 0, ['t5']),
        ],
      };
    }
    case 'explore_fanout': {
      return {
        topology,
        tracks: [
          track('t1', 'explore', '双线 ×2', 0, 0, [], { branches: 2 }),
          track('t2', 'implement', '', 1, 0, ['t1']),
          track('t3', 'verify', '', 2, 0, ['t2']),
        ],
      };
    }
    case 'review_consensus': {
      return {
        topology,
        tracks: [
          track('t1', 'implement', '', 0, 0, []),
          track('t2', 'review', '共识 ×3', 1, 0, ['t1'], { branches: 3 }),
        ],
      };
    }
    case 'linear':
    default: {
      return {
        topology: 'linear',
        tracks: [
          track('t1', 'explore', '', 0, 0, []),
          track('t2', 'plan', '', 1, 0, ['t1']),
          track('t3', 'implement', '', 2, 0, ['t2']),
          track('t4', 'verify', '', 3, 0, ['t3']),
          track('t5', 'review', '', 4, 0, ['t4']),
        ],
      };
    }
  }
}
