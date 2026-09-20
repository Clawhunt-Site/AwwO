import React from 'react';
import { createRoot } from 'react-dom/client';
// Global stylesheet must load before any component module so that
// module-scoped CSS (e.g. settings/settings.css) wins equal-specificity ties.
import './styles.css';
import { App } from './App';
// The shared workspace markup needs the same layout overrides as the hosted app.
import './canvas/ios-theme.css';
import { ErrorBoundary } from './ErrorBoundary';
import { initUiZoom } from './zoom';
import { recordStartupMark } from './startupTrace';

// ES module imports are evaluated before this body runs, so reaching here means
// the whole app bundle (styles + App + vendor chunks) has downloaded and
// evaluated. The gap from the inline `html-parse` mark to here is the bundle
// download/parse/eval cost on the startup critical path.
recordStartupMark('react-bundle-evaluated');

// Runs before React mounts; a throw here would blank the window before the
// ErrorBoundary can catch anything, so it must never take the app down.
try {
  initUiZoom();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[ClawHunt] initUiZoom failed (non-fatal):', err);
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
recordStartupMark('react-render-called');
