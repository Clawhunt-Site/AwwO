// The settings' "Privacy policy" links (设置 → 关于, 设置 → 本机版连接's Privacy card) open ClawHunt's privacy policy at
// its own top, #sec-privacy, the policy's element id that the site's footer and contents link: /legal alone opens on
// the Terms of Service above it (2026-11-12). They are drawn only where the API named an https site.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { httpsSite, privacyPolicyPageURL } from '../src/canvas/privacyPolicy';
import { privacyPolicyURL } from '../src/canvas/ClaudeFableNote';
import type { Identity } from '../src/saas/api';
import { AccountPreferencesProvider } from '../src/saas/accountPreferences';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const SITE = 'https://clawhunt.example';
const hosted = { user: { id: 'user-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' },
  tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }], authentication: 'clawhunt',
  clawhuntSiteURL: SITE, personalCredentialsRequired: false, relay: true } as unknown as Identity;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function open(section: string, who: Identity = hosted) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/preferences') ? json({ preferences: {}, version: 0 })
    : url.endsWith('/auth/relay-keys') ? json({ items: [], limit: 5 }) : json({ items: [] })));
  history.replaceState(null, '', `/?account=${section}`);
  return render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={who.user.id}><PersonalEngineGate identity={who}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); });

describe('the privacy policy’s links', () => {
  it('open the policy at its top, and clause 08 at the clause, only on an https site', () => {
    expect(privacyPolicyPageURL(SITE)).toBe(`${SITE}/legal#sec-privacy`);
    expect(privacyPolicyPageURL(`${SITE}// `)).toBe(`${SITE}/legal#sec-privacy`);
    expect(privacyPolicyURL(SITE)).toBe(`${SITE}/legal#s-privacy-c8`);
    for (const site of ['', 'http://clawhunt.example', 'javascript:alert(1)', '//clawhunt.example', undefined, null]) {
      expect(httpsSite(site), String(site)).toBe('');
      expect(privacyPolicyPageURL(site), String(site)).toBe('');
    }
  });

  it('设置 → 关于 links the policy at its top, in a new tab', async () => {
    open('about');
    const link = await screen.findByRole('link', { name: '隐私政策' });
    expect(link).toHaveAttribute('href', `${SITE}/legal#sec-privacy`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('设置 → 本机版连接’s Privacy card links the policy at its top', async () => {
    open('relay');
    const link = await screen.findByRole('link', { name: '隐私政策' });
    expect(link).toHaveAttribute('href', `${SITE}/legal#sec-privacy`);
  });

  it('names no link where the API named no https site', async () => {
    open('about', { ...hosted, clawhuntSiteURL: 'http://clawhunt.example' } as unknown as Identity);
    expect(await screen.findByRole('link', { name: '开源许可' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '隐私政策' })).toBeNull();
  });
});
