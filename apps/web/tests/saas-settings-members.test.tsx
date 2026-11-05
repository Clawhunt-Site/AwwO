import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider, emptyAccountPreferences } from '../src/saas/accountPreferences';
import type { Identity } from '../src/saas/api';

// The hosted entry's stylesheets in the order the page applies them: main.tsx's, with the sheets SaaSApp's components
// import evaluated where SaaSApp is, then the settings centre's, whose chunk loads lazily after them.
const SHEETS = [
  'src/styles.css', 'src/saas/saas.css', 'src/account/account.css', 'src/saas/personal-account.css',
  'src/canvas/ios-theme.css', 'src/saas/design/tokens.css', 'src/saas/design/themes.css', 'src/saas/design/system.css', 'src/saas/design/canvas.css',
  'src/saas/design/surfaces.css', 'src/saas/design/motion.css', 'src/saas/design/modes.css', 'src/saas/design/transitions.css',
  'src/saas/settings/settings-center.css',
];
const identity = { user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.test', platformRole: 'user' },
  tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }], authentication: 'local', personalCredentialsRequired: false } as unknown as Identity;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function open(locale: 'zh' | 'en') {
  localStorage.setItem('superclaw_locale', locale);
  history.replaceState(null, '', '/?account=workspace');
  render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={identity.user.id}><PersonalEngineGate identity={identity}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
}

beforeAll(() => {
  for (const file of SHEETS) {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), file), 'utf8');
    document.head.appendChild(style);
  }
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://awwo.test');
    if (url.pathname.endsWith('/auth/me')) return json(identity);
    if (url.pathname.endsWith('/auth/preferences')) return json({ preferences: emptyAccountPreferences(), version: 1 });
    if (url.pathname.endsWith('/tenants/team-a/members')) return json({ items: [{ userId: 'user-1', name: 'Ada Lovelace', email: 'ada@example.test', role: 'owner' }], nextCursor: null });
    if (url.pathname.endsWith('/tenants/team-a/invites')) return json({ items: [], nextCursor: null });
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); localStorage.clear(); });

// The card took its avatar from its own status line: 「已」 of 已认证工作区, "AW" of Authenticated workspace.
it.each([['zh', 'AwwO 工作区会话'], ['en', 'AwwO workspace session']] as const)('gives the workspace session card the signed-in person’s initials (%s)', async (locale, card) => {
  open(locale);
  const session = await screen.findByRole('region', { name: card });
  expect(session.querySelector('.account-avatar-fallback')).toHaveTextContent(/^AL$/);
  // The member list already showed each person's own.
  const members = await screen.findByText('ada@example.test', { selector: '.account-member-identity span' });
  expect(members.closest('.account-member-row')!.querySelector('.account-avatar-fallback')).toHaveTextContent(/^AL$/);
});

// In Chrome at 1440 px (2026-11-05) the page drew the shared panel's grey ground inside its own card, tracked capital
// labels, and the generic button padding (8px 14px) on the 36 px 刷新 icon button, which squeezed the icon to 6 px.
it('draws the panel in 设置 → 成员与工作区 as the account dialog draws it: its sections are the cards, its icon is whole', async () => {
  open('zh');
  const panel = (await screen.findByRole('heading', { level: 1, name: '账户与成员' })).closest('.account-workspace-panel') as HTMLElement;
  const card = panel.closest('.saas-settings-members') as HTMLElement;
  expect(card).toHaveClass('saas-card');
  const style = getComputedStyle(card);
  expect([style.paddingTop, style.borderTopStyle, style.boxShadow]).toEqual(['0px', 'none', 'none']);
  expect(getComputedStyle(panel).paddingTop).toBe('0px');
  const refresh = within(panel).getByRole('button', { name: '重试' });
  expect(refresh).toHaveClass('account-icon-button');
  expect(getComputedStyle(refresh).padding).toBe('0px');
  for (const label of panel.querySelectorAll('.account-eyebrow')) expect(getComputedStyle(label).textTransform).toBe('none');
});

it('keeps every rule the account dialog gives its panel for the settings page too', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/saas/design/surfaces.css'), 'utf8');
  // The dialog's own frame (its size, header and body) stays the dialog's; what is inside it is the panel.
  const panelRules = css.split('\n').filter(line => /\.awwo-account-dialog\b[^{]*\.account-/.test(line));
  expect(panelRules.length).toBeGreaterThan(50);
  for (const line of panelRules) expect(line, line.slice(0, 90)).toContain(':is(.awwo-account-dialog, .saas-settings-members)');
});
