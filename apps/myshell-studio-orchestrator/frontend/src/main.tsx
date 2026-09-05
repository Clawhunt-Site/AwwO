import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './i18n';
import { initNetworkProbe } from './services/network-probe';
import { initTracking, trackEvent } from './services/tracking';
import { classifyEntrySource, recordSessionStart } from './services/session';

// Call tg.ready() BEFORE React mounts — TG WebView needs this signal early
try {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }
} catch {
  // TG WebApp init is best-effort; app still works in browser
}

// Classify entry source from tg.initDataUnsafe.start_param / URL params and
// persist to sessionStorage so trackEvent() can auto-inject it on every event.
try {
  const classified = classifyEntrySource();
  sessionStorage.setItem('entry_source', classified.entrySource);
  if (classified.refCode) {
    sessionStorage.setItem('entry_ref_code', classified.refCode);
  }
} catch { /* non-fatal */ }

initNetworkProbe();
initTracking();

// Emit session_start right after tracking boots so every subsequent event
// (webview_ready, init, etc.) shares the same session_id.
try {
  const entrySource = sessionStorage.getItem('entry_source') || 'direct';
  const refCode = sessionStorage.getItem('entry_ref_code') || '';
  const isNewUser = recordSessionStart();
  trackEvent('miniapp_session_start', {
    entry_source: entrySource,
    ref_code: refCode,
    is_new_user: isNewUser,
  });
} catch { /* ignore */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
