// After the free trial's end a workspace without its owner's plan is closed whole (owner 2026-11-12: 「确保现在没有付费的
// 用户使用不了任何awwo的功能」, and, asked how far: locked completely, only the plans page left). The server answers 402
// free_plan_ended on every route of such a workspace but its usage answer (backend free_plan.go planLocked); this gate
// reads that answer before anything else is drawn and, where it says the trial has ended, shows the plans and nothing
// else: no home, canvas, results or settings. Nothing in the workspace is removed; the moment its owner's plan lands
// (the plans page says so on the page, ROUTE_USAGE_CHANGED) the gate reads again and the page is the app again.
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { SaaSApiError, type Identity, type Tenant } from './api';
import { BootSurface } from './BootSurface';
import { isLocalEdition } from './edition';
import { LanguageSwitch, useSaaSPreferences } from './preferences';
import { ROUTE_USAGE_CHANGED, fetchRouteUsage } from './routeUsage';
import { signOut } from './signOut';
import './plan-gate.css';

const PlansPage = lazy(() => import('./PlansPage').then(module => ({ default: module.PlansPage })));

/** The workspace a page is about: the address's, else the first active one (the same pick for every page of the app). */
export function shownTenant(identity: Identity, search: string = window.location.search): Tenant | undefined {
  const requested = new URLSearchParams(search).get('tenant');
  return identity.tenants.find(item => item.id === requested) || (!requested ? identity.tenants.find(item => item.status === 'active') || identity.tenants[0] : undefined);
}

/** open: the app; locked: the plans alone; unknown: not read yet, and nothing kept from an earlier page of this tab. */
export type PlanLock = 'unknown' | 'open' | 'locked';
/** While locked the usage answer is read again this often while the page is looked at (and whenever it is looked at
 *  again), so a plan bought in another tab or on another device opens this page without a reload. */
export const LOCKED_POLL_MS = 20_000;
const lockKey = (user: string, tenant: string) => `awwo.planlock.v1:${user}:${tenant}`;
function remembered(user: string, tenant: string): PlanLock {
  try { const value = sessionStorage.getItem(lockKey(user, tenant)); return value === 'open' || value === 'locked' ? value : 'unknown'; } catch { return 'unknown'; }
}
function remember(user: string, tenant: string, lock: PlanLock) {
  try { sessionStorage.setItem(lockKey(user, tenant), lock); } catch { /* a browser without storage reads again each time */ }
}

/** Whether the trial's end has this workspace closed, kept up with the server. What this tab last read is used at once
 *  (so a paying person's pages do not wait for the answer), and corrected when the answer comes. A read that fails for
 *  any reason but the closure itself decides nothing: an unknown workspace opens, since the server refuses whatever a
 *  closed one may not do, and a closed one stays closed and is read again (a failed read never ends the reading).
 *  `skip`: pages the gate never covers. */
export function usePlanLock(userId: string, tenantId: string | undefined, skip: boolean): PlanLock {
  const [lock, setLock] = useState<PlanLock>(() => skip || !tenantId ? 'open' : remembered(userId, tenantId));
  useEffect(() => {
    if (skip || !tenantId) { setLock('open'); return; }
    setLock(remembered(userId, tenantId));
    let live = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    /** What the page shows now, as this effect last set it: a closed page is read again, whatever the read's outcome. */
    let shown: PlanLock = remembered(userId, tenantId);
    const again = () => {
      window.clearTimeout(timer);
      // A page nobody is looking at asks nothing; it reads the moment it is looked at again (seen).
      if (shown === 'locked') timer = window.setTimeout(() => { if (document.visibilityState === 'visible') read(); else again(); }, LOCKED_POLL_MS);
    };
    const settle = (next: PlanLock) => {
      remember(userId, tenantId, next);
      setLock(shown = next);
      again();
    };
    function read() {
      controller?.abort();
      const mine = controller = new AbortController();
      fetchRouteUsage(tenantId!, mine.signal).then(usage => {
        if (live && !mine.signal.aborted) settle(usage.freePlan?.ended === true ? 'locked' : 'open');
      }).catch((error: unknown) => {
        if (!live || mine.signal.aborted) return;
        if (error instanceof SaaSApiError && error.code === 'free_plan_ended') { settle('locked'); return; }
        if (shown === 'unknown') setLock(shown = 'open');
        again();
      });
    }
    const seen = () => { if (document.visibilityState === 'visible') read(); };
    read();
    window.addEventListener(ROUTE_USAGE_CHANGED, read);
    document.addEventListener('visibilitychange', seen);
    return () => {
      live = false;
      controller?.abort();
      window.clearTimeout(timer);
      window.removeEventListener(ROUTE_USAGE_CHANGED, read);
      document.removeEventListener('visibilitychange', seen);
    };
  }, [userId, tenantId, skip]);
  return lock;
}

/** The pages the gate never covers: the local edition (it sells no plan), no workspace or a suspended one (its own
 *  page says so), the operator's console, and an invitation being answered (it may lead into a paying workspace). */
export function gateSkipped(identity: Identity, tenant: Tenant | undefined, pathname = window.location.pathname, search = window.location.search): boolean {
  return isLocalEdition(identity) || !tenant || tenant.status !== 'active' || pathname === '/admin' || new URLSearchParams(search).has('invite');
}

export function PlanGate({ identity, children }: { identity: Identity; children: ReactNode }) {
  const { t } = useSaaSPreferences();
  const tenant = shownTenant(identity);
  const lock = usePlanLock(identity.user.id, tenant?.id, gateSkipped(identity, tenant));
  if (lock === 'open' || !tenant) return <>{children}</>;
  // Not read yet in this tab: the same surface the app boots with, so a new tab goes from one to the other unseen.
  if (lock === 'unknown') return <BootSurface text={t('正在打开工作区…', 'Opening your workspace…')} canvas={new URLSearchParams(window.location.search).has('canvas')} />;
  return <PlanWall identity={identity} tenant={tenant} />;
}

/** The whole page of a closed workspace: who is signed in, why the plans are all there is, and the plans. */
function PlanWall({ identity, tenant }: { identity: Identity; tenant: Tenant }) {
  const { t } = useSaaSPreferences();
  const [failure, setFailure] = useState('');
  const owner = tenant.role === 'owner';
  const who = identity.user.email || identity.user.name;
  return <main className="saas-dashboard saas-plan-wall" data-plan-wall>
    <header>
      <span className="saas-logo">AwwO</span>
      <div className="saas-account-actions saas-plan-wall-actions">
        {identity.tenants.length > 1 && <select aria-label={t('切换工作区', 'Switch workspace')} value={tenant.id}
          onChange={event => window.location.assign('/?tenant=' + encodeURIComponent(event.target.value))}>
          {identity.tenants.map(item => <option key={item.id} value={item.id}>{item.name}{item.status === 'active' ? '' : t('（已暂停）', ' (suspended)')}</option>)}
        </select>}
        <LanguageSwitch />
        <button type="button" onClick={async () => { const message = await signOut(identity, t); if (message) setFailure(message); }}>
          <LogOut size={16} aria-hidden="true" /><span>{t('退出登录', 'Sign out')}</span>
        </button>
      </div>
    </header>
    <section className="saas-page-intro saas-plan-wall-intro">
      <h1>{owner ? t('免费试用已结束，订阅后继续使用 AwwO', 'The free trial has ended. Subscribe to keep using AwwO')
        : t('这个工作区的免费试用已结束', 'This workspace’s free trial has ended')}</h1>
      <p>{owner
        ? t('选一个套餐就能继续。你的画布和成果都保留着，订阅成功后立刻恢复使用。', 'Choose a plan to go on. Your canvases and results are all kept, and open again the moment your subscription lands.')
        : t(`「${tenant.name}」的所有者订阅 Pro、Max 或 Ultra 后，这个工作区恢复使用，里面的画布和成果都保留着。你也可以为自己的账号订阅，在自己的工作区里使用。`,
          `“${tenant.name}” opens again once its owner subscribes to Pro, Max or Ultra; its canvases and results are all kept. You can also subscribe for your own account and work in a workspace of your own.`)}</p>
      {who && <p className="saas-plan-wall-who">{t(`当前账号：${who}`, `Signed in as ${who}`)}</p>}
      {failure && <p role="alert" className="saas-error">{failure}</p>}
    </section>
    <div className="saas-plan-wall-plans">
      <Suspense fallback={<section className="saas-card saas-plans-note" role="status">{t('正在读取套餐…', 'Loading plans…')}</section>}>
        <PlansPage identity={identity} keepReturn />
      </Suspense>
    </div>
  </main>;
}
