import { describe, expect, it } from 'vitest';

import { normalizeAppEnv, pickServiceUrl } from '../src/app-env';

describe('normalizeAppEnv', () => {
  it('defaults to staging when unset (there is no localhost development tier)', () => {
    expect(normalizeAppEnv(undefined)).toBe('staging');
    expect(normalizeAppEnv('')).toBe('staging');
    expect(normalizeAppEnv('   ')).toBe('staging');
  });

  it('passes through canonical values (case/space insensitive)', () => {
    expect(normalizeAppEnv('staging')).toBe('staging');
    expect(normalizeAppEnv('  Production ')).toBe('production');
  });

  it('folds every legacy/non-production spelling to staging, matching the kernel', () => {
    expect(normalizeAppEnv('prod')).toBe('production');
    expect(normalizeAppEnv('stage')).toBe('staging');
    expect(normalizeAppEnv('development')).toBe('staging');
    expect(normalizeAppEnv('dev')).toBe('staging');
    expect(normalizeAppEnv('local')).toBe('staging');
    expect(normalizeAppEnv('test')).toBe('staging');
  });
});

describe('pickServiceUrl — build-mode no-localhost-leak invariant', () => {
  it('returns the localhost default only on the Vite dev server', () => {
    expect(pickServiceUrl(undefined, 'http://127.0.0.1:3000', true)).toBe('http://127.0.0.1:3000');
  });

  it('NEVER falls back to localhost in a compiled bundle (staging/production)', () => {
    // import.meta.env.DEV is statically false in a build, so the dead branch can never
    // resolve to the localhost literal — a shipped bundle uses no localhost URL.
    expect(pickServiceUrl(undefined, 'http://127.0.0.1:3000', false)).toBeUndefined();
    expect(pickServiceUrl('', 'http://127.0.0.1:8787', false)).toBeUndefined();
    expect(pickServiceUrl('   ', 'http://127.0.0.1:8790', false)).toBeUndefined();
  });

  it('an explicit configured value always wins (trimmed), dev or bundle', () => {
    expect(pickServiceUrl(' https://osiris.example ', 'http://127.0.0.1:3000', false)).toBe('https://osiris.example');
    expect(pickServiceUrl('https://clawhunt.store', 'http://127.0.0.1:8787', true)).toBe('https://clawhunt.store');
  });
});
