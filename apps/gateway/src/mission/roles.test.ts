import { describe, expect, it } from 'vitest';
import { isMissionRole, mapAgentRole, roleLabel } from './roles.js';

describe('mapAgentRole', () => {
  it('maps kernel free-text role/title onto the five mission roles', () => {
    expect(mapAgentRole('ceo', null)).toBe('plan');
    expect(mapAgentRole('general', 'QA 测试')).toBe('verify');
    expect(mapAgentRole('general', 'Code Reviewer')).toBe('review');
    expect(mapAgentRole('general', '调研分析师')).toBe('explore');
    expect(mapAgentRole('engineer', null)).toBe('implement');
  });

  it('falls back to implement for unknown / empty text', () => {
    expect(mapAgentRole('general', 'Sparkles')).toBe('implement');
    expect(mapAgentRole(null, null)).toBe('implement');
    expect(mapAgentRole(undefined, undefined)).toBe('implement');
  });

  it('tests specific roles before the plan/implement catch-alls', () => {
    // "test engineer" contains both 'test' (verify) and 'engineer' (implement);
    // verify is checked first → verify wins. Guards the ordering contract.
    expect(mapAgentRole('general', 'Test Engineer')).toBe('verify');
  });
});

describe('roleLabel / isMissionRole', () => {
  it('returns a localized label per role', () => {
    expect(roleLabel('implement')).toBe('实现');
    expect(roleLabel('review')).toBe('评审');
  });
  it('isMissionRole guards the union', () => {
    expect(isMissionRole('explore')).toBe(true);
    expect(isMissionRole('nope')).toBe(false);
    expect(isMissionRole(42)).toBe(false);
  });
});
