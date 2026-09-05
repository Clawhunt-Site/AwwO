import { describe, expect, it } from 'vitest';
import { proposeCompany } from './proposal.js';
import { planMissionResult } from './plan.js';
import { planMission } from './planner.js';
import type { UpstreamCompanyReader } from './upstream-reader.js';
import type { MissionRole } from './types.js';

describe('proposeCompany', () => {
  it('returns null when there is nothing to cover (fully-matched mission)', () => {
    expect(proposeCompany([])).toBeNull();
  });

  it('proposes a company with one roster agent per uncovered role', () => {
    const p = proposeCompany(['verify', 'review'])!;
    expect(p).not.toBeNull();
    expect(p.coversRoles).toEqual(['verify', 'review']);
    expect(p.roster.map((a) => a.role)).toEqual(['verify', 'review']);
    expect(p.roster.every((a) => a.title.length > 0)).toBe(true);
    expect(p.name).toContain('验证');
    expect(p.name).toContain('评审');
    expect(p.mandate.length).toBeGreaterThan(0);
  });

  it('de-dupes repeated roles (a fan-out can list a role twice)', () => {
    const p = proposeCompany(['implement', 'implement', 'verify'] as MissionRole[])!;
    expect(p.coversRoles).toEqual(['implement', 'verify']);
    expect(p.roster).toHaveLength(2);
  });

  it('is deterministic on identical input', () => {
    expect(proposeCompany(['plan'])).toEqual(proposeCompany(['plan']));
  });
});

describe('planMissionResult proposal wiring', () => {
  it('attaches a proposal covering the unmatched roles when nothing can staff them', async () => {
    // No companies at all → every role unmatched → proposal covers all of them.
    const reader: UpstreamCompanyReader = {
      readCompanyCapabilities: async () => ({ capabilities: [], unreadableCompanies: [] }),
    };
    const res = await planMissionResult('x', 'linear', reader);
    expect(res.fullyMatched).toBe(false);
    expect(res.proposal).toBeDefined();
    expect(res.proposal!.coversRoles.sort()).toEqual([...res.unmatchedRoles].sort());
    // one roster agent per plan role (linear = 5 distinct roles)
    expect(res.proposal!.roster).toHaveLength(new Set(planMission('x', 'linear').tracks.map((t) => t.role)).size);
  });

  it('omits the proposal when the mission is fully matched', async () => {
    const reader: UpstreamCompanyReader = {
      readCompanyCapabilities: async () => ({
        capabilities: [
          { companyId: 'co-a', companyName: 'A', strengths: ['explore', 'plan', 'implement', 'verify', 'review'], availableAgents: 5 },
        ],
        unreadableCompanies: [],
      }),
    };
    const res = await planMissionResult('x', 'linear', reader);
    expect(res.fullyMatched).toBe(true);
    expect(res.proposal).toBeUndefined();
  });

  it('does NOT propose when a roster was unreadable (coverage unproven, fail-closed)', async () => {
    // Readable company covers only implement; another company's roster failed to
    // read → it MIGHT cover the others. Asserting "无现役公司承接" would be false,
    // so no proposal is generated.
    const reader: UpstreamCompanyReader = {
      readCompanyCapabilities: async () => ({
        capabilities: [{ companyId: 'co-a', companyName: 'A', strengths: ['implement'], availableAgents: 1 }],
        unreadableCompanies: ['co-b'],
      }),
    };
    const res = await planMissionResult('x', 'linear', reader);
    expect(res.unmatchedRoles.length).toBeGreaterThan(0); // there IS an apparent gap...
    expect(res.proposal).toBeUndefined(); // ...but we don't claim it, coverage unproven
  });
});
