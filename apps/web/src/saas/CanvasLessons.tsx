// The canvas bar's 经验 tool: what AwwO learnt from this canvas's runs (canvas_lessons.go). When a run ends, each node
// that failed in a way it could avoid gets a lesson, which its next runs are given and which each of them counts; a
// lesson that never helps retires itself, and a person can retire or restore any. A lesson's suggestion for the canvas
// goes to the canvas assistant's box as a request the reader sends: nothing here edits the canvas.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Check, GraduationCap, RefreshCw, RotateCcw, Send, X } from 'lucide-react';
import { WorkbenchOverlay, type CanvasTaskDraft } from './CanvasKnowledgeDock';
import { saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';
import { readCanvasLessons, updateCanvasLesson, type CanvasLesson, type CanvasLessonsView } from './lessonsApi';
import './canvas-library.css';
import './canvas-lessons.css';

type Translate = (zh: string, en: string) => string;
interface Props { tenantId: string; canvasId: string; readOnly?: boolean; onTaskDraft?: (draft: CanvasTaskDraft) => void }

export const lessonKindName = (kind: string, t: Translate): string => ({
  output_limit: t('停在输出上限', 'Stopped at its output limit'),
  step_limit: t('工具步数用完', 'Ran out of tool steps'),
  run_timeout: t('运行超时', 'Ran out of time'),
  workspace_context: t('工具输出塞满了上下文', 'Tool output filled its context'),
  delivery: t('交付不符合输出字段', 'Delivery did not match its outputs'),
  context_limit: t('输入超出模型的上下文', 'Inputs too large for its model'),
  provider: t('模型服务不可用', 'Model provider unavailable'),
} as Record<string, string>)[kind] ?? kind;

/** The request a lesson's suggestion puts in the canvas assistant's box, in the reader's words: what to change about
 *  the node so it stops failing. Empty for a lesson without one. */
export function lessonRequest(lesson: CanvasLesson, t: Translate): string {
  const node = lesson.nodeTitle || lesson.nodeId || '';
  switch (lesson.proposal) {
    case 'lower_effort':
      return t(`「${node}」已经 ${lesson.seen} 次停在模型的输出上限，没有交付完。把它的推理强度调成 low，模型不变。`,
        `“${node}” has stopped at its model's output limit ${lesson.seen} times without finishing. Set its reasoning effort to low and keep its model.`);
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

/** Whether a lesson's suggestion is worth offering now: one not dismissed or already handed over, and for a provider
 *  that could not answer, only once it happened twice (one outage is no reason to change a node's model). */
export function lessonSuggests(lesson: CanvasLesson): boolean {
  return lesson.proposal !== '' && lesson.proposalState === 'open' && (lesson.proposal !== 'other_model' || lesson.seen >= 2);
}

export function CanvasLessons({ tenantId, canvasId, readOnly = false, onTaskDraft }: Props) {
  const { t } = useSaaSPreferences();
  const [open, setOpen] = useState(false);
  const name = t('经验', 'Lessons');
  return <>
    <button type="button" className="awwo-knowledge-tool" aria-label={name} title={t('经验：AwwO 从这个画布的运行里学到的东西', 'Lessons: what AwwO learnt from this canvas’s runs')} onClick={() => setOpen(true)}>
      <GraduationCap size={15} aria-hidden="true" /><span>{name}</span></button>
    {open && <WorkbenchOverlay label={t('经验与进化', 'Lessons and evolution')} onClose={() => setOpen(false)}>
      <LessonsWorkbench key={`${tenantId}/${canvasId}`} tenantId={tenantId} canvasId={canvasId} readOnly={readOnly}
        onTaskDraft={onTaskDraft && (draft => { onTaskDraft(draft); setOpen(false); })} onClose={() => setOpen(false)} />
    </WorkbenchOverlay>}
  </>;
}

export function LessonsWorkbench({ tenantId, canvasId, readOnly = false, onTaskDraft, onClose }: Props & { onClose: () => void }) {
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
  const ask = (lesson: CanvasLesson) => {
    const prompt = lessonRequest(lesson, t);
    if (!prompt || !onTaskDraft) return;
    // Marked as handed over first, so the suggestion is not offered again; the request itself waits for the reader.
    void updateCanvasLesson(tenantId, lesson.id, { proposalState: 'asked' }).catch(() => undefined);
    onTaskDraft({ id: `lesson:${lesson.id}:${Date.now()}`, prompt });
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
        <p>{t('画布运行结束后，失败的节点会在这里留下经验：下次运行时它带着这些经验跑，每次运行都会记下经验帮没帮上忙，一直帮不上忙的会自动停用。改画布的建议会交给画布助手，由你确认后发送。',
          'When a canvas run ends, each node that failed leaves a lesson here: its next runs take the lesson with them, each run records whether it helped, and one that never helps retires itself. Suggestions for the canvas go to the canvas assistant, for you to send.')}</p>
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
              <span className="awwo-library-badge">{lesson.nodeTitle || t('已不在画布上的节点', 'A node no longer on the canvas')}</span>
              <span className={`awwo-library-badge${lesson.status === 'active' ? ' is-pinned' : ''}`}>{status(lesson)}</span>
            </div>
            <strong>{lessonKindName(lesson.kind, t)}</strong>
            <small>{t(`出现 ${lesson.seen} 次`, `Seen ${lesson.seen} ${lesson.seen === 1 ? 'time' : 'times'}`)}
              {/* Counted only by the runs a lesson is judged by: done, or failed in a way a lesson could prevent. */}
              {lesson.given ? ` · ${lessonOutcome(lesson, t)}` : ''}
              {` · ${t('最近一次', 'Last')} ${date(lesson.lastSeenAt)}`}</small>
            {lesson.given && <details className="awwo-lessons-rule"><summary>{t('交给模型的话', 'What the model is told')}</summary><p lang="en">{lesson.rule}</p></details>}
            {lessonSuggests(lesson) && <p className="awwo-lessons-suggestion">{lessonRequest(lesson, t)}</p>}
            {!readOnly && <div className="awwo-library-item-actions">
              {lessonSuggests(lesson) && onTaskDraft && <button type="button" className="awwo-library-primary" disabled={busy} onClick={() => ask(lesson)}><Send size={14} aria-hidden="true" />{t('交给画布助手', 'Hand to the assistant')}</button>}
              {lessonSuggests(lesson) && <button type="button" disabled={busy} onClick={() => void patch(lesson, { proposalState: 'dismissed' }, t('已忽略这条建议。', 'Suggestion dismissed.'))}>{t('忽略建议', 'Dismiss')}</button>}
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
