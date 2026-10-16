// 从网址读取 in simple mode (普通模式). The knowledge map is a developer-mode tool, so a simple canvas gets just its web
// reader in the canvas bar: one public page read by the server (the same reader, allowance and refusals as the map's
// import panel) and saved to the workspace's knowledge, then, if asked, cited by the canvas's next tasks through the
// same knowledge references the map's 加入任务 sets (the assistant's planning and the node runs take them). Shown only
// to a workspace whose server reads the web; while references are set, a chip says so and clears them.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { BookMarked, Globe, Loader2, X } from 'lucide-react';
import { saasErrorMessage } from './api';
import { canvasKnowledgeRevisionIds, configureCanvasKnowledge } from './canvasBridge';
import { readCapabilities, type WorkspaceCapabilities } from './capabilitiesApi';
import type { CanvasTaskDraft } from './CanvasKnowledgeDock';
import { importKnowledgeFromWeb, KNOWLEDGE_CONTEXT_ITEMS, readKnowledgeRevisionContext, type KnowledgeDocument } from './knowledgeApi';
import { useSaaSPreferences } from './preferences';
import { useCanvasKnowledgeCount } from './useCanvasKnowledgeCount';
import './canvas-knowledge-dock.css';
import './canvas-web-reader.css';

interface Props { tenantId: string; canvasId: string; onTaskDraft?: (draft: CanvasTaskDraft) => void }
type Reader = WorkspaceCapabilities['webReader'];
const ADDRESS = /^https?:\/\/\S+$/i;
const EXCERPT = 280;
/** While the day's reads are used up, the allowance is read again this often, so the UTC day's reset shows. */
const EXHAUSTED_RECHECK_MS = 60_000;

/** The page's host, for the saved page's caption; nothing for an address that does not parse. */
function hostOf(uri: string): string {
  try { return new URL(uri).host; } catch { return ''; }
}
function excerptOf(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text;
}

export function CanvasWebReader(props: Props) {
  return <Tool key={`${props.tenantId}/${props.canvasId}`} {...props} />;
}

function Tool({ tenantId, onTaskDraft }: Props) {
  const { t } = useSaaSPreferences();
  const [reader, setReader] = useState<Reader | null>(null);
  // Bumped when the dialog opens, after each read and while the allowance is used up: the server's count is the only
  // one shown (a refused read may not count, a retried read is answered from the first).
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const cited = useCanvasKnowledgeCount();
  useEffect(() => {
    const scope = new AbortController();
    readCapabilities(tenantId, scope.signal).then(value => { if (!scope.signal.aborted) setReader(value.webReader); }, () => undefined);
    return () => scope.abort();
  }, [tenantId, refresh]);
  const recheck = useCallback(() => setRefresh(count => count + 1), []);
  if (!reader?.enabled && cited === 0) return null;
  const references = t(`已引用 ${cited} 份知识`, `${cited} references selected`);
  return <div className="awwo-knowledge-tools awwo-web-reader-tools">
    {reader?.enabled && <button type="button" className="awwo-knowledge-tool" aria-haspopup="dialog" title={t('从网址读取一个公开网页，存入工作区知识', 'Read a public web page into the workspace’s knowledge')}
      onClick={() => { recheck(); setOpen(true); }}><Globe size={15} aria-hidden="true" /><span>{t('从网址读取', 'Read a web page')}</span></button>}
    {cited > 0 && <span className="awwo-knowledge-references" title={references}><span className="awwo-knowledge-references-label">{references}</span>
      <span className="awwo-knowledge-references-count" aria-hidden="true"><BookMarked size={13} aria-hidden="true" />{cited}</span>
      <button type="button" aria-label={t('清除任务知识引用', 'Clear task knowledge references')} onClick={() => configureCanvasKnowledge([])}><X size={13} aria-hidden="true" /></button></span>}
    {open && reader?.enabled && <ReaderDialog tenantId={tenantId} reader={reader} cited={cited} onRecheck={recheck} onTaskDraft={onTaskDraft} onClose={() => setOpen(false)} />}
  </div>;
}

interface DialogProps { tenantId: string; reader: Reader; cited: number; onRecheck: () => void; onTaskDraft?: (draft: CanvasTaskDraft) => void; onClose: () => void }

function ReaderDialog({ tenantId, reader, cited, onRecheck, onTaskDraft, onClose }: DialogProps) {
  const { t, locale } = useSaaSPreferences();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'read' | 'cite' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<KnowledgeDocument | null>(null);
  // One operation per address, as in the map's import panel: a second click while the page is still being read, or a
  // retry of the same address, is answered for the same read instead of starting another.
  const operations = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal?.();
    return () => { alive.current = false; if (element?.open) element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const exhausted = reader.usedToday >= reader.perDay;
  useEffect(() => {
    if (!exhausted) return;
    const timer = window.setInterval(onRecheck, EXHAUSTED_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [exhausted, onRecheck]);
  const ready = busy === null && !exhausted && ADDRESS.test(url.trim());
  // A read cannot be called back once the server has it, so the dialog stays until it answers.
  const close = () => { if (busy === null) onClose(); };
  const read = async () => {
    const address = url.trim();
    if (!ready) return;
    const key = `web:${JSON.stringify({ url: address })}`;
    let operationId = operations.current.get(key);
    if (!operationId) { operationId = `knowledge-${crypto.randomUUID()}`; operations.current.set(key, operationId); }
    setBusy('read'); setProblem(null); setSaved(null);
    try {
      const value = await importKnowledgeFromWeb(tenantId, { url: address, operationId }, new AbortController().signal);
      if (alive.current) { setSaved(value); setUrl(''); }
    } catch (cause) {
      if (alive.current) setProblem(saasErrorMessage(cause, locale));
    } finally {
      if (alive.current) setBusy(null);
      onRecheck();
    }
  };
  // Added to what the canvas already cites, after the server has checked the whole selection as a plan or a run would
  // (at most eight, 64 KiB in all), so a page too large to carry is said here rather than when the task starts.
  const cite = async () => {
    if (!saved || busy !== null) return;
    const ids = [...new Set([...canvasKnowledgeRevisionIds(), saved.currentRevisionId])];
    if (ids.length > KNOWLEDGE_CONTEXT_ITEMS) {
      setProblem(t(`一次任务最多引用 ${KNOWLEDGE_CONTEXT_ITEMS} 份知识，请先清除已引用的知识。`, `A task cites at most ${KNOWLEDGE_CONTEXT_ITEMS} knowledge items. Clear the selected ones first.`));
      return;
    }
    setBusy('cite'); setProblem(null);
    try {
      // The knowledge API bounds the request itself (15 s) and says a timeout in words.
      await readKnowledgeRevisionContext(tenantId, ids, new AbortController().signal);
      if (!alive.current) return;
      configureCanvasKnowledge(ids);
    } catch (cause) {
      if (alive.current) { setProblem(saasErrorMessage(cause, locale)); setBusy(null); }
      return;
    }
    onTaskDraft?.({ id: crypto.randomUUID(), prompt: t(`请结合网页「${saved.title}」完成任务：`, `Use the web page “${saved.title}” to complete this task:`) });
    setBusy(null);
    onClose();
  };
  return <dialog ref={dialog} className="saas-native-dialog awwo-web-reader" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <form className="saas-card" onSubmit={event => { event.preventDefault(); void read(); }}>
      <header><Globe size={17} aria-hidden="true" /><h2 id={titleId}>{t('从网址读取', 'Read a web page')}</h2>
        <button type="button" className="awwo-web-reader-close" aria-label={t('关闭', 'Close')} disabled={busy !== null} onClick={close}><X size={16} aria-hidden="true" /></button></header>
      <p className="awwo-web-reader-help">{t(`由服务器读取一个公开网页并保存正文：遵守 robots.txt，不访问本机或内网地址。今天已用 ${reader.usedToday} / ${reader.perDay} 次。`,
        `The server reads one public page and saves its text. It honours robots.txt and never reaches local or private addresses. Used today: ${reader.usedToday} / ${reader.perDay}.`)}</p>
      <div className="awwo-web-reader-field">
        <input type="text" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://" aria-label={t('网页地址', 'Web address')} value={url} readOnly={busy !== null}
          onChange={event => setUrl(event.target.value)} />
        <button type="submit" className="saas-primary" disabled={!ready}>{busy === 'read' ? <><Loader2 size={14} aria-hidden="true" className="awwo-web-reader-spin" />{t('读取中…', 'Reading…')}</> : t('读取并保存', 'Read and save')}</button>
      </div>
      {exhausted && !saved && <p className="awwo-web-reader-note">{t('今天的网页读取次数已用完，请在 UTC 次日再试。', 'Today’s web reads are used up. Try again after the next UTC day.')}</p>}
      {problem && <p className="saas-error" role="alert">{problem}</p>}
      {saved && <section className="awwo-web-reader-result" aria-label={t('已保存的网页', 'Saved page')}>
        <p className="awwo-web-reader-saved" role="status">{t('已存入工作区知识，读取记录（地址、时间、robots.txt）在来源信息里。', 'Saved to the workspace’s knowledge, with the read (address, time, robots.txt) in its provenance.')}</p>
        <h3>{saved.title}</h3>
        {hostOf(saved.sourceUri) && <p className="awwo-web-reader-source">{hostOf(saved.sourceUri)}</p>}
        <p className="awwo-web-reader-excerpt">{excerptOf(saved.content)}</p>
        <p className="awwo-web-reader-note">{cited > 0
          ? t(`加入任务会把这份网页加到已引用的 ${cited} 份知识里；画布助手接下来的规划和运行的节点都会引用它们，直到清除或离开画布。`, `Added to the task, the page joins the ${cited} items already cited; the assistant’s next plan and the nodes that run cite them all until you clear them or leave the canvas.`)
          : t('加入任务后，画布助手接下来的规划和运行的节点都会引用这份网页正文，直到清除或离开画布。', 'Added to the task, the page text is cited by the assistant’s next plan and by the nodes that run, until you clear it or leave the canvas.')}</p>
        <footer><button type="button" disabled={busy !== null} onClick={close}>{t('完成', 'Done')}</button>
          <button type="button" className="saas-primary" disabled={busy !== null} onClick={() => { void cite(); }}>{busy === 'cite' ? t('正在核对…', 'Checking…') : t('加入任务', 'Add to task')}</button></footer>
      </section>}
    </form>
  </dialog>;
}
