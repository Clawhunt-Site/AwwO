import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import { CanvasPreviewDesk } from '../canvas/CanvasPreviewDesk';
import { api, saasErrorMessage, tenantPath } from './api';
import { configureCanvasKnowledge } from './canvasBridge';
import { KnowledgeWorkbench, type KnowledgeArtifactCandidate } from './KnowledgeWorkbench';
import { OpenMausBridgePanel } from './OpenMausBridgePanel';
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
interface Props { tenantId: string; canvasId: string; readOnly?: boolean; onTaskDraft?: (draft: CanvasTaskDraft) => void }
const requestSignal = (signal?: AbortSignal | null) => signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
const boundedApi = <T,>(path: string, init: RequestInit = {}) => api<T>(path, { ...init, signal: requestSignal(init.signal) });

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
  const [externalOpen, setExternalOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState<KnowledgeContextItem[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [recent, setRecent] = useState<{id:string;status:string}[]>([]);
  const [recentId, setRecentId] = useState('');
  const [workbenchVersion, setWorkbenchVersion] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const compilation = useRef<{ id: string; refs: KnowledgeContextItem[] } | null>(null);
  const compileOperation = useRef<{ id: string; key: string } | null>(null);
  const mounted = useRef(true);
  const artifactGeneration = useRef(0);
  const artifactInFlight = useRef<number | null>(null);
  const refresh = useCallback(async (signal: AbortSignal) => {
    if (artifactInFlight.current !== null) return;
    const generation = ++artifactGeneration.current;
    artifactInFlight.current = generation;
    setRefreshing(true);
    try {
      const result = await boundedApi<{ items: Artifact[] }>(tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/artifacts`), { signal });
      if (!Array.isArray(result.items) || result.items.some(x => !x || typeof x.id !== 'string' || typeof x.name !== 'string')) throw new Error('Invalid artifact response');
      if (!signal.aborted && mounted.current && generation === artifactGeneration.current) { setArtifacts(result.items); setError(''); }
    } catch (cause) {
      if (!signal.aborted && mounted.current && generation === artifactGeneration.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (artifactInFlight.current === generation) artifactInFlight.current = null;
      if (mounted.current && generation === artifactGeneration.current) setRefreshing(false);
    }
  }, [tenantId, canvasId]);
  useEffect(() => {
    mounted.current = true;
    const scope = new AbortController();
    void refresh(scope.signal);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(scope.signal); }, 15000);
    return () => {
      mounted.current = false;
      artifactGeneration.current++;
      artifactInFlight.current = null;
      scope.abort();
      controller.current?.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const scope = new AbortController();
    boundedApi<{items:{id:string;status:string}[]}>(tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/knowledge-compilations`), { signal: scope.signal })
      .then(value => { if (!scope.signal.aborted && Array.isArray(value.items)) { setRecent(value.items); setRecentId(value.items[0]?.id || ''); } })
      .catch(cause => { if (!scope.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => scope.abort();
  }, [open, tenantId, canvasId]);

  const compile = async (_prompt: string, refs: KnowledgeContextItem[]) => {
    if (readOnly || controller.current) throw new Error(t('当前无法提交整理任务。', 'Compilation is not available.'));
    const scope = new AbortController(); controller.current = scope; setCompiling(true);
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
      setNotice(t('模型正在整理资料；完成后生成待审核提案。', 'Compiling selected evidence into reviewable proposals.'));
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
          setNotice(t(`已生成 ${result.pages.length} 份待审核提案。`, `${result.pages.length} proposals are ready for review.`));
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
    } finally { controller.current = null; if (mounted.current) setCompiling(false); }
  };
  const candidates: KnowledgeArtifactCandidate[] = artifacts.map(item => ({ id: item.id, title: item.name, runId: item.runId, nodeId: item.nodeId, canvasId }));
  return <div className={`awwo-knowledge-dock${focused ? ' is-focused' : ''}`}>
    <div className="awwo-knowledge-dock-bar"><button type="button" onClick={() => setOpen(true)}><BookOpen size={15} />{t('知识地图', 'Knowledge map')}</button>
      <button type="button" onClick={() => setExternalOpen(true)} aria-label={t('OpenMaus 外部执行连接', 'OpenMaus external execution')}>OpenMaus</button>
      <span>{selected.length ? t(`已引用 ${selected.length} 份知识`, `${selected.length} references selected`) : t('知识 → 协作 → 产物', 'Knowledge → Work → Artifacts')}</span>
      {selected.length > 0 && !readOnly && <button type="button" aria-label={t('清除任务知识引用', 'Clear task knowledge references')} onClick={() => { configureCanvasKnowledge([]); setSelected([]); }}><X size={14} /></button>}
      <button type="button" disabled={refreshing} aria-label={t('刷新画布产物', 'Refresh canvas artifacts')} onClick={() => { const next = new AbortController(); void refresh(next.signal); }}><RefreshCw size={14} /></button>
      <button type="button" aria-label={focused ? t('恢复画布与预览', 'Restore canvas and previews') : t('聚焦四窗预览', 'Focus all four previews')} aria-pressed={focused} onClick={() => setFocused(value => !value)}>{focused ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
    </div>
    {error && <p className="awwo-knowledge-dock-error" role="alert">{saasErrorMessage(error, locale)}</p>}
    {notice && <p className="awwo-knowledge-dock-notice" role="status">{notice}</p>}
    <CanvasPreviewDesk scopeKey={`${tenantId}/${canvasId}`} artifacts={artifacts.map(item => ({ reference: `awwo-file:${item.id}`, title: item.name, name: item.name, identity: item.id }))} />
    {externalOpen && <WorkbenchOverlay label={t('OpenMaus 外部执行', 'OpenMaus execution')} onClose={() => setExternalOpen(false)}><OpenMausBridgePanel tenantId={tenantId} readOnly={readOnly} onClose={() => setExternalOpen(false)} onImported={() => { setNotice(t('外部结果已保存为知识资料，可在知识地图中核对。', 'External result saved as evidence. Review it in the knowledge map.')); }} /></WorkbenchOverlay>}
    {open && <WorkbenchOverlay label={t('知识地图工作台', 'Knowledge workbench')} onClose={() => setOpen(false)}>
      {error && <p className="awwo-knowledge-dock-error" role="alert">{saasErrorMessage(error, locale)}</p>}
      {!readOnly && recent.length > 0 && <div className="awwo-knowledge-resume"><label>{t('历史整理任务', 'Previous compilations')}<select value={recentId} disabled={compiling} onChange={event => setRecentId(event.target.value)}>{recent.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} · {item.status}</option>)}</select></label><button type="button" disabled={compiling || !recentId} onClick={() => {
        const scope = new AbortController();
        void boundedApi<Compilation>(tenantPath(tenantId, `/knowledge/compilations/${encodeURIComponent(recentId)}`), { signal: scope.signal }).then(async result => {
          if (!mounted.current || !result.knowledge?.items.length) return;
          compilation.current = { id: result.id, refs: result.knowledge.items };
          await compile('', result.knowledge.items);
        }).catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); });
      }}>{t('继续读取并生成提案', 'Resume and save proposals')}</button></div>}
      <KnowledgeWorkbench key={workbenchVersion} tenantId={tenantId} canvasId={canvasId} readOnly={readOnly} artifacts={candidates} onClose={() => setOpen(false)} onCompile={readOnly ? undefined : compile}
        onTaskContext={(_context, refs) => {
          if (readOnly) return;
          configureCanvasKnowledge(refs.map(item => item.revisionId)); setSelected(refs);
          setFocused(false);
          onTaskDraft?.({ id: crypto.randomUUID(), prompt: t('请结合已选知识完成任务：', 'Use the selected knowledge to complete this task:') });
          setNotice(t('已固定资料版本。请在任务输入框中描述目标。', 'Evidence versions are fixed. Describe your goal in the task input.')); setOpen(false);
        }} />
    </WorkbenchOverlay>}
  </div>;
}
