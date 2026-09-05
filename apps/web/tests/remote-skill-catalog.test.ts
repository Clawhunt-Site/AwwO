import { describe, expect, it } from 'vitest';

import { isPluginInstallable, isSkillCapability, selectRemoteSkillCatalogItems } from '../src/App';

type Item = Parameters<typeof selectRemoteSkillCatalogItems>[0]['marketplaceCatalogItems'][number];

function item(partial: Partial<Item> & { plugin_id: string }): Item {
  return {
    kind: 'skill',
    plugin_id: partial.plugin_id,
    version: '1.0.0',
    name: { en: partial.plugin_id, zh: partial.plugin_id },
    summary: { en: '', zh: '' },
    source: 'server',
    skill_origin: true,
    ...partial,
  } as unknown as Item;
}

describe('selectRemoteSkillCatalogItems (workshop IA P1)', () => {
  it('red line: keeps ONLY remote skills, drops plugin/company', () => {
    const result = selectRemoteSkillCatalogItems({
      marketplaceCatalogItems: [
        item({ plugin_id: 'skill.one', kind: 'skill', skill_origin: true }),
        item({ plugin_id: 'plug.one', kind: 'plugin', skill_origin: false }),
        item({ plugin_id: 'co.one', kind: 'company', skill_origin: false }),
      ],
      nativeSkillIds: [],
    });
    expect(result.map((i) => i.plugin_id)).toEqual(['skill.one']);
  });

  it('recognizes skill_origin even when kind is not "skill"', () => {
    const result = selectRemoteSkillCatalogItems({
      marketplaceCatalogItems: [item({ plugin_id: 'origin.one', kind: 'plugin', skill_origin: true })],
      nativeSkillIds: [],
    });
    expect(result.map((i) => i.plugin_id)).toEqual(['origin.one']);
  });

  it('Local>Remote: drops a remote skill already in the native store (namespace-normalized)', () => {
    const result = selectRemoteSkillCatalogItems({
      marketplaceCatalogItems: [
        item({ plugin_id: 'skill.commit-message-writer' }),
        item({ plugin_id: 'skill.only-remote' }),
      ],
      // native store records it WITHOUT the "skill." namespace — must still dedupe
      nativeSkillIds: ['commit-message-writer'],
    });
    expect(result.map((i) => i.plugin_id)).toEqual(['skill.only-remote']);
  });

  it('applies the free-text query against id/name/summary', () => {
    const result = selectRemoteSkillCatalogItems({
      marketplaceCatalogItems: [
        item({ plugin_id: 'skill.alpha', name: { en: 'Alpha', zh: 'Alpha' } }),
        item({ plugin_id: 'skill.beta', name: { en: 'Beta', zh: 'Beta' } }),
      ],
      nativeSkillIds: [],
      query: 'beta',
    });
    expect(result.map((i) => i.plugin_id)).toEqual(['skill.beta']);
  });

  it('returns all remote skills when nothing is local', () => {
    const result = selectRemoteSkillCatalogItems({
      marketplaceCatalogItems: [item({ plugin_id: 'skill.a' }), item({ plugin_id: 'skill.b' })],
      nativeSkillIds: [],
    });
    expect(result).toHaveLength(2);
  });

  it('empty input -> empty list (no throw)', () => {
    expect(
      selectRemoteSkillCatalogItems({ marketplaceCatalogItems: [], nativeSkillIds: [] }),
    ).toEqual([]);
  });

  it('defensive: missing name/summary fields and null ids never throw (untrusted remote data)', () => {
    expect(() =>
      selectRemoteSkillCatalogItems({
        marketplaceCatalogItems: [
          { kind: 'skill', plugin_id: 'skill.bare', skill_origin: true } as unknown as Item,
        ],
        nativeSkillIds: [null as unknown as string, undefined as unknown as string],
        query: 'x',
      }),
    ).not.toThrow();
  });

  it('strips a namespaced "skill." prefix for dedupe (acme/skill.x aligns with acme/x)', () => {
    const result = selectRemoteSkillCatalogItems({
      marketplaceCatalogItems: [item({ plugin_id: 'acme/skill.formatter' }), item({ plugin_id: 'skill.keep' })],
      nativeSkillIds: ['acme/formatter'],
    });
    expect(result.map((i) => i.plugin_id)).toEqual(['skill.keep']);
  });
});

describe('isPluginInstallable (capability-workshop red line: skill never via plugin install)', () => {
  it('refuses skill-origin / kind=skill registry entries from any entry point', () => {
    expect(isPluginInstallable({ kind: 'skill' })).toBe(false);
    expect(isPluginInstallable({ skill_origin: true })).toBe(false);
    expect(isPluginInstallable({ kind: 'plugin', skill_origin: true })).toBe(false);
  });

  it('allows real plugins (and treats absent kind/skill_origin as plugin)', () => {
    expect(isPluginInstallable({ kind: 'plugin' })).toBe(true);
    expect(isPluginInstallable({ kind: 'plugin', skill_origin: false })).toBe(true);
    expect(isPluginInstallable({})).toBe(true);
  });

  it('refuses a "skill." id even when kind=plugin & skill_origin=false (kernel mirror)', () => {
    expect(isPluginInstallable({ kind: 'plugin', skill_origin: false, plugin_id: 'skill.sneaky' })).toBe(false);
    expect(isPluginInstallable({ kind: 'plugin', plugin_id: 'dev.x.tool' })).toBe(true);
  });
});

describe('isSkillCapability mirrors kernel is_skill_origin_plugin (skill_origin OR "skill." prefix)', () => {
  it('recognizes a skill by kind, skill_origin, OR "skill." id prefix', () => {
    expect(isSkillCapability({ kind: 'skill' })).toBe(true);
    expect(isSkillCapability({ skill_origin: true })).toBe(true);
    expect(isSkillCapability({ plugin_id: 'skill.foo' })).toBe(true);
    expect(isSkillCapability({ kind: 'plugin', plugin_id: 'dev.x.tool' })).toBe(false);
    expect(isSkillCapability({})).toBe(false);
  });
});
