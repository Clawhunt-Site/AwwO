import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSApp } from '../src/saas/SaaSApp';
import { appearanceFixture } from './saas-appearance-fixture';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider, emptyAccountPreferences } from '../src/saas/accountPreferences';
import type { Identity } from '../src/saas/api';

const identity = { user: { id: 'user-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' },
  tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }], authentication: 'clawhunt', clawhuntSiteURL: 'https://clawhunt.store',
  personalCredentialsRequired: false } as unknown as Identity;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function open(section: string) {
  history.replaceState(null, '', `/?account=${section}`);
  render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={identity.user.id}><PersonalEngineGate identity={identity}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
}

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/preferences') ? json({ preferences: emptyAccountPreferences(), version: 1 })
    : /\/tenants\/team-a\/[^?]*runtime/.test(url) ? json({ ready: true, capabilities: { workspace: true, approvals: true }, models: [{ id: 'opus', label: 'Claude Opus', runtime: 'pi' }] })
      : json({ error: { code: 'not_found', message: 'Not found' } }, 404)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); localStorage.clear(); });

// The links a section writes into its own text carry no class, which is what the centre's link rule reaches; a
// link drawn as a button or a chip carries its own class and colour.
it.each([
  ['about', ['隐私政策', '开源许可']],
  ['engines', ['通用']],
])('gives the links in the text of 设置 → %s the page’s link rule', async (section, names) => {
  open(section);
  for (const name of names) {
    // (The navigation has a 通用 of its own, outside the section.)
    const links = (await screen.findAllByRole('link', { name })).filter(link => link.closest('.saas-settings-content'));
    expect(links, name).toHaveLength(1);
    expect(links[0].hasAttribute('class'), name).toBe(false);
  }
});

// A ClawHunt sign-in that failed and an administrator's page refused to an ordinary user end on a classless link back,
// which took the browser's blue too (its purple once visited).
it('gives the links back from a failed sign-in and a refused admin page the same rule', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/options') ? json({ clawhuntSSO: true, localAuth: false })
    : json({ error: { code: 'unauthenticated', message: 'Login required' } }, 401)));
  history.replaceState(null, '', '/?sso=error&reason=waitlisted');
  render(<SaaSApp />);
  const back = await screen.findByRole('link', { name: '返回登录' });
  expect(back.closest('.saas-login')).not.toBeNull();
  expect(back.hasAttribute('class')).toBe(false);
  cleanup();
  history.replaceState(null, '', '/admin');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? json(identity) : url.endsWith('/appearance') ? json(appearanceFixture) : json({ items: [] })));
  render(<SaaSApp />);
  const home = await screen.findByRole('link', { name: '返回工作区' });
  expect(home.closest('.saas-notice')).not.toBeNull();
  expect(home.hasAttribute('class')).toBe(false);
});

// jsdom applies neither :where() nor custom properties, so the rule is pinned at its source. Measured in Chrome on the
// browser fixture (云白), on the sign-in page, a failed sign-in, a reset link, the home, four settings sections, the
// refused admin page, a lost invitation and a canvas: no link left in the browser's rgb(0, 0, 238) or rgb(85, 26, 139),
// and the links in the theme's #3346c4 were these classless ones; the navigation's, menus' and footer's kept theirs.
it('colours them with the theme’s link colours at zero specificity, so a component’s own link rule wins', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/saas/design/system.css'), 'utf8');
  const selector = ':where(:is(.saas-login, .saas-dashboard, .saas-notice, .saas-native-dialog) a:not([class]))';
  const rule = (at: string) => { const start = css.indexOf(`${at} {`); expect(start, at).toBeGreaterThanOrEqual(0); return css.slice(start, css.indexOf('}', start)); };
  expect(rule(selector)).toContain('color: var(--saas-link);');
  expect(rule(selector)).toContain('text-decoration: underline;');
  // The hover rule is inside :where() too, so it is zero specificity as well.
  expect(rule(':where(:is(.saas-login, .saas-dashboard, .saas-notice, .saas-native-dialog) a:not([class]):hover)')).toContain('color: var(--saas-link-hover);');
  // One rule for the hosted pages: the settings centre keeps no copy of its own.
  expect(readFileSync(resolve(process.cwd(), 'src/saas/settings/settings-center.css'), 'utf8')).not.toContain('a:not([class])');
  // The colour is the theme's: every appearance style names both, as the light and dark defaults do.
  const themes = readFileSync(resolve(process.cwd(), 'src/saas/design/themes.css'), 'utf8');
  const blocks = themes.split(/(?=html:root\[data-awwo-theme=')/).filter(block => block.startsWith('html:root[data-awwo-theme='));
  expect(blocks.length).toBe(8);
  for (const block of blocks) expect(block, block.slice(0, 40)).toMatch(/--saas-link: #[0-9a-f]{6}; --saas-link-hover: #[0-9a-f]{6};/);
});
