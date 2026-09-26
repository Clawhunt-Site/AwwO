import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CircleHelp, ExternalLink } from 'lucide-react';
import { FirstRunTour, type FirstRunAction, type FirstRunScene } from './FirstRunTour';
import { useSaaSPreferences } from './preferences';
import { mainSiteURL } from './mainSite';
import type { Identity } from './api';
import './onboarding-host.css';

const GuideContext = createContext<(() => void) | null>(null);
// Only presentation progress is stored here, separately for every account on this device.
const memorySeen = new Set<string>();
export const onboardingStorageKey = (userID: string, scene: FirstRunScene) => `awwo.onboarding.v1:${encodeURIComponent(userID)}:${scene}`;
function wasSeen(key: string): boolean {
  if (memorySeen.has(key)) return true;
  try { return ['completed', 'dismissed'].includes(localStorage.getItem(key) || ''); }
  catch { return false; }
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
  const selector = action === 'create-canvas' ? '[data-onboarding="canvas-create"] input' : '[data-onboarding="provider-key"]';
  // Wait for modal cleanup/focus restoration before moving to the real control.
  requestAnimationFrame(() => {
    const element = document.querySelector<HTMLInputElement>(selector);
    if (!element || element.disabled) return;
    element.scrollIntoView({ block: 'center', behavior: 'auto' });
    element.focus({ preventScroll: true });
  });
}

export function SaaSOnboarding({ identity, children }: { identity: Identity; children: ReactNode }) {
  const { locale } = useSaaSPreferences();
  const route = onboardingScene(identity, location.search, location.pathname);
  const scene = route?.scene;
  const key = scene ? onboardingStorageKey(identity.user.id, scene) : '';
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    if (!scene || wasSeen(key)) return;
    const selector = scene === 'canvas' ? '[data-onboarding="canvas-stage"]' : scene === 'engines' ? '[data-onboarding="engine-setup"]' : '[data-onboarding="canvas-list"]';
    const ready = () => {
      // A user can launch and dismiss the guide while the page is still loading.
      if (wasSeen(key)) return true;
      if (!document.querySelector(selector) || document.querySelector('dialog[open], [role="dialog"], .saas-draft-recovery')) return false;
      setOpen(true);
      return true;
    };
    if (ready()) return;
    const observer = new MutationObserver(() => { if (ready()) observer.disconnect(); });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, [key, scene]);
  const launch = useMemo(() => scene ? () => setOpen(true) : null, [scene]);
  const close = (completed: boolean) => {
    memorySeen.add(key);
    try { localStorage.setItem(key, completed ? 'completed' : 'dismissed'); } catch { /* The guide remains usable when browser storage is unavailable. */ }
    setOpen(false);
  };
  return <GuideContext.Provider value={launch}>
    {children}
    {scene && <FirstRunTour open={open} scene={scene} readOnly={route?.readOnly} locale={locale} personalEngines={identity.personalCredentialsRequired === true} mainSiteURL={mainSiteURL} onClose={close} onAction={guideAction} />}
  </GuideContext.Provider>;
}

export function GuideLauncher() {
  const launch = useContext(GuideContext);
  const { t } = useSaaSPreferences();
  if (!launch) return null;
  return <button type="button" className="saas-guide-launch" onClick={launch} title={t('使用引导', 'Getting started')} aria-label={t('使用引导', 'Getting started')}><CircleHelp size={16} aria-hidden="true" /><span>{t('使用引导', 'Getting started')}</span></button>;
}

export function MainSiteLink() {
  const { t } = useSaaSPreferences();
  return mainSiteURL ? <a className="saas-main-site" data-onboarding="main-site" href={mainSiteURL} target="_blank" rel="noopener noreferrer" title={t('打开 ClawHunt 主站（新窗口）', 'Open ClawHunt in a new window')}><span>{t('ClawHunt 主站', 'ClawHunt')}</span><ExternalLink size={13} aria-hidden="true" /></a> : null;
}
