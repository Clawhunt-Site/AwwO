import { describe, expect, it } from 'vitest';

import { enrichCardItemWithNodeInstall, nodeCapToCatalogItem } from '../src/App';

const cap = (over: Record<string, unknown> = {}) =>
  ({
    origin: 'node-workshop',
    kind: 'plugin',
    capability_id: 'acme.tool',
    native_key: 'acme.tool',
    version: '1.0.0',
    name: 'Acme Tool',
    official: true,
    configurable: false,
    uninstallable: true,
    ...over,
  }) as Parameters<typeof nodeCapToCatalogItem>[0];

describe('nodeCapToCatalogItem', () => {
  it('maps a node-workshop capability to an installed (local) catalog card', () => {
    const item = nodeCapToCatalogItem(cap());
    expect(item.source).toBe('local');
    expect(item.category).toBe('local');
    expect(item.plugin_id).toBe('acme.tool'); // native_key drives uninstall routing
    expect(item.version).toBe('1.0.0');
    expect(item.origin).toBe('node-workshop');
    expect(item.configurable).toBe(false); // Node caps have no Python-cache config surface
    expect(item.verified).toBe(true); // mirrors official
  });

  it('marks a skill capability with skill_origin + skill kind', () => {
    const item = nodeCapToCatalogItem(cap({ kind: 'skill', capability_id: 'skill.demo', native_key: 'skill.demo' }));
    expect(item.kind).toBe('skill');
    expect(item.skill_origin).toBe(true);
  });

  it('tolerates a null version', () => {
    expect(nodeCapToCatalogItem(cap({ version: null })).version).toBe('');
  });
});

describe('enrichCardItemWithNodeInstall', () => {
  // Keyed by the kind-aware catalog identity (`kind:id@version`), same as catalogIdentityKey.
  const byIdentity = new Map([['plugin:acme.tool@1.0.0', cap()]]);
  const remote = { kind: 'plugin', plugin_id: 'acme.tool', version: '1.0.0', source: 'server' } as Parameters<
    typeof enrichCardItemWithNodeInstall
  >[0];

  it('threads origin+configurable onto a REMOTE card that matches a node install', () => {
    // This is the fix for the overlay-manage bug: a remote marketplace card overlaid as installed
    // must still know it is a Node install so uninstall routes correctly + Configure hides.
    const out = enrichCardItemWithNodeInstall(remote, byIdentity);
    expect(out.origin).toBe('node-workshop');
    expect(out.configurable).toBe(false);
  });

  it('leaves a non-matching card unchanged', () => {
    const other = { ...remote, plugin_id: 'other.tool' };
    expect(enrichCardItemWithNodeInstall(other, byIdentity)).toBe(other);
  });

  it('is kind-aware: a skill card sharing the id is NOT matched to a plugin node install', () => {
    const skillCard = { ...remote, kind: 'skill' };
    expect(enrichCardItemWithNodeInstall(skillCard, byIdentity).origin).toBeUndefined();
  });

  it('does NOT override an item that already carries an origin (local cards)', () => {
    const local = { ...remote, origin: 'cache' as const, configurable: true };
    expect(enrichCardItemWithNodeInstall(local, byIdentity).origin).toBe('cache');
  });
});
