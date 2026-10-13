import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { COMPACT_CASE_COUNT } from '../src/saas/ProductionCases';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { SaaSApp } from '../src/saas/SaaSApp';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import type { Identity, Tenant } from '../src/saas/api';

// Where the production cases sit in the app, and how a member copies a case's canvas. The cases read in English in
// both interface languages; these tests run in the Chinese interface.
const cards = () => screen.getAllByRole('listitem').filter(item => item.classList.contains('production-card'));
beforeAll(async () => { await import('../src/saas/ProductionShowcase'); }, 300_000);
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it('puts the cases on the signed-out homepage, after the welcome, with no other examples', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/options')
    ? new Response(JSON.stringify({ clawhuntSSO: true, localAuth: false }))
    : new Response(JSON.stringify({ error: { code: 'unauthenticated' } }), { status: 401 })));
  render(<SaaSApp />);
  const cases = await screen.findByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' });
  expect(cases.closest('section')).toHaveAttribute('lang', 'en');
  // The 18 official examples (「从一个作品开始」) were taken off the homepage on 2026-10-14.
  expect(screen.queryByRole('heading', { level: 2, name: '从一个作品开始' })).toBeNull();
  expect(screen.getByRole('heading', { level: 1 }).compareDocumentPosition(cases) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
  expect(screen.queryByRole('button', { name: /^See all \d+ cases$/ })).toBeNull();
});

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [tenant] };
it.each(['owner', 'reader'] as const)('shows one row of cases on the %s workspace home, with no other examples', async role => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify(new URL(input, 'http://localhost').pathname.endsWith('/runtime')
    ? { available: true, configured: true, plannerAvailable: true, models: [] } : { items: [], nextCursor: null }))));
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={{ ...tenant, role }} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  const cases = await screen.findByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' });
  expect(cases.closest('section')).toHaveAttribute('lang', 'en');
  expect(screen.queryByRole('heading', { level: 2, name: '从一个作品开始' })).toBeNull();
  expect(cards()).toHaveLength(COMPACT_CASE_COUNT);
  expect(screen.getByRole('button', { name: `See all ${PRODUCTION_CASES.length} cases` })).toHaveAttribute('aria-expanded', 'false');
  // The row is the catalog's first cases, so the pixel case is one click away.
  for (const item of PRODUCTION_CASES.slice(0, COMPACT_CASE_COUNT)) expect(screen.getByRole('button', { name: item.title })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Pixel platformer' })).toBeNull();
  // Members copy a case's canvas; readers cannot copy.
  fireEvent.click(screen.getByRole('button', { name: `See all ${PRODUCTION_CASES.length} cases` }));
  fireEvent.click(screen.getByRole('button', { name: 'Pixel platformer' }));
  const dialog = screen.getByRole('dialog', { name: 'Pixel platformer' });
  await within(dialog).findByRole('region');
  const copy = within(dialog).queryByRole('button', { name: 'Copy this canvas' });
  if (role === 'reader') { expect(copy).toBeNull(); return; }
  fireEvent.click(copy!);
  expect(await screen.findByRole('dialog', { name: 'Copy example to my canvases' })).toBeVisible();
  expect(screen.getByText(PRODUCTION_WORKFLOWS['pixel-platformer'].title)).toBeVisible();
});
