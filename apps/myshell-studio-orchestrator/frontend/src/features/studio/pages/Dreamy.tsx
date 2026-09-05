import { Suspense, lazy, useState } from 'react';
import { Clapperboard, Loader2, PanelsTopLeft } from 'lucide-react';

const CanvasPro = lazy(() => import('./CanvasPro'));
const CreativeCanvasSurface = lazy(() => import('../../../../../../creative-canvas/src/embed'));

type StudioWorkspace = 'canvaspro' | 'creative-director';

function readInitialWorkspace(): StudioWorkspace {
  if (typeof window === 'undefined') return 'canvaspro';
  return new URLSearchParams(window.location.search).get('workspace') === 'creative-director'
    ? 'creative-director'
    : 'canvaspro';
}

function replaceWorkspaceQuery(workspace: StudioWorkspace): void {
  const url = new URL(window.location.href);
  url.searchParams.set('workspace', workspace);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export default function Dreamy() {
  const [workspace, setWorkspace] = useState<StudioWorkspace>(readInitialWorkspace);
  const [creativeDirectorOpened, setCreativeDirectorOpened] = useState(workspace === 'creative-director');

  const selectWorkspace = (next: StudioWorkspace) => {
    if (next === 'creative-director') setCreativeDirectorOpened(true);
    setWorkspace(next);
    replaceWorkspaceQuery(next);
  };

  return (
    <div className="dreamy-studio-root" data-testid="dreamy-studio-root">
      <header
        data-testid="studio-workspace-switcher"
        className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 px-4"
      >
        <div className="min-w-0">
          <strong className="block truncate text-sm font-bold text-Cr-text-default-v2">MyShell Studio</strong>
          <span className="block truncate text-[11px] font-semibold text-Cr-text-disabled-v2">
            CanvasPro 主工作台 · SuperClaw 创意导演补充
          </span>
        </div>
        <div className="flex shrink-0 items-center rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 p-1">
          <button
            data-testid="canvaspro-workspace-switch"
            type="button"
            aria-pressed={workspace === 'canvaspro'}
            onClick={() => selectWorkspace('canvaspro')}
            className={`inline-flex h-8 items-center gap-2 rounded-full-v2 px-3 text-xs font-bold transition-colors ${
              workspace === 'canvaspro'
                ? 'bg-Cr-Bg-surface-default-v2 text-Cr-text-default-v2 shadow-sm'
                : 'text-Cr-text-subtler-v2 active:bg-Cr-beta-white-8-v2'
            }`}
          >
            <PanelsTopLeft size={14} />
            CanvasPro
          </button>
          <button
            data-testid="creative-director-workspace-switch"
            type="button"
            aria-pressed={workspace === 'creative-director'}
            onClick={() => selectWorkspace('creative-director')}
            className={`inline-flex h-8 items-center gap-2 rounded-full-v2 px-3 text-xs font-bold transition-colors ${
              workspace === 'creative-director'
                ? 'bg-Cr-Bg-surface-default-v2 text-Cr-text-default-v2 shadow-sm'
                : 'text-Cr-text-subtler-v2 active:bg-Cr-beta-white-8-v2'
            }`}
          >
            <Clapperboard size={14} />
            创意导演
          </button>
        </div>
      </header>
      <section
        data-testid="canvaspro-workspace-panel"
        aria-hidden={workspace !== 'canvaspro'}
        className={`relative z-0 min-h-0 flex-1 overflow-hidden bg-Cr-Bg-soft-v2 ${
          workspace === 'canvaspro' ? '' : 'hidden'
        }`}
      >
        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center bg-Cr-Bg-soft-v2 text-sm font-semibold text-Cr-text-subtler-v2">
              <Loader2 size={16} className="mr-2 animate-spin" />
              Loading CanvasPro
            </div>
          }
        >
          <CanvasPro embeddedInStudio />
        </Suspense>
      </section>
      {creativeDirectorOpened ? (
        <section
          data-testid="creative-director-workspace-panel"
          aria-hidden={workspace !== 'creative-director'}
          className={`relative z-0 min-h-0 flex-1 overflow-hidden bg-Cr-Bg-soft-v2 ${
            workspace === 'creative-director' ? '' : 'hidden'
          }`}
        >
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center bg-Cr-Bg-soft-v2 text-sm font-semibold text-Cr-text-subtler-v2">
                <Loader2 size={16} className="mr-2 animate-spin" />
                Loading Creative Director
              </div>
            }
          >
            <CreativeCanvasSurface locale="zh" theme="dark" />
          </Suspense>
        </section>
      ) : null}
    </div>
  );
}
