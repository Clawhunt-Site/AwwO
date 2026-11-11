// The launch notice (owner 2026-11-11: 「在awwo的模型列表中是上线fable5.2,然后上线弹窗，价格改为三档」): once per account on
// this device, on the workspace home, a dialog that says what is new and leads to the plans page. It says only what the
// server confirms at that moment: Claude Fable 5.2 only while this workspace's model list holds it, and the plans as the
// plan catalog lists them, only while they can be bought. Each of the two is remembered on its own, so an account that
// saw the plans before the model arrived is still told of the model. It creates, runs and buys nothing; going on to the
// plans records the interest the admin panel lists, as the app's other ways to the plans do.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, tenantPath } from './api';
import { fetchPlanOffer, formatCredits, isPlanId, planName, type CatalogPlan } from './billing';
import { accountURL } from './PersonalAccount';
import { useSaaSPreferences } from './preferences';
import { recordUpgradeInterest } from './routeUsage';
import type { SaaSRuntimeModel } from './runtimeCatalog';
import './launch-notice.css';

/** The model the notice announces, as the catalog names it. */
export const LAUNCH_MODEL_ID = 'bedrock.claude-fable-5-2';
export type LaunchNews = 'model' | 'plans';
/** Only that the notice was shown is stored, separately for every account on this device and for each piece of news. */
export const launchNoticeKey = (userID: string, news: LaunchNews) => `awwo.launch.${news === 'model' ? 'fable52' : 'plans3'}.v1:${encodeURIComponent(userID)}`;

/** The home's own content (SaaSOnboarding's selector for it): the notice opens over a page that has drawn. */
const HOME_READY = '[data-onboarding="canvas-list"]';
const memory = new Set<string>();
function shown(key: string): boolean {
  if (memory.has(key)) return true;
  try { return localStorage.getItem(key) === 'shown'; } catch { return false; }
}
function remember(key: string) {
  memory.add(key);
  try { localStorage.setItem(key, 'shown'); } catch { /* Remembered for this page only. */ }
}
/** That a visit found nothing to say is kept for the tab's session, so the home's later loads in it do not ask again;
 *  a new session asks once more, which is how an account learns of the model when it arrives. */
const quietKey = (userID: string, tenantId: string) => `awwo.launch.quiet.v1:${encodeURIComponent(userID)}:${encodeURIComponent(tenantId)}`;
function quiet(key: string): boolean { try { return sessionStorage.getItem(key) === '1'; } catch { return false; } }
function keepQuiet(key: string) { try { sessionStorage.setItem(key, '1'); } catch { /* Asked again on the next load. */ } }
/** Without storage nothing is remembered past this page, so the notice would come back on every one: it stays away. */
function storageWorks(): boolean {
  try { const probe = 'awwo.launch.probe'; localStorage.setItem(probe, '1'); localStorage.removeItem(probe); return true; }
  catch { return false; }
}

type News = { model: { needsPlan: boolean } | null; plans: CatalogPlan[] };

/** What there is to say that this account has not been shown yet; null when nothing is. A failed read counts as
 *  nothing to say for that part: the notice never guesses. */
async function readNews(userID: string, tenantId: string, signal: AbortSignal): Promise<News | null> {
  const wantModel = !shown(launchNoticeKey(userID, 'model')), wantPlans = !shown(launchNoticeKey(userID, 'plans'));
  if (!wantModel && !wantPlans) return null;
  const [offer, runtime] = await Promise.all([
    fetchPlanOffer(signal).catch(() => null),
    wantModel ? api<{ models?: SaaSRuntimeModel[] }>(tenantPath(tenantId, '/runtime'), { signal }).catch(() => null) : null,
  ]);
  const listed = Array.isArray(runtime?.models) ? runtime.models.find(model => model?.id === LAUNCH_MODEL_ID) : undefined;
  const plans = offer?.checkoutEnabled === true && Array.isArray(offer.catalog) ? offer.catalog.filter(plan => isPlanId(plan?.id)) : [];
  const model = listed ? { needsPlan: listed.requiresUpgrade === true } : null;
  // The plans alone are news once, and only as the three of them; with the model they are shown again beside it, as
  // where it leads.
  if (!model && !(wantPlans && plans.length >= 3)) return null;
  return { model, plans };
}

/** Mounted by the onboarding host on the workspace home, once the tutorial is out of the way. */
export default function LaunchNotice({ userID, tenantId }: { userID: string; tenantId: string }) {
  const [news, setNews] = useState<News | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setNews(null); setOpen(false);
    const silent = quietKey(userID, tenantId);
    if (!storageWorks() || quiet(silent)) return;
    const controller = new AbortController();
    let observer: MutationObserver | null = null;
    void readNews(userID, tenantId, controller.signal).then(found => {
      if (controller.signal.aborted) return;
      if (!found) { keepQuiet(silent); return; }
      setNews(found);
      // It waits its turn: for the home to have drawn, and never over another dialog, a draft's recovery or the tutorial.
      const ready = () => {
        if (!document.querySelector(HOME_READY) || document.querySelector('dialog[open], [role="dialog"], .saas-draft-recovery')) return false;
        setOpen(true);
        return true;
      };
      if (ready()) return;
      observer = new MutationObserver(() => { if (ready()) observer?.disconnect(); });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    });
    return () => { controller.abort(); observer?.disconnect(); };
  }, [userID, tenantId]);
  if (!news || !open) return null;
  const close = () => {
    if (news.model) remember(launchNoticeKey(userID, 'model'));
    // The three plans are the news the key stands for: fewer listed beside the model do not count as it.
    if (news.plans.length >= 3) remember(launchNoticeKey(userID, 'plans'));
    setOpen(false);
  };
  return <LaunchDialog news={news} onClose={close} onPlans={() => { void recordUpgradeInterest(tenantId).catch(() => {}); close(); }} />;
}

function LaunchDialog({ news, onClose, onPlans }: { news: News; onClose: () => void; onPlans: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const titleId = useId();
  // Layout timing, as the app's other native dialogs: closed while still in the document, and the focus handed back.
  useLayoutEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    // The way on takes the focus, not the close button the dialog would pick as its first control.
    primary.current?.focus({ preventScroll: true });
    return () => {
      if (element?.open) element.close();
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);
  const { model, plans } = news;
  const plansTitle = plans.length === 3 ? t('套餐现在有三档', 'Plans now come in three sizes') : t('付费套餐', 'Paid plans');
  const title = model ? t('Claude Fable 5.2 已上线', 'Claude Fable 5.2 is here') : plansTitle;
  return <dialog ref={dialog} className="saas-native-dialog saas-launch" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    // The canvas listens for its shortcuts on the window: keys pressed in here are the dialog's.
    onKeyDown={event => event.stopPropagation()}>
    <button type="button" className="saas-launch-close" onClick={onClose} aria-label={t('关闭', 'Close')}><X size={18} aria-hidden="true" /></button>
    <h2 id={titleId}>{title}</h2>
    {model && <p className="saas-launch-lead">{model.needsPlan
      ? t('Anthropic 的新模型，已经在节点和画布助手的模型列表里。它需要付费套餐，按点数使用。', 'Anthropic’s new model is in the model list for nodes and the canvas assistant. It needs a paid plan and runs on credits.')
      : t('Anthropic 的新模型，已经在节点和画布助手的模型列表里，现在就能选用。', 'Anthropic’s new model is in the model list for nodes and the canvas assistant. You can choose it now.')}</p>}
    {plans.length > 0 && <>
      {model && <h3>{plansTitle}</h3>}
      <ul className="saas-launch-plans">
        {plans.map(plan => <li key={plan.id} className={`saas-launch-plan saas-launch-plan-${plan.id}`}>
          <strong>{planName(plan.id)}</strong>
          <span className="saas-launch-price">${plan.priceUsd}<small>{t(' / 月', ' / month')}</small></span>
          <span className="saas-launch-credits">{t(`每月 ${formatCredits(plan.credits, locale)} 点`, `${formatCredits(plan.credits, locale)} credits a month`)}</span>
        </li>)}
      </ul>
      <p className="saas-launch-terms">{t('包月订阅，每月自动续订，新一期的点数随之到账；可随时取消，取消后用到本期结束。', 'Plans are monthly and renew automatically, each period with its new credits. Cancel anytime; a cancelled plan stays on until its period ends.')}</p>
    </>}
    <div className="saas-launch-actions">
      {plans.length > 0
        ? <a ref={primary} className="saas-primary" href={accountURL('plans')} onClick={onPlans}>{t('查看套餐', 'See plans')}</a>
        : <button ref={primary} type="button" className="saas-primary" onClick={onClose}>{t('知道了', 'Got it')}</button>}
      {plans.length > 0 && <button type="button" onClick={onClose}>{t('以后再说', 'Not now')}</button>}
    </div>
  </dialog>;
}
