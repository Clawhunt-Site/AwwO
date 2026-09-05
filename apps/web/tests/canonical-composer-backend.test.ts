import { describe, expect, it } from 'vitest';
import { canonicalComposerBackend } from '../src/App';

// The Node composer inventory exposes underscored adapter-type names.
const NODE_INVENTORY = ['claude_local', 'codex_local', 'gemini_local', 'grok_local', 'clawwork_local'];

describe('canonicalComposerBackend', () => {
  it('returns an exact inventory name unchanged', () => {
    expect(canonicalComposerBackend('codex_local', NODE_INVENTORY)).toBe('codex_local');
    expect(canonicalComposerBackend('claude_local', NODE_INVENTORY)).toBe('claude_local');
  });

  it('maps legacy Python CLI backend ids to the canonical node name', () => {
    // These are the ids a chat created by `superclaw chat --backend <x>` persists;
    // without this mapping selectedAgentInfo was null → model+effort selectors vanished.
    expect(canonicalComposerBackend('codex', NODE_INVENTORY)).toBe('codex_local');
    expect(canonicalComposerBackend('codex-app-server', NODE_INVENTORY)).toBe('codex_local');
    expect(canonicalComposerBackend('claude', NODE_INVENTORY)).toBe('claude_local');
  });

  it('bridges the bare-name <-> _local split generically', () => {
    expect(canonicalComposerBackend('gemini', NODE_INVENTORY)).toBe('gemini_local');
    expect(canonicalComposerBackend('grok', NODE_INVENTORY)).toBe('grok_local');
  });

  it('resolves an underscored id against a legacy (bare-name) inventory in reverse', () => {
    const legacyInventory = ['claude', 'codex'];
    expect(canonicalComposerBackend('codex_local', legacyInventory)).toBe('codex');
    expect(canonicalComposerBackend('claude_local', legacyInventory)).toBe('claude');
  });

  it('returns empty string when nothing plausibly matches or input is blank', () => {
    expect(canonicalComposerBackend('totally-unknown', NODE_INVENTORY)).toBe('');
    expect(canonicalComposerBackend('', NODE_INVENTORY)).toBe('');
    expect(canonicalComposerBackend('codex', [])).toBe('');
  });

  it('never rewrites an id that is already an exact inventory entry, even if an alias also exists', () => {
    // 'claude' is present verbatim → must be returned as-is (not remapped to claude_local).
    const mixed = ['claude', 'claude_local'];
    expect(canonicalComposerBackend('claude', mixed)).toBe('claude');
  });

  it('regression: a legacy alias reads as RESOLVED so the default-picker does not override it', () => {
    // Bug scenario (Codex review): switching to a chat whose persisted backend is
    // the legacy "codex" while the inventory exposes "codex_local" and the configured
    // default is "claude_local". Both the reconcile effect and the default-backend
    // effect gate on this helper: the reconcile snaps "codex" → "codex_local", and the
    // default-picker's guard early-returns because the value canonicalizes to a
    // non-empty name — so the chat stays on its own runtime, NOT the claude_local
    // default. This asserts the predicate both effects depend on.
    const inventory = ['codex_local', 'claude_local'];
    const canonical = canonicalComposerBackend('codex', inventory);
    expect(canonical).toBe('codex_local'); // reconcile snaps here
    expect(canonical !== '').toBe(true); // default-picker guard treats it as resolved → no override
  });
});
