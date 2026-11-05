import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider, emptyAccountPreferences } from '../src/saas/accountPreferences';
import type { Identity } from '../src/saas/api';

// The hosted entry's stylesheets in the order the page applies them: main.tsx's own imports, with the sheets SaaSApp's
// components import (personal-account.css, canvas-library.css) evaluated where SaaSApp is, then the settings centre's,
// whose chunk loads lazily after them.
const SHEETS = [
  'src/styles.css', 'src/saas/saas.css', 'src/saas/personal-account.css', 'src/saas/canvas-library.css',
  'src/canvas/ios-theme.css', 'src/saas/design/tokens.css', 'src/saas/design/themes.css', 'src/saas/design/system.css', 'src/saas/design/canvas.css',
  'src/saas/design/surfaces.css', 'src/saas/design/motion.css', 'src/saas/design/modes.css', 'src/saas/design/transitions.css',
  'src/saas/settings/settings-center.css',
];
const identity = { user: { id: 'user-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' },
  tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }], authentication: 'local', personalCredentialsRequired: false } as unknown as Identity;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeAll(() => {
  for (const file of SHEETS) {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), file), 'utf8');
    document.head.appendChild(style);
  }
});
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/preferences') ? json({ preferences: emptyAccountPreferences(), version: 1 })
    : url.includes('/tenants/team-a/skills') ? json({ items: [] }) : json({ error: { code: 'not_found', message: 'Not found' } }, 404)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); localStorage.clear(); });

// A page's own field rules outrank one class: inside .saas-personal an input is width: 100% and min-height: 44px. The
// absolutely placed SKILL.md picker of 设置 → 技能 then reached 1440 px past its button, so in Chrome at 1440 px the page
// was 2376 px wide and scrolled sideways (2026-11-05); jsdom lays nothing out, but it resolves the same cascade.
it('keeps the SKILL.md picker of 设置 → 技能 one pixel square, so the page does not scroll sideways', async () => {
  history.replaceState(null, '', '/?account=skills');
  render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={identity.user.id}><PersonalEngineGate identity={identity}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
  const picker = await screen.findByLabelText('选择 SKILL.md 文件');
  expect(picker).toHaveClass('saas-visually-hidden');
  expect(picker.closest('.saas-personal')).not.toBeNull();
  const style = getComputedStyle(picker);
  expect({ position: style.position, width: style.width, height: style.height, minWidth: style.minWidth, minHeight: style.minHeight, padding: style.padding })
    .toEqual({ position: 'absolute', width: '1px', height: '1px', minWidth: '0px', minHeight: '0px', padding: '0px' });
  // jsdom's cascade of the border shorthand is not reliable across its versions, so the reset is pinned at its source.
  const css = readFileSync(resolve(process.cwd(), 'src/saas/design/system.css'), 'utf8');
  const at = css.indexOf('.saas-visually-hidden {');
  expect(css.slice(at, css.indexOf('}', at))).toContain('border: 0 !important;');
});

it('holds the hidden size against any field rule of the page, whatever its specificity', () => {
  document.body.innerHTML = '<main class="saas-personal saas-dashboard"><section class="saas-card"><label><input id="field" class="saas-visually-hidden" type="file"></label></section></main>';
  const style = getComputedStyle(document.getElementById('field')!);
  expect([style.width, style.height, style.minWidth, style.minHeight, style.padding, style.overflow]).toEqual(['1px', '1px', '0px', '0px', '0px', 'hidden']);
});
