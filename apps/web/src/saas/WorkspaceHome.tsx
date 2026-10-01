import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Plus } from 'lucide-react';
import { api, tenantPath, saasErrorMessage, type CanvasRecord, type Identity, type Tenant } from './api';
import { emptyDocument } from '../canvas/canvasDoc';
import { useCanvasI18n } from '../canvas/i18n';
import { useEnterToSend } from '../canvas/composerKeys';
import { useSaaSPreferences } from './preferences';
import { CanvasList } from './CanvasList';
import { CaseGallery } from './CaseGallery';
import { HOME_PROMPT_MAX_CHARACTERS, canvasNameFromPrompt, clearHomeDraft, readHomeDraft, saveHomeDraft } from './homePrompt';
import { savePlanHandoff } from './planHandoff';
import { STARTER_CASES, type StarterCase } from './starterCases';
import { OfficialExamples } from './examples/OfficialExamples';
import { ProductionCases } from './ProductionCases';
import { type OfficialWorkflow } from './examples/officialWorkflows';
import { OfficialCopySetup, createOfficialCopyDocument, type OfficialCopyModel } from './examples/OfficialCopySetup';
import { readOfficialSelection, clearOfficialSelection } from './examples/officialSelection';

/** Recent canvases shown before the operator expands the full list. */
export const RECENT_CANVAS_COUNT = 4;

type HomeProps = { identity: Identity; tenant: Tenant; onOpen: (canvasId: string) => void };
type RuntimeStatus = { available?: boolean; plannerAvailable?: boolean; reason?: string; models?: unknown[] };
type Notice = { kind: 'case'; caseId: string } | { kind: 'restored' } | null;

/** The title of the example whose prompt this is, word for word, in the language it was written in. */
function exampleTitle(prompt: string): string | undefined {
  for (const item of STARTER_CASES) {
    for (const locale of ['zh', 'en'] as const) if (item.prompt[locale].trim() === prompt) return item.title[locale];
  }
  return undefined;
}
const isExamplePrompt = (text: string) => exampleTitle(text.trim()) !== undefined;
const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The workspace landing page: a prompt box that starts a planned canvas, the most recently updated
 * canvases, and examples to start from. Readers, who cannot create canvases, get the list only. */
export function WorkspaceHome(props: HomeProps) {
  return props.tenant.role === 'reader' || props.tenant.status !== 'active' ? <ReaderHome {...props} /> : <PromptHome {...props} />;
}

function ReaderHome({ identity, tenant, onOpen }: HomeProps) {
  const { t } = useSaaSPreferences();
  return <>
    <section className="saas-page-intro"><span className="saas-eyebrow">{t('工作区', 'WORKSPACE')}</span><h1>{tenant.name}</h1><p>{t('打开画布，查看团队的 Agent 分工、会话和运行结果。', 'Open a canvas to review your team’s Agents, conversations and results.')}</p></section>
    <CanvasList userId={identity.user.id} tenant={tenant} onOpen={onOpen} recentLimit={RECENT_CANVAS_COUNT} />
    <ProductionCases compact />
    <OfficialExamples compact readOnly />
  </>;
}

function PromptHome({ identity, tenant, onOpen }: HomeProps) {
  const { locale, t } = useSaaSPreferences();
  const { t: text } = useCanvasI18n();
  const scope = useMemo(() => ({ user: identity.user.id, tenant: tenant.id }), [identity.user.id, tenant.id]);
  const [draft, setDraft] = useState(() => readHomeDraft(scope));
  const [busy, setBusy] = useState(false);
  // State lags a fast second Enter; the ref makes one request per send.
  const sending = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [officialCopy, setOfficialCopy] = useState<OfficialWorkflow | null>(null);
  // The operator's own text, set aside when an example replaced it.
  const [replaced, setReplaced] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  // A canvas that was created but could not be handed the request, because this browser refused to
  // store it. The request stays here instead of being lost on the way.
  const [stranded, setStranded] = useState<{ id: string; name: string } | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  const noteId = useId();
  const examplesId = useId();

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Planning needs a ready engine. Knowing that before sending lets the page say so honestly;
  // an unknown status is not a warning, since the canvas checks again before it plans.
  useEffect(() => {
    const controller = new AbortController();
    api<RuntimeStatus>(tenantPath(tenant.id, '/runtime'), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setRuntime(value); })
      .catch(() => {});
    return () => controller.abort();
  }, [tenant.id]);
  // Coming back through the back/forward cache restores this page as it was left: mid-send, with a
  // prompt already handed to the canvas. Take the box's state from storage again.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      sending.current = false;
      setBusy(false);
      setDraft(readHomeDraft(scope));
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, [scope]);
  // The box grows with its request (CSS bounds it), so an example can be read in full before sending.
  // A new width (a rotated phone, a resized window) rewraps the text, so it is measured again then too.
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const fit = () => { element.style.height = 'auto'; element.style.height = `${element.scrollHeight}px`; };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [draft]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!focusRequest || !element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    element.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [focusRequest]);

  const update = (value: string) => {
    setDraft(value);
    saveHomeDraft(scope, value);
    setError(null);
    setNotice(null);
    setReplaced(null);
  };
  const create = async (prompt: string | null, official?: OfficialWorkflow, model: OfficialCopyModel | null = null) => {
    if (sending.current || tenant.role === 'reader' || tenant.status !== 'active') return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setStranded(null);
    const untitled = t('未命名', 'Untitled');
    const name = official ? official.title[locale] : prompt === null ? untitled : exampleTitle(prompt) ?? canvasNameFromPrompt(prompt, untitled);
    try {
      const canvas = await api<CanvasRecord>(tenantPath(tenant.id, '/canvases'), { method: 'POST', body: JSON.stringify({ name, document: official ? createOfficialCopyDocument(official, locale, model) : emptyDocument() }) });
      if (!mounted.current) return;
      if (prompt !== null) {
        // Leaving now would lose the request: the canvas could only open with an empty prompt box.
        // Stay, keep the text, and let the operator open the canvas once they have it.
        if (!savePlanHandoff({ user: identity.user.id, tenant: tenant.id, canvas: canvas.id }, prompt)) {
          sending.current = false;
          setBusy(false);
          setStranded({ id: canvas.id, name });
          return;
        }
        clearHomeDraft(scope);
      }
      if (official) clearOfficialSelection();
      // The page is leaving now; the box keeps its text until then.
      onOpen(canvas.id);
    } catch (cause) {
      if (!mounted.current) return;
      sending.current = false;
      setBusy(false);
      setError(cause);
    }
  };
  const send = () => {
    const prompt = draft.trim();
    if (prompt) void create(prompt);
  };
  const composerKeys = useEnterToSend(send);
  const pick = (item: StarterCase) => {
    if (sending.current) return;
    const prompt = item.prompt[locale];
    // Choosing an example must never cost the operator their own words. An untouched example that
    // is replaced in turn is not theirs, so the text set aside first stays the one to restore.
    if (draft.trim() && !isExamplePrompt(draft)) setReplaced(draft);
    setDraft(prompt);
    saveHomeDraft(scope, prompt);
    setError(null);
    setNotice({ kind: 'case', caseId: item.id });
    setFocusRequest(value => value + 1);
  };
  const restore = () => {
    if (replaced === null) return;
    setDraft(replaced);
    saveHomeDraft(scope, replaced);
    setReplaced(null);
    setNotice({ kind: 'restored' });
    setFocusRequest(value => value + 1);
  };

  const example = notice?.kind === 'case' ? STARTER_CASES.find(item => item.id === notice.caseId) : undefined;
  const noticeText = example ? t(`已填入案例「${example.title.zh}」，可以直接生成，也可以先修改。`, `Filled in the “${example.title.en}” example. Generate it as is, or edit it first.`)
    : notice?.kind === 'restored' ? t('已恢复原来的输入。', 'Your earlier text is back.') : '';
  const executionReady = runtime !== null && runtime.available === true && runtime.plannerAvailable === true
    && !runtime.reason && Array.isArray(runtime.models) && runtime.models.length > 0;
  const plannerIssue = runtime === null || executionReady ? ''
    : (runtime.reason ? saasErrorMessage(runtime.reason, locale) : t('执行引擎尚未就绪', 'the execution engine is not ready')).replace(/[。.]\s*$/u, '');
  const describedBy = [hintId, error !== null ? errorId : '', plannerIssue ? noteId : ''].filter(Boolean).join(' ');

  return <>
    <section className="saas-home-hero" aria-labelledby={titleId}>
      <p className="saas-home-workspace">{tenant.name}</p>
      <h1 id={titleId}>{text('assistant.title')}</h1>
      <p className="saas-home-lead">{t('描述你想交付的成果。先确认分工，再开始执行。', 'Describe what you want to deliver. Review the plan, then run it.')}</p>
      <form className="saas-home-composer" data-onboarding="canvas-create" aria-labelledby={titleId} onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea ref={input} aria-label={text('assistant.input')} aria-describedby={describedBy}
          placeholder={text('assistant.welcomePlaceholder')} value={draft} rows={3} maxLength={HOME_PROMPT_MAX_CHARACTERS}
          enterKeyHint="send" readOnly={busy} aria-busy={busy || undefined}
          onChange={event => update(event.target.value)} {...composerKeys} />
        <div className="saas-home-composer-actions">
          <button type="button" className="saas-home-blank" disabled={busy} onClick={() => void create(null)}><Plus size={15} aria-hidden="true" />{t('空白画布', 'Blank canvas')}</button>
          <span id={hintId} className="saas-home-hint">{t('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for a new line')}</span>
          <button type="submit" className="saas-primary saas-home-send" disabled={busy || !draft.trim()}><span>{busy ? t('正在创建…', 'Creating…') : text('assistant.generate')}</span><ArrowUp size={15} aria-hidden="true" /></button>
        </div>
      </form>
      <div className="saas-home-quick-starts" role="group" aria-label={t('快速填写需求', 'Start with a prompt')}>
        {['product-site-trial', 'weekly-sales-report', 'competitor-research'].map(id => {
          const item = STARTER_CASES.find(candidate => candidate.id === id)!;
          return <button type="button" key={id} disabled={busy} onClick={() => pick(item)} aria-label={t(`填写示例：${item.title.zh}`, `Use prompt: ${item.title.en}`)}>{item.title[locale]}</button>;
        })}
        <button type="button" disabled={busy} aria-expanded={examplesOpen} aria-controls={examplesId}
          aria-label={t('需要灵感？看看案例', 'Need inspiration? Explore examples')} onClick={() => setExamplesOpen(value => !value)}>
          {t('更多灵感', 'More ideas')}<ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="saas-home-notice" role="status">{noticeText && <span>{noticeText}</span>}{example && replaced !== null && <button type="button" className="saas-link" onClick={restore}>{t('恢复原输入', 'Restore my text')}</button>}</div>
      {error !== null && <p id={errorId} className="saas-error saas-home-error" role="alert">{saasErrorMessage(error, locale)}</p>}
      {stranded && <p className="saas-error saas-home-error" role="alert">
        {t(`已新建画布「${stranded.name}」，但这个浏览器不允许暂存需求，无法把它自动带入画布。请先复制上面的需求，再打开画布粘贴。`,
          `The canvas “${stranded.name}” was created, but this browser does not allow the request to be stored, so it cannot be carried into the canvas. Copy the request above, then open the canvas and paste it.`)}
        {' '}<button type="button" className="saas-link" onClick={() => onOpen(stranded.id)}>{t('打开画布', 'Open the canvas')}</button>
      </p>}
      {plannerIssue && <p id={noteId} className="saas-home-planner-note">{t(`规划暂不可用：${plannerIssue}。仍会新建画布，需求会保留在画布输入框中。`, `Planning is not available yet: ${plannerIssue}. A canvas will still be created, and your request will stay in its prompt box.`)}</p>}
    </section>
    <section id={examplesId} className="saas-home-prompt-ideas" aria-label={t('案例灵感', 'Example ideas')} hidden={!examplesOpen}>
      {examplesOpen && <CaseGallery onPick={pick} disabled={busy} />}
    </section>
    <CanvasList userId={identity.user.id} tenant={tenant} onOpen={onOpen} recentLimit={RECENT_CANVAS_COUNT} />
    <ProductionCases compact />
    <OfficialExamples compact onReuse={item => { if (!sending.current) { setError(null); setOfficialCopy(item); } }} disabled={busy}
      initialId={new URLSearchParams(window.location.search).get('official') || readOfficialSelection()}
      error={error !== null ? saasErrorMessage(error, locale) : undefined} />
    {officialCopy && <OfficialCopySetup key={`${tenant.id}:${officialCopy.id}`} item={officialCopy} tenantId={tenant.id} locale={locale} busy={busy}
      error={error !== null ? saasErrorMessage(error, locale) : undefined} onClose={() => setOfficialCopy(null)}
      onConfirm={model => create(null, officialCopy, model)} />}
  </>;
}
