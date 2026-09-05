import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';

import { companyBoardQueryClient } from './companyBoardPrewarm';
import { BoardNavReporter } from './BoardNavReporter';
import { CapabilityStoreProvider } from '@/host/capability-store';
import { initPluginBridge } from '@/plugins/bridge-init';
import { App } from '@/App';
import { CompanyProvider, useCompany } from '@/context/CompanyContext';
import { BoardChromeProvider } from '@/context/BoardChromeContext';
import { LiveUpdatesProvider } from '@/context/LiveUpdatesProvider';
import { BreadcrumbProvider } from '@/context/BreadcrumbContext';
import { PanelProvider } from '@/context/PanelContext';
import { SidebarProvider } from '@/context/SidebarContext';
import { DialogProvider } from '@/context/DialogContext';
import { EditorAutocompleteProvider } from '@/context/EditorAutocompleteContext';
import { ToastProvider } from '@/context/ToastContext';
import { ThemeProvider, useTheme } from '@/context/ThemeContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PluginLauncherProvider } from '@/plugins/launchers';
// Board i18n: the board ships its own i18next instance + component-level {en,zh}
// translations (server/ui/src/i18n/localized.ts). super owns the language preference
// (its `Locale` = 'en'|'zh'); we drive the board's i18next language off super's locale
// so the localized components render zh. We intentionally do NOT install the runtime
// DOM text-bridge overlay: it translates by exact phrase-table match over text nodes,
// which can mistranslate user content (e.g. a task literally named "Settings") — the
// precise, fail-safe path is the component-level i18n. Uncovered long-tail strings
// stay English until their components are localized upstream.
import { i18n as boardI18n } from '@/i18n';
import { syncBoardLocale, type SuperClawLocale } from './boardLocale';
// The board's MDX editor chrome. The package lives in server/ui/node_modules (pnpm),
// so a bare specifier can't resolve from apps/web's tree; apps/web/vite.config.mjs
// aliases this exact specifier to the resolved file in the board's install. This
// mirrors server/ui/src/main.tsx so the embedded editor gets full toolbar styling.
import '@mdxeditor/editor/style.css';
// The board's own Tailwind styles.
import '@/index.css';

// CompanyBoard — the real Paperclip board UI (server/ui) mounted natively inside
// apps/web's company surface and compiled into apps/web's build (no iframe). It
// mirrors server/ui/src/main.tsx's provider stack, with one deliberate change for
// embedding: MemoryRouter (not BrowserRouter) so the board navigates in its own
// in-memory history and never touches super's URL bar. The service worker is the
// only main.tsx side effect dropped (an app-global registration that must not leak
// out of an embedded surface); the plugin bridge IS initialized so embedded plugin
// UIs keep working — it only sets the namespaced globalThis.__paperclipPluginBridge__.
//
// Data: the board reads __PAPERCLIP_API_BASE__ (vite `define`) so every /api/WS/SSE
// call targets the Paperclip control plane via the same-origin /paperclip-api proxy.
// The board's own Tailwind v4 styles (@/index.css) are compiled in via @tailwindcss/vite.

// Match main.tsx: expose the host React/ReactDOM to dynamically-loaded plugin UIs.
initPluginBridge(React, ReactDOM);

// The board's query cache is the module-level companyBoardQueryClient (see
// companyBoardPrewarm.ts). It's shared with the startup prewarm and persists across
// mounts/unmounts of this surface, so the data warmed at startup is already in cache
// when the Team tab first opens — no cold fetch, no spinner. Embedded-surface retry/
// refetch tuning lives with the client there (one quick retry; several board endpoints
// legitimately 404 in local_trusted mode, and focus flips constantly between super's
// shell and the embedded board, so focus-refetch is off).

function CompanyAwareBreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const { selectedCompany } = useCompany();
  return <BreadcrumbProvider companyName={selectedCompany?.name ?? null}>{children}</BreadcrumbProvider>;
}

// super's resolved theme (its `AppTheme` = 'light' | 'dark', the single source). The
// board ships its OWN ThemeProvider (server/ui) that keys off `<html>.dark` + its own
// localStorage and never observes super's `:root[data-theme]`, so without a bridge the
// embedded board ignores super's light/dark choice.
export type SuperClawTheme = 'light' | 'dark';

// Drives the embedded board's ThemeProvider from super's resolved theme. Rendered
// INSIDE the board's <ThemeProvider> so it can push super's value through the provider's
// public setTheme — we never fork/modify the vendored provider, mirroring how
// syncBoardLocale drives the board's i18next. useLayoutEffect so the board paints in the
// right theme (the provider then owns `<html>.dark`/color-scheme as usual). Calling the
// board's setTheme marks an explicit choice, which also (intentionally) disables the
// board's own OS-follow — fine, because super owns OS-following and pushes the resolved
// theme here. One-way super -> board: super is the single theme source for the embedded
// surface; the board's own account-menu ThemeToggle is suppressed in the embed (see the
// `[aria-label="Switch to … mode"]` display:none rule in styles.css) so it can't diverge.
function BoardThemeBridge({ theme }: { theme: SuperClawTheme }) {
  const { setTheme } = useTheme();
  React.useLayoutEffect(() => {
    setTheme(theme);
  }, [theme, setTheme]);
  return null;
}

export function CompanyBoard({
  locale = 'en',
  theme = 'light',
  onOpenCapabilityStore,
}: {
  locale?: SuperClawLocale;
  theme?: SuperClawTheme;
  /** Host opener for its capability store (the Capability Workshop). The embedded
      board's plugin page delegates "get plugins" to this instead of its own
      standalone npm-install dialog; omitted → the board keeps its own flow. */
  onOpenCapabilityStore?: () => void;
}) {
  // Drive the board's i18next language from super's locale (en -> en, zh -> zh-CN)
  // so the component-level {en,zh} translations render. useLayoutEffect runs before
  // paint (resources are bundled, so changeLanguage is synchronous) — no English flash.
  React.useLayoutEffect(() => {
    syncBoardLocale(boardI18n, locale);
  }, [locale]);

  // Provide super's capability-store opener to the board via context (NOT an effect-
  // registered global) so the embedded board's plugin page reads host mode on its first
  // render — no standalone flash / wrong-endpoint fetch on a deep link, and naturally
  // scoped per board instance. Omitted opener → standalone behavior unchanged.
  return (
    <CapabilityStoreProvider opener={onOpenCapabilityStore ?? null}>
      <div className="company-board-root">
        <QueryClientProvider client={companyBoardQueryClient}>
          <ThemeProvider>
            <BoardThemeBridge theme={theme} />
            {/* Land on the company directory (/companies), not auto-dropped into one
                company's Dashboard — super's directory is the Team-tab entry surface. */}
            <MemoryRouter initialEntries={['/companies']}>
              <CompanyProvider>
                <BoardNavReporter />
                <EditorAutocompleteProvider>
                  <ToastProvider>
                    <LiveUpdatesProvider>
                      <TooltipProvider>
                        <CompanyAwareBreadcrumbProvider>
                          <SidebarProvider>
                            <PanelProvider>
                              <PluginLauncherProvider>
                                <DialogProvider>
                                  {/* Embedded chrome: super owns the surrounding
                                      shell (back button, account/theme), so the
                                      board's in-company primary nav renders as a
                                      horizontal top-nav instead of its left
                                      sidebar. Presentation only — same routes.
                                      We drive this via BoardChromeContext (NOT
                                      embeddedHost) so the board's embed-gated
                                      create/onboarding behaviors stay unchanged;
                                      App is left in its default (non-embedded)
                                      mode so the onboarding wizard still mounts. */}
                                  <BoardChromeProvider chrome="top-nav">
                                    <App />
                                  </BoardChromeProvider>
                                </DialogProvider>
                              </PluginLauncherProvider>
                            </PanelProvider>
                          </SidebarProvider>
                        </CompanyAwareBreadcrumbProvider>
                      </TooltipProvider>
                    </LiveUpdatesProvider>
                  </ToastProvider>
                </EditorAutocompleteProvider>
              </CompanyProvider>
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>
      </div>
    </CapabilityStoreProvider>
  );
}

export default CompanyBoard;
