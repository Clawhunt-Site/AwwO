import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider } from '../src/saas/accountPreferences';
import type { Identity } from '../src/saas/api';

// A tab opened before a deploy asks for a settings chunk that is gone. Its page names itself, as every page does: after
// a sign-in on the same page it kept the sign-in page's title (2026-11-05).
vi.mock('../src/saas/SettingsCenter', () => { throw new Error('chunk gone'); });
const identity = { user: { id: 'user-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' },
  tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }], authentication: 'local', personalCredentialsRequired: false } as unknown as Identity;

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ preferences: {}, version: 0 }), { status: 200 }))); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); localStorage.clear(); });

it('names the settings centre that could not load as the settings, not as the page before it', async () => {
  document.title = 'AwwO · 让 Agent 在同一张画布上协作';
  history.replaceState(null, '', '/?account=security');
  render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={identity.user.id}><PersonalEngineGate identity={identity}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('设置没能加载，请刷新页面重试。');
  expect(document.title).toBe('设置 · AwwO');
});
