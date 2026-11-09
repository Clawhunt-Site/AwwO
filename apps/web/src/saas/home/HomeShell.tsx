// The signed-in workspace home's frame, under the page's top bar: a left rail of the home's sections with the account
// card at its foot, and the chosen section beside it, under the trial banner (owner 2026-11-07: the cases, the recent
// canvases and the canvases were one long page with nothing sorted; the bottom left is to put the account and its plan
// first). The frame reads route-usage once, through the card's meter, for the card and the banner; WorkspaceHome, the
// section itself, reads nothing more than it did (a reader's home makes one request).
import { useLayoutEffect, useRef, useState } from 'react';
import type { Identity, Tenant } from '../api';
import type { RouteUsage } from '../routeUsage';
import { WorkspaceHome } from '../WorkspaceHome';
import { HomeAccountCard } from './HomeAccountCard';
import { HomeNav } from './HomeNav';
import { MEMBER_SECTIONS, READER_SECTIONS } from './homeSections';
import { TrialBanner } from './TrialBanner';
import { useHomeSection } from './useHomeSection';
import './home.css';

/** The page back at its top (jsdom draws no page to scroll). */
function toTop() {
  try { window.scrollTo({ top: 0, left: 0 }); } catch { document.documentElement.scrollTop = 0; }
}

/** The focus on the shown section's heading, so a keyboard or a screen reader starts there. */
function focusHeading(panel: HTMLElement | null) {
  const heading = panel?.querySelector<HTMLElement>('h1, h2');
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

export function HomeShell({ identity, tenant, onOpen }: { identity: Identity; tenant: Tenant; onOpen: (canvasId: string) => void }) {
  const member = tenant.role !== 'reader';
  const { section, go, moves } = useHomeSection(member ? MEMBER_SECTIONS : READER_SECTIONS);
  const [usage, setUsage] = useState<RouteUsage | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  // A move, never the first drawing: the page opens where the browser put it, with no focus taken.
  useLayoutEffect(() => {
    if (!moves) return;
    toTop();
    focusHeading(panel.current);
  }, [moves]);
  // The rail keeps a place at its foot for the feedback assistant's button (FeedbackAssistant.tsx, feedbackPlacement.ts):
  // the bottom-left corner the button takes on every page, under the account card rather than over it.
  return <div className="saas-home-layout">
    <div className="saas-home-rail" data-feedback-avoid="beside">
      <HomeNav sections={member ? MEMBER_SECTIONS : READER_SECTIONS} section={section} onSection={go} />
      <HomeAccountCard identity={identity} tenant={tenant} usage={usage} onUsage={setUsage} />
      <div className="saas-home-feedback-slot" data-feedback-slot aria-hidden="true" />
    </div>
    <div className="saas-home-content">
      <TrialBanner usage={usage} userId={identity.user.id} tenantId={tenant.id} owner={tenant.role === 'owner'} onDismiss={() => focusHeading(panel.current)} />
      <div ref={panel} className="saas-home-panel" data-section={section}>
        <WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} section={section} onSection={go} />
      </div>
    </div>
  </div>;
}
