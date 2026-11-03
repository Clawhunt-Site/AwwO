// The canvas bar's 经验 tool: what AwwO learnt from this canvas's runs (canvas_lessons.go). When a run ends, each node
// that failed in a way it could avoid gets a lesson, which its next runs are given and which each of them counts; a
// lesson that never helps retires itself, and a person can retire or restore any. A lesson's suggestion for the canvas
// is the reader's to take: a reasoning effort is applied as a plan (onEvolve: the canvas surface's applyEvolution,
// undoable as any plan), a change of model goes to the canvas assistant's box as a request the reader sends.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Check, GraduationCap, RefreshCw, RotateCcw, Send, Share2, Wand2, X } from 'lucide-react';
import { AGENT_TEMPLATE_IDS, getAgentTemplate, type AgentTemplateId } from '../canvas/agentTemplates';
import type { CanvasEvolution, CanvasEvolutionResult } from '../canvas/CanvasSurface';
import { WorkbenchOverlay, type CanvasTaskDraft } from './CanvasKnowledgeDock';
import { saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';
import { promoteCanvasLesson, readCanvasLessons, updateCanvasLesson, type CanvasLesson, type CanvasLessonsView } from './lessonsApi';
import { readMemory, updateMemory, type MemoryNote } from './memoryApi';
import { readCanvasEvolution, updateCanvasEvolution, type CanvasEvolutionView, type EvolutionEntry } from './evolutionApi';
import './canvas-library.css';
import './canvas-lessons.css';

type Translate = (zh: string, en: string) => string;
interface Props {
  tenantId: string; canvasId: string; readOnly?: boolean; onTaskDraft?: (draft: CanvasTaskDraft) => void; onEvolve?: (evolution: CanvasEvolution) => void;
  /** Takes back a change the canvas made by itself (canvasEvolution.ts: a plan on the canvas, then its record). */
  onRevert?: (entry: EvolutionEntry) => void;
}

/** The id of a lesson's evolution request, which names its lesson (lessonOfEvolution reads it back). */
export const evolutionId = (lessonId: string) => `lesson:${lessonId}:${Date.now()}`;
export const lessonOfEvolution = (id: string): string => /^lesson:(.+):\d+$/.exec(id)?.[1] ?? '';

/** The reasoning effort a lesson's suggestion runs its node at, or '' for a suggestion that is not an effort. */
export const lessonEffort = (lesson: CanvasLesson): string => ({ lower_effort: 'low', raise_effort: 'medium' } as Record<string, string>)[lesson.proposal] ?? '';

export const lessonKindName = (kind: string, t: Translate): string => ({
  output_limit: t('停在输出上限', 'Stopped at its output limit'),
  step_limit: t('工具步数用完', 'Ran out of tool steps'),
  run_timeout: t('运行超时', 'Ran out of time'),
  workspace_context: t('工具输出塞满了上下文', 'Tool output filled its context'),
  delivery: t('交付不符合输出字段', 'Delivery did not match its outputs'),
  context_limit: t('输入超出模型的上下文', 'Inputs too large for its model'),
  provider: t('模型服务不可用', 'Model provider unavailable'),
  effort_tuning: t('推理强度可以更低', 'Could run at a lower effort'),
} as Record<string, string>)[kind] ?? kind;

/** The request a lesson's suggestion puts in the canvas assistant's box, in the reader's words: what to change about
 *  the node so it stops failing. Empty for a lesson without one. */
export function lessonRequest(lesson: CanvasLesson, t: Translate): string {
  const node = lesson.nodeTitle || lesson.nodeId || '';
  switch (lesson.proposal) {
    case 'lower_effort':
      return lesson.kind === 'effort_tuning'
        ? t(`在至少两个工作区的运行里，和「${node}」同类、用同一个模型的节点，用 low 推理强度首轮完成得一样多，输出更少。把它的推理强度调成 low，模型不变。`,
          `In runs from at least two workspaces, nodes like “${node}” on the same model finished on their first attempt as often at low reasoning effort, with less output. Set its reasoning effort to low and keep its model.`)
        : t(`「${node}」已经 ${lesson.seen} 次停在模型的输出上限，没有交付完。把它的推理强度调成 low，模型不变。`,
          `“${node}” has stopped at its model's output limit ${lesson.seen} times without finishing. Set its reasoning effort to low and keep its model.`);
    case 'raise_effort':
      return t(`「${node}」最近一次在 low 推理强度下没能完成交付（同样的问题已出现 ${lesson.seen} 次）。把它的推理强度调回 medium，模型不变。`,
        `“${node}” last failed to deliver at low reasoning effort (the same failure has come ${lesson.seen} times). Set its reasoning effort back to medium and keep its model.`);
    case 'larger_context':
      return t(`「${node}」的输入 ${lesson.seen} 次超出了模型的上下文长度。把它换成上下文更长的模型，或者缩短喂给它的内容。`,
        `“${node}”'s inputs were too large for its model's context window ${lesson.seen} times. Switch it to a model with a longer context, or shorten what feeds it.`);
    case 'other_model':
      return t(`「${node}」的模型服务 ${lesson.seen} 次不可用（自动重试之后）。把它换成另一个可用的模型。`,
        `“${node}”'s model provider was unavailable ${lesson.seen} times, after its automatic retries. Switch it to another available model.`);
  }
  return '';
}

/** How the runs given a lesson went: how many finished with it, how often the failure it exists to prevent came back
 *  anyway, and how many ended in another failure a lesson could prevent (an outage, an interruption or credits running
 *  out judge no lesson, so they are in none of these). A person's restore keeps only the runs it helped finish. */
export function lessonOutcome(lesson: CanvasLesson, t: Translate): string {
  const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`;
  if (!lesson.applied) return t('还没有带着它的运行', 'No run with it yet');
  const other = Math.max(0, lesson.applied - lesson.succeeded - lesson.failed);
  return [t(`带着它完成 ${lesson.succeeded} 次`, `finished with it ${times(lesson.succeeded)}`),
    lesson.failed ? t(`同样的问题又出现 ${lesson.failed} 次`, `the same failure came back ${times(lesson.failed)}`) : '',
    other ? t(`别的原因没完成 ${other} 次`, `other failures ${times(other)}`) : ''].filter(Boolean).join(t('，', ', '));
}

/** A node's lesson goes to the whole workspace once it helped this many of its runs and failed at most one
 *  (workspace_lessons.go). */
const PROMOTE_AFTER = 3;

/** Whether a node's lesson may go to the whole workspace, for every node of its template: an active lesson its node is
 *  given, which helped at least PROMOTE_AFTER of its runs and failed at most one, of a node on the canvas with an Agent
 *  template, not there already. */
export function lessonPromotable(lesson: CanvasLesson): boolean {
  return lesson.canvasId !== null && !!lesson.nodeId && lesson.given && lesson.status === 'active' && lesson.succeeded >= PROMOTE_AFTER && lesson.failed <= 1
    && !lesson.promoted && AGENT_TEMPLATE_IDS.has(lesson.nodeTemplate ?? '');
}

/** A template's name as the canvas's library shows it, or its id for one it does not know. */
export function templateName(id: string | undefined, locale: 'zh' | 'en'): string {
  return id && AGENT_TEMPLATE_IDS.has(id) ? getAgentTemplate(id as AgentTemplateId, locale).title : id ?? '';
}

/** Whether the node a suggested effort is for already runs at it, in the canvas as saved: low for a lower effort, any
 *  but low for a higher one ('' is the model's default). Unknown (null) for a node no longer on the canvas or a view
 *  that does not say. */
export function lessonSatisfied(lesson: CanvasLesson): boolean | null {
  if (!lessonEffort(lesson) || typeof lesson.nodeEffort !== 'string') return null;
  return lesson.proposal === 'lower_effort' ? lesson.nodeEffort === 'low' : lesson.nodeEffort !== 'low';
}

/** Whether a lesson's suggestion is worth offering now: one open (not dismissed, applied or handed over: one applied is
 *  offered again only when its failure comes back, canvas_lessons.go), and for a provider that could not answer, or a
 *  node that failed at low effort, only once it happened twice (one outage is no reason to change a node's model, nor
 *  one bad delivery to make every run of it cost more). A suggested effort its node already runs at, in the canvas as
 *  saved, is not offered. */
export function lessonSuggests(lesson: CanvasLesson): boolean {
  return lesson.proposal !== '' && lesson.proposalState === 'open' && lessonSatisfied(lesson) !== true
    && ((lesson.proposal !== 'other_model' && lesson.proposal !== 'raise_effort') || lesson.seen >= 2);
}

/** The requests to apply a suggested effort, in turn: a request handed over while one waits (the canvas reads its
 *  palette first) waits behind it rather than replacing it. `evolution` is the one the canvas takes now, and `settled`
 *  takes it off; `withdraw` takes one off that the canvas has not taken (whether it was still waiting). A suggestion the canvas took (its plan changed the node, or the node already ran that way) is marked
 *  applied once the cloud confirms a canvas with its node at that effort (`saved`, told each canvas the cloud
 *  confirmed): one whose change was undone, or never saved (another tab's newer canvas won), stays open. A mark that
 *  cannot be written is let go: the suggestion is then offered again, and taking it again marks it. */
export function useLessonEvolutions(tenantId: string) {
  const queue = useRef<CanvasEvolution[]>([]);
  const [, setShown] = useState(0);
  const tenant = useRef(tenantId);
  tenant.current = tenantId;
  const marks = useRef<CanvasEvolution[]>([]);
  // The canvas as the cloud last confirmed it, read only for its nodes' efforts.
  const confirmed = useRef<unknown>(null);
  const mark = useCallback(() => {
    const nodes = confirmed.current && typeof confirmed.current === 'object' ? (confirmed.current as { nodes?: unknown }).nodes : undefined;
    if (!Array.isArray(nodes)) return;
    marks.current = marks.current.filter(taken => {
      const node = nodes.find(item => !!item && typeof item === 'object' && (item as { id?: unknown }).id === taken.nodeId) as { kind?: unknown; effort?: unknown } | undefined;
      if (node?.kind !== 'session' || node.effort !== taken.effort) return true;
      const lesson = lessonOfEvolution(taken.id);
      if (lesson) void updateCanvasLesson(tenant.current, lesson, { proposalState: 'applied' }).catch(() => undefined);
      return false;
    });
  }, []);
  const enqueue = useCallback((evolution: CanvasEvolution) => { queue.current = [...queue.current, evolution]; setShown(value => value + 1); }, []);
  const withdraw = useCallback((id: string) => {
    const waiting = queue.current.some(item => item.id === id);
    if (waiting) { queue.current = queue.current.filter(item => item.id !== id); setShown(value => value + 1); }
    return waiting;
  }, []);
  const settled = useCallback((id: string, result: CanvasEvolutionResult) => {
    const taken = queue.current.find(item => item.id === id);
    queue.current = queue.current.filter(item => item.id !== id);
    if (taken && (result.applied || result.satisfied)) marks.current = [...marks.current, taken];
    setShown(value => value + 1);
    mark();
  }, [mark]);
  const saved = useCallback((document: unknown) => { confirmed.current = document; mark(); }, [mark]);
  return { evolution: queue.current[0] ?? null, enqueue, withdraw, settled, saved };
}

export function CanvasLessons({ tenantId, canvasId, readOnly = false, onTaskDraft, onEvolve, onRevert }: Props) {
  const { t } = useSaaSPreferences();
  const [open, setOpen] = useState(false);
  const name = t('经验', 'Lessons');
  return <>
    <button type="button" className="awwo-knowledge-tool" aria-label={name} title={t('经验：AwwO 从这个画布的运行里学到的东西', 'Lessons: what AwwO learnt from this canvas’s runs')} onClick={() => setOpen(true)}>
      <GraduationCap size={15} aria-hidden="true" /><span>{name}</span></button>
    {open && <WorkbenchOverlay label={t('经验与进化', 'Lessons and evolution')} onClose={() => setOpen(false)}>
      <LessonsWorkbench key={`${tenantId}/${canvasId}`} tenantId={tenantId} canvasId={canvasId} readOnly={readOnly}
        onTaskDraft={onTaskDraft && (draft => { onTaskDraft(draft); setOpen(false); })}
        onEvolve={onEvolve && (evolution => { onEvolve(evolution); setOpen(false); })}
        onRevert={onRevert && (entry => { onRevert(entry); setOpen(false); })} onClose={() => setOpen(false)} />
    </WorkbenchOverlay>}
  </>;
}

const effortWord = (effort: string, t: Translate) => effort || t('模型默认', 'model default');

/** A line of the canvas's evolution log, in the reader's words. */
export function evolutionEntryText(entry: EvolutionEntry, t: Translate): string {
  const node = entry.nodeTitle || t('已不在画布上的节点', 'a node no longer on the canvas');
  const from = effortWord(entry.from, t), to = effortWord(entry.to, t);
  // A change claimed is under way until the page settles it; one never settled was let go.
  if (entry.state === 'claimed') return entry.kind === 'revert'
    ? t(`「${node}」正在改回 ${to}`, `“${node}” is being set back to ${to}`)
    : t(`「${node}」正在调整推理强度 ${from} → ${to}`, `“${node}” is being changed: reasoning effort ${from} → ${to}`);
  if (entry.state === 'expired') return t(`「${node}」的调整没有完成：页面在完成前关闭了`, `“${node}”’s change did not finish: the page closed first`);
  switch (entry.kind) {
    case 'effort': return t(`「${node}」推理强度 ${from} → ${to}${entry.reverted ? '（已改回）' : ''}`,
      `“${node}” reasoning effort ${from} → ${to}${entry.reverted ? ' (taken back)' : ''}`);
    case 'revert': return entry.auto
      ? t(`「${node}」改回 ${to}：调整之后的运行都没完成`, `“${node}” set back to ${to}: the runs after the change did not finish`)
      : t(`「${node}」被手动改回 ${to}`, `“${node}” set back to ${to} by hand`);
    case 'skip': return entry.reason
      ? t(`「${node}」没能自动调整：${entry.reason}`, `“${node}” could not be changed by itself: ${entry.reason}`)
      : t(`「${node}」的调整没有完成：页面在完成前关闭了`, `“${node}”’s change did not finish: the page closed first`);
    case 'rerun': return t('自动重跑了上次没完成的节点', 'Reran the unfinished nodes by itself');
  }
}

/** The 经验 panel's 自动进化: the canvas's two switches, off until a member turns them on, and what it did by itself, a
 *  change of effort taken back here (改回) as a plan on the canvas. Nothing shows until it is read, nor when it cannot
 *  be (an API before it: the lessons are the panel's own business); a reader sees it and changes nothing. */
function CanvasAutoEvolution({ tenantId, canvasId, readOnly, onRevert }: { tenantId: string; canvasId: string; readOnly: boolean; onRevert?: (entry: EvolutionEntry) => void }) {
  const { t, locale } = useSaaSPreferences();
  const [view, setView] = useState<CanvasEvolutionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The newest read or switch decides what shows: an older answer that comes after it is dropped.
  const latest = useRef(0);
  useEffect(() => {
    const mine = ++latest.current;
    const controller = new AbortController();
    readCanvasEvolution(tenantId, canvasId, controller.signal).then(value => { if (latest.current === mine) setView(value); }, () => undefined);
    return () => controller.abort();
  }, [tenantId, canvasId]);
  const toggle = async (change: { autoApply?: boolean; autoRerun?: boolean }) => {
    if (busy) return;
    const mine = ++latest.current;
    setBusy(true); setError(null);
    try { const value = await updateCanvasEvolution(tenantId, canvasId, change); if (alive.current && latest.current === mine) setView(value); }
    catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  };
  if (!view) return null;
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : '';
  const perDay = view.limits.rerunsPerDay;
  return <section className="awwo-lessons-evolution" aria-label={t('自动进化', 'Auto-evolve')}>
    <h3>{t('自动进化：从开启之后结束的运行开始', 'Auto-evolve: from the runs that end after you turn it on')}</h3>
    {error !== null && <p className="awwo-library-alert" role="alert">{saasErrorMessage(error, locale)}</p>}
    <label className="awwo-library-check awwo-lessons-switch"><input type="checkbox" checked={view.autoApply.on} disabled={readOnly || busy}
      onChange={event => void toggle({ autoApply: event.target.checked })} />
      <span><strong>{t('自动应用建议', 'Apply suggestions by itself')}</strong>
        <small>{t(`运行结束后，没完成的节点自动换上经验建议的推理强度：只改推理强度，不改模型和画布结构，可以撤销。同一个节点 ${view.limits.changeEveryHours} 小时内最多调整一次、一周最多 ${view.limits.changesPerWeek} 次；调整后接下来的 ${view.limits.revertAfterRuns} 次运行都没完成，就马上自动改回（改回也算一次调整）。`,
          `When a run ends, each node that did not finish takes the reasoning effort its lesson suggests: only the effort, never the model or the canvas’s shape, and it can be undone. A node is changed at most once in ${view.limits.changeEveryHours} hours and ${view.limits.changesPerWeek} times a week; if its next ${view.limits.revertAfterRuns} runs after a change all fail, the change is taken back at once (which counts as a change).`)}</small></span></label>
    <label className="awwo-library-check awwo-lessons-switch"><input type="checkbox" checked={view.autoRerun.on} disabled={readOnly || busy}
      onChange={event => void toggle({ autoRerun: event.target.checked })} />
      <span><strong>{t('自动重跑没完成的节点', 'Rerun unfinished nodes by itself')}</strong>
        <small>{t(`运行没完成时，把没完成的节点再跑一次，带上刚学到的经验。会消耗额度（图片、视频等生成也算）；每 24 小时最多 ${perDay} 次，重跑本身没完成不会再重跑。`,
          `When a run does not finish, its unfinished nodes run once more, with what was just learnt. This spends credits (image, video and other generations too); at most ${perDay} times in 24 hours, and a rerun that does not finish is not rerun.`)}</small></span></label>
    {view.log.length > 0 && <ol className="awwo-lessons-evolution-log" aria-label={t('自动进化记录', 'What auto-evolve did')}>{view.log.map(entry => <li key={entry.id}>
      <span>{evolutionEntryText(entry, t)}</span><time dateTime={entry.createdAt}>{date(entry.createdAt)}</time>
      {entry.standing && !readOnly && onRevert
        && <button type="button" onClick={() => onRevert(entry)}><RotateCcw size={13} aria-hidden="true" />{t('改回', 'Undo')}</button>}
    </li>)}</ol>}
  </section>;
}

/** The notes AwwO's own model proposed from this canvas's runs (run_memory.go), waiting for a member: one accepted joins
 *  the canvas's memory, which its runs are given as background data; one ignored is set aside and never proposed again.
 *  Nothing shows while there is none (or they cannot be read: the lessons are the panel's own business). */
function DistilledNotes({ tenantId, canvasId, readOnly }: { tenantId: string; canvasId: string; readOnly: boolean }) {
  const { t, locale } = useSaaSPreferences();
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const value = await readMemory(tenantId, { canvasId, status: 'proposed' });
      if (alive.current) setNotes(value.filter(note => note.canvasId === canvasId && note.origin === 'run' && note.source.distilled === true));
    } catch { if (alive.current) setNotes([]); }
  }, [tenantId, canvasId]);
  useEffect(() => { void load(); }, [load]);
  const settle = async (note: MemoryNote, status: 'active' | 'archived') => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await updateMemory(tenantId, note.id, { version: note.version, status }); if (alive.current) await load(); }
    catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  };
  if (!notes.length) return null;
  return <section className="awwo-lessons-notes" aria-label={t('从运行中提炼的记忆', 'Notes proposed from runs')}>
    <h3>{t('从运行中提炼的记忆：接受后，这张画布之后的运行会把它当作背景资料', 'Notes proposed from runs: once accepted, this canvas’s runs take them as background')}</h3>
    {error !== null && <p className="awwo-library-alert" role="alert">{saasErrorMessage(error, locale)}</p>}
    <ul>{notes.map(note => <li key={note.id}>
      <strong>{note.title}</strong>
      {note.body && <p>{note.body}</p>}
      {!readOnly && <div className="awwo-library-item-actions">
        <button type="button" className="awwo-library-primary" disabled={busy} onClick={() => void settle(note, 'active')}><Check size={14} aria-hidden="true" />{t('接受', 'Accept')}</button>
        <button type="button" disabled={busy} onClick={() => void settle(note, 'archived')}>{t('忽略', 'Ignore')}</button>
      </div>}
    </li>)}</ul>
  </section>;
}

export function LessonsWorkbench({ tenantId, canvasId, readOnly = false, onTaskDraft, onEvolve, onRevert, onClose }: Props & { onClose: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const [view, setView] = useState<CanvasLessonsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const value = await readCanvasLessons(tenantId, canvasId);
      if (alive.current && mine === generation.current) { setView(value); setError(null); }
    } catch (cause) { if (alive.current && mine === generation.current) setError(cause); }
    finally { if (alive.current && mine === generation.current) setLoading(false); }
  }, [tenantId, canvasId]);
  useEffect(() => { void load(); }, [load]);

  const patch = async (lesson: CanvasLesson, change: { status?: 'active' | 'retired'; proposalState?: 'open' | 'asked' | 'dismissed' }, done: string) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice('');
    try {
      await updateCanvasLesson(tenantId, lesson.id, change);
      if (!alive.current) return;
      setNotice(done); await load();
    } catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  };
  const promote = async (lesson: CanvasLesson) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice('');
    try {
      const promoted = await promoteCanvasLesson(tenantId, lesson.id);
      if (!alive.current) return;
      const name = templateName(lesson.nodeTemplate, locale);
      // One a person retired stays retired: they restore it, here, for the nodes to take it.
      setNotice(promoted.status === 'active'
        ? t(`已推广：工作区里的「${name}」节点之后都会带上这条经验（自己已有同类经验的节点除外）。`,
          `Promoted: every “${name}” node in the workspace takes this lesson from now on, unless it has a lesson of its own of this kind.`)
        : t(`这条经验已经在工作区里，但被停用了：在下面恢复它，所有「${name}」节点才会带上它。`, `This lesson is already the workspace’s, but retired: restore it below for every “${name}” node to take it.`));
      await load();
    } catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  };
  const ask = (lesson: CanvasLesson) => {
    const prompt = lessonRequest(lesson, t);
    if (!prompt || !onTaskDraft) return;
    // Marked as handed over first, so the suggestion is not offered again; the request itself waits for the reader.
    void updateCanvasLesson(tenantId, lesson.id, { proposalState: 'asked' }).catch(() => undefined);
    onTaskDraft({ id: `lesson:${lesson.id}:${Date.now()}`, prompt });
  };
  // A reasoning effort is applied on the canvas itself, as a plan: the canvas marks the suggestion applied once its
  // plan changed the node (SaaSApp), and says why when it did not.
  const evolution = (lesson: CanvasLesson): CanvasEvolution | null => {
    const effort = lessonEffort(lesson);
    return effort && lesson.nodeId && onEvolve
      ? { id: evolutionId(lesson.id), nodeId: lesson.nodeId, effort, model: lesson.scope.model ?? '', note: lessonRequest(lesson, t) } : null;
  };
  const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : '';
  const lessons = view?.lessons ?? [];
  const runs = view?.runs ?? [];
  const status = (lesson: CanvasLesson) => lesson.status === 'active'
    ? (lesson.given ? t('生效中', 'In use') : t('只有建议', 'Suggestion only'))
    : lesson.retiredReason === 'ineffective' ? t('已自动停用：一直没帮上忙', 'Retired by itself: it never helped') : t('已停用', 'Retired');

  return <section className="awwo-library" aria-label={t('经验与进化', 'Lessons and evolution')}>
    <header className="awwo-library-header">
      <div className="awwo-library-heading"><span className="awwo-library-mark"><GraduationCap size={20} aria-hidden="true" /></span><div>
        <h2>{t('经验与进化', 'Lessons and evolution')}</h2>
        <p>{t('画布运行结束后，失败的节点会在这里留下经验：下次运行时它带着这些经验跑，每次运行都会记下经验帮没帮上忙，一直帮不上忙的会自动停用。调推理强度的建议可以直接应用到画布上（可以撤销），换模型的建议会交给画布助手，由你确认后发送。',
          'When a canvas run ends, each node that failed leaves a lesson here: its next runs take the lesson with them, each run records whether it helped, and one that never helps retires itself. A suggested reasoning effort can be applied to the canvas here (and undone); a suggested change of model goes to the canvas assistant, for you to send.')}</p>
      </div></div>
      <div className="awwo-library-actions">
        <button type="button" disabled={loading || busy} onClick={() => void load()} aria-label={t('刷新经验', 'Refresh lessons')}><RefreshCw size={16} aria-hidden="true" /></button>
        <button type="button" onClick={onClose} aria-label={t('关闭经验', 'Close lessons')}><X size={19} aria-hidden="true" /></button>
      </div>
    </header>
    {error !== null && <p className="awwo-library-alert" role="alert">{saasErrorMessage(error, locale)}</p>}
    {notice && <p className="awwo-library-notice" role="status"><Check size={14} aria-hidden="true" />{notice}</p>}
    <div className="awwo-library-body">
      <div className="awwo-library-list-column">
        <CanvasAutoEvolution tenantId={tenantId} canvasId={canvasId} readOnly={readOnly} onRevert={onRevert} />
        <DistilledNotes tenantId={tenantId} canvasId={canvasId} readOnly={readOnly} />
        {runs.length > 0 && <section className="awwo-lessons-runs" aria-label={t('最近的运行', 'Recent runs')}>
          <h3>{t('最近的运行：首轮就完成的节点', 'Recent runs: nodes done on their first attempt')}</h3>
          <ol>{runs.map(run => {
            const share = run.ran ? run.firstPass / run.ran : 0;
            return <li key={run.id}>
              <span className="awwo-lessons-run-date">{date(run.createdAt)}</span>
              <span className="awwo-lessons-run-bar" role="img" aria-label={t(`${run.ran} 个节点里 ${run.firstPass} 个首轮完成`, `${run.firstPass} of ${run.ran} nodes done first time`)}>
                <span style={{ width: `${Math.round(share * 100)}%` }} /></span>
              <span className="awwo-lessons-run-figure">{run.firstPass} / {run.ran}</span>
              <small>{[run.failed ? t(`失败 ${run.failed}`, `${run.failed} failed`) : '', run.retried ? t(`重试 ${run.retried}`, `${run.retried} retried`) : '',
                run.givenLessons ? t(`${run.givenLessons} 个带着经验`, `${run.givenLessons} with lessons`) : ''].filter(Boolean).join(' · ')}</small>
            </li>;
          })}</ol>
        </section>}
        {loading && !view ? <p className="awwo-library-empty" role="status">{t('正在读取经验…', 'Loading lessons…')}</p>
          : !lessons.length ? <p className="awwo-library-empty">{t('还没有经验。画布运行结束后，没完成的节点会在这里留下经验，下次运行时带上。', 'No lessons yet. When a canvas run ends, the nodes that did not finish leave lessons here, and take them into their next runs.')}</p>
          : <ul className="awwo-library-list" aria-label={t('经验', 'Lessons')}>{lessons.map(lesson => <li key={lesson.id}>
            <div className="awwo-library-item-head">
              <span className="awwo-library-badge">{lesson.canvasId === null
                ? t(`工作区 · 所有「${templateName(lesson.scope.templateId, locale)}」节点`, `Workspace · every “${templateName(lesson.scope.templateId, locale)}” node`)
                : lesson.nodeTitle || t('已不在画布上的节点', 'A node no longer on the canvas')}</span>
              <span className={`awwo-library-badge${lesson.status === 'active' ? ' is-pinned' : ''}`}>{status(lesson)}</span>
            </div>
            <strong>{lessonKindName(lesson.kind, t)}</strong>
            <small>{t(`出现 ${lesson.seen} 次`, `Seen ${lesson.seen} ${lesson.seen === 1 ? 'time' : 'times'}`)}
              {/* Counted only by the runs a lesson is judged by: done, or failed in a way a lesson could prevent. */}
              {lesson.given ? ` · ${lessonOutcome(lesson, t)}` : ''}
              {` · ${t('最近一次', 'Last')} ${date(lesson.lastSeenAt)}`}
              {lesson.proposalState === 'applied' ? ` · ${t('建议已应用', 'Suggestion applied')}` : ''}
              {lesson.promoted ? ` · ${t('已推广到工作区', 'Promoted to the workspace')}` : ''}</small>
            {lesson.given && <details className="awwo-lessons-rule"><summary>{t('交给模型的话', 'What the model is told')}</summary><p lang="en">{lesson.rule}</p></details>}
            {lessonSuggests(lesson) && <p className="awwo-lessons-suggestion">{lessonRequest(lesson, t)}</p>}
            {!readOnly && <div className="awwo-library-item-actions">
              {lessonSuggests(lesson) && (evolution(lesson)
                ? <button type="button" className="awwo-library-primary" disabled={busy} onClick={() => { const next = evolution(lesson); if (next) onEvolve?.(next); }}><Wand2 size={14} aria-hidden="true" />{t('应用建议', 'Apply')}</button>
                : onTaskDraft && <button type="button" className="awwo-library-primary" disabled={busy} onClick={() => ask(lesson)}><Send size={14} aria-hidden="true" />{t('交给画布助手', 'Hand to the assistant')}</button>)}
              {lessonSuggests(lesson) && <button type="button" disabled={busy} onClick={() => void patch(lesson, { proposalState: 'dismissed' }, t('已忽略这条建议。', 'Suggestion dismissed.'))}>{t('忽略建议', 'Dismiss')}</button>}
              {lessonPromotable(lesson) && <button type="button" disabled={busy} title={t(`让工作区里所有「${templateName(lesson.nodeTemplate, locale)}」节点都带上这条经验`, `Give this lesson to every “${templateName(lesson.nodeTemplate, locale)}” node in the workspace`)}
                onClick={() => void promote(lesson)}><Share2 size={14} aria-hidden="true" />{t('推广到工作区', 'Promote to the workspace')}</button>}
              {lesson.given && (lesson.status === 'active'
                ? <button type="button" disabled={busy} onClick={() => void patch(lesson, { status: 'retired' }, t('已停用：之后的运行不再带它。', 'Retired: later runs no longer take it.'))}><Archive size={14} aria-hidden="true" />{t('停用', 'Retire')}</button>
                : <button type="button" disabled={busy} onClick={() => void patch(lesson, { status: 'active' }, lesson.retiredReason === 'ineffective'
                  ? t('已恢复：之后的运行会带上它，没完成的次数重新算起。', 'Restored: later runs take it again, and its failures are counted afresh.')
                  : t('已恢复：之后的运行会带上它。', 'Restored: later runs take it again.'))}><RotateCcw size={14} aria-hidden="true" />{t('恢复', 'Restore')}</button>)}
            </div>}
          </li>)}</ul>}
      </div>
    </div>
  </section>;
}
