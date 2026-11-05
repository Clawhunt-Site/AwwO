// The memory workbench: the short notes a workspace keeps (memory.go). When a run is admitted, the active notes
// that bear on a node's task (pinned ones first) are frozen into it and quoted to the model as background data,
// never as instructions. Notes AwwO keeps from the canvas's runs show as 自动 (Auto), with how many runs bore them out,
// and as 试用中 (On probation) while proposed: no run is given one until a later run writes it again on its own. A
// person's confirm, edit or pin makes one theirs, given at once. An archived note says why AwwO archived it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Brain, Check, Pencil, Pin, PinOff, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';
import {
  createMemory, deleteMemory, MEMORY_BODY_BYTES, MEMORY_KINDS, MEMORY_TITLE_CHARS, readMemory, updateMemory,
  type MemoryArchivedReason, type MemoryDeleted, type MemoryKind, type MemoryNote, type MemoryStatus,
} from './memoryApi';
import './canvas-library.css';

type Translate = (zh: string, en: string) => string;
type Scope = 'all' | 'canvas' | 'workspace';
// A note being edited keeps the title and body it was opened with (opened), for its save to say whether its text changed.
interface Draft { id?: string; version?: number; title: string; body: string; kind: MemoryKind; scope: 'canvas' | 'workspace'; pinned: boolean; opened?: { title: string; body: string } }
interface Props { tenantId: string; canvasId: string; readOnly?: boolean; onClose: () => void }

const emptyDraft = (): Draft => ({ title: '', body: '', kind: 'preference', scope: 'canvas', pinned: false });
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const memoryKindName = (kind: MemoryKind, t: Translate) => ({
  preference: t('偏好', 'Preference'), fact: t('事实', 'Fact'), decision: t('决策', 'Decision'), lesson: t('经验', 'Lesson'), style: t('风格', 'Style'),
})[kind];
/** Whether AwwO keeps the note itself: one of its own (from a run or a learning cycle) no person wrote, changed or pinned. */
export const memoryNoteAuto = (note: MemoryNote) => (note.origin === 'run' || note.origin === 'evolution') && note.locked === false;
/** Whether a note AwwO keeps waits on probation (proposed): given to no run until a later run writes it again on its own. */
export const memoryNoteOnProbation = (note: MemoryNote) => memoryNoteAuto(note) && note.status === 'proposed';
/** Why AwwO archived a note, in the reader's words ('' for one a person archived). */
export const memoryArchivedReason = (reason: MemoryArchivedReason | '' | undefined, t: Translate) => reason ? ({
  merged: t('已和别的笔记合并', 'Merged with other notes'), superseded: t('已被更新的笔记取代', 'Replaced by a newer note'),
  promoted: t('已提升到整个工作区', 'Moved to the whole workspace'), unused: t('30 天没有用到', 'Unused for 30 days'),
  outdated: t('已过时', 'Out of date'), restated: t('复述了一条被删掉或改掉的人写笔记', 'Restated a person’s note that was deleted or changed'),
  tidied: t('整理时归档', 'Archived in a tidy-up'), undone: t('改动已撤销', 'Its change was taken back'),
})[reason] : '';
/** What a deletion says it did: the notes of AwwO's that said the same it archived, for the person to delete as well, and
 * those of the whole workspace it no longer gives this canvas. */
export const memoryDeletedNotice = ({ setAside, heldBack }: MemoryDeleted, t: Translate) => {
  const notes = (n: number) => n === 1 ? 'a note' : `${n} notes`;
  const kept = t('已经开始的运行仍保留当时冻结的副本。', 'Runs already admitted keep the copy they froze.');
  if (setAside > 0 && heldBack > 0) {
    return t(`记忆已删除。AwwO 说同一件事的 ${setAside} 条笔记已归档（在各自所在的「已归档」里，可以一并删掉），整个工作区里的 ${heldBack} 条不再交给这张画布。`,
      `Note deleted. ${setAside === 1 ? 'A note' : `${setAside} notes`} of AwwO's that said the same ${setAside === 1 ? 'is' : 'are'} archived (each under Archived where it was kept, to delete as well), and ${heldBack === 1 ? 'one' : heldBack} of the whole workspace ${heldBack === 1 ? 'is' : 'are'} no longer given to this canvas. `) + kept;
  }
  if (setAside > 0) {
    return t(`记忆已删除，AwwO 说同一件事的 ${setAside} 条笔记也已归档（在各自所在的「已归档」里，可以一并删掉）。`,
      `Note deleted, and ${notes(setAside)} of AwwO's that said the same archived (each under Archived where it was kept, to delete as well). `) + kept;
  }
  if (heldBack > 0) {
    return t(`记忆已删除，整个工作区里 AwwO 说同一件事的 ${heldBack} 条笔记不再交给这张画布。`,
      `Note deleted, and ${notes(heldBack)} of AwwO's for the whole workspace that said the same no longer given to this canvas. `) + kept;
  }
  return t('记忆已删除。', 'Note deleted. ') + kept;
};

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

  // Reads the notes as the filters ask, answering them (null where a later read took over, or this one failed).
  const load = useCallback(async (): Promise<MemoryNote[] | null> => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const items = await readMemory(tenantId, { canvasId, status: archived ? 'archived' : 'active,proposed', ...(search ? { q: search } : {}) });
      if (alive.current && mine === generation.current) { setNotes(items); setError(null); return items; }
    } catch (cause) { if (alive.current && mine === generation.current) setError(cause); }
    finally { if (alive.current && mine === generation.current) setLoading(false); }
    return null;
  }, [tenantId, canvasId, archived, search]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => notes.filter(note => scope === 'all' || note.scope === scope), [notes, scope]);
  // The title of the note a note on probation was written to take the place of, where it is listed.
  const replacedTitle = (note: MemoryNote) => notes.find(other => other.id === note.replacesId)?.title ?? '';
  // What a change did, said once it is done; a function says it from the notes read again after it.
  const act = async (change: () => Promise<void>, done: string | ((items: MemoryNote[]) => string)) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice('');
    try {
      await change();
      if (!alive.current) return;
      if (typeof done === 'string') { setNotice(done); await load(); return; }
      const items = await load();
      if (alive.current && items) setNotice(done(items));
    } catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  };
  const save = (value: Draft) => {
    const fields = { title: value.title.trim(), body: value.body.trim(), kind: value.kind, pinned: value.pinned };
    const rewritten = !!value.opened && (value.opened.title !== fields.title || value.opened.body !== fields.body);
    void act(async () => {
    if (value.id && value.version) await updateMemory(tenantId, value.id, { version: value.version, ...fields });
    else await createMemory(tenantId, { ...(value.scope === 'canvas' ? { canvasId } : {}), ...fields });
    if (alive.current) setDraft(null);
    }, !value.id ? t('记忆已保存。之后的运行会在与任务相关时引用它。', 'Note saved. Later runs quote it when it bears on the task.')
      : rewritten && value.scope === 'canvas' ? t('记忆已更新；AwwO 若有说着它原来内容的笔记，已一并归档（在各自所在的「已归档」里），整个工作区里的这类笔记不再交给这张画布。', 'Note updated; any note of AwwO’s that said its old text is archived (each under Archived where it was kept), or, one of the whole workspace, no longer given to this canvas.')
        : rewritten ? t('记忆已更新；AwwO 若有说着它原来内容的笔记，已一并归档（在各自所在的「已归档」里）。', 'Note updated; any note of AwwO’s that said its old text is archived (each under Archived where it was kept).')
          : t('记忆已更新。', 'Note updated.'));
  };
  // A note open in the editor takes the version (and pin) a list action gave it, so its save is not a conflict.
  const patch = (note: MemoryNote, change: { pinned?: boolean; status?: MemoryStatus }, done: string | ((items: MemoryNote[]) => string)) => void act(async () => {
    const value = await updateMemory(tenantId, note.id, { version: note.version, ...change });
    if (alive.current) setDraft(current => current?.id === value.id ? { ...current, version: value.version, ...(change.pinned !== undefined ? { pinned: value.pinned } : {}) } : current);
  }, done);
  const remove = (note: MemoryNote) => {
    let deleted: MemoryDeleted = { setAside: 0, heldBack: 0 };
    void act(async () => {
      deleted = await deleteMemory(tenantId, note.id);
      if (alive.current) { setDeleting(null); if (draft?.id === note.id) setDraft(null); }
    }, () => memoryDeletedNotice(deleted, t));
  };
  const edit = (note: MemoryNote) => {
    setDraft({ id: note.id, version: note.version, title: note.title, body: note.body, kind: note.kind, scope: note.scope, pinned: note.pinned, opened: { title: note.title, body: note.body } });
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
        <p>{t('保存偏好、事实、决策、经验和风格规则。运行开始时，与节点任务相关的记忆（置顶的优先，最多 12 条）会作为背景资料交给它，而不是当作指令。开着自动学习时，AwwO 也会从运行中自己记下笔记（标「自动」）：先在试用中，等之后的运行又独立记下同样的一条，才交给运行；它还会在学习周期里整理这些笔记（多久一次，见「经验」）。你确认、改动或置顶后，它马上交给运行，AwwO 也不再改它。你删掉的 AwwO 笔记，或你改过文字的 AwwO 笔记原来的说法，AwwO 不会再在那里记，大体相同的说法也不会：它记的是这些文字用 ClawHunt 持有的密钥算出的哈希，不留原文，但有这把密钥就能还原出其中大部分内容，一直留到那张画布或这个工作区删掉、或密钥更换（用的是某张画布的原话时，那张画布删掉后就不再记着）；你确认或置顶过的 AwwO 笔记，文字仍是 AwwO 的，删掉或改动时也这样记下；照着 AwwO 在那里已有的一条原样保存的，就是那一条，也一样。你们自己写的笔记不留它的文字，只有一点：AwwO 有给整个工作区、说着同样内容的笔记时，在一张画布里删掉或改动你们的那条，会在那张画布里记下那条 AwwO 笔记原文的哈希，让它不再交给这张画布；复述了你们笔记的 AwwO 笔记（你们恢复过的归你们），删掉时只记下它原文的哈希。AwwO 移到整个工作区的笔记，会随用到它原话的最后一张画布一起删掉，除非你置顶或改过它的文字。运行会留着交给它们的笔记的副本。', 'Keep preferences, facts, decisions, lessons and style rules. When a run starts, the notes that bear on a node’s task (pinned ones first, at most 12) go to it as background data, never as instructions. With self-learning on, AwwO also keeps notes from runs itself (marked Auto): each waits on probation until a later run writes the same note again on its own, and only then goes to runs; AwwO also tidies them in its learning cycles (how often, see Lessons). Once you confirm, change or pin one, runs are given it at once and AwwO no longer changes it. A note of AwwO’s you delete, or what one of AwwO’s said before you changed its text, AwwO does not keep there again, in those words or most of them: it keeps hashes of the words, made with a key ClawHunt holds, not the text, though with that key much of it could be worked out again, until the canvas or the workspace is deleted or the key is replaced (one in a canvas’s own words, only while that canvas is kept); a note of AwwO’s you confirmed or pinned keeps AwwO’s words, and deleting or changing it is remembered the same way, as is one you save in the very words of one AwwO keeps there (it is that note). Of the notes you write yourselves no text is kept, but for this: where AwwO keeps a note for the whole workspace that says the same, deleting or changing yours in a canvas keeps there the hash of that note’s very text, so that it is not given to that canvas again; and deleting a note of AwwO’s that restated one of yours (unless you restored it, which makes it yours) keeps the hash of its very text alone. A note AwwO moved to the whole workspace is deleted with the last canvas whose words it holds, unless you pin it or change its text. Runs keep copies of the notes they were given.')}</p>
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
            : t('还没有记忆。把反复交代的偏好、已经定下的决策或踩过的坑记下来，之后的运行就会参考；开着自动学习时，AwwO 也会从运行中记下。', 'No notes yet. Save the preferences you keep repeating, the decisions already made or the lessons learned, and later runs will take them into account; with self-learning on, AwwO keeps notes from runs too.')}</p>
          : <ul className="awwo-library-list">{visible.map(note => <li key={note.id} className={draft?.id === note.id ? 'is-active' : undefined}>
            <div className="awwo-library-item-head">
              <span className={`awwo-library-badge kind-${note.kind}`}>{memoryKindName(note.kind, t)}</span>
              <span className="awwo-library-badge">{note.scope === 'canvas' ? t('本画布', 'This canvas') : t('整个工作区', 'Whole workspace')}</span>
              {note.status === 'proposed' && !memoryNoteAuto(note) && <span className="awwo-library-badge is-proposed">{t('待确认', 'Proposed')}</span>}
              {memoryNoteAuto(note) && <span className="awwo-library-badge is-auto" title={t('AwwO 从运行中记下的；你确认、改动或置顶之后，AwwO 不再改它（你改过的文字归你）', 'Kept by AwwO from runs; once you confirm, change or pin it, AwwO no longer changes it (a text you change is yours)')}>{t('自动', 'Auto')}</span>}
              {memoryNoteOnProbation(note) && <span className="awwo-library-badge is-probation" title={t('还没交给运行：之后的运行又独立记下同样的一条，或你确认、改动、置顶它之后才会', 'Not given to runs yet: it is once a later run writes the same note again on its own, or once you confirm, change or pin it')}>{t('试用中', 'On probation')}</span>}
              {note.pinned && <span className="awwo-library-badge is-pinned" title={t('已置顶：每次运行优先引用', 'Pinned: quoted first in every run')}><Pin size={11} aria-hidden="true" />{t('置顶', 'Pinned')}</span>}
            </div>
            <strong>{note.title}</strong>
            {note.body && <p>{note.body}</p>}
            {memoryNoteOnProbation(note) && note.replacesId && <p className="awwo-library-replaces">{replacedTitle(note)
              ? t(`将取代「${replacedTitle(note)}」`, `Will take the place of “${replacedTitle(note)}”`) : t('将取代另一条笔记', 'Will take the place of another note')}</p>}
            <small>{t(`已被引用 ${note.useCount} 次`, `Quoted ${note.useCount} ${note.useCount === 1 ? 'time' : 'times'}`)}
              {(note.evidence ?? 1) > 1 ? ` · ${t(`${note.evidence} 次运行印证`, `borne out by ${note.evidence} runs`)}` : ''}
              {note.status === 'archived' && memoryArchivedReason(note.archivedReason, t) ? ` · ${memoryArchivedReason(note.archivedReason, t)}` : ''}
              {' · '}{t('更新于', 'Updated')} {date(note.updatedAt)}</small>
            {!readOnly && <div className="awwo-library-item-actions">
              {note.status === 'proposed' && <button type="button" disabled={busy} onClick={() => {
                // The note it takes the place of is said to be archived only when it was listed in use and is no longer.
                const replaced = replacedTitle(note) ? note.replacesId : undefined;
                patch(note, { status: 'active' }, items => replaced && !items.some(other => other.id === replaced)
                  ? t('已确认。之后的运行会引用它，它取代的那条已归档。', 'Confirmed. Later runs will quote it, and the note it takes the place of is archived.')
                  : t('已确认。之后的运行会引用它。', 'Confirmed. Later runs will quote it.'));
              }}><Check size={14} aria-hidden="true" />{t('确认', 'Confirm')}</button>}
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
