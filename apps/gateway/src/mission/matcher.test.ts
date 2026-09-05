import { describe, expect, it } from 'vitest';
import { matchTracks } from './matcher.js';
import { planMission } from './planner.js';
import type { CompanyCapability, MissionRole } from './types.js';

function cap(id: string, name: string, strengths: MissionRole[], availableAgents = strengths.length): CompanyCapability {
  return { companyId: id, companyName: name, strengths, availableAgents };
}

const ALL: MissionRole[] = ['explore', 'plan', 'implement', 'verify', 'review'];

describe('matchTracks', () => {
  it('fully matches a linear plan when one company covers every role', () => {
    const plan = planMission('x', 'linear');
    const res = matchTracks(plan, [cap('co-1', 'All House', ALL)]);
    expect(res.fullyMatched).toBe(true);
    expect(res.unmatchedRoles).toEqual([]);
    expect(res.matches.every((m) => m.companyId === 'co-1')).toBe(true);
    expect(res.companies).toEqual(['co-1']);
  });

  it('reports unmatched roles when no company covers them (P2 seam) — no silent drop', () => {
    const plan = planMission('x', 'linear'); // needs explore/plan/implement/verify/review
    const res = matchTracks(plan, [cap('co-impl', 'Impl Only', ['implement'])]);
    expect(res.fullyMatched).toBe(false);
    expect(res.unmatchedRoles.sort()).toEqual(['explore', 'plan', 'review', 'verify']);
    // the implement track still matched
    expect(res.matches.find((m) => m.role === 'implement')!.companyId).toBe('co-impl');
    // unmatched tracks carry companyId null, not a fake binding
    expect(res.matches.filter((m) => m.companyId === null).map((m) => m.role).sort()).toEqual([
      'explore',
      'plan',
      'review',
      'verify',
    ]);
  });

  it('spreads work across equally-capable houses (load balance, not all on one)', () => {
    // Two full-coverage, equal-capacity houses → a 5-track linear plan should
    // touch BOTH, not pile every track on one (the least-loaded-this-mission
    // tiebreak alternates them).
    const plan = planMission('x', 'linear');
    const res = matchTracks(plan, [cap('co-a', 'A', ALL, 3), cap('co-b', 'B', ALL, 3)]);
    expect(new Set(res.matches.map((m) => m.companyId)).size).toBe(2);
    // neither house takes more than ceil(5/2)=3 tracks
    const counts = new Map<string | null, number>();
    for (const m of res.matches) counts.set(m.companyId, (counts.get(m.companyId) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });

  it('when a role has a single specialist house, parallel branches may share it (capacity-correct)', () => {
    // co-a covers everything but is consumed by explore+plan first; co-b only
    // implements. Both implement branches land on co-b — the honest outcome, and
    // both are matched (no unmatched, no fake binding).
    const plan = planMission('x', 'implement_fanout');
    const res = matchTracks(plan, [
      cap('co-a', 'A', ['explore', 'plan', 'implement', 'verify', 'review'], 3),
      cap('co-b', 'B', ['implement'], 5),
    ]);
    expect(res.fullyMatched).toBe(true);
    expect(res.matches.filter((m) => m.role === 'implement').every((m) => m.companyId !== null)).toBe(true);
    expect(new Set(res.matches.map((m) => m.companyId))).toEqual(new Set(['co-a', 'co-b'])); // both houses used
  });

  it('prefers the company with more available agents on a fresh pick', () => {
    const plan = planMission('x', 'review_consensus'); // implement then review
    const res = matchTracks(plan, [
      cap('co-small', 'Small', ['implement', 'review'], 1),
      cap('co-big', 'Big', ['implement', 'review'], 9),
    ]);
    // implement (first, no company used yet) → the bigger house
    expect(res.matches.find((m) => m.role === 'implement')!.companyId).toBe('co-big');
  });

  it('is deterministic on identical input', () => {
    const plan = planMission('x', 'linear');
    const companies = [cap('co-b', 'B', ALL, 2), cap('co-a', 'A', ALL, 2)];
    expect(matchTracks(plan, companies)).toEqual(matchTracks(plan, companies));
  });

  it('no companies at all → every role unmatched, no throw', () => {
    const res = matchTracks(planMission('x', 'linear'), []);
    expect(res.fullyMatched).toBe(false);
    expect(res.unmatchedRoles.sort()).toEqual([...ALL].sort());
    expect(res.companies).toEqual([]);
  });
});
