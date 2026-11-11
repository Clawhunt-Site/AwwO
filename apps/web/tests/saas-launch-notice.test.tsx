// The launch notice (owner 2026-11-11: 「在awwo的模型列表中是上线fable5.2,然后上线弹窗，价格改为三档」): once per account on
// this device, on a workspace's home, saying only what the server confirms.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LaunchNotice, { LAUNCH_MODEL_ID, launchNoticeKey } from '../src/saas/LaunchNotice';
import { LaunchNoticeHost } from '../src/saas/LaunchNoticeHost';
import { launchNoticeTenant, tutorialSettled, tutorialStorageKey } from '../src/saas/SaaSOnboarding';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity } from '../src/saas/api';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const catalog = [
  { id: 'pro', priceUsd: 20, credits: 2000, dailyCalls: 300, concurrentAgents: 3, workspaces: 3, mediaPerDay: 30 },
  { id: 'max', priceUsd: 100, credits: 10000, dailyCalls: 1000, concurrentAgents: 6, workspaces: 10, mediaPerDay: 100 },
  { id: 'ultra', priceUsd: 299, credits: 29900, dailyCalls: 3000, concurrentAgents: 12, workspaces: 30, mediaPerDay: 300 },
];
const offer = { catalog, checkoutEnabled: true };
const fable = { id: LAUNCH_MODEL_ID, name: 'Claude Fable 5.2', runtime: 'openai-agents' };
const opus = { id: 'bedrock.claude-opus-5-5', name: 'Claude Opus 5.5', runtime: 'openai-agents' };

let sequence = 0;
const userID = () => `launch-user-${++sequence}`;
/** Serves the two reads the notice makes; anything else is an error the test would see in `calls`. */
function serve(plans: unknown, models: unknown[] | null) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith('/billing/catalog')) return plans === null ? response({ error: { code: 'not_found' } }, 404) : response(plans);
    if (url.endsWith('/runtime')) return models === null ? response({ error: { code: 'unavailable' } }, 503) : response({ models });
    return response({ error: { code: 'not_found' } }, 404);
  }));
  return calls;
}
/** The notice on a home that has drawn (its list is there), unless `drawn` is false. */
const notice = (user: string, tenant = 'team', drawn = true) => render(<SaaSPreferencesProvider>{drawn && <div data-onboarding="canvas-list" />}<LaunchNotice userID={user} tenantId={tenant} /></SaaSPreferencesProvider>);
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  history.replaceState(null, '', '/?tenant=team');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); });

it('announces the model and the three plans as the server lists them, and leads to the plans page', async () => {
  const user = userID();
  const calls = serve(offer, [opus, fable]);
  notice(user);
  const dialog = await screen.findByRole('dialog', { name: 'Claude Fable 5.2 已上线' });
  expect(dialog).toHaveTextContent('已经在节点和画布助手的模型列表里，现在就能选用');
  expect(within(dialog).getByRole('heading', { name: '套餐现在有三档' })).toBeVisible();
  const plans = within(dialog).getAllByRole('listitem');
  expect(plans.map(item => item.textContent)).toEqual(['Pro$20 / 月每月 2,000 点', 'Max$100 / 月每月 10,000 点', 'Ultra$299 / 月每月 29,900 点']);
  // Monthly, and renewed by itself (owner: 「包月自动续订」).
  expect(dialog).toHaveTextContent('包月订阅，每月自动续订，新一期的点数随之到账；可随时取消，取消后用到本期结束。');
  const see = within(dialog).getByRole('link', { name: '查看套餐' });
  expect(see).toHaveAttribute('href', expect.stringContaining('account=plans'));
  expect(see).toHaveFocus();
  // It only reads: the plan catalog and this workspace's model list.
  expect(calls).toEqual(['/api/v1/billing/catalog', '/api/v1/tenants/team/runtime']);
  expect(localStorage.getItem(launchNoticeKey(user, 'model'))).toBeNull();
  fireEvent.click(see);
  expect(screen.queryByRole('dialog')).toBeNull();
  // Going on to the plans says so to the admin panel's list, without waiting for the answer.
  expect(calls).toEqual(['/api/v1/billing/catalog', '/api/v1/tenants/team/runtime', '/api/v1/tenants/team/upgrade-interest']);
  expect(localStorage.getItem(launchNoticeKey(user, 'model'))).toBe('shown');
  expect(localStorage.getItem(launchNoticeKey(user, 'plans'))).toBe('shown');
});

it('says nothing of a model the workspace does not list: the three plans alone are the news', async () => {
  const user = userID();
  serve(offer, [opus]);
  notice(user);
  const dialog = await screen.findByRole('dialog', { name: '套餐现在有三档' });
  expect(dialog).not.toHaveTextContent('Fable');
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
  const calls = vi.mocked(fetch).mock.calls.length;
  fireEvent.click(within(dialog).getByRole('button', { name: '以后再说' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  // Declining records nothing.
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  // The plans were shown; the model was not, so it is still news when it arrives.
  expect(localStorage.getItem(launchNoticeKey(user, 'plans'))).toBe('shown');
  expect(localStorage.getItem(launchNoticeKey(user, 'model'))).toBeNull();
  cleanup();
  serve(offer, [opus, fable]);
  notice(user);
  expect(await screen.findByRole('dialog', { name: 'Claude Fable 5.2 已上线' })).toBeVisible();
});

it('tells a workspace whose allowance does not include the model that it needs a plan', async () => {
  serve(offer, [{ ...fable, requiresUpgrade: true }]);
  notice(userID());
  expect(await screen.findByRole('dialog', { name: 'Claude Fable 5.2 已上线' })).toHaveTextContent('它需要付费套餐，按点数使用。');
});

it('speaks English to an English reader', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  serve(offer, [fable]);
  notice(userID());
  const dialog = await screen.findByRole('dialog', { name: 'Claude Fable 5.2 is here' });
  expect(within(dialog).getByRole('heading', { name: 'Plans now come in three sizes' })).toBeVisible();
  expect(within(dialog).getAllByRole('listitem')[2]).toHaveTextContent('Ultra$299 / month29,900 credits a month');
  expect(dialog).toHaveTextContent('Plans are monthly and renew automatically');
  expect(within(dialog).getByRole('link', { name: 'See plans' })).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'Not now' })).toBeVisible();
});

it('stays away when there is nothing confirmed to say', async () => {
  // Checkout closed and no model: nothing to announce, and nothing remembered.
  const user = userID();
  serve({ catalog, checkoutEnabled: false }, [opus]);
  notice(user);
  await settle();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(localStorage.getItem(launchNoticeKey(user, 'plans'))).toBeNull();
  cleanup();
  // Having found nothing, it does not ask again on the home's later loads in this tab.
  const again = serve(offer, [fable]);
  notice(user);
  await settle();
  expect(again).toEqual([]);
  expect(screen.queryByRole('dialog')).toBeNull();
  cleanup();
  // A server that lists two plans (an older one) has no three to announce.
  sessionStorage.clear();
  const two = serve({ catalog: catalog.slice(0, 2), checkoutEnabled: true }, [opus]);
  notice(user);
  await settle();
  expect(two).toHaveLength(2);
  expect(screen.queryByRole('dialog')).toBeNull();
  cleanup();
  // Both reads failing says nothing either.
  sessionStorage.clear();
  const failing = serve(null, null);
  notice(user);
  await settle();
  expect(failing).toHaveLength(2);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(localStorage.getItem(launchNoticeKey(user, 'plans'))).toBeNull();
});

it('counts fewer plans listed beside the model as the model’s news only', async () => {
  const user = userID();
  serve({ catalog: catalog.slice(0, 2), checkoutEnabled: true }, [fable]);
  notice(user);
  const dialog = await screen.findByRole('dialog', { name: 'Claude Fable 5.2 已上线' });
  expect(within(dialog).getByRole('heading', { name: '付费套餐' })).toBeVisible();
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
  fireEvent.click(within(dialog).getByRole('button', { name: '以后再说' }));
  expect(localStorage.getItem(launchNoticeKey(user, 'model'))).toBe('shown');
  // The three plans were not shown: they are still news.
  expect(localStorage.getItem(launchNoticeKey(user, 'plans'))).toBeNull();
});

it('waits for the home to have drawn', async () => {
  serve(offer, [fable]);
  const view = notice(userID(), 'team', false);
  await settle();
  expect(screen.queryByRole('dialog')).toBeNull();
  const list = document.createElement('div');
  list.setAttribute('data-onboarding', 'canvas-list');
  await act(async () => { view.container.append(list); });
  expect(await screen.findByRole('dialog', { name: 'Claude Fable 5.2 已上线' })).toBeVisible();
});

it('announces the model without plans to buy where checkout is closed', async () => {
  const user = userID();
  serve({ catalog, checkoutEnabled: false }, [fable]);
  notice(user);
  const dialog = await screen.findByRole('dialog', { name: 'Claude Fable 5.2 已上线' });
  expect(within(dialog).queryAllByRole('listitem')).toHaveLength(0);
  expect(within(dialog).queryByRole('link')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: '知道了' }));
  expect(localStorage.getItem(launchNoticeKey(user, 'model'))).toBe('shown');
  // No plans were shown, so they are not counted as seen.
  expect(localStorage.getItem(launchNoticeKey(user, 'plans'))).toBeNull();
});

it('is shown once: an account that has seen both reads nothing again', async () => {
  const user = userID();
  localStorage.setItem(launchNoticeKey(user, 'model'), 'shown');
  localStorage.setItem(launchNoticeKey(user, 'plans'), 'shown');
  const calls = serve(offer, [fable]);
  notice(user);
  await settle();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(calls).toEqual([]);
  // Another account on this device is told.
  notice(userID());
  expect(await screen.findByRole('dialog')).toBeVisible();
});

it('closes with Escape and its close button, remembering either way', async () => {
  const user = userID();
  serve(offer, [fable]);
  notice(user);
  const dialog = await screen.findByRole('dialog');
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(localStorage.getItem(launchNoticeKey(user, 'model'))).toBe('shown');
  cleanup();
  const other = userID();
  notice(other);
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(localStorage.getItem(launchNoticeKey(other, 'plans'))).toBe('shown');
});

it('waits its turn behind another dialog', async () => {
  serve(offer, [fable]);
  const blocker = document.createElement('dialog');
  blocker.setAttribute('open', '');
  document.body.append(blocker);
  try {
    notice(userID());
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Claude Fable 5.2 已上线' })).toBeNull();
    await act(async () => { blocker.removeAttribute('open'); });
    expect(await screen.findByRole('dialog', { name: 'Claude Fable 5.2 已上线' })).toBeVisible();
  } finally {
    blocker.remove();
  }
});

it('does not come back on every page where the browser cannot remember it', async () => {
  const calls = serve(offer, [fable]);
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage is off'); });
  notice(userID());
  await settle();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(calls).toEqual([]);
});

const identity = (over: Partial<Identity> = {}): Identity => ({
  user: { id: userID(), name: 'Ada', email: 'ada@example.test', platformRole: 'user' }, authentication: 'clawhunt',
  tenants: [{ id: 'team', name: 'Team', role: 'owner', status: 'active', createdAt: '2026-09-01T08:00:00Z' }], ...over,
} as Identity);

it('opens only on a workspace home, for an account the tutorial is done with', async () => {
  const who = identity();
  expect(launchNoticeTenant(who, '?tenant=team', '/')).toBe('team');
  expect(launchNoticeTenant(who, '', '/')).toBe('team');
  // Not on a canvas, the settings, the admin page, or a workspace that is not the account's or not active.
  expect(launchNoticeTenant(who, '?tenant=team&canvas=c1', '/')).toBeNull();
  expect(launchNoticeTenant(who, '?account=plans', '/')).toBeNull();
  // A link to a case or an Academy video opens that dialog: the notice keeps off that page.
  expect(launchNoticeTenant(who, '?tenant=team&case=pallward', '/')).toBeNull();
  expect(launchNoticeTenant(who, '?academy=start-node', '/')).toBeNull();
  expect(launchNoticeTenant(who, '', '/admin')).toBeNull();
  expect(launchNoticeTenant(who, '?tenant=other', '/')).toBeNull();
  expect(launchNoticeTenant(identity({ tenants: [{ id: 'team', name: 'Team', role: 'owner', status: 'suspended' }] } as Partial<Identity>), '', '/')).toBeNull();
  // The local edition sells nothing.
  expect(launchNoticeTenant(identity({ edition: 'local' } as Partial<Identity>), '', '/')).toBeNull();

  // The tutorial first: an account it still opens for gets no second dialog on that page.
  expect(tutorialSettled(who)).toBe(false);
  const calls = serve(offer, [fable]);
  render(<SaaSPreferencesProvider><div data-onboarding="canvas-list" /><LaunchNoticeHost identity={who} /></SaaSPreferencesProvider>);
  await settle();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(calls).toEqual([]);
  cleanup();
  localStorage.setItem(tutorialStorageKey(who.user.id), 'dismissed');
  expect(tutorialSettled(who)).toBe(true);
  render(<SaaSPreferencesProvider><div data-onboarding="canvas-list" /><LaunchNoticeHost identity={who} /></SaaSPreferencesProvider>);
  expect(await screen.findByRole('dialog', { name: 'Claude Fable 5.2 已上线' })).toBeVisible();
  await waitFor(() => expect(calls).toEqual(['/api/v1/billing/catalog', '/api/v1/tenants/team/runtime']));
});
