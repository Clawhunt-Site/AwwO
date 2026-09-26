import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { emptyDocument } from '../canvas/canvasDoc';
import { api, tenantPath, saasErrorMessage, type CanvasRecord, type Tenant } from './api';
import { ListPager, usePagedList } from './ListPager';
import { useSaaSPreferences } from './preferences';

export function CanvasList({ tenant, onOpen }: { tenant: Tenant; onOpen: (canvasId: string) => void }) {
  const { locale, t } = useSaaSPreferences();
  const path = tenantPath(tenant.id, '/canvases');
  const listing = usePagedList<CanvasRecord>(path);
  const readOnly = tenant.role === 'reader' || tenant.status !== 'active';
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ canvas: CanvasRecord; action: 'rename' | 'delete' } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <>
    {readOnly && <p className="saas-runtime-note" role="status">{t('只读成员：可以浏览画布、会话和导出副本，不能编辑或运行。', 'Reader: browse canvases and conversations or export a copy. Editing and execution require member access.')}</p>}
    {!readOnly && <form className="saas-create" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError(null);
      try {
        const canvas = await api<CanvasRecord>(path, { method: 'POST', body: JSON.stringify({ name: name.trim() || t('未命名', 'Untitled'), document: emptyDocument() }) });
        if (mounted.current) onOpen(canvas.id);
      } catch (cause) { if (mounted.current) setError(cause); }
      finally { if (mounted.current) setBusy(false); }
    }}><input aria-label={t('新画布名称', 'New canvas name')} placeholder={t('为新画布起个名字', 'Name your new canvas')} value={name} onChange={event => setName(event.target.value)} maxLength={100} disabled={busy}/><button disabled={busy} className="saas-primary"><Plus size={16}/>{busy ? t('正在创建…', 'Creating…') : t('新建画布', 'Create canvas')}</button></form>}
    {(error || listing.error) && <p role="alert" className="saas-error">{saasErrorMessage(error || listing.error, locale)}</p>}
    {(listing.loading || listing.pageNumber > 1 || Boolean(listing.page?.items.length) || listing.error) ? <ListPager label={t('画布分页', 'Canvas pages')} page={listing.pageNumber} busy={listing.loading || busy} previous={listing.previous} next={listing.next} refresh={listing.refresh}/> : <button type="button" onClick={listing.refresh}>{t('刷新列表', 'Refresh list')}</button>}
    {listing.loading ? <p role="status">{t('正在加载画布…', 'Loading canvases…')}</p> : listing.page && <div className="saas-canvas-list">{listing.page.items.map(canvas => <article key={canvas.id} className="saas-canvas-card">
      <button className="saas-canvas-open" onClick={() => onOpen(canvas.id)}><span>↗</span><h2>{canvas.name}</h2><p>{new Date(canvas.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</p></button>
      {!readOnly && <div className="saas-canvas-actions"><button aria-label={t(`改名：${canvas.name}`, `Rename ${canvas.name}`)} onClick={() => setEditing({ canvas, action: 'rename' })}>{t('改名', 'Rename')}</button><button aria-label={t(`删除：${canvas.name}`, `Delete ${canvas.name}`)} onClick={() => setEditing({ canvas, action: 'delete' })}>{t('删除', 'Delete')}</button></div>}
    </article>)}{listing.page.items.length === 0 && <section className="saas-empty-guide">
      <h2>{listing.pageNumber === 1 ? t('从第一张画布开始', 'Start with your first canvas') : t('当前页没有画布', 'No canvases on this page')}</h2>
      <p>{readOnly ? t('请工作区成员创建画布后，刷新列表查看。', 'Ask a workspace member to create a canvas, then refresh this list.') : listing.pageNumber > 1 ? t('返回上一页，或新建一张画布。', 'Go to the previous page or create a canvas.') : t('在上方输入任务名称并新建画布。进入后，先选人设，再从左侧添加模型；右侧 Bot 清单会显示你的协作者。', 'Name your task above and create a canvas. Choose a persona, then add a model from the left. Your collaborators appear in the Bot list on the right.')}</p>
    </section>}</div>}
    {editing && !readOnly && <CanvasAction key={`${tenant.id}:${editing.canvas.id}:${editing.action}`} tenantId={tenant.id} {...editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); listing.refresh(); }}/>}
  </>;
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
