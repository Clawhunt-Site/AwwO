import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BookMarked, BookOpen, TerminalSquare, X } from 'lucide-react';
import { api, saasErrorMessage, tenantPath } from './api';
import { configureCanvasKnowledge } from './canvasBridge';
import { KnowledgeWorkbench, type KnowledgeArtifactCandidate } from './KnowledgeWorkbench';
import { ManagedExecutionPanel } from './ManagedExecutionPanel';
import { createKnowledgeProposal, type KnowledgeContextItem } from './knowledgeApi';
import { useSaaSPreferences } from './preferences';
import './canvas-knowledge-dock.css';

interface Artifact { id: string; name: string; runId: string; nodeId: string }
interface Compilation {
  id: string; status: string; error?: string;
  pages: { title: string; kind: 'page' | 'decision'; content: string; sourceRevisionIds: string[] }[];
  knowledge?: { items: KnowledgeContextItem[] };
}
export interface CanvasTaskDraft { id: string; prompt: string }
// A failure keeps the original error, so API error codes are still translated when it is shown.
type Message = { text: string } | { error: unknown };
interface Props { tenantId: string; canvasId: string; readOnly?: boolean; onTaskDraft?: (draft: CanvasTaskDraft) => void }
const requestSignal = (signal?: AbortSignal | null) => signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
const boundedApi = <T,>(path: string, init: RequestInit = {}) => api<T>(path, { ...init, signal: requestSignal(init.signal) });
// Free width the tool labels leave before the run controls, below which they give way to icons.
const LABEL_ROOM = 24;

function WorkbenchOverlay({ label, onClose, children }: {label:string;onClose:()=>void;children:ReactNode}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="awwo-knowledge-overlay" aria-label={label} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>{children}</dialog>;
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2000);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

export function CanvasKnowledgeDock(props: Props) {
  return <Dock key={`${props.tenantId}/${props.canvasId}`} {...props} />;
}
function Dock({ tenantId, canvasId, readOnly = false, onTaskDraft }: Props) {
  const { t, locale } = useSaaSPreferences();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [open, setOpen] = useState(false);
  const [executionOpen, setExecutionOpen] = useState(false);
  const [selected, setSelected] = useState<KnowledgeContextItem[]>([]);
  // A failed read concerns only the open map. `message` is the latest compilation outcome: shown at
  // the top of the open map and, while the map is closed, marked on its button until it is opened.
  const [readError, setReadError] = useState<unknown>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compact, setCompact] = useState(false);
  const [recent, setRecent] = useState<{id:string;status:string}[]>([]);
  const [recentId, setRecentId] = useState('');
  const [workbenchVersion, setWorkbenchVersion] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const compilation = useRef<{ id: string; refs: KnowledgeContextItem[] } | null>(null);
  const compileOperation = useRef<{ id: string; key: string } | null>(null);
  const mounted = useRef(true);
  // Counts openings of the map, so a compilation can tell whether the workbench that started it
  // is still showing and reports the outcome itself.
  const mapSession = useRef(0);
  const mapOpen = useRef(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef(false);
  const refit = useRef<() => void>(() => {});
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  const openMap = () => { mapSession.current += 1; mapOpen.current = true; setReadError(null); setOpen(true); };
  // What the map has shown is not shown again; the progress of a running compilation stays, since it
  // is still current.
  const closeMap = () => { mapOpen.current = false; if (!controller.current) setMessage(null); setOpen(false); };
  // Task artifacts are needed only to save one as evidence in the knowledge map, so they are
  // read each time the map opens rather than polled for the whole canvas session.
  useEffect(() => {
    if (!open) return;
    const scope = new AbortController();
    boundedApi<{ items: Artifact[] }>(tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/artifacts`), { signal: scope.signal })
      .then(result => {
        if (!Array.isArray(result.items) || result.items.some(x => !x || typeof x.id !== 'string' || typeof x.name !== 'string')) throw new Error('Invalid artifact response');
        if (!scope.signal.aborted) setArtifacts(result.items);
      })
      .catch(cause => { if (!scope.signal.aborted) setReadError(cause); });
    return () => scope.abort();
  }, [open, tenantId, canvasId]);
  useEffect(() => {
    if (!open) return;
    const scope = new AbortController();
    boundedApi<{items:{id:string;status:string}[]}>(tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/knowledge-compilations`), { signal: scope.signal })
      .then(value => { if (!scope.signal.aborted && Array.isArray(value.items)) { setRecent(value.items); setRecentId(value.items[0]?.id || ''); } })
      .catch(cause => { if (!scope.signal.aborted) setReadError(cause); });
    return () => scope.abort();
  }, [open, tenantId, canvasId]);

  const compile = async (_prompt: string, refs: KnowledgeContextItem[]) => {
    if (readOnly || controller.current) throw new Error(t('当前无法提交整理任务。', 'Compilation is not available.'));
    const scope = new AbortController(); controller.current = scope; setCompiling(true);
    setMessage({ text: t('模型正在整理资料；完成后生成待审核提案。', 'Compiling selected evidence into reviewable proposals.') });
    const session = mapSession.current;
    const key = JSON.stringify(refs.map(item => item.revisionId));
    try {
      if (!compilation.current || JSON.stringify(compilation.current.refs.map(item => item.revisionId)) !== key) {
        if (compileOperation.current?.key !== key) compileOperation.current = { key, id: `wiki-${crypto.randomUUID()}` };
        const run = await boundedApi<{ id: string }>(tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/knowledge-compile`), {
          method: 'POST', signal: scope.signal, body: JSON.stringify({ operationId: compileOperation.current.id, revisionIds: refs.map(item => item.revisionId) }),
        });
        if (!run.id || typeof run.id !== 'string') throw new Error('Invalid compilation identity');
        compilation.current = { id: run.id, refs };
      }
      const pending = compilation.current;
      for (let attempt = 0; attempt < 180; attempt++) {
        const result = await boundedApi<Compilation>(tenantPath(tenantId, `/knowledge/compilations/${encodeURIComponent(pending.id)}`), { signal: scope.signal });
        if (result.id !== pending.id) throw new Error('Compilation identity changed');
        if (result.status === 'completed') {
          const frozen = result.knowledge?.items;
          if (!frozen || frozen.length !== pending.refs.length || frozen.some(item => !pending.refs.some(ref => ref.revisionId === item.revisionId && ref.contentHash === item.contentHash))
            || !Array.isArray(result.pages) || result.pages.length < 1 || result.pages.length > 8) throw new Error('Compilation source verification failed');
          for (let i = 0; i < result.pages.length; i++) {
            const page = result.pages[i];
            if (!Array.isArray(page.sourceRevisionIds) || page.sourceRevisionIds.length < 1 || page.sourceRevisionIds.some(id => !frozen.some(item => item.revisionId === id))) throw new Error('Compilation page source verification failed');
            await createKnowledgeProposal(tenantId, { ...page, baseVersion: 0, operationId: `wiki-${pending.id}-${i}` }, requestSignal(scope.signal));
          }
          setMessage({ text: t(`已生成 ${result.pages.length} 份待审核提案。`, `${result.pages.length} proposals are ready for review.`) });
          compilation.current = null; compileOperation.current = null;
          setWorkbenchVersion(value => value + 1);
          return;
        }
        if (['failed', 'cancelled', 'interrupted'].includes(result.status)) {
          compilation.current = null; compileOperation.current = null;
          throw new Error(result.error || result.status);
        }
        if (!['queued', 'running'].includes(result.status)) throw new Error('Unknown compilation status');
        await delay(scope.signal);
      }
      throw new Error(t('整理仍在后台运行。再次点击整理可继续读取同一任务。', 'Compilation is still running. Compile again to resume observing the same run.'));
    } catch (cause) {
      // The workbench that started the run shows the failure itself. Once it has closed, report it
      // here instead of leaving the progress notice in place.
      if (mounted.current) setMessage(mapOpen.current && mapSession.current === session ? null : { error: cause });
      throw cause;
    } finally { controller.current = null; if (mounted.current) setCompiling(false); }
  };
  const candidates: KnowledgeArtifactCandidate[] = artifacts.map(item => ({ id: item.id, title: item.name, runId: item.runId, nodeId: item.nodeId, canvasId }));
  const messageText = (value: Message) => 'error' in value ? saasErrorMessage(value.error, locale) : value.text;
  // With the map closed, an outcome marks the map button (pulsing while the compilation still runs),
  // names itself in the button's label and tooltip, and is announced by the live regions below when it
  // changes. They are always present, so a change is spoken, and have no role, so the page's alerts stay
  // its own. They follow the message itself, not the map's state, so closing the map during a run says
  // nothing again; while a dialog is open they are inert and the dialog speaks for itself.
  // Nothing floats over the canvas, where it would cover controls.
  const pending = open ? null : message;
  const mark = !pending ? '' : compiling ? 'busy' : 'error' in pending ? 'error' : 'new';
  const mapName = t('知识地图', 'Knowledge map');
  const mapLabel = mark === 'busy' ? t('知识地图（正在整理资料）', 'Knowledge map (compiling)')
    : mark === 'error' ? t('知识地图（整理未完成，打开查看原因）', 'Knowledge map (compilation did not finish, open to see why)')
    : mark === 'new' ? t('知识地图（有新的整理结果）', 'Knowledge map (new compilation result)') : mapName;
  const politeText = message && !('error' in message) ? messageText(message) : '';
  const assertiveText = message && 'error' in message ? messageText(message) : '';
  const references = t(`已引用 ${selected.length} 份知识`, `${selected.length} references selected`);

  // The canvas bar also holds the assistant toggle and the run controls, and it is narrow in a small
  // window or with both side panels open. The labels give way to icons (same names and tooltips)
  // once the free width before the run controls runs out, and return when they fit with room to spare.
  useLayoutEffect(() => {
    const tools = toolsRef.current;
    const bar = tools?.parentElement;
    if (!tools || !bar || typeof ResizeObserver === 'undefined') return;
    const following = () => { const last = bar.lastElementChild; return last && last !== tools ? last : null; };
    const slack = () => {
      const own = tools.getBoundingClientRect();
      const after = following()?.getBoundingClientRect();
      // A control that has wrapped onto the next row leaves the whole rest of this row free.
      const end = after && after.top < own.bottom ? after.left : bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight || '0');
      return end - own.right;
    };
    // Where the bar wraps, it is out of room as well when the tools land on a row of their own, or when
    // they push the run controls onto the next row. On phones the run controls always take a full row
    // of their own, which does not count.
    const wrapped = () => {
      const own = tools.getBoundingClientRect();
      const before = tools.previousElementSibling?.getBoundingClientRect();
      if (before && own.top >= before.bottom) return true;
      const after = following()?.getBoundingClientRect();
      const style = getComputedStyle(bar);
      const row = bar.getBoundingClientRect().width - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
      return !!after && after.top >= own.bottom && after.width < row - 1;
    };
    // The width the labels would add, read from the labels themselves: icon-only mode hides them
    // visually but keeps them laid out, so this holds whatever state the bar was in before. The 9px
    // per label is the gap before it plus the extra padding of a labelled button (an overestimate
    // for the references label, which replaces a short count).
    const labelsWidth = () => Array.from(tools.querySelectorAll<HTMLElement>('.awwo-knowledge-tool > span, .awwo-knowledge-references-label'), label => label.scrollWidth + 9).reduce((sum, width) => sum + width, 0);
    const fit = () => {
      if (!compactRef.current) {
        if (slack() >= LABEL_ROOM && !wrapped()) return;
        compactRef.current = true; setCompact(true);
      } else if (!wrapped() && slack() >= labelsWidth() + 2 * LABEL_ROOM) {
        compactRef.current = false; setCompact(false);
      }
    };
    const sizes = new ResizeObserver(fit);
    const watch = () => { sizes.disconnect(); sizes.observe(bar); sizes.observe(tools); const after = following(); if (after) sizes.observe(after); };
    // A sibling appearing or going away (the assistant toggle comes with the first node and goes with
    // the last) moves the tools without resizing anything watched above.
    const children = new MutationObserver(() => { watch(); fit(); });
    children.observe(bar, { childList: true });
    refit.current = fit;
    watch(); fit();
    return () => { sizes.disconnect(); children.disconnect(); };
  }, []);
  // The references chip is the dock's own content: re-check before the browser paints it, so a chip that
  // only fits beside icons never shows for a frame with labels and a wrapped bar.
  useLayoutEffect(() => { refit.current(); }, [selected.length]);
  return <div ref={toolsRef} className={compact ? 'awwo-knowledge-tools is-compact' : 'awwo-knowledge-tools'}>
    <button type="button" className="awwo-knowledge-tool" aria-label={mapLabel} title={pending ? `${mapName}${t('：', ': ')}${messageText(pending)}` : mapName} onClick={openMap}><BookOpen size={15} aria-hidden="true" /><span>{mapName}</span>{mark && <i className={`awwo-knowledge-tool-mark is-${mark}`} aria-hidden="true" />}</button>
    <button type="button" className="awwo-knowledge-tool" aria-label={t('执行助手', 'Execution assistant')} title={t('执行助手', 'Execution assistant')} onClick={() => setExecutionOpen(true)}><TerminalSquare size={15} aria-hidden="true" /><span>{t('执行助手', 'Execution assistant')}</span></button>
    {selected.length > 0 && <span className="awwo-knowledge-references" title={references}><span className="awwo-knowledge-references-label">{references}</span><span className="awwo-knowledge-references-count" aria-hidden="true"><BookMarked size={13} aria-hidden="true" />{selected.length}</span>
      {!readOnly && <button type="button" aria-label={t('清除任务知识引用', 'Clear task knowledge references')} onClick={() => { configureCanvasKnowledge([]); setSelected([]); }}><X size={13} aria-hidden="true" /></button>}</span>}
    <span className="saas-visually-hidden" aria-live="polite">{politeText}</span>
    <span className="saas-visually-hidden" aria-live="assertive">{assertiveText}</span>
    {executionOpen && <WorkbenchOverlay label={t('执行助手', 'Execution assistant')} onClose={() => setExecutionOpen(false)}><ManagedExecutionPanel tenantId={tenantId} canvasId={canvasId} knowledgeReferences={selected} readOnly={readOnly}
      onClose={() => setExecutionOpen(false)}
      onImported={() => setWorkbenchVersion(value => value + 1)} /></WorkbenchOverlay>}
    {open && <WorkbenchOverlay label={t('知识地图工作台', 'Knowledge workbench')} onClose={closeMap}>
      {readError !== null && <p className="awwo-knowledge-dock-error" role="alert">{saasErrorMessage(readError, locale)}</p>}
      {message && <p className={'error' in message ? 'awwo-knowledge-dock-error' : 'awwo-knowledge-dock-notice'} role={'error' in message ? 'alert' : 'status'}>{messageText(message)}</p>}
      {!readOnly && recent.length > 0 && <div className="awwo-knowledge-resume"><label>{t('历史整理任务', 'Previous compilations')}<select value={recentId} disabled={compiling} onChange={event => setRecentId(event.target.value)}>{recent.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} · {item.status}</option>)}</select></label><button type="button" disabled={compiling || !recentId} onClick={() => {
        const scope = new AbortController();
        void boundedApi<Compilation>(tenantPath(tenantId, `/knowledge/compilations/${encodeURIComponent(recentId)}`), { signal: scope.signal }).then(async result => {
          if (!mounted.current || !result.knowledge?.items.length) return;
          compilation.current = { id: result.id, refs: result.knowledge.items };
          await compile('', result.knowledge.items);
        }).catch(cause => { if (mounted.current) setMessage({ error: cause }); });
      }}>{t('继续读取并生成提案', 'Resume and save proposals')}</button></div>}
      <KnowledgeWorkbench key={workbenchVersion} tenantId={tenantId} canvasId={canvasId} readOnly={readOnly} artifacts={candidates} onClose={closeMap} onCompile={readOnly ? undefined : compile}
        onTaskContext={(_context, refs) => {
          if (readOnly) return;
          configureCanvasKnowledge(refs.map(item => item.revisionId)); setSelected(refs);
          onTaskDraft?.({ id: crypto.randomUUID(), prompt: t('请结合已选知识完成任务：', 'Use the selected knowledge to complete this task:') });
          closeMap();
        }} />
    </WorkbenchOverlay>}
  </div>;
}
