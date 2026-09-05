import { describe, expect, it } from 'vitest';
import { planMission } from './planner.js';
import { MISSION_TOPOLOGIES, type MissionTopology } from './types.js';

describe('planMission', () => {
  it('linear is a 5-role serial chain with correct dependencies', () => {
    const plan = planMission('anything', 'linear');
    expect(plan.topology).toBe('linear');
    expect(plan.tracks.map((t) => t.role)).toEqual(['explore', 'plan', 'implement', 'verify', 'review']);
    // each track depends on the previous one, depth increments
    for (let i = 1; i < plan.tracks.length; i += 1) {
      expect(plan.tracks[i]!.dependsOn).toEqual([plan.tracks[i - 1]!.trackId]);
      expect(plan.tracks[i]!.depth).toBe(i);
    }
  });

  it('implement_fanout has two parallel implement tracks at the same depth', () => {
    const plan = planMission('x', 'implement_fanout');
    const impls = plan.tracks.filter((t) => t.role === 'implement');
    expect(impls).toHaveLength(2);
    expect(impls[0]!.depth).toBe(impls[1]!.depth);
    expect(impls[0]!.lane).not.toBe(impls[1]!.lane);
    // verify depends on BOTH implement tracks
    const verify = plan.tracks.find((t) => t.role === 'verify')!;
    expect(verify.dependsOn.sort()).toEqual(impls.map((t) => t.trackId).sort());
  });

  it('explore_fanout / review_consensus carry fanout branch counts', () => {
    expect(planMission('x', 'explore_fanout').tracks.find((t) => t.role === 'explore')!.fanout).toEqual({ branches: 2 });
    expect(planMission('x', 'review_consensus').tracks.find((t) => t.role === 'review')!.fanout).toEqual({ branches: 3 });
  });

  it('is deterministic and prompt-independent (same topology → identical plan)', () => {
    for (const topo of MISSION_TOPOLOGIES) {
      const a = planMission('prompt A', topo as MissionTopology);
      const b = planMission('a totally different prompt', topo as MissionTopology);
      expect(a).toEqual(b);
    }
  });

  it('unknown topology falls back to linear', () => {
    const plan = planMission('x', 'bogus' as unknown as MissionTopology);
    expect(plan.topology).toBe('linear');
    expect(plan.tracks).toHaveLength(5);
  });

  it('every track id is unique and every dependsOn references a real track', () => {
    for (const topo of MISSION_TOPOLOGIES) {
      const plan = planMission('x', topo as MissionTopology);
      const ids = new Set(plan.tracks.map((t) => t.trackId));
      expect(ids.size).toBe(plan.tracks.length);
      for (const t of plan.tracks) for (const d of t.dependsOn) expect(ids.has(d)).toBe(true);
    }
  });
});
