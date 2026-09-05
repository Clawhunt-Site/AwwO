import { afterEach, describe, expect, it } from 'vitest';

import {
  applyAppearance,
  applyCachedScheme,
  cacheScheme,
  createSerialQueue,
  hexToRgba,
  isValidHex,
  readCachedScheme,
  resolveOverrides,
  resolveSchemeVars,
  type AppearancePayload,
} from '../src/appearance';

function makePayload(overrides: Partial<AppearancePayload> = {}): AppearancePayload {
  return {
    schema_version: '0.1.0',
    canvases: ['light', 'dark'],
    default_preset: 'default',
    custom_preset_id: 'custom',
    tokens: [
      { id: 'accent', label: 'Accent', css_var: '--accent', soft_var: '--accent-soft', soft_alpha: 0.14, group: 'accent' },
      { id: 'bg_base', label: 'Background', css_var: '--bg-base', group: 'surface' },
    ],
    presets: [
      { id: 'default', label: 'Default', description: '', swatch: '#4f5fd6', overrides: { light: {}, dark: {} } },
      {
        id: 'emerald',
        label: 'Emerald',
        description: '',
        swatch: '#0f9d58',
        overrides: { light: { accent: '#0f9d58' }, dark: { accent: '#34d27f' } },
      },
    ],
    active_preset: 'default',
    custom: { light: {}, dark: {} },
    ...overrides,
  };
}

afterEach(() => {
  document.documentElement.removeAttribute('style');
  localStorage.clear();
});

describe('hex helpers', () => {
  it('validates 3- and 6-digit hex, rejects junk', () => {
    expect(isValidHex('#abc')).toBe(true);
    expect(isValidHex('#aabbcc')).toBe(true);
    expect(isValidHex('rgb(0,0,0)')).toBe(false);
    expect(isValidHex('nope')).toBe(false);
  });

  it('derives rgba from hex, expanding shorthand and trimming alpha zeros', () => {
    expect(hexToRgba('#000000', 0.14)).toBe('rgba(0, 0, 0, 0.14)');
    expect(hexToRgba('#fff', 0.2)).toBe('rgba(255, 255, 255, 0.2)');
  });
});

describe('resolveOverrides', () => {
  it('reads preset overrides for the active canvas', () => {
    const payload = makePayload({ active_preset: 'emerald' });
    expect(resolveOverrides(payload, 'dark')).toEqual({ accent: '#34d27f' });
    expect(resolveOverrides(payload, 'light')).toEqual({ accent: '#0f9d58' });
  });

  it('reads the custom palette when active_preset is custom', () => {
    const payload = makePayload({
      active_preset: 'custom',
      custom: { light: { accent: '#123456' }, dark: {} },
    });
    expect(resolveOverrides(payload, 'light')).toEqual({ accent: '#123456' });
    expect(resolveOverrides(payload, 'dark')).toEqual({});
  });
});

describe('resolveSchemeVars', () => {
  it('expands a token to its css var + derived soft companion', () => {
    const payload = makePayload({ active_preset: 'emerald' });
    expect(resolveSchemeVars(payload, 'dark')).toEqual({
      '--accent': '#34d27f',
      '--accent-soft': 'rgba(52, 210, 127, 0.14)',
    });
  });

  it('normalizes shorthand hex and skips invalid/unknown entries', () => {
    const payload = makePayload({
      active_preset: 'custom',
      custom: { light: { accent: '#ABC', bg_base: 'not-hex' }, dark: {} },
    });
    expect(resolveSchemeVars(payload, 'light')).toEqual({
      '--accent': '#aabbcc',
      '--accent-soft': 'rgba(170, 187, 204, 0.14)',
    });
  });
});

describe('applyAppearance', () => {
  it('sets the active scheme vars on the document root', () => {
    applyAppearance(makePayload({ active_preset: 'emerald' }), 'dark');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#34d27f');
    expect(document.documentElement.style.getPropertyValue('--accent-soft')).toBe('rgba(52, 210, 127, 0.14)');
  });

  it('clears previously-set vars when switching back to a preset with no overrides', () => {
    applyAppearance(makePayload({ active_preset: 'emerald' }), 'dark');
    applyAppearance(makePayload({ active_preset: 'default' }), 'dark');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--accent-soft')).toBe('');
  });
});

describe('createSerialQueue', () => {
  it('runs tasks strictly in issue order even when a later task would resolve sooner', async () => {
    const queue = createSerialQueue();
    const startOrder: number[] = [];
    const endOrder: number[] = [];
    const p1 = queue.run(() => {
      startOrder.push(1);
      return new Promise<void>((resolve) => setTimeout(() => { endOrder.push(1); resolve(); }, 30));
    });
    const p2 = queue.run(() => {
      startOrder.push(2);
      return new Promise<void>((resolve) => setTimeout(() => { endOrder.push(2); resolve(); }, 1));
    });
    await Promise.all([p1, p2]);
    // Task 2 has a far shorter timer, but it only STARTS after task 1 settles — so the
    // server (a real mutation) would observe them in issue order, last intent wins.
    expect(startOrder).toEqual([1, 2]);
    expect(endOrder).toEqual([1, 2]);
  });

  it('a failed task does not wedge the queue', async () => {
    const queue = createSerialQueue();
    const failed = queue.run(() => Promise.reject(new Error('boom')));
    await expect(failed).rejects.toThrow('boom');
    await expect(queue.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('cache', () => {
  it('caches only a resolved var snapshot, not the contract', () => {
    cacheScheme(makePayload({ active_preset: 'emerald' }));
    const cached = readCachedScheme();
    expect(cached?.dark).toEqual({ '--accent': '#34d27f', '--accent-soft': 'rgba(52, 210, 127, 0.14)' });
    // No preset/token catalog leaked into the cache.
    expect((cached as unknown as Record<string, unknown>).presets).toBeUndefined();
  });

  it('applies the cached scheme to the document root', () => {
    cacheScheme(makePayload({ active_preset: 'emerald' }));
    applyCachedScheme('dark');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#34d27f');
  });

  it('drops cached entries with unsafe var names or values (no injection)', () => {
    localStorage.setItem(
      'superclaw_appearance',
      JSON.stringify({ dark: { '--accent': '#000000', 'color:red;}': '#fff', '--evil': 'url(x)' } }),
    );
    const cached = readCachedScheme();
    expect(cached?.dark).toEqual({ '--accent': '#000000' });
  });

  it('returns sanitized empties for a malformed cache entry', () => {
    localStorage.setItem('superclaw_appearance', '{ not json');
    expect(readCachedScheme()).toBeNull();
  });

  it('applyAppearance wipes non-whitelisted cache vars so they cannot outlive the authoritative load', () => {
    // Inject a var that is real in styles.css but NOT in the kernel token whitelist.
    localStorage.setItem('superclaw_appearance', JSON.stringify({ dark: { '--bg-muted': '#000000' }, light: {} }));
    applyCachedScheme('dark');
    expect(document.documentElement.style.getPropertyValue('--bg-muted')).toBe('#000000');

    // Now the authoritative payload arrives (default preset, tokens = accent + bg_base only).
    applyAppearance(makePayload({ active_preset: 'default' }), 'dark');
    // The non-whitelisted cache var must be gone — it is not owned by the kernel contract.
    expect(document.documentElement.style.getPropertyValue('--bg-muted')).toBe('');
  });
});
