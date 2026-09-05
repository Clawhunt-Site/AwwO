import React, { useEffect, useState } from 'react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sparkles, X } from 'lucide-react';
import { useRtl } from './i18n/useRtl';
import { EnergyProvider } from './contexts/EnergyContext';
import { ToastProvider } from './contexts/ToastContext';
import { InviteProvider } from './contexts/InviteContext';
import { CheckinProvider, useCheckin } from './contexts/CheckinContext';
import InviteCodeModal from './components/InviteCodeModal';
import AgeGateModal from './components/AgeGateModal';
import RouteObserver from './components/RouteObserver';
import CheckinModal from './components/Checkin/CheckinModal';
import { reportInviteOpened, reportPickOpened, reportShareOpened } from './services/api';
import {
  STUDIO_SESSION_CHANGED_EVENT,
  clearStudioDispatchSession,
  getStudioReturnPath,
  readStudioDispatchSessionFromUrl,
  readStudioDispatchSession,
  stripStudioDispatchNavigationParams,
} from './features/studio/session';
import { resolveInitialEntry } from './services/initialEntry';
import { trackEvent } from './services/tracking';

const Explore = React.lazy(() => import('./pages/Characters'));
const AiPicks = React.lazy(() => import('./pages/AiPicks'));
const BotDetail = React.lazy(() => import('./pages/BotDetail'));
const Library = React.lazy(() => import('./pages/Library'));
const ViewImage = React.lazy(() => import('./pages/ViewImage'));
const GetEnergy = React.lazy(() => import('./pages/GetEnergy'));
const Settings = React.lazy(() => import('./pages/Settings'));
const EnergyHistory = React.lazy(() => import('./pages/EnergyHistory'));
const Upload = React.lazy(() => import('./pages/Upload'));
const TagGenerator = React.lazy(() => import('./pages/TagGenerator').then((module) => ({ default: module.TagGenerator })));
const Earn = React.lazy(() => import('./pages/Earn'));
const ShareInvite = React.lazy(() => import('./pages/ShareInvite'));
const TestCustomizeScene = React.lazy(() => import('./pages/TestCustomizeScene'));
const CheckinDemo = React.lazy(() => import('./pages/CheckinDemo'));
const Dreamy = React.lazy(() => import('./features/studio/pages/Dreamy'));

let communityPushCtaOpenedReported = false;

const COMMUNITY_PUSH_ATTRIBUTION_KEYS = new Set([
  'start',
  'source',
  'community_push_task_id',
  'channel_post_message_id',
  'campaign_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'recipient_trace_id',
  'push_trace_id',
  'trace_id',
  'user_trace_id',
  'delivery_id',
  'recipient_id',
]);

function readStartParam(params: URLSearchParams): { value: string; source: string } {
  const tgStartParam = (
    window.Telegram?.WebApp?.initDataUnsafe as { start_param?: string } | undefined
  )?.start_param;
  if (tgStartParam) return { value: tgStartParam, source: 'telegram_init_data' };

  const startapp = params.get('startapp');
  if (startapp) return { value: startapp, source: 'url_startapp' };

  const tgWebAppStartParam = params.get('tgWebAppStartParam');
  if (tgWebAppStartParam) return { value: tgWebAppStartParam, source: 'url_tgWebAppStartParam' };

  return { value: '', source: 'none' };
}

function isCommunityPushAttributionParam(key: string): boolean {
  return (
    COMMUNITY_PUSH_ATTRIBUTION_KEYS.has(key) ||
    key.startsWith('community_push_') ||
    key.startsWith('channel_post_') ||
    key.startsWith('recipient_') ||
    key.startsWith('trace_') ||
    key.startsWith('push_') ||
    key.startsWith('utm_')
  );
}

function collectCommunityPushAttributionParams(
  params: URLSearchParams,
): Record<string, string> {
  const attributionParams: Record<string, string> = {};
  params.forEach((value, key) => {
    if (value && isCommunityPushAttributionParam(key)) {
      attributionParams[key] = value;
    }
  });
  return attributionParams;
}

// Parse deep-link params before MemoryRouter takes over.
// Supports: slug_id (from URL query) and startapp (from Telegram start_param).
function getInitialEntry(): string {
  return resolveInitialEntry({
    pathname: window.location.pathname,
    search: window.location.search,
    telegramStartParam: (
      window.Telegram?.WebApp?.initDataUnsafe as { start_param?: string } | undefined
    )?.start_param,
  });
}

// Error boundary to catch rendering crashes (prevents blank screen)
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, color: '#fff', background: '#0E0E0F', minHeight: '100vh' }}>
          <h2>Something went wrong</h2>{/* ErrorBoundary: no hooks available in class component */}
          <pre style={{ fontSize: 12, color: '#f88', whiteSpace: 'pre-wrap' }}>
            {this.state.error?.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Connects the global CheckinModal to CheckinContext state. */
function GlobalCheckinModal() {
  const { isModalOpen, closeModal, modalSource } = useCheckin();
  return <CheckinModal open={isModalOpen} onClose={closeModal} source={modalSource} />;
}

function StudioReturnDock() {
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState(() => readStudioDispatchSession() || readStudioDispatchSessionFromUrl(window.location));

  useEffect(() => {
    const refresh = () => setSession(readStudioDispatchSession() || readStudioDispatchSessionFromUrl(window.location));
    window.addEventListener(STUDIO_SESSION_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    refresh();
    return () => {
      window.removeEventListener(STUDIO_SESSION_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [location.pathname]);

  if (!session || location.pathname === '/dreamy') return null;

  const targetPath = getStudioReturnPath(session);
  const dismissSession = () => {
    clearStudioDispatchSession();
    setSession(null);
    const cleanedPath = stripStudioDispatchNavigationParams({
      pathname: location.pathname,
      search: location.search,
      hash: window.location.hash,
    });
    const cleanedBrowserPath = stripStudioDispatchNavigationParams(window.location);
    try {
      window.history.replaceState(window.history.state, '', cleanedBrowserPath);
    } catch {
      // MemoryRouter can still hide the dock even if the outer URL cannot be rewritten.
    }
    if (cleanedPath !== `${location.pathname}${location.search}${window.location.hash}`) {
      navigate(cleanedPath, { replace: true });
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-[120] flex max-w-[calc(100vw-32px)] items-center gap-1 rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 p-1 shadow-[0_10px_28px_rgba(0,0,0,0.32)]">
      <button
        type="button"
        onClick={() => {
          trackEvent('studio_return_click', {
            page_id: session.pageId || '',
            navigation_path: session.navigationPath || '',
          });
          navigate(targetPath);
        }}
        className="inline-flex h-10 items-center gap-2 rounded-full-v2 px-3 text-sm font-semibold text-Cr-text-default-v2 active:bg-Cr-beta-white-8-v2"
        aria-label="Return to Studio"
      >
        <Sparkles size={16} className="text-dreamy-brand-hot-v2" />
        Studio
      </button>
      <button
        type="button"
        onClick={dismissSession}
        className="flex h-8 w-8 items-center justify-center rounded-full-v2 text-Cr-text-subtler-v2 active:bg-Cr-beta-white-8-v2"
        aria-label="Dismiss Studio return"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function RouteFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-Cr-Bg-default-v2 text-sm font-semibold text-Cr-text-subtler-v2">
      Loading
    </div>
  );
}

function AppRoutes() {
  return (
    <div className="h-full w-full">
      <React.Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Dreamy />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="/ai-picks" element={<AiPicks />} />
          <Route path="/bot" element={<BotDetail />} />
          <Route path="/profile" element={<Settings />} />
          <Route path="/library" element={<Library />} />
          <Route path="/library/:id" element={<ViewImage />} />
          <Route path="/energy" element={<GetEnergy />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/energy-history" element={<EnergyHistory />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/tag-generator" element={<TagGenerator />} />
          <Route path="/earn" element={<Earn />} />
          <Route path="/share-invite" element={<ShareInvite />} />
          <Route path="/dreamy" element={<Dreamy />} />
          <Route path="/__test-customize-scene" element={<TestCustomizeScene />} />
          <Route path="/checkin-demo" element={<CheckinDemo />} />
        </Routes>
      </React.Suspense>
      <StudioReturnDock />
    </div>
  );
}

export default function App() {
  useRtl();

  // ── Funnel Step 3: miniapp_webview_ready ──
  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        try {
          trackEvent('miniapp_webview_ready', {
            ts: Date.now(),
            first_route: (window.location.search || '') + (window.location.hash || ''),
            has_tg_init: !!(window.Telegram?.WebApp?.initData),
          });
        } catch { /* swallow */ }
      });
    });
    return () => { cancelled = true; };
  }, []);

  // ── Funnel Step 4: miniapp_firstview_engage ──
  useEffect(() => {
    let fired = false;
    const fire = (signal: string) => {
      if (fired) return;
      fired = true;
      try { trackEvent('miniapp_firstview_engage', { signal }); } catch {}
      cleanup();
    };

    const onScroll = () => fire('scroll');
    const onTouchMove = () => fire('touchmove');
    const onClick = () => fire('click');
    const onKey = () => fire('keydown');
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fire('visible');
    };
    const timer = window.setTimeout(() => fire('dwell_3s'), 3000);

    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('click', onClick, { capture: true });
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);

    function cleanup() {
      window.clearTimeout(timer);
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('click', onClick, { capture: true } as EventListenerOptions);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
    }
    return cleanup;
  }, []);

  // Fire traceable community-push CTA-open telemetry when the TG WebApp button
  // URL carries start=push / source=community_push attribution params.
  useEffect(() => {
    if (communityPushCtaOpenedReported) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const source = params.get('source') || '';
      const startMarker = params.get('start') || '';
      const isCommunityPushOpen =
        source === 'community_push' ||
        startMarker === 'push' ||
        params.has('community_push_task_id') ||
        params.has('channel_post_message_id');

      if (!isCommunityPushOpen) return;
      communityPushCtaOpenedReported = true;

      const startParam = readStartParam(params);
      trackEvent('miniapp_community_push_cta_opened', {
        opened_from: 'tg_web_app_cta',
        attribution_source: source || (startMarker === 'push' ? 'push' : 'community_push'),
        start_marker: startMarker,
        target_slug_id: startParam.value,
        start_param: startParam.value,
        start_param_source: startParam.source,
        community_push_task_id: params.get('community_push_task_id') || '',
        channel_post_message_id: params.get('channel_post_message_id') || '',
        campaign_id: params.get('campaign_id') || '',
        recipient_trace_id: params.get('recipient_trace_id') || '',
        push_trace_id: params.get('push_trace_id') || '',
        trace_id: params.get('trace_id') || '',
        delivery_id: params.get('delivery_id') || '',
        has_tg_init: !!(window.Telegram?.WebApp?.initData),
        attribution_params: collectCommunityPushAttributionParams(params),
      });
    } catch { /* ignore */ }
  }, []);

  // Fire invite-push telemetry when the Mini App is launched from the
  // next-day push notification (CTA URL carries ?src=invite_push).
  useEffect(() => {
    try {
      const src = new URLSearchParams(window.location.search).get('src');
      if (src === 'invite_push') void reportInviteOpened();
    } catch { /* ignore */ }
  }, []);

  // Fire ai-pick-push telemetry when the Mini App is launched from the AI
  // Pick daily push card.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('source') === 'ai_pick') {
        const rawTaskId = params.get('task_id');
        const taskId = rawTaskId ? Number(rawTaskId) : 0;
        void reportPickOpened(Number.isFinite(taskId) ? taskId : 0);
      }
    } catch { /* ignore */ }
  }, []);

  // Fire share-opened telemetry when the Mini App is launched from a share link.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const startParam = (
        window.Telegram?.WebApp?.initDataUnsafe as { start_param?: string } | undefined
      )?.start_param
        ?? params.get('startapp')
        ?? params.get('tgWebAppStartParam');
      if (startParam?.startsWith('share_')) {
        const parts = startParam.split('_');
        // Format: share_<taskId>_<inviterUserId>
        if (parts.length >= 3) {
          const taskId = parts[1];
          const inviterUserId = parts.slice(2).join('_');
          void reportShareOpened(taskId, inviterUserId);
        }
      }
    } catch { /* ignore */ }
  }, []);

  return (
    <ErrorBoundary>
      <div className="h-full w-full relative">
        <EnergyProvider>
          <ToastProvider>
            <CheckinProvider>
              <InviteProvider>
                <MemoryRouter initialEntries={[getInitialEntry()]}>
                  <RouteObserver />
                  <AppRoutes />
                  <InviteCodeModal />
                  <AgeGateModal />
                  <GlobalCheckinModal />
                </MemoryRouter>
              </InviteProvider>
            </CheckinProvider>
          </ToastProvider>
        </EnergyProvider>
      </div>
    </ErrorBoundary>
  );
}
