// The memory workbench: the short notes a workspace keeps (memory.go). When a run is admitted, the active notes
// that bear on a node's task (pinned ones first) are frozen into it and quoted to the model as background data,
// never as instructions; proposed notes wait here until someone confirms them. Nothing is captured silently.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Brain, Check, Pencil, Pin, PinOff, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';
import {
  createMemory, deleteMemory, MEMORY_BODY_BYTES, MEMORY_KINDS, MEMORY_TITLE_CHARS, readMemory, updateMemory,
  type MemoryKind, type MemoryNote, type MemoryStatus,
} from './memoryApi';
import './canvas-library.css';

type Translate = (zh: string, en: string) => string;
type Scope = 'all' | 'canvas' | 'workspace';
interface Draft { id?: string; version?: number; title: string; body: string; kind: MemoryKind; scope: 'canvas' | 'workspace'; pinned: boolean }
interface Props { tenantId: string; canvasId: string; readOnly?: boolean; onClose: () => void }

const emptyDraft = (): Draft => ({ title: '', body: '', kind: 'preference', scope: 'canvas', pinned: false });
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const memoryKindName = (kind: MemoryKind, t: Translate) => ({
  preference: t('偏好', 'Preference'), fact: t('事实', 'Fact'), decision: t('决策', 'Decision'), lesson: t('经验', 'Lesson'), style: t('风格', 'Style'),
})[kind];

export function MemoryWorkbench({ tenantId, canvasId, readOnly = false, onClose }: Props) {
  const { t, locale } = useSaaSPreferences();
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [archived, setArchived] = useState(false);
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const items = await readMemory(tenantId, { canvasId, status: archived ? 'archived' : 'active,proposed', ...(search ? { q: search } : {}) });
      if (alive.current && mine === generation.current) { setNotes(items); setError(null); }
    } catch (cause) { if (alive.current && mine === generation.current) setError(cause); }
    finally { if (alive.current && mine === generation.current) setLoading(false); }
  }, [tenantId, canvasId, archived, search]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => notes.filter(note => scope === 'all' || note.scope === scope), [notes, scope]);
  const act = async (change: () => Promise<void>, done: string) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice('');
    try {
      await change();
      if (!alive.current) return;
      setNotice(done); await load();
    } catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  };
  const save = (value: Draft) => void act(async () => {
    const fields = { title: value.title.trim(), body: value.body.trim(), kind: value.kind, pinned: value.pinned };
    if (value.id && value.version) await updateMemory(tenantId, value.id, { version: value.version, ...fields });
    else await createMemory(tenantId, { ...(value.scope === 'canvas' ? { canvasId } : {}), ...fields });
    if (alive.current) setDraft(null);
  }, value.id ? t('记忆已更新。', 'Note updated.') : t('记忆已保存。之后的运行会在与任务相关时引用它。', 'Note saved. Later runs quote it when it bears on the task.'));
  // A note open in the editor takes the version (and pin) a list action gave it, so its save is not a conflict.
  const patch = (note: MemoryNote, change: { pinned?: boolean; status?: MemoryStatus }, done: string) => void act(async () => {
    const value = await updateMemory(tenantId, note.id, { version: note.version, ...change });
    if (alive.current) setDraft(current => current?.id === value.id ? { ...current, version: value.version, ...(change.pinned !== undefined ? { pinned: value.pinned } : {}) } : current);
  }, done);
  const remove = (note: MemoryNote) => void act(async () => {
    await deleteMemory(tenantId, note.id);
    if (alive.current) { setDeleting(null); if (draft?.id === note.id) setDraft(null); }
  }, t('记忆已删除。已经开始的运行仍保留当时冻结的副本。', 'Note deleted. Runs already admitted keep the copy they froze.'));
  const edit = (note: MemoryNote) => {
    setDraft({ id: note.id, version: note.version, title: note.title, body: note.body, kind: note.kind, scope: note.scope, pinned: note.pinned });
    setError(null); setNotice('');
  };
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : value;
  const titleChars = draft ? [...draft.title.trim()].length : 0;
  const bodyBytes = draft ? bytes(draft.body.trim()) : 0;
  const draftReady = !!draft && titleChars > 0 && titleChars <= MEMORY_TITLE_CHARS && bodyBytes <= MEMORY_BODY_BYTES;
  const scopes: [Scope, string][] = [['all', t('全部', 'All')], ['canvas', t('本画布', 'This canvas')], ['workspace', t('整个工作区', 'Whole workspace')]];

  return <section className="awwo-library" aria-label={t('记忆', 'Memory')}>
    <header className="awwo-library-header">
      <div className="awwo-library-heading"><span className="awwo-library-mark"><Brain size={20} aria-hidden="true" /></span><div>
        <h2>{t('记忆', 'Memory')}</h2>
        <p>{t('保存偏好、事实、决策、经验和风格规则。运行开始时，与节点任务相关的记忆（置顶的优先，最多 12 条）会作为背景资料交给它，而不是当作指令。', 'Keep preferences, facts, decisions, lessons and style rules. When a run starts, the notes that bear on a node’s task (pinned ones first, at most 12) go to it as background data, never as instructions.')}</p>
      </div></div>
      <div className="awwo-library-actions">
        <button type="button" disabled={loading || busy} onClick={() => void load()} aria-label={t('刷新记忆', 'Refresh memory')}><RefreshCw size={16} aria-hidden="true" /></button>
        {!readOnly && <button type="button" className="awwo-library-primary" disabled={busy} onClick={() => { setDraft(emptyDraft()); setError(null); setNotice(''); }}><Plus size={16} aria-hidden="true" />{t('新建记忆', 'New note')}</button>}
        <button type="button" onClick={onClose} aria-label={t('关闭记忆', 'Close memory')}><X size={19} aria-hidden="true" /></button>
      </div>
    </header>
    {error !== null && <p className="awwo-library-alert" role="alert">{saasErrorMessage(error, locale)}</p>}
    {notice && <p className="awwo-library-notice" role="status"><Check size={14} aria-hidden="true" />{notice}</p>}
    <div className={draft ? 'awwo-library-body has-editor' : 'awwo-library-body'}>
      <div className="awwo-library-list-column">
        <div className="awwo-library-filters">
          <div className="awwo-library-segments" role="group" aria-label={t('范围', 'Scope')}>
            {scopes.map(([value, name]) => <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)}>{name}</button>)}
          </div>
          <div className="awwo-library-segments" role="group" aria-label={t('状态', 'Status')}>
            <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>{t('在用', 'In use')}</button>
            <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>{t('已归档', 'Archived')}</button>
          </div>
          <form className="awwo-library-search" role="search" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }}>
            <input type="search" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder={t('搜索标题和内容', 'Search titles and text')} aria-label={t('搜索记忆', 'Search memory')} />
            <button type="submit" disabled={loading} aria-label={t('搜索', 'Search')}><Search size={15} aria-hidden="true" /></button>
          </form>
        </div>
        {loading && !notes.length ? <p className="awwo-library-empty" role="status">{t('正在读取记忆…', 'Loading memory…')}</p>
          : !visible.length ? <p className="awwo-library-empty">{search || scope !== 'all' || archived ? t('没有匹配的记忆。', 'No matching notes.')
            : t('还没有记忆。把反复交代的偏好、已经定下的决策或踩过的坑记下来，之后的运行就会参考。', 'No notes yet. Save the preferences you keep repeating, the decisions already made or the lessons learned, and later runs will take them into account.')}</p>
          : <ul className="awwo-library-list">{visible.map(note => <li key={note.id} className={draft?.id === note.id ? 'is-active' : undefined}>
            <div className="awwo-library-item-head">
              <span className={`awwo-library-badge kind-${note.kind}`}>{memoryKindName(note.kind, t)}</span>
              <span className="awwo-library-badge">{note.scope === 'canvas' ? t('本画布', 'This canvas') : t('整个工作区', 'Whole workspace')}</span>
              {note.status === 'proposed' && <span className="awwo-library-badge is-proposed">{t('待确认', 'Proposed')}</span>}
              {note.pinned && <span className="awwo-library-badge is-pinned" title={t('已置顶：每次运行优先引用', 'Pinned: quoted first in every run')}><Pin size={11} aria-hidden="true" />{t('置顶', 'Pinned')}</span>}
            </div>
            <strong>{note.title}</strong>
            {note.body && <p>{note.body}</p>}
            <small>{t(`已被引用 ${note.useCount} 次`, `Quoted ${note.useCount} ${note.useCount === 1 ? 'time' : 'times'}`)} · {t('更新于', 'Updated')} {date(note.updatedAt)}</small>
            {!readOnly && <div className="awwo-library-item-actions">
              {note.status === 'proposed' && <button type="button" disabled={busy} onClick={() => patch(note, { status: 'active' }, t('已确认。之后的运行会引用它。', 'Confirmed. Later runs will quote it.'))}><Check size={14} aria-hidden="true" />{t('确认', 'Confirm')}</button>}
              {note.status !== 'archived' && <button type="button" disabled={busy} onClick={() => patch(note, { pinned: !note.pinned }, note.pinned ? t('已取消置顶。', 'Unpinned.') : t('已置顶：每次运行都会优先引用。', 'Pinned: quoted first in every run.'))}>
                {note.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}{note.pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin')}</button>}
              {note.status !== 'archived' && <button type="button" disabled={busy} onClick={() => edit(note)}><Pencil size={14} aria-hidden="true" />{t('编辑', 'Edit')}</button>}
              {note.status === 'archived'
                ? <button type="button" disabled={busy} onClick={() => patch(note, { status: 'active' }, t('已恢复。', 'Restored.'))}><RotateCcw size={14} aria-hidden="true" />{t('恢复', 'Restore')}</button>
                : <button type="button" disabled={busy} onClick={() => patch(note, { status: 'archived' }, t('已归档，之后的运行不再引用。', 'Archived. Later runs no longer quote it.'))}><Archive size={14} aria-hidden="true" />{t('归档', 'Archive')}</button>}
              {deleting === note.id
                ? <><button type="button" className="is-danger" disabled={busy} onClick={() => remove(note)}>{t('确认删除', 'Delete now')}</button><button type="button" onClick={() => setDeleting(null)}>{t('取消', 'Cancel')}</button></>
                : <button type="button" disabled={busy} onClick={() => setDeleting(note.id)}><Trash2 size={14} aria-hidden="true" />{t('删除', 'Delete')}</button>}
            </div>}
          </li>)}</ul>}
      </div>
      {draft && !readOnly && <form className="awwo-library-editor" onSubmit={event => { event.preventDefault(); if (draftReady) save(draft); }}>
        <h3>{draft.id ? t('编辑记忆', 'Edit note') : t('新建记忆', 'New note')}</h3>
        <label>{t('标题', 'Title')}<input required value={draft.title} maxLength={MEMORY_TITLE_CHARS} onChange={event => setDraft({ ...draft, title: event.target.value.replace(/[\r\n\t]+/g, ' ') })}
          placeholder={t('例如：对外文案一律用简体中文', 'For example: customer-facing copy is always in English')} /></label>
        <label>{t('补充说明（可选）', 'Details (optional)')}<textarea rows={6} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
        <small className={bodyBytes > MEMORY_BODY_BYTES ? 'awwo-library-count is-over' : 'awwo-library-count'}>{bodyBytes.toLocaleString()} / {MEMORY_BODY_BYTES.toLocaleString()} B{bodyBytes > MEMORY_BODY_BYTES ? t('，更长的资料请存入知识库', '; save longer material to the knowledge base') : ''}</small>
        <label>{t('类型', 'Kind')}<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as MemoryKind })}>
          {MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{memoryKindName(kind, t)}</option>)}</select></label>
        <fieldset disabled={!!draft.id}><legend>{t('范围', 'Scope')}</legend>
          <label className="awwo-library-check"><input type="radio" name="awwo-memory-scope" checked={draft.scope === 'canvas'} onChange={() => setDraft({ ...draft, scope: 'canvas' })} />{t('只用于本画布', 'This canvas only')}</label>
          <label className="awwo-library-check"><input type="radio" name="awwo-memory-scope" checked={draft.scope === 'workspace'} onChange={() => setDraft({ ...draft, scope: 'workspace' })} />{t('整个工作区的所有画布', 'Every canvas in the workspace')}</label>
          {draft.id && <small>{t('范围在保存后不能更改；需要时新建一条。', 'The scope cannot change after saving; create a new note instead.')}</small>}
        </fieldset>
        <label className="awwo-library-check"><input type="checkbox" checked={draft.pinned} onChange={event => setDraft({ ...draft, pinned: event.target.checked })} />{t('置顶：每次运行都优先引用，不论是否相关', 'Pin: quote it first in every run, relevant or not')}</label>
        <div className="awwo-library-editor-actions">
          <button type="button" onClick={() => setDraft(null)}>{t('取消', 'Cancel')}</button>
          <button type="submit" className="awwo-library-primary" disabled={busy || !draftReady}>{busy ? t('保存中…', 'Saving…') : t('保存', 'Save')}</button>
        </div>
      </form>}
    </div>
  </section>;
}
