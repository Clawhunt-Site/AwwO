import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { COMPACT_CASE_COUNT } from '../src/saas/ProductionCases';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { SaaSApp } from '../src/saas/SaaSApp';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import type { Identity, Tenant } from '../src/saas/api';

// Where the production cases sit in the app, and how a member copies a case's canvas.
const cards = () => screen.getAllByRole('listitem').filter(item => item.classList.contains('production-card'));
beforeAll(async () => { await import('../src/saas/ProductionShowcase'); }, 300_000);
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it('puts the cases on the signed-out homepage, between the welcome and the examples to try', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/options')
    ? new Response(JSON.stringify({ clawhuntSSO: true, localAuth: false }))
    : new Response(JSON.stringify({ error: { code: 'unauthenticated' } }), { status: 401 })));
  render(<SaaSApp />);
  const cases = await screen.findByRole('heading', { level: 2, name: '一句话需求，交给一支 Agent 团队。' });
  const tryOne = screen.getByRole('heading', { level: 2, name: '从一个作品开始' });
  expect(cases.compareDocumentPosition(tryOne) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1 }).compareDocumentPosition(cases) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
  expect(screen.queryByRole('button', { name: /查看全部 \d+ 个制作案例/ })).toBeNull();
});

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [tenant] };
it.each(['owner', 'reader'] as const)('shows one row of cases on the %s workspace home, before the examples to try', async role => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify(new URL(input, 'http://localhost').pathname.endsWith('/runtime')
    ? { available: true, configured: true, plannerAvailable: true, models: [] } : { items: [], nextCursor: null }))));
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={{ ...tenant, role }} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  const cases = await screen.findByRole('heading', { level: 2, name: '一句话需求，交给一支 Agent 团队。' });
  expect(cases.compareDocumentPosition(screen.getByRole('heading', { level: 2, name: '从一个作品开始' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(cards()).toHaveLength(COMPACT_CASE_COUNT);
  expect(screen.getByRole('button', { name: `查看全部 ${PRODUCTION_CASES.length} 个制作案例` })).toHaveAttribute('aria-expanded', 'false');
  // Members copy a case's canvas the way they copy an official example; readers cannot copy.
  fireEvent.click(screen.getByRole('button', { name: '像素平台跳跃' }));
  const dialog = screen.getByRole('dialog', { name: '像素平台跳跃' });
  await within(dialog).findByRole('region');
  const copy = within(dialog).queryByRole('button', { name: '复制这张画布' });
  if (role === 'reader') { expect(copy).toBeNull(); return; }
  fireEvent.click(copy!);
  expect(await screen.findByRole('dialog', { name: '复制案例到我的画布' })).toBeVisible();
  expect(screen.getByText(PRODUCTION_WORKFLOWS['pixel-platformer'].title.zh)).toBeVisible();
});
