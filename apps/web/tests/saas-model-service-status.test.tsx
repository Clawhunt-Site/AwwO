import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider, emptyAccountPreferences } from '../src/saas/accountPreferences';
import { EXECUTION_NO_MODEL, EXECUTION_SERVICE_NOT_READY } from '../src/saas/managedExecutionApi';
import type { Identity } from '../src/saas/api';

// An account on the platform's models, whose 设置 has 模型服务 (an account with its own key has 我的执行引擎 instead).
const identity = { user: { id: 'user-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' },
  tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }], authentication: 'clawhunt', personalCredentialsRequired: false } as unknown as Identity;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function open(locale: 'zh' | 'en', runtime: Record<string, unknown>) {
  localStorage.setItem('superclaw_locale', locale);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/preferences') ? json({ preferences: emptyAccountPreferences(), version: 1 })
    : /\/tenants\/team-a\/[^?]*runtime/.test(url) ? json(runtime) : json({ error: { code: 'not_found', message: 'Not found' } }, 404)));
  history.replaceState(null, '', '/?account=engines');
  render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={identity.user.id}><PersonalEngineGate identity={identity}><p>workspace</p></PersonalEngineGate></AccountPreferencesProvider></SaaSPreferencesProvider>);
}
const down = (reason: string) => ({ ready: false, reason, capabilities: { workspace: false, approvals: false }, models: [] });

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); localStorage.clear(); });

it('names the two reasons the API gives as the API writes them (computer_execution.go)', () => {
  const go = readFileSync(resolve(process.cwd(), '../../backend/internal/app/computer_execution.go'), 'utf8');
  for (const reason of [EXECUTION_SERVICE_NOT_READY, EXECUTION_NO_MODEL]) expect(go).toContain(`reason = "${reason}"`);
});

// 设置 → 模型服务 showed 「服务暂时不可用：Managed execution service is not ready」, the API's English inside a Chinese page.
it.each([
  ['zh', EXECUTION_SERVICE_NOT_READY, '工作区执行服务暂时不可用，请稍后重新检查。'],
  ['en', EXECUTION_SERVICE_NOT_READY, 'Workspace execution is temporarily unavailable. Check again later.'],
  // These accounts have no 我的引擎 to send them to: the workspace may use no model.
  ['zh', EXECUTION_NO_MODEL, '这个工作区现在没有可用的模型。'],
  ['en', EXECUTION_NO_MODEL, 'No model is available to this workspace right now.'],
] as const)('says why the service is unavailable in the reader’s language (%s: %s)', async (locale, reason, said) => {
  open(locale, down(reason));
  const status = await screen.findByText(said);
  expect(status).toHaveAttribute('role', 'status');
  expect(document.body.textContent).not.toContain(reason === EXECUTION_NO_MODEL && locale === 'en' ? 'My engines' : reason);
});

it('keeps saying any other reason as the service wrote it, after its own words', async () => {
  open('zh', down('Upstream maintenance until 18:00'));
  expect(await screen.findByText('服务暂时不可用：Upstream maintenance until 18:00')).toHaveAttribute('role', 'status');
});
