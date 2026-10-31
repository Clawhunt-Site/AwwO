import { createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleHelp, ExternalLink, Workflow } from 'lucide-react';
import { FirstRunTour, type FirstRunAction } from './FirstRunTour';
import { useSaaSPreferences } from './preferences';
import { mainSiteURL } from './mainSite';
import type { Identity } from './api';
import { isLocalEdition } from './edition';
import { LazyBoundary } from './LazyBoundary';
import { page, reloadAfterSaving } from './staleBuild';
import './onboarding-host.css';

const WorkModeTutorial = lazy(() => import('./WorkModeTutorial'));
const GuideContext = createContext<{ tour: (() => void) | null; tutorial: () => void } | null>(null);

/** Only presentation progress is stored here, separately for every account on this device. */
export const tutorialStorageKey = (userID: string) => `awwo.workmode.v1:${encodeURIComponent(userID)}`;
/** Accounts registered from this day on go through the tutorial before anything else. */
export const TUTORIAL_REQUIRED_SINCE = '2026-10-03T00:00:00Z';
/** A newcomer who opens AwwO somewhere new within these days is asked again; after that, never. */
export const TUTORIAL_REQUIRED_DAYS = 14;
/** How far an account has got with the tutorial, in order: `dismissed` (an offered tutorial or a replay closed
 * before its end), `skipped` (the tutorial a new account is asked to see, closed with its × or, when it could not
 * load, for now) and `completed`. */
const STATES = ['dismissed', 'skipped', 'completed'] as const;
type TutorialState = (typeof STATES)[number];
const rank = (state: unknown) => STATES.findIndex(value => value === state);
const memoryState = new Map<string, TutorialState>();
/** The furthest state anywhere — this page or storage another tab wrote — wins. */
function tutorialState(key: string): TutorialState | null {
  let stored: string | null = null;
  try { stored = localStorage.getItem(key); } catch { /* Read as unknown when storage is unavailable. */ }
  return STATES[Math.max(rank(stored), rank(memoryState.get(key)))] ?? null;
}
/** Without storage nothing is remembered past this page, so a tutorial would come back on every one. */
function storageWorks(): boolean {
  try { const probe = 'awwo.workmode.probe'; localStorage.setItem(probe, '1'); localStorage.removeItem(probe); return true; }
  catch { return false; }
}

/** An account counts as new from the creation of the first workspace it owns — the one its
 * registration created, the only per-account date the identity carries. The local edition's one person set it up
 * themselves: the tutorial is offered once there, never required. */
export function tutorialRequired(identity: Identity, now = Date.now()): boolean {
  if (isLocalEdition(identity)) return false;
  const owned = identity.tenants.filter(tenant => tenant.role === 'owner' && typeof tenant.createdAt === 'string')
    .map(tenant => Date.parse(tenant.createdAt!)).filter(Number.isFinite);
  if (!owned.length) return false;
  const registered = Math.min(...owned);
  return registered >= Date.parse(TUTORIAL_REQUIRED_SINCE) && now - registered <= TUTORIAL_REQUIRED_DAYS * 86_400_000;
}

export function onboardingScene(identity: Identity, search: string, pathname: string) {
  const query = new URLSearchParams(search);
  if (pathname !== '/' || query.has('invite') || query.has('reset') || (query.has('account') && query.get('account') !== 'engines')) return null;
  if (query.get('account') === 'engines') return identity.personalCredentialsRequired ? { scene: 'engines' as const, readOnly: false } : null;
  const requested = query.get('tenant');
  const tenant = identity.tenants.find(item => item.id === requested) || (!requested ? identity.tenants.find(item => item.status === 'active') || identity.tenants[0] : undefined);
  if (!tenant || tenant.status !== 'active') return null;
  return { scene: query.get('canvas') ? 'canvas' as const : 'workspace' as const, readOnly: tenant.role === 'reader' };
}

function guideAction(action: FirstRunAction) {
  if (action === 'engines') {
    const query = new URLSearchParams(location.search);
    query.set('account', 'engines');
    location.assign('/?' + query);
    return;
  }
  const selector = action === 'create-canvas' ? '[data-onboarding="canvas-create"] textarea' : '[data-onboarding="provider-key"]';
  // Wait for modal cleanup/focus restoration before moving to the real control.
  requestAnimationFrame(() => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!element || element.disabled) return;
    element.scrollIntoView({ block: 'center', behavior: 'auto' });
    element.focus({ preventScroll: true });
  });
}

/** Opens the work-mode tutorial once per account on this device, when the page is ready and no other
 * dialog is open. For a new account it is mandatory: it comes back until it has been finished or closed
 * with its ×, on every page load where the browser cannot remember that, and if its chunk cannot load
 * the account is asked to reload, or can close it for now. Anyone else carries on without it in both
 * cases. The step-by-step page tour opens only on request. Nothing here creates, runs or submits anything. */
export function SaaSOnboarding({ identity, children }: { identity: Identity; children: ReactNode }) {
  const { locale } = useSaaSPreferences();
  const route = onboardingScene(identity, location.search, location.pathname);
  const scene = route?.scene;
  const key = tutorialStorageKey(identity.user.id);
  const [persistent] = useState(storageWorks);
  // A tutorial that cannot be remembered would come back on every page: only a new account, which is asked
  // to see it, is shown it then; the menu still opens it for anyone.
  const required = tutorialRequired(identity);
  const [tutorial, setTutorial] = useState<{ mandatory: boolean } | null>(null);
  const [tour, setTour] = useState(false);
  // A finished or skipped tutorial counts as seen for every account; a dismissed one, only for an account not asked to see it.
  const seen = () => { const state = tutorialState(key); return state === 'completed' || state === 'skipped' || (!required && state === 'dismissed'); };
  useEffect(() => {
    setTutorial(null);
    if (!scene || seen() || (!persistent && !required)) return;
    const selector = scene === 'canvas' ? '[data-onboarding="canvas-stage"]' : scene === 'engines' ? '[data-onboarding="engine-setup"]' : '[data-onboarding="canvas-list"]';
    const ready = () => {
      // A user can open and finish the tutorial while the page is still loading.
      if (seen()) return true;
      if (!document.querySelector(selector) || document.querySelector('dialog[open], [role="dialog"], .saas-draft-recovery')) return false;
      setTutorial({ mandatory: required });
      return true;
    };
    if (ready()) return;
    const observer = new MutationObserver(() => { if (ready()) observer.disconnect(); });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, [key, scene, required, persistent]);
  const launchers = useMemo(() => ({ tour: scene ? () => setTour(true) : null, tutorial: () => setTutorial({ mandatory: false }) }), [scene]);
  const closeTutorial = (completed: boolean) => {
    // Closing the tutorial a new account is asked to see is a deliberate skip, which keeps it from coming back on
    // this device; closing an offered one or a replay before its end is a dismissal.
    const state: TutorialState = completed ? 'completed' : tutorial?.mandatory ? 'skipped' : 'dismissed';
    // A replay never downgrades: a finished or skipped tutorial does not become a dismissed one.
    if (rank(state) >= rank(tutorialState(key))) {
      memoryState.set(key, state);
      try { localStorage.setItem(key, state); } catch { /* The tutorial remains usable when browser storage is unavailable. */ }
    }
    setTutorial(null);
  };
  return <GuideContext.Provider value={launchers}>
    {children}
    {tutorial && <LazyBoundary fallback={tutorial.mandatory ? <TutorialUnavailable onClose={() => closeTutorial(false)} /> : null}><Suspense fallback={null}><WorkModeTutorial open mandatory={tutorial.mandatory} locale={locale} readOnly={route?.readOnly}
      onClose={closeTutorial} onStart={scene === 'workspace' && !route?.readOnly ? () => guideAction('create-canvas') : undefined} /></Suspense></LazyBoundary>}
    {scene && <FirstRunTour open={tour} scene={scene} readOnly={route?.readOnly} locale={locale} personalEngines={identity.personalCredentialsRequired === true} mainSiteURL={mainSiteURL}
      onClose={() => setTour(false)} onAction={guideAction} />}
  </GuideContext.Provider>;
}

/** A tab opened before a deploy can lose the tutorial's chunk; a new account is asked to reload rather than
 * miss it, or can close it for now, which counts as closing the tutorial with its × (it does not come back on
 * this device). Like the tutorial it is a native modal dialog, so the page behind it is inert; Escape is ignored
 * and a forced close reopens it, so only its buttons end it. The reload saves an open canvas first; should that
 * fail, or an editor hold changes the canvas does not have yet, the dialog says so, and the person can reload
 * anyway (the browser still asks before leaving unsaved canvas changes) or close it for now and see to them.
 * Closed while the save runs, it does not reload when the save ends. */
function TutorialUnavailable({ onClose }: { onClose: () => void }) {
  const { t } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const [kept, setKept] = useState<'failed' | 'editor' | null>(null);
  const [saving, setSaving] = useState(false);
  // Cleared when it closes, so a reload still waiting on the save does not go on.
  const shown = useRef(true);
  useLayoutEffect(() => { const element = dialog.current; shown.current = true; if (element && !element.open) element.showModal(); return () => { shown.current = false; if (element?.open) element.close(); }; }, []);
  const reload = async () => {
    if (kept) { page.reload(); return; }
    setSaving(true);
    const outcome = await reloadAfterSaving(() => shown.current);
    if (!shown.current) return;
    setSaving(false);
    setKept(outcome.kind === 'failed' || outcome.kind === 'editor' ? outcome.kind : null);
  };
  return <dialog ref={dialog} className="saas-tutorial-unavailable" role="alertdialog" aria-labelledby="saas-tutorial-unavailable-text"
    onCancel={event => event.preventDefault()} onClose={() => { const element = dialog.current; if (shown.current && element?.isConnected && !element.open) element.showModal(); }}>
    {/* A part that failed to load stays failed in this page (React.lazy keeps the rejection), so the menu's replay works
      only after a reload. */}
    <p id="saas-tutorial-unavailable-text">{t('新手教程没能加载。刷新页面会重新打开它；也可以先关闭，刷新页面后再从「更多选项 → AwwO 工作模式」重看。', 'The tutorial could not load. Reloading the page opens it again; you can also close it for now and, once the page has been reloaded, replay it from More options → How AwwO works.')}</p>
    {kept && <p role="alert">{kept === 'failed'
      ? t('画布有修改没能保存，现在刷新可能会丢失这些修改。', 'Your canvas has changes that could not be saved; reloading now may lose them.')
      : t('有一个打开的编辑面板里还有没保存的修改，现在刷新会丢失这些修改。', 'An editor you have open holds changes the canvas does not have yet; reloading now loses them.')}</p>}
    <div className="saas-tutorial-unavailable-actions">
      <button type="button" autoFocus disabled={saving} onClick={() => void reload()}>{kept ? t('仍然刷新', 'Reload anyway') : t('刷新页面', 'Reload page')}</button>
      <button type="button" className="saas-tutorial-unavailable-close" onClick={onClose}>{t('先关闭', 'Close for now')}</button>
    </div>
  </dialog>;
}

export function GuideLauncher({ onLaunch }: { onLaunch?: () => void } = {}) {
  const launch = useContext(GuideContext)?.tour;
  const { t } = useSaaSPreferences();
  if (!launch) return null;
  return <button type="button" className="saas-guide-launch" onClick={() => { onLaunch?.(); launch(); }} title={t('使用引导', 'Getting started')} aria-label={t('使用引导', 'Getting started')}><CircleHelp size={16} aria-hidden="true" /><span>{t('使用引导', 'Getting started')}</span></button>;
}

/** Replays the work-mode tutorial; never mandatory from here. */
export function TutorialLauncher({ onLaunch }: { onLaunch?: () => void } = {}) {
  const launch = useContext(GuideContext)?.tutorial;
  const { t } = useSaaSPreferences();
  if (!launch) return null;
  return <button type="button" className="saas-guide-launch" onClick={() => { onLaunch?.(); launch(); }} title={t('AwwO 工作模式', 'How AwwO works')} aria-label={t('AwwO 工作模式', 'How AwwO works')}><Workflow size={16} aria-hidden="true" /><span>{t('AwwO 工作模式', 'How AwwO works')}</span></button>;
}

export function MainSiteLink() {
  const { t } = useSaaSPreferences();
  return mainSiteURL ? <a className="saas-main-site" data-onboarding="main-site" href={mainSiteURL} target="_blank" rel="noopener noreferrer" title={t('打开 ClawHunt 主站（新窗口）', 'Open ClawHunt in a new window')}><span>{t('ClawHunt 主站', 'ClawHunt')}</span><ExternalLink size={13} aria-hidden="true" /></a> : null;
}
