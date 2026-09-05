import { describe, expect, it } from 'vitest';

import { catalogIdentityKey, selectMarketplaceCatalogItems } from '../src/App';

const MOCK = [
  { kind: 'plugin', plugin_id: 'mock.one', version: '0.0.1', name: { en: 'Mock', zh: 'Mock' }, source: 'mock' },
] as unknown as Parameters<typeof selectMarketplaceCatalogItems>[0]['mock'];

describe('selectMarketplaceCatalogItems', () => {
  it('fails closed: kernel catalog answered but empty -> empty list, never mock', () => {
    const result = selectMarketplaceCatalogItems({
      catalogLiveLoaded: true,
      marketplaceServerPlugins: [],
      registryCatalogItems: [],
      mock: MOCK,
    });
    // An upstream workshop failure (empty marketplace) must NOT surface the
    // static mock dressed up as approved capabilities.
    expect(result).toEqual([]);
    expect(result.some((i) => i.source === 'mock')).toBe(false);
  });

  it('uses mock only when the kernel was never reached (offline onboarding)', () => {
    const result = selectMarketplaceCatalogItems({
      catalogLiveLoaded: false,
      marketplaceServerPlugins: [],
      registryCatalogItems: [],
      mock: MOCK,
    });
    expect(result).toBe(MOCK);
  });

  it('merges live workshop entries with a NON-EMPTY local registry (does not drop them)', () => {
    const result = selectMarketplaceCatalogItems({
      catalogLiveLoaded: true,
      registryCatalogItems: [
        { kind: 'plugin', plugin_id: 'local.one', version: '1.0.0' } as unknown as (typeof MOCK)[number],
      ],
      marketplaceServerPlugins: [
        { plugin_id: 'clawhunt.new', version: '0.1.0', kind: 'plugin', name: 'Fresh', verified: true },
      ],
      mock: MOCK,
    });
    const ids = result.map((i) => i.plugin_id);
    // The non-empty registry must NOT shadow the live workshop feed.
    expect(ids).toContain('local.one');
    expect(ids).toContain('clawhunt.new');
  });

  it('identity key is kind-aware: same id@version but different kind are distinct', () => {
    expect(catalogIdentityKey({ kind: 'skill', plugin_id: 'x', version: '1.0.0' })).not.toBe(
      catalogIdentityKey({ kind: 'plugin', plugin_id: 'x', version: '1.0.0' }),
    );
    // Legacy entries without kind fall back via skill_origin, matching the merge layer.
    expect(catalogIdentityKey({ plugin_id: 'x', version: '1.0.0', skill_origin: true })).toBe('skill:x@1.0.0');
    expect(catalogIdentityKey({ plugin_id: 'x', version: '1.0.0' })).toBe('plugin:x@1.0.0');
  });

  it('keeps same id@version across different kinds (skill + plugin both survive)', () => {
    const result = selectMarketplaceCatalogItems({
      catalogLiveLoaded: true,
      registryCatalogItems: [],
      marketplaceServerPlugins: [
        { plugin_id: 'dup.id', version: '1.0.0', kind: 'plugin', name: 'P', verified: true },
        { plugin_id: 'dup.id', version: '1.0.0', kind: 'skill', name: 'S', verified: true },
      ],
      mock: MOCK,
    });
    const kinds = result.filter((i) => i.plugin_id === 'dup.id').map((i) => i.kind).sort();
    expect(kinds).toEqual(['plugin', 'skill']);
  });

  it('de-dupes repeats WITHIN the server feed (ClawHunt allows duplicate same-version publishes)', () => {
    const result = selectMarketplaceCatalogItems({
      catalogLiveLoaded: true,
      registryCatalogItems: [],
      marketplaceServerPlugins: [
        { plugin_id: 'repeat.one', version: '1.0.0', kind: 'plugin', name: 'First', verified: true },
        { plugin_id: 'repeat.one', version: '1.0.0', kind: 'plugin', name: 'Second copy', verified: true },
      ],
      mock: MOCK,
    });
    expect(result.filter((i) => i.plugin_id === 'repeat.one')).toHaveLength(1);
  });

  it('de-dupes on id@version collision, keeping the local registry item (not the server copy)', () => {
    const result = selectMarketplaceCatalogItems({
      catalogLiveLoaded: true,
      registryCatalogItems: [
        { kind: 'plugin', plugin_id: 'dup.one', version: '1.0.0', source: 'registry' } as unknown as (typeof MOCK)[number],
      ],
      marketplaceServerPlugins: [
        { plugin_id: 'dup.one', version: '1.0.0', kind: 'plugin', name: 'Server Copy', verified: true },
      ],
      mock: MOCK,
    });
    const dup = result.filter((i) => i.plugin_id === 'dup.one');
    expect(dup).toHaveLength(1);
    expect(dup[0].source).toBe('registry');
  });

  it('preserves company kind (not downgraded to plugin) and marks it non-instantiable', () => {
    const [item] = selectMarketplaceCatalogItems({
      catalogLiveLoaded: true,
      marketplaceServerPlugins: [
        {
          plugin_id: 'acme.company',
          version: '1.0.0',
          kind: 'company',
          name: 'Acme Co',
          summary: 'A company template',
          verified: false,
          capability_status: 'published',
        },
      ],
      registryCatalogItems: [],
      mock: MOCK,
    });
    expect(item.kind).toBe('company');
    expect(item.instantiable).toBe(false);
  });

  it('carries the API kernel-verified trust state through (official lights the badge)', () => {
    const result = selectMarketplaceCatalogItems({
      catalogLiveLoaded: true,
      marketplaceServerPlugins: [
        // The API sets trust:'official' ONLY after locally re-verifying the official
        // co-signature; the selector must carry it through so the existing
        // trust==='official' badge logic fires.
        { plugin_id: 'endorsed.one', version: '1.0.0', kind: 'plugin', name: 'Endorsed', verified: true, trust: 'official' },
        // No trust from the API -> stays undefined -> no official badge (fail-closed).
        { plugin_id: 'plain.one', version: '1.0.0', kind: 'plugin', name: 'Plain', verified: true },
      ],
      registryCatalogItems: [],
      mock: MOCK,
    });
    expect(result.find((i) => i.plugin_id === 'endorsed.one')?.trust).toBe('official');
    expect(result.find((i) => i.plugin_id === 'plain.one')?.trust).toBeUndefined();
  });

  it('passes verified through unchanged — approved-but-unsigned is NOT verified', () => {
    const [item] = selectMarketplaceCatalogItems({
      catalogLiveLoaded: true,
      marketplaceServerPlugins: [
        {
          plugin_id: 'acme.skill',
          version: '0.1.0',
          kind: 'skill',
          name: 'Acme Skill',
          verified: false,
          capability_status: 'approved',
        },
      ],
      registryCatalogItems: [],
      mock: MOCK,
    });
    // Review-approval must never be rendered as signature-verified.
    expect(item.verified).toBe(false);
    expect(item.capability_status).toBe('approved');
    expect(item.kind).toBe('skill');
  });
});
