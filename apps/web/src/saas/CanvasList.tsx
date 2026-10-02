import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, Search } from 'lucide-react';
import { CanvasThumbnail, canvasShape, relativeTime } from './CanvasThumbnail';
import { ActionMenu } from './ActionMenu';
import { api, tenantPath, saasErrorMessage, type CanvasRecord, type Tenant } from './api';
import { ListPager, usePagedList } from './ListPager';
import { useSaaSPreferences } from './preferences';
import { CANVAS_SEARCH_MAX_LENGTH, readCanvasListView, saveCanvasListView } from './canvasListView';

const updatedAt = (canvas: CanvasRecord) => Date.parse(canvas.updatedAt) || 0;
/** Most recently touched first; canvases touched at the same time keep the server's order. */
const byRecentUpdate = (items: ReadonlyArray<CanvasRecord>) => [...items].sort((a, b) => updatedAt(b) - updatedAt(a));

/** The workspace's canvases, most recently updated first. With `recentLimit`, only that many are
 * shown until the operator expands the full list in place (its pages, rename and delete). Search
 * matches only the loaded page; paging stays explicit, and clearing a search returns recent mode. */
type CanvasListProps = { tenant: Tenant; onOpen: (canvasId: string) => void; recentLimit?: number; userId?: string };
export function CanvasList(props: CanvasListProps) {
  // A changed identity must never inherit another account's search or in-flight list request.
  return <ScopedCanvasList key={JSON.stringify([props.userId ?? null, props.tenant.id])} {...props} />;
}

function ScopedCanvasList({ tenant, onOpen, recentLimit, userId }: CanvasListProps) {
  const { locale, t } = useSaaSPreferences();
  const path = tenantPath(tenant.id, '/canvases');
  const listing = usePagedList<CanvasRecord>(path);
  const readOnly = tenant.role === 'reader' || tenant.status !== 'active';
  const [editing, setEditing] = useState<{ canvas: CanvasRecord; action: 'rename' | 'delete' } | null>(null);
  const [view, setView] = useState(() => readCanvasListView(userId, tenant.id));
  const { query, expanded } = view;
  const setQuery = (query: string) => {
    const bounded = query.slice(0, CANVAS_SEARCH_MAX_LENGTH);
    setView(value => ({ ...value, query: bounded }));
    // Clearing a search returns a collapsed list to the actual recent page, not a hidden later page.
    if (!bounded.trim() && !expanded && listing.pageNumber > 1) listing.refresh();
  };
  const setExpanded = (expanded: boolean) => setView(value => ({ ...value, expanded }));
  const searchInput = useRef<HTMLInputElement>(null);
  const clearSearch = () => { setQuery(''); searchInput.current?.focus(); };
  useEffect(() => { saveCanvasListView(userId, tenant.id, view); }, [userId, tenant.id, view]);
  const titleId = useId();
  const listId = useId();
  const searchStatusId = useId();
  // A page restored from the back/forward cache shows the list as it was when it was left.
  const refresh = useRef(listing.refresh);
  refresh.current = listing.refresh;
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => { if (event.persisted) refresh.current(); };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);

  const items = listing.page ? byRecentUpdate(listing.page.items) : [];
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle ? items.filter(canvas => canvas.name.toLocaleLowerCase().includes(needle)) : items;
  const limit = recentLimit ?? Infinity;
  const collapsible = recentLimit !== undefined;
  const showingAll = !collapsible || expanded;
  const morePages = listing.pageNumber > 1 || Boolean(listing.next);
  // A search shows every match on the page; otherwise the collapsed view shows the most recent few.
  const visible = needle || showingAll ? matches : matches.slice(0, limit);
  const canExpand = collapsible && (items.length > limit || morePages);
  const count = listing.page && listing.pageNumber === 1 ? (listing.next ? `${items.length}+` : String(items.length)) : '';
  const toggle = () => {
    // The collapsed view shows the newest canvases, which live on the first page.
    if (expanded && listing.pageNumber > 1) listing.refresh();
    setExpanded(!expanded);
  };
  const searchStatus = !listing.page ? '' : !needle ? (morePages ? t('只搜索当前页', 'Search covers this page only') : '')
    : `${matches.length ? t(`找到 ${matches.length} 张画布`, `${matches.length} ${matches.length === 1 ? 'canvas' : 'canvases'} found`)
      : t(`没有名称包含“${query.trim()}”的画布`, `No canvas name contains “${query.trim()}”`)}${morePages ? t('（只搜索当前页）', ' (this page only)') : ''}`;

  const card = (canvas: CanvasRecord) => {
    const shape = canvasShape(canvas.document);
    return <article key={canvas.id} className="saas-canvas-card">
      <button className="saas-canvas-open" onClick={() => onOpen(canvas.id)}><CanvasThumbnail document={canvas.document} /><span className="saas-canvas-card-body"><h3>{canvas.name}</h3><span className="saas-canvas-card-meta"><time dateTime={canvas.updatedAt} title={new Date(canvas.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}>{t('更新于', 'Updated')} {relativeTime(canvas.updatedAt, locale)}</time><span>{shape.boxes.length ? t(`${shape.boxes.length} 个节点`, `${shape.boxes.length} ${shape.boxes.length === 1 ? 'node' : 'nodes'}`) : t('空白画布', 'Blank')}</span></span></span></button>
      {!readOnly && <div className="saas-canvas-actions"><ActionMenu label={t(`画布选项：${canvas.name}`, `Canvas options: ${canvas.name}`)}>{close => <>
        <button onClick={() => { close(); setEditing({ canvas, action: 'rename' }); }}>{t('改名', 'Rename')}</button>
        <button className="saas-danger-action" onClick={() => { close(); setEditing({ canvas, action: 'delete' }); }}>{t('删除', 'Delete')}</button>
      </>}</ActionMenu></div>}
    </article>;
  };

  return <section className="saas-home-section saas-home-recent" aria-labelledby={titleId}>
    <div className="saas-home-section-header">
      <div className="saas-home-section-title">
        <h2 id={titleId}>{t('继续工作', 'Continue working')}</h2>
        {count && <span className="saas-library-count">{t(`${count} 张画布`, `${count} ${count === '1' ? 'canvas' : 'canvases'}`)}</span>}
      </div>
      <div className="saas-library-meta">
        {(items.length > 0 || query) && <label className="saas-list-search"><Search size={14} aria-hidden="true" /><input ref={searchInput} type="search" aria-label={t('按名称搜索画布', 'Search canvases by name')} aria-describedby={searchStatus ? searchStatusId : undefined} placeholder={t('搜索画布', 'Search canvases')} value={query} onChange={event => setQuery(event.target.value)} maxLength={CANVAS_SEARCH_MAX_LENGTH}
          onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); clearSearch(); } }} /></label>}
        {query && <button type="button" className="saas-link" onClick={clearSearch}>{t('清除搜索', 'Clear search')}</button>}
        {(showingAll || needle) && morePages ? <ListPager label={t('画布分页', 'Canvas pages')} page={listing.pageNumber} busy={listing.loading} previous={listing.previous} next={listing.next} refresh={listing.refresh}/> : <button type="button" className="saas-list-refresh" disabled={listing.loading} onClick={listing.refresh}><RefreshCw size={14} aria-hidden="true"/>{t('刷新列表', 'Refresh list')}</button>}
        {canExpand && <button type="button" className="saas-list-toggle" aria-expanded={expanded} aria-controls={listId} onClick={toggle}>
          {expanded ? <><ChevronUp size={14} aria-hidden="true" />{t('收起', 'Show recent only')}</> : <><ChevronDown size={14} aria-hidden="true" />{listing.next || listing.pageNumber > 1 ? t('查看全部画布', 'View all canvases') : t(`查看全部 ${items.length} 张`, `View all ${items.length}`)}</>}
        </button>}
      </div>
    </div>
    {readOnly && <p className="saas-runtime-note" role="status">{t('只读成员：可以浏览画布、会话和导出副本，不能编辑或运行。', 'Reader: browse canvases and conversations or export a copy. Editing and execution require member access.')}</p>}
    {Boolean(listing.error) && <p role="alert" className="saas-error">{saasErrorMessage(listing.error, locale)}</p>}
    <p id={searchStatusId} className="saas-list-search-status" role="status">{searchStatus}</p>
    <div id={listId}>
      {listing.loading ? <div className={`saas-canvas-list is-loading${showingAll ? '' : ' is-recent'}`} role="status" aria-label={t('正在加载画布…', 'Loading canvases…')}>{Array.from({ length: showingAll ? 3 : Math.min(limit, 4) }, (_, index) => <div key={index} className="saas-canvas-card saas-canvas-skeleton" aria-hidden="true"><span /><i /><i /></div>)}</div>
        : listing.page && <div data-onboarding="canvas-list" className={`saas-canvas-list${showingAll || needle ? '' : ' is-recent'}`}>{visible.map(card)}{items.length === 0 && <section className="saas-empty-guide">
          <div className="saas-empty-art" aria-hidden="true"><span /><span /><span /></div>
          <h3>{listing.pageNumber === 1 ? t('从第一张画布开始', 'Start with your first canvas') : t('当前页没有画布', 'No canvases on this page')}</h3>
          <p>{readOnly ? t('请工作区成员创建画布后，刷新列表查看。', 'Ask a workspace member to create a canvas, then refresh this list.') : listing.pageNumber > 1 ? t('返回上一页，或新建一张画布。', 'Go to the previous page or create a canvas.') : t('在上方写下目标，AwwO 会新建画布并规划分工；也可以新建空白画布，从左侧添加模型，或从右侧 Bot 清单选择协作者。', 'Describe a goal above and AwwO creates a canvas and plans the work. Or start a blank canvas: add a model from the left, or choose a collaborator from the Bot list on the right.')}</p>
        </section>}</div>}
    </div>
    {editing && !readOnly && <CanvasAction key={`${tenant.id}:${editing.canvas.id}:${editing.action}`} tenantId={tenant.id} {...editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); listing.refresh(); }}/>}
  </section>;
}

function CanvasAction({ tenantId, canvas, action, onClose, onSaved }: { tenantId: string; canvas: CanvasRecord; action: 'rename' | 'delete'; onClose: () => void; onSaved: () => void }) {
  const { locale, t } = useSaaSPreferences();
  const [name, setName] = useState(canvas.name);
  const [current, setCurrent] = useState<CanvasRecord | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const path = tenantPath(tenantId, `/canvases/${encodeURIComponent(canvas.id)}`);
  useEffect(() => {
    alive.current = true; dialog.current?.showModal();
    return () => { alive.current = false; dialog.current?.close(); };
  }, []);
  useEffect(() => {
    if (action !== 'rename') return;
    const controller = new AbortController(); setCurrent(null);
    api<CanvasRecord>(path, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setCurrent(value); setError(null); } }).catch(cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [path, action, revision]);
  return <dialog ref={dialog} className="saas-native-dialog" aria-labelledby="saas-canvas-action-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form className="saas-card" onSubmit={async event => {
      event.preventDefault(); if (busy || (action === 'rename' && (!current || !name.trim()))) return;
      setBusy(true); setError(null);
      try {
        await api(path, action === 'delete' ? { method: 'DELETE' } : { method: 'PUT', body: JSON.stringify({ name: name.trim(), document: current!.document, version: current!.version }) });
        if (alive.current) onSaved();
      } catch (cause) { if (alive.current) setError(cause); }
      finally { if (alive.current) setBusy(false); }
    }}><h2 id="saas-canvas-action-title">{action === 'rename' ? t('更改画布名称', 'Rename canvas') : t('确认删除画布', 'Delete canvas?')}</h2>
      {action === 'rename' ? <><label>{t('画布名称', 'Canvas name')}<input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={busy}/></label><p>{t('只更改名称，保留最新云端文档；版本冲突时请刷新后重试。', 'Only the name changes; the cloud document is preserved. Refresh and retry if its version changes.')}</p></> : <p>{t(`确认删除“${canvas.name}”及其全部会话和运行历史？此操作无法撤销；正在运行的画布不能删除。`, `Delete “${canvas.name}” and all its conversations and run history? This cannot be undone. A canvas with active runs cannot be deleted.`)}</p>}
      {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
      {action === 'rename' && !current && !error && <p role="status">{t('正在读取最新画布…', 'Loading the latest canvas…')}</p>}
      {action === 'rename' && error !== null && <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{t('刷新云端版本，保留名称', 'Refresh cloud version, keep name')}</button>}
      <div className="saas-draft-actions"><button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button><button className={action === 'delete' ? 'saas-danger-button' : 'saas-primary'} disabled={busy || (action === 'rename' && (!current || !name.trim()))}>{busy ? t('请稍候…', 'Please wait…') : action === 'delete' ? t('确认删除', 'Confirm deletion') : t('保存名称', 'Save name')}</button></div>
    </form>
  </dialog>;
}
