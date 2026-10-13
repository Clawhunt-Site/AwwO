// The workspace home's one canvas section (owner 2026-10-13 12:58: 最近的成果留下，去掉继续工作). 最近的成果 shows the
// canvases' results, read from the newest canvases as the canvas list pages them; 「全部画布」 opens that whole list in a
// dialog (search, pages, rename and delete), so a canvas that has delivered nothing yet stays one click away. Until the
// first page is read nothing is shown; a workspace without canvases gets the first-canvas guide instead. Either one
// carries the onboarding anchor the home's tutorial waits for (SaaSOnboarding.tsx) and the tour points at.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { saasErrorMessage, tenantPath, type CanvasRecord, type Tenant } from './api';
import { CanvasList } from './CanvasList';
import { usePagedList } from './ListPager';
import { useSaaSPreferences } from './preferences';
import { ResultsGallery } from './ResultsGallery';

type Props = { tenant: Tenant; userId?: string; onOpen: (canvasId: string) => void };

export function HomeResults(props: Props) {
  // Another person or workspace never inherits this one's list or open dialog.
  return <ScopedHomeResults key={JSON.stringify([props.userId ?? null, props.tenant.id])} {...props} />;
}

function ScopedHomeResults({ tenant, userId, onOpen }: Props) {
  const { locale, t } = useSaaSPreferences();
  const listing = usePagedList<CanvasRecord>(tenantPath(tenant.id, '/canvases'));
  // The last first page read: a reload keeps the results on screen until the new one arrives.
  const [canvases, setCanvases] = useState<ReadonlyArray<CanvasRecord> | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  useEffect(() => { if (listing.page && listing.pageNumber === 1) setCanvases(listing.page.items); }, [listing.page, listing.pageNumber]);
  const refresh = useRef(listing.refresh);
  refresh.current = listing.refresh;
  // A page restored from the back/forward cache reads the canvases again, as the list does.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => { if (event.persisted) refresh.current(); };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  // Stable: the gallery is memoised against the home's per-keystroke renders.
  const reload = useCallback(() => refresh.current(), []);
  const showAll = useCallback(() => setAllOpen(true), []);
  const readOnly = tenant.role === 'reader' || tenant.status !== 'active';
  const failed = Boolean(listing.error) && canvases === null;
  return <>
    {failed && <section className="saas-home-section">
      <p role="alert" className="saas-error">{saasErrorMessage(listing.error, locale)}{' '}
        <button type="button" className="saas-link" onClick={reload}>{t('重新读取', 'Try again')}</button></p>
    </section>}
    {canvases !== null && <div data-onboarding="canvas-list">
      {canvases.length ? <ResultsGallery tenant={tenant} canvases={canvases} userId={userId} onCanvasesDeleted={reload} onShowAll={showAll} />
        : <section className="saas-home-section saas-empty-guide">
          <div className="saas-empty-art" aria-hidden="true"><span /><span /><span /></div>
          <h3>{t('从第一张画布开始', 'Start with your first canvas')}</h3>
          <p>{readOnly ? t('请工作区成员创建画布后，刷新页面查看。', 'Ask a workspace member to create a canvas, then refresh this page.')
            : t('在上方写下目标，AwwO 会新建画布并规划分工；也可以新建空白画布，从左侧添加模型，或从右侧 Bot 清单选择协作者。', 'Describe a goal above and AwwO creates a canvas and plans the work. Or start a blank canvas: add a model from the left, or choose a collaborator from the Bot list on the right.')}</p>
        </section>}
    </div>}
    {allOpen && <AllCanvases tenant={tenant} userId={userId} onOpen={onOpen} onClose={() => { setAllOpen(false); reload(); }} />}
  </>;
}

/** Every canvas of the workspace, in the canvas list's own form, in a dialog over the home. */
function AllCanvases({ tenant, userId, onOpen, onClose }: Props & { onClose: () => void }) {
  const { t } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="saas-native-dialog saas-all-canvases" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="saas-all-canvases-bar">
      <h2 id={titleId}>{t('全部画布', 'All canvases')}</h2>
      <button type="button" className="saas-all-canvases-close" aria-label={t('关闭', 'Close')} onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </div>
    <CanvasList tenant={tenant} userId={userId} onOpen={onOpen} bare />
  </dialog>;
}
