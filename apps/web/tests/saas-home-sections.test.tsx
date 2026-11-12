// The workspace home's sections (home/HomeShell.tsx): the left rail, the section in the address with back and forward,
// the focus and scroll a move gives, a case opened from any section, and the top bar without its meter on the home.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HomeShell } from '../src/saas/home/HomeShell';
import { sectionAddress, sectionFrom, MEMBER_SECTIONS, READER_SECTIONS } from '../src/saas/home/homeSections';
import { AcademyProvider } from '../src/saas/Academy';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { SaaSApp } from '../src/saas/SaaSApp';
import { canOpenCase, openCase } from '../src/saas/caseLink';
import type { Identity, Tenant } from '../src/saas/api';
import { appearanceFixture } from './saas-appearance-fixture';

const tenant: Tenant = { id: 'team-h', name: 'Team H', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-h', name: 'Hana Ito', email: 'hana@example.test', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function server() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith('/runtime')) return json({ available: true, configured: true, plannerAvailable: true, models: [{ id: 'model' }] });
    if (url.pathname.endsWith('/route-usage')) return json({ limited: true, interested: false, daily: { limit: 30, used: 3 }, routes: {} });
    if (url.pathname.endsWith('/capabilities')) return json({ error: { code: 'not_found' } }, 404);
    if (url.pathname.endsWith('/auth/me')) return json(identity);
    if (url.pathname.endsWith('/appearance')) return json(appearanceFixture);
    return json({ items: [], nextCursor: null });
  }));
  return calls;
}
const shell = (role = 'owner') => render(<SaaSPreferencesProvider><AcademyProvider>
  <main className="saas-dashboard saas-home"><HomeShell identity={identity} tenant={{ ...tenant, role }} onOpen={vi.fn()} /></main>
</AcademyProvider></SaaSPreferencesProvider>);
const rail = () => within(screen.getByRole('navigation', { name: '首页分区' }));
const current = () => rail().getAllByRole('button').find(button => button.getAttribute('aria-current') === 'page')?.textContent;
const back = (search: string) => act(() => { window.history.replaceState(window.history.state, '', `/${search}`); window.dispatchEvent(new PopStateEvent('popstate')); });

beforeAll(async () => { await import('../src/saas/ProductionShowcase'); }, 300_000);
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  window.history.replaceState({}, '', '/?tenant=team-h');
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

describe('the section an address names', () => {
  it('reads ?section= among this person’s sections, a case link first, and writes it keeping the rest', () => {
    expect(sectionFrom('?tenant=t', MEMBER_SECTIONS)).toBe('overview');
    expect(sectionFrom('?section=canvases', MEMBER_SECTIONS)).toBe('canvases');
    expect(sectionFrom('?section=market', MEMBER_SECTIONS)).toBe('market');
    // A reader has no market; an unknown section is 首页.
    expect(sectionFrom('?section=market', READER_SECTIONS)).toBe('overview');
    expect(sectionFrom('?section=elsewhere', MEMBER_SECTIONS)).toBe('overview');
    expect(sectionFrom('?section=canvases&case=pallward', READER_SECTIONS)).toBe('cases');
    expect(sectionAddress('cases', 'http://localhost/?tenant=t&academy#x')).toBe('/?tenant=t&academy=&section=cases#x');
    expect(sectionAddress('overview', 'http://localhost/?tenant=t&section=cases')).toBe('/?tenant=t');
    expect(sectionAddress('cases', 'http://localhost/?tenant=t', 'pallward')).toBe('/?tenant=t&section=cases&case=pallward');
  });
});

describe('the rail', () => {
  it('lists a member’s sections with the shown one marked, and the Academy last', async () => {
    server();
    shell();
    expect(rail().getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['首页', '我的画布', '制作案例', 'Agent 市场', '教程']);
    expect(current()).toBe('首页');
    expect(screen.getByRole('heading', { level: 1, name: '想一起搭建什么？' })).toBeVisible();
    // The tutorial's anchors are on 首页.
    expect(document.querySelector('form[data-onboarding="canvas-create"]')).not.toBeNull();
    await waitFor(() => expect(document.querySelector('[data-onboarding="canvas-list"]')).not.toBeNull());
    // The page never takes the focus or scrolls when it opens.
    expect(document.body).toHaveFocus();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('gives a reader no Agent market', () => {
    server();
    shell('reader');
    expect(rail().getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['首页', '我的画布', '制作案例', '教程']);
    expect(screen.getByRole('heading', { level: 1, name: 'Team H' })).toBeVisible();
  });

  it('moves between sections in the address, keeping its other parameters, and back and forward walk them', async () => {
    server();
    shell();
    fireEvent.click(rail().getByRole('button', { name: '我的画布' }));
    expect(window.location.search).toBe('?tenant=team-h&section=canvases');
    expect(current()).toBe('我的画布');
    const mine = screen.getByRole('heading', { level: 2, name: '我的画布' });
    expect(mine).toHaveFocus();
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox', { name: '画布需求' })).toBeNull();
    fireEvent.click(rail().getByRole('button', { name: 'Agent 市场' }));
    expect(window.location.search).toBe('?tenant=team-h&section=market');
    expect(screen.getByRole('heading', { level: 2, name: 'Agent 市场' })).toHaveFocus();
    expect(await screen.findByText('暂时读不到 Agent 市场。')).toBeVisible();
    expect(window.history.length).toBeGreaterThanOrEqual(3);
    back('?tenant=team-h&section=canvases');
    expect(current()).toBe('我的画布');
    expect(screen.getByRole('heading', { level: 2, name: '我的画布' })).toHaveFocus();
    back('?tenant=team-h');
    expect(current()).toBe('首页');
    expect(screen.getByRole('heading', { level: 1, name: '想一起搭建什么？' })).toHaveFocus();
    // The shown section again: no new entry, the page back at its top.
    const entries = window.history.length;
    fireEvent.click(rail().getByRole('button', { name: '首页' }));
    expect(window.history.length).toBe(entries);
    expect(window.location.search).toBe('?tenant=team-h');
  });

  it('opens the section the address names, and 探索’s tiles move there', async () => {
    server();
    window.history.replaceState({}, '', '/?tenant=team-h&section=cases');
    const view = shell();
    expect(current()).toBe('制作案例');
    expect(screen.getByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' })).toBeVisible();
    view.unmount();
    window.history.replaceState({}, '', '/?tenant=team-h');
    shell();
    fireEvent.click(screen.getByRole('button', { name: /^打开制作案例/ }));
    expect(current()).toBe('制作案例');
    expect(window.location.search).toBe('?tenant=team-h&section=cases');
    back('?tenant=team-h');
    fireEvent.click(screen.getByRole('button', { name: '打开 Agent 市场' }));
    expect(current()).toBe('Agent 市场');
  });
});

describe('a case opened from elsewhere', () => {
  it('opens in 制作案例 from every section, with no case left in the address', async () => {
    server();
    shell();
    for (const from of ['首页', '我的画布', 'Agent 市场']) {
      fireEvent.click(rail().getByRole('button', { name: from }));
      expect(canOpenCase()).toBe(true);
      expect(openCase('nothing-here')).toBe(false);
      let opened = false;
      act(() => { opened = openCase('summer-ad'); });
      expect(opened).toBe(true);
      const dialog = await screen.findByRole('dialog', { name: 'Summer sparkling-drink ad' });
      expect(current()).toBe('制作案例');
      expect(window.location.search).toBe('?tenant=team-h&section=cases');
      fireEvent(dialog, new Event('cancel', { cancelable: true }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByRole('button', { name: 'Summer sparkling-drink ad' })).toHaveFocus();
    }
    // In 制作案例 itself the case library opens it.
    act(() => { openCase('pallward'); });
    expect(await screen.findByRole('dialog', { name: 'PALLWARD' })).toBeVisible();
  });

  it('follows a case link into 制作案例 once, and a reload stays there', async () => {
    server();
    window.history.replaceState({}, '', '/?tenant=team-h&case=summer-ad');
    shell('reader');
    expect(await screen.findByRole('dialog', { name: 'Summer sparkling-drink ad' })).toBeVisible();
    expect(current()).toBe('制作案例');
    expect(window.location.search).toBe('?tenant=team-h&section=cases');
  });
});

describe('the top bar on the home', () => {
  it('has no meter there: the account card has the page’s one, and route-usage is asked by the gate and the card alone', async () => {
    const calls = server();
    localStorage.setItem('awwo.workmode.v1:user-h', 'completed');
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    render(<SaaSApp />);
    const card = await screen.findByRole('region', { name: '账号与套餐' });
    expect(await within(card).findByRole('button', { name: '今日额度 · 剩 27 次' })).toBeVisible();
    const header = document.querySelector('main.saas-home > header')!;
    expect(header.querySelector('.saas-route-usage-trigger')).toBeNull();
    expect(within(header as HTMLElement).getByRole('button', { name: '账号与工作区' })).toBeVisible();
    // Two reads: the plan gate's, before anything is drawn (whether the trial's end has the workspace closed,
    // PlanGate.tsx), and the account card's; none for a meter in the top bar.
    expect(calls.filter(call => call.includes('/route-usage'))).toHaveLength(2);
  });
});
