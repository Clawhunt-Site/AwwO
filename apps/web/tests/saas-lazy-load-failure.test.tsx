import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProductionCases } from '../src/saas/ProductionCases';
import { SaaSOnboarding } from '../src/saas/SaaSOnboarding';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { page } from '../src/saas/staleBuild';
import { registerUnsavedEdits } from '../src/canvas/unsavedEdits';
import type { Identity } from '../src/saas/api';

// A tab opened before a deploy asks for chunks that are gone; neither part may take the page down, and a
// new account may not slip past the tutorial that way. Their reloads save an open canvas first.
vi.mock('../src/saas/ProductionShowcase', () => { throw new Error('chunk gone'); });
vi.mock('../src/saas/WorkModeTutorial', () => { throw new Error('chunk gone'); });
let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/?tenant=team'); vi.spyOn(console, 'error').mockImplementation(() => {});
  reload = vi.fn(); vi.spyOn(page, 'reload').mockImplementation(reload);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearSaaSCanvas(); history.replaceState(null, '', '/'); });

it('keeps the cases when a case view cannot load, and offers a reload, in English in the Chinese interface too', async () => {
  render(<SaaSPreferencesProvider><ProductionCases /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Team knowledge-base SaaS' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/^The run record could not be loaded\. Reload the page$/);
  expect(screen.getByRole('button', { name: 'Reload the page' })).toBeVisible();
  expect(screen.getByRole('dialog', { name: 'Team knowledge-base SaaS' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' })).toBeVisible();
  expect(reload).not.toHaveBeenCalled();
  // No canvas on the pages that list the cases: the reload comes at once.
  fireEvent.click(screen.getByRole('button', { name: 'Reload the page' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
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
  expect(reload).not.toHaveBeenCalled();
});

it('saves the open canvas before the tutorial’s reload, and says so when it cannot', async () => {
  const user = account('lazy-canvas', new Date().toISOString());
  const save = vi.fn().mockRejectedValueOnce(new Error('画布未同步，请先解决保存错误再运行。')).mockResolvedValueOnce(8);
  configureSaaSCanvas({ tenant: user.tenants[0], canvasId: 'canvas-1' });
  configureSaaSCanvasSave(save);
  home(user);
  fireEvent.click(await screen.findByRole('button', { name: '刷新页面' }));
  // The modal dialog keeps the canvas out of reach, so the reload may still go on; the browser asks before leaving.
  expect(await screen.findByText('画布有修改没能保存，现在刷新可能会丢失这些修改。')).toBeVisible();
  expect(save).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '仍然刷新' }));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
});

it('says so before the tutorial’s reload when an open editor holds changes the canvas does not have', async () => {
  const user = account('lazy-editor', new Date().toISOString());
  const save = vi.fn(async () => 9);
  configureSaaSCanvas({ tenant: user.tenants[0], canvasId: 'canvas-1' });
  configureSaaSCanvasSave(save);
  const stop = registerUnsavedEdits(() => true);
  try {
    home(user);
    fireEvent.click(await screen.findByRole('button', { name: '刷新页面' }));
    expect(await screen.findByText('有一个打开的编辑面板里还有没保存的修改，现在刷新会丢失这些修改。')).toBeVisible();
    expect(save).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '仍然刷新' }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally { stop(); }
});

it('reloads for the tutorial once the open canvas is saved', async () => {
  const user = account('lazy-saved', new Date().toISOString());
  const save = vi.fn(async () => 9);
  configureSaaSCanvas({ tenant: user.tenants[0], canvasId: 'canvas-1' });
  configureSaaSCanvasSave(save);
  home(user);
  fireEvent.click(await screen.findByRole('button', { name: '刷新页面' }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
});

it('lets anyone else carry on without the tutorial when it cannot load', async () => {
  home(account('lazy-old', '2026-09-01T08:00:00Z'));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(screen.getByText('workspace home')).toBeVisible();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
