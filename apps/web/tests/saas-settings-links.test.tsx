import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
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

// jsdom applies neither :where() nor custom properties, so the rule is pinned at its source. Measured in Chrome on the
// browser fixture (云白): 模型服务's 「通用」 and 关于's 开源许可 went from the browser's rgb(0, 0, 238) to the theme's
// #3346c4, underlined 3 px below the text, while the navigation's links and the skill library's licence link kept theirs.
it('colours them with the theme’s link colours at zero specificity, so a component’s own link rule wins', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/saas/settings/settings-center.css'), 'utf8');
  const rule = (selector: string) => { const at = css.indexOf(`${selector} {`); expect(at, selector).toBeGreaterThanOrEqual(0); return css.slice(at, css.indexOf('}', at)); };
  expect(rule(':where(.saas-settings-content a:not([class]))')).toContain('color: var(--saas-link);');
  expect(rule(':where(.saas-settings-content a:not([class]))')).toContain('text-decoration: underline;');
  expect(rule(':where(.saas-settings-content a:not([class])):hover')).toContain('color: var(--saas-link-hover);');
  // The colour is the theme's: every appearance style names both, as the light and dark defaults do.
  const themes = readFileSync(resolve(process.cwd(), 'src/saas/design/themes.css'), 'utf8');
  const blocks = themes.split(/(?=html:root\[data-awwo-theme=')/).filter(block => block.startsWith('html:root[data-awwo-theme='));
  expect(blocks.length).toBe(8);
  for (const block of blocks) expect(block, block.slice(0, 40)).toMatch(/--saas-link: #[0-9a-f]{6}; --saas-link-hover: #[0-9a-f]{6};/);
});
