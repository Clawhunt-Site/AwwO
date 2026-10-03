import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProductionCases } from '../src/saas/ProductionCases';
import { SaaSOnboarding } from '../src/saas/SaaSOnboarding';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity } from '../src/saas/api';

// A tab opened before a deploy asks for chunks that are gone; neither part may take the page down, and a
// new account may not slip past the tutorial that way.
vi.mock('../src/saas/ProductionShowcase', () => { throw new Error('chunk gone'); });
vi.mock('../src/saas/WorkModeTutorial', () => { throw new Error('chunk gone'); });
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/?tenant=team'); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); });

it('keeps the cases when a case view cannot load, and offers a reload', async () => {
  render(<SaaSPreferencesProvider><ProductionCases /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: '团队知识库 SaaS' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取运行记录。');
  expect(screen.getByRole('button', { name: '刷新页面' })).toBeVisible();
  expect(screen.getByRole('dialog', { name: '团队知识库 SaaS' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 2, name: '一句话需求，交给一支 Agent 团队。' })).toBeVisible();
});

const account = (id: string, createdAt: string): Identity => ({ user: { id, name: 'Member', email: `${id}@example.test`, platformRole: 'user' },
  tenants: [{ id: 'team', name: 'Team', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 20, createdAt }] });
const home = (user: Identity) => render(<SaaSPreferencesProvider><SaaSOnboarding identity={user}><main data-onboarding="canvas-list">workspace home</main></SaaSOnboarding></SaaSPreferencesProvider>);

it('asks a new account to reload when the tutorial cannot load, instead of letting it skip the tutorial', async () => {
  home(account('lazy-new', new Date().toISOString()));
  const notice = await screen.findByRole('alertdialog');
  expect(notice).toHaveTextContent('新手教程没能加载');
  // A native modal dialog: the workspace behind it is inert, and neither Escape nor a forced close dismisses it.
  expect(notice.tagName).toBe('DIALOG');
  expect((notice as HTMLDialogElement).open).toBe(true);
  expect(fireEvent(notice, new Event('cancel', { cancelable: true }))).toBe(false);
  (notice as HTMLDialogElement).removeAttribute('open'); fireEvent(notice, new Event('close'));
  expect((notice as HTMLDialogElement).open).toBe(true);
  expect(screen.getByRole('button', { name: '刷新页面' })).toHaveFocus();
  expect(localStorage.getItem('awwo.workmode.v1:lazy-new')).toBeNull();   // nothing recorded: it opens again after the reload
});

it('lets anyone else carry on without the tutorial when it cannot load', async () => {
  home(account('lazy-old', '2026-09-01T08:00:00Z'));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(screen.getByText('workspace home')).toBeVisible();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
