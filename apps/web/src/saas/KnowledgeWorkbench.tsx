import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Check, FileText, GitBranch, History, Import, Link2, Plus, RefreshCw, Search, Sparkles, X, ZoomIn, ZoomOut } from 'lucide-react';
import { SaaSApiError, saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';
import {
  acceptKnowledgeProposal, createKnowledgeProposal, createKnowledgeSource, knowledgeCompilePrompt,
  KNOWLEDGE_CONTENT_BYTES, KNOWLEDGE_CONTEXT_ITEMS, readKnowledge, readKnowledgeContext,
  readKnowledgeRevisions, rejectKnowledgeProposal, restoreKnowledgeRevision,
  type KnowledgeContextItem, type KnowledgeDocument, type KnowledgeKind, type KnowledgeLink,
  type KnowledgeLinkDraft, type KnowledgeProposal, type KnowledgeProposalInput, type KnowledgeRelation,
  type KnowledgeRevision, type KnowledgeSnapshot,
} from './knowledgeApi';
import './knowledge-workbench.css';

export interface KnowledgeArtifactCandidate {
  id: string; title: string; kind?: string; runId?: string; nodeId?: string; canvasId?: string;
}
export interface KnowledgeWorkbenchProps {
  tenantId: string;
  canvasId?: string;
  onTaskContext: (context: string, refs: KnowledgeContextItem[]) => void | Promise<void>;
  onCompile?: (prompt: string, refs: KnowledgeContextItem[]) => void | Promise<void>;
  onClose?: () => void;
  artifacts?: KnowledgeArtifactCandidate[];
  readOnly?: boolean;
}
type Translate = (zh: string, en: string) => string;
type Panel = 'document' | 'source' | 'proposal' | 'review' | 'artifacts' | 'evidence';
interface EvidenceReference { documentId: string; revisionId: string; title: string; contentHash: string }
type ProposalDraft = Omit<KnowledgeProposalInput, 'operationId'> & { content: string; sourceIds: string[]; links: KnowledgeLinkDraft[]; sourceRevisions: Record<string, string> };
const emptySnapshot = (): KnowledgeSnapshot => ({ documents: [], links: [], proposals: [] });
const emptyDraft = (): ProposalDraft => ({ kind: 'page', title: '', content: '', baseVersion: 0, sourceIds: [], links: [], sourceRevisions: {} });
function evidenceReferences(provenance: Record<string, unknown>): EvidenceReference[] {
  if (!Array.isArray(provenance.sourceRevisions)) return [];
  return provenance.sourceRevisions.filter((value): value is EvidenceReference => !!value && typeof value === 'object'
    && ['documentId', 'revisionId', 'title', 'contentHash'].every(key => typeof value[key] === 'string'));
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
const kindName = (kind: KnowledgeKind, t: Translate) => ({ source: t('原始资料', 'Source'), page: t('知识页面', 'Page'), decision: t('决策记录', 'Decision') })[kind];
const relationName = (relation: KnowledgeRelation, t: Translate) => ({ links_to: t('关联', 'Related to'), cites: t('引用', 'Cites'), supports: t('支持', 'Supports'), contradicts: t('反驳', 'Contradicts'), derived_from: t('源自', 'Derived from') })[relation];
const relationTypes: KnowledgeRelation[] = ['links_to', 'cites', 'supports', 'contradicts', 'derived_from'];
const safeUrl = (value: string): string | undefined => /^https?:\/\//i.test(value) ? value : undefined;
const shortDate = (value: string, locale: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : value;

/** A workspace switch remounts all state before old evidence can be shown or sent. */
export function KnowledgeWorkbench(props: KnowledgeWorkbenchProps) {
  return <KnowledgeWorkbenchView key={JSON.stringify([props.tenantId, props.canvasId ?? ''])} {...props} />;
}

function KnowledgeWorkbenchView({ tenantId, canvasId, onTaskContext, onCompile, onClose, artifacts = [], readOnly = false }: KnowledgeWorkbenchProps) {
  const { t, locale } = useSaaSPreferences();
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot>(emptySnapshot);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KnowledgeKind | 'all'>('all');
  const [relationFilter, setRelationFilter] = useState<KnowledgeRelation | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [panel, setPanel] = useState<Panel>('document');
  const [rail, setRail] = useState<'documents' | 'proposals'>('documents');
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceReference | null>(null);
  const [sourceTitle, setSourceTitle] = useState('');
  const [sourceContent, setSourceContent] = useState('');
  const [sourceUri, setSourceUri] = useState('');
  const [draft, setDraft] = useState<ProposalDraft>(emptyDraft);
  const [linkTarget, setLinkTarget] = useState('');
  const [linkRelation, setLinkRelation] = useState<KnowledgeRelation>('links_to');
  const [artifactId, setArtifactId] = useState('');
  const [artifactAction, setArtifactAction] = useState<'source' | 'proposal'>('source');
  const [artifactTitle, setArtifactTitle] = useState('');
  const [artifactSources, setArtifactSources] = useState<string[]>([]);
  const controllers = useRef(new Set<AbortController>());
  const alive = useRef(true);
  const lock = useRef(false);
  const readGeneration = useRef(0);
  const operations = useRef(new Map<string, string>());
  const searchQuery = useRef('');
  const knownDocuments = useRef(new Map<string, KnowledgeDocument>());
  const retainedDocumentIds = useRef(new Set<string>());
  retainedDocumentIds.current = new Set([...selectedIds, ...draft.sourceIds, ...(selectedId ? [selectedId] : [])]);
  const fileInput = useRef<HTMLInputElement>(null);
  const documentMap = useMemo(() => new Map([...knownDocuments.current, ...snapshot.documents.map(item => [item.id, item] as const)]), [snapshot.documents]);
  const selected = selectedId ? documentMap.get(selectedId) ?? null : null;
  const proposal = snapshot.proposals.find(item => item.id === proposalId) ?? null;
  const visible = useMemo(() => snapshot.documents.filter(item => (kindFilter === 'all' || item.kind === kindFilter)
    && (!query.trim() || normalize(`${item.title}\n${item.content}`).includes(normalize(query.trim())))), [snapshot.documents, query, kindFilter]);
  const draftCount = snapshot.proposals.filter(item => item.status === 'draft').length;
  const operationId = (key: string) => {
    const existing = operations.current.get(key);
    if (existing) return existing;
    const id = `knowledge-${crypto.randomUUID()}`;
    operations.current.set(key, id); return id;
  };
  const request = useCallback(async <T,>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const value = await fn(controller.signal);
      return !controller.signal.aborted && alive.current ? value : undefined;
    } catch (error) { if (controller.signal.aborted) return undefined; throw error; }
    finally { controllers.current.delete(controller); }
  }, []);
  const handleError = useCallback((value: unknown) => {
    setError(value);
    if (value instanceof SaaSApiError && [401, 403, 404].includes(value.status)) {
      knownDocuments.current.clear(); setSnapshot(emptySnapshot()); setLoaded(false); setSelectedId(null); setSelectedIds([]);
      setDraft(emptyDraft()); setEvidence(null); setPanel('document');
    }
  }, []);
  const reload = useCallback(async () => {
    const generation = ++readGeneration.current;
    setLoading(true);
    try {
      const value = await request(signal => readKnowledge(tenantId, signal, searchQuery.current));
      if (!value || generation !== readGeneration.current) return;
      const returnedIds = new Set(value.documents.map(item => item.id));
      for (const id of knownDocuments.current.keys()) if (!returnedIds.has(id) && !retainedDocumentIds.current.has(id)) knownDocuments.current.delete(id);
      value.documents.forEach(item => knownDocuments.current.set(item.id, item));
      setSnapshot(value); setLoaded(true); setError(null);
      setSelectedId(id => id && value.documents.some(item => item.id === id) ? id : value.documents[0]?.id ?? null);
    } catch (value) { if (alive.current && generation === readGeneration.current) handleError(value); }
    finally { if (alive.current && generation === readGeneration.current) setLoading(false); }
  }, [tenantId, request, handleError]);
  useEffect(() => {
    alive.current = true; void reload();
    return () => { alive.current = false; controllers.current.forEach(item => item.abort()); controllers.current.clear(); };
  }, [reload]);

  const action = async (fn: (signal: AbortSignal) => Promise<void>, refresh = true) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setNotice('');
    try {
      await request(fn);
      if (alive.current && refresh) await reload();
    } catch (value) { if (alive.current) handleError(value); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const select = (id: string) => { setSelectedId(id); setPanel('document'); };
  const selectEvidence = (ref: EvidenceReference) => { setEvidence(ref); setPanel('evidence'); };
  const toggleContext = (id: string) => {
    setSelectedIds(ids => {
      if (ids.includes(id)) return ids.filter(value => value !== id);
      if (ids.length >= KNOWLEDGE_CONTEXT_ITEMS) { setError(new Error(t('一次最多选择 8 份资料。', 'Select at most 8 documents at once.'))); return ids; }
      return [...ids, id];
    });
  };
  const newProposal = (existing?: KnowledgeDocument) => {
    const existingLinks = existing ? snapshot.links.filter(link => link.fromDocumentId === existing.id).map(({ toDocumentId, relation }) => ({ toDocumentId, relation })) : [];
    const fixedRefs = existing ? evidenceReferences(existing.provenance) : [];
    setDraft(existing ? { documentId: existing.id, kind: existing.kind === 'decision' ? 'decision' : 'page', title: existing.title,
      content: existing.content, baseVersion: existing.version, sourceIds: existingLinks.filter(link => link.relation === 'cites').map(link => link.toDocumentId),
      sourceRevisions: Object.fromEntries(fixedRefs.map(ref => [ref.documentId, ref.revisionId])), links: existingLinks.filter(link => link.relation !== 'cites') }
      : { ...emptyDraft(), sourceIds: selectedIds, sourceRevisions: Object.fromEntries(selectedIds.map(id => [id, documentMap.get(id)!.currentRevisionId])) });
    setPanel('proposal'); setError(null); setLinkTarget('');
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (!/\.(md|markdown|txt)$/i.test(file.name) || file.size > KNOWLEDGE_CONTENT_BYTES) {
      setError(new Error(t('请选择不超过 256 KiB 的 Markdown 或文本文件。', 'Choose a Markdown or text file up to 256 KiB.'))); return;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!alive.current) return;
      setSourceTitle(file.name.replace(/\.(md|markdown|txt)$/i, '')); setSourceContent(text); setError(null);
    } catch { if (alive.current) setError(new Error(t('无法读取 UTF-8 文本，请检查文件编码。', 'Could not read UTF-8 text. Check the file encoding.'))); }
    if (fileInput.current) fileInput.current.value = '';
  };
  const saveSource = () => void action(async signal => {
    const input = { title: sourceTitle.trim(), content: sourceContent, ...(sourceUri.trim() ? { sourceUri: sourceUri.trim() } : {}) };
    const result = await createKnowledgeSource(tenantId, { ...input, operationId: operationId(`source:${JSON.stringify(input)}`) }, signal);
    if (signal.aborted) return;
    setSelectedId(result.id); setPanel('document'); setSourceTitle(''); setSourceContent(''); setSourceUri('');
    setNotice(t('原始资料已入库，可以据此新建知识提案。', 'Source saved. You can now create a knowledge proposal.'));
  });
  const saveProposal = () => void action(async signal => {
    const { sourceRevisions, ...proposalDraft } = draft;
    const input = { ...proposalDraft, title: draft.title.trim(), sourceRevisionIds: draft.sourceIds.map(id => sourceRevisions[id] ?? documentMap.get(id)?.currentRevisionId).filter((id): id is string => !!id) };
    const result = await createKnowledgeProposal(tenantId, { ...input, operationId: operationId(`proposal:${JSON.stringify(input)}`) }, signal);
    if (signal.aborted) return;
    setProposalId(result.id); setPanel('review'); setRail('proposals'); setDraft(emptyDraft());
    setNotice(t('提案已保存，审核通过后会更新知识图谱。', 'Proposal saved. Accept it to update the knowledge graph.'));
  });
  const resolveProposal = (item: KnowledgeProposal, accept: boolean) => void action(async signal => {
    const id = operationId(`${accept ? 'accept' : 'reject'}:${item.id}:${item.baseVersion}`);
    if (accept) {
      const value = await acceptKnowledgeProposal(tenantId, item.id, id, signal);
      if (signal.aborted) return;
      setSelectedId(value.id); setNotice(t('提案已通过，页面与关系已保存。', 'Proposal accepted. Its page and relationships are saved.'));
    } else {
      await rejectKnowledgeProposal(tenantId, item.id, id, signal);
      if (signal.aborted) return;
      setNotice(t('已拒绝提案，现有知识未改变。', 'Proposal rejected. Existing knowledge is unchanged.'));
    }
  });
  const useContext = (compile = false) => void action(async signal => {
    const context = await readKnowledgeContext(tenantId, selectedIds, signal);
    if (signal.aborted) return;
    if (compile) await (onCompile ?? onTaskContext)(knowledgeCompilePrompt(context), context.items);
    else await onTaskContext(context.text, context.items);
    if (signal.aborted) return;
    setNotice(compile ? onCompile ? t('知识整理已完成，请查看待审提案。', 'Knowledge compilation completed. Review the pending proposals.') : t('已将资料和整理要求交给任务编辑器。', 'Sources and compilation instructions were sent to the task composer.')
      : t('已加入任务上下文，引用固定到本次读取的版本。', 'Added to the task with references pinned to the versions read.'));
  }, compile);
  const saveArtifact = () => void action(async signal => {
    const input = { artifactId, title: artifactTitle.trim() || artifacts.find(item => item.id === artifactId)?.title || t('任务产物', 'Task artifact') };
    if (artifactAction === 'source') {
      const value = await createKnowledgeSource(tenantId, { ...input, operationId: operationId(`artifact-source:${JSON.stringify(input)}`) }, signal);
      if (signal.aborted) return;
      setSelectedId(value.id); setPanel('document'); setNotice(t('产物已作为原始资料入库，保留运行来源。', 'Artifact saved as a source with its run provenance.'));
    } else {
      const inputProposal = { ...input, kind: 'page' as const, baseVersion: 0, sourceIds: artifactSources, sourceRevisionIds: artifactSources.map(id => documentMap.get(id)?.currentRevisionId).filter((id): id is string => !!id), links: [] };
      const value = await createKnowledgeProposal(tenantId, { ...inputProposal, operationId: operationId(`artifact-proposal:${JSON.stringify(inputProposal)}`) }, signal);
      if (signal.aborted) return;
      setProposalId(value.id); setPanel('review'); setRail('proposals'); setNotice(t('产物已生成提案，请检查引用和内容后审核。', 'Artifact proposal created. Review its content and citations.'));
    }
  });
  const restore = (doc: KnowledgeDocument, revision: KnowledgeRevision) => void action(async signal => {
    const value = await restoreKnowledgeRevision(tenantId, doc.id, revision.id, doc.version, operationId(`restore:${doc.id}:${revision.id}:${doc.version}`), signal);
    if (signal.aborted) return;
    setSelectedId(value.id); setNotice(t('已创建恢复版本，完整历史仍然保留。', 'A restored version was created. The full history is retained.'));
  });
  const conflict = error instanceof SaaSApiError && (error.status === 409 || /conflict/.test(error.code));

  return <section className="knowledge-workbench" aria-label={t('知识工作台', 'Knowledge workbench')}>
    <header className="knowledge-header">
      <div className="knowledge-heading"><span className="knowledge-mark"><GitBranch size={22} /></span><div><h2>{t('知识工作台', 'Knowledge workbench')}</h2><p>{t('让资料成为可追溯、可复用的知识', 'Turn sources into traceable, reusable knowledge')}</p></div></div>
      <div className="knowledge-header-actions">
        <button type="button" disabled={loading || busy} onClick={() => void reload()} aria-label={t('刷新知识库', 'Refresh knowledge')}><RefreshCw size={16} /></button>
        {!readOnly && <button type="button" onClick={() => { setPanel('artifacts'); setArtifactSources(selectedIds.filter(id => documentMap.get(id)?.kind === 'source')); }}><Import size={16} />{t('产物入库', 'Save artifact')}</button>}
        {!readOnly && <button className="knowledge-primary" type="button" onClick={() => { setPanel('source'); setError(null); }}><Plus size={16} />{t('导入资料', 'Import source')}</button>}
        {onClose && <button type="button" onClick={onClose} aria-label={t('关闭知识工作台', 'Close knowledge workbench')}><X size={19} /></button>}
      </div>
    </header>
    {error !== null && <div className="knowledge-alert" role="alert"><span>{conflict
      ? t('知识版本已变化，未覆盖新内容。请刷新并对照最新版本重新创建提案；当前草稿已保留。', 'Knowledge changed. No newer content was overwritten. Refresh and compare before creating a new proposal; your draft is retained.')
      : saasErrorMessage(error, locale)}</span><button type="button" disabled={loading || busy} onClick={() => void reload()}>{t('重新读取', 'Reload')}</button></div>}
    {notice && <div className="knowledge-notice" role="status"><Check size={15} />{notice}</div>}
    {loading && !loaded && <p className="knowledge-loading" role="status">{t('正在读取知识库…', 'Loading knowledge…')}</p>}
    {snapshot.truncated && <p className="knowledge-limit" role="status">{t('资料较多，当前只显示部分记录。输入关键词并点击搜索，可检索完整知识库。', 'Only part of this large library is shown. Enter keywords and search to query the full knowledge base.')}</p>}
    <div className="knowledge-body">
      <aside className="knowledge-library" aria-label={t('资料目录', 'Knowledge library')}>
        <div className="knowledge-tabs"><button type="button" aria-pressed={rail === 'documents'} onClick={() => setRail('documents')}>{t('资料', 'Documents')} <span>{snapshot.documents.length}</span></button><button type="button" aria-pressed={rail === 'proposals'} onClick={() => setRail('proposals')}>{t('提案', 'Proposals')} <span>{draftCount}</span></button></div>
        {rail === 'documents' ? <>
          <form className="knowledge-search" onSubmit={event => { event.preventDefault(); searchQuery.current = query.trim(); void reload(); }}><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索标题与内容', 'Search titles and content')} aria-label={t('搜索知识库', 'Search knowledge')} /><button type="submit" disabled={loading || busy} aria-label={t('搜索完整知识库', 'Search the full knowledge base')}><Search size={15} /></button></form>
          {searchQuery.current && <button className="knowledge-clear-search" type="button" disabled={loading || busy} onClick={() => { setQuery(''); searchQuery.current = ''; void reload(); }}>{t('清除服务器搜索', 'Clear server search')}</button>}
          <div className="knowledge-filters">{(['all', 'source', 'page', 'decision'] as const).map(kind => <button key={kind} type="button" aria-pressed={kindFilter === kind} onClick={() => setKindFilter(kind)}>{kind === 'all' ? t('全部', 'All') : kindName(kind, t)}</button>)}</div>
          <div className="knowledge-document-list">{visible.map(item => <div className={`knowledge-list-item ${selectedId === item.id && panel === 'document' ? 'is-active' : ''}`} key={item.id}>
            <input type="checkbox" aria-label={`${t('选择上下文：', 'Select context: ')}${item.title}`} checked={selectedIds.includes(item.id)} onChange={() => toggleContext(item.id)} />
            <button type="button" onClick={() => select(item.id)}><span className={`knowledge-dot kind-${item.kind}`} /><span><strong>{item.title}</strong><small>{kindName(item.kind, t)} · v{item.version}</small></span></button>
          </div>)}</div>
          {loaded && !visible.length && <p className="knowledge-empty-small">{query || kindFilter !== 'all' ? t('没有匹配的资料。', 'No matching documents.') : t('先导入一份资料，开始建立你的知识库。', 'Import a source to begin your knowledge base.')}</p>}
        </> : <div className="knowledge-proposal-list">{snapshot.proposals.map(item => <button type="button" key={item.id} className={proposalId === item.id && panel === 'review' ? 'is-active' : ''} onClick={() => { setProposalId(item.id); setPanel('review'); }}><strong>{item.title}</strong><span>{item.status === 'draft' ? t('待审核', 'Pending review') : item.status === 'accepted' ? t('已通过', 'Accepted') : t('已拒绝', 'Rejected')} · {item.documentId ? `v${item.baseVersion} → v${item.baseVersion + 1}` : t('新页面', 'New page')}</span></button>)}{!snapshot.proposals.length && <p className="knowledge-empty-small">{t('尚无变更提案。', 'No change proposals yet.')}</p>}</div>}
        {!readOnly && <button className="knowledge-new-page" type="button" onClick={() => newProposal()}><Plus size={16} />{t('新建知识提案', 'New knowledge proposal')}</button>}
      </aside>
      <main className="knowledge-map-column">
        <div className="knowledge-map-heading"><div><h3>{t('知识关系图', 'Knowledge graph')}</h3><p>{visible.length} {t('份资料', 'documents')} · {t('关系可双向连接', 'Relationships can connect in both directions')}</p></div><label><span className="knowledge-sr-only">{t('筛选关系', 'Filter relationships')}</span><select value={relationFilter} onChange={event => setRelationFilter(event.target.value as KnowledgeRelation | 'all')}><option value="all">{t('全部关系', 'All relationships')}</option>{relationTypes.map(item => <option key={item} value={item}>{relationName(item, t)}</option>)}</select></label></div>
        <KnowledgeGraph documents={visible} links={snapshot.links.filter(link => relationFilter === 'all' || link.relation === relationFilter)} activeId={selectedId} selectedIds={selectedIds} onSelect={select} t={t} />
        <div className="knowledge-context-bar"><div><strong>{selectedIds.length ? `${t('已选择', 'Selected')} ${selectedIds.length} / ${KNOWLEDGE_CONTEXT_ITEMS}` : t('选中资料，带入下一次任务', 'Select evidence for your next task')}</strong><span>{t('引用会保留具体修订版本', 'References retain their exact revision')}</span></div><div><button type="button" disabled={!selectedIds.length || busy} onClick={() => setSelectedIds([])}>{t('清空', 'Clear')}</button><button type="button" disabled={!selectedIds.length || busy || readOnly} onClick={() => useContext(true)}><Sparkles size={15} />{t('整理知识', 'Compile knowledge')}</button><button className="knowledge-primary" type="button" disabled={!selectedIds.length || busy || readOnly} onClick={() => useContext()}>{t('加入任务', 'Add to task')}</button></div></div>
      </main>
      <aside className="knowledge-inspector" aria-label={t('知识详情', 'Knowledge details')}>
        {panel === 'source' && <form onSubmit={event => { event.preventDefault(); saveSource(); }}>
          <PanelTitle icon={<Import size={18} />} title={t('导入原始资料', 'Import source')} onClose={() => setPanel('document')} t={t} />
          <p className="knowledge-help">{t('原文保存后保持不变。整理、补充与纠错通过知识页面提案完成。', 'Original sources stay immutable. Synthesis and corrections become page proposals.')}</p>
          <input ref={fileInput} className="knowledge-sr-only" type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" aria-label={t('选择文本文件', 'Choose text file')} onChange={event => void importFile(event.target.files?.[0])} />
          <button className="knowledge-upload" type="button" onClick={() => fileInput.current?.click()}><Import size={20} />{t('选择 Markdown / 文本文件', 'Choose Markdown / text file')}<small>UTF-8 · ≤ 256 KiB</small></button>
          <label>{t('资料标题', 'Source title')}<input required maxLength={500} value={sourceTitle} onChange={event => setSourceTitle(event.target.value)} /></label>
          <label>{t('来源链接（可选）', 'Source URL (optional)')}<input type="url" value={sourceUri} onChange={event => setSourceUri(event.target.value)} placeholder="https://" /></label>
          <label>{t('原文内容', 'Original content')}<textarea required rows={15} value={sourceContent} onChange={event => setSourceContent(event.target.value)} /></label>
          <ByteCount content={sourceContent} t={t} />
          <button type="submit" className="knowledge-primary knowledge-wide" disabled={busy || !sourceTitle.trim() || !sourceContent.trim() || bytes(sourceContent) > KNOWLEDGE_CONTENT_BYTES}>{busy ? t('保存中…', 'Saving…') : t('保存原始资料', 'Save source')}</button>
        </form>}
        {panel === 'proposal' && <form onSubmit={event => { event.preventDefault(); saveProposal(); }}>
          <PanelTitle icon={<BookOpen size={18} />} title={draft.documentId ? t('修订知识', 'Revise knowledge') : t('新建知识提案', 'New knowledge proposal')} onClose={() => setPanel('document')} t={t} />
          <p className="knowledge-help">{draft.documentId ? `${t('基于版本', 'Based on version')} ${draft.baseVersion} · ` : ''}{t('提交后可对照原文审核，审核通过才发布。', 'Review the proposal against its sources before publishing.')}</p>
          <label>{t('页面类型', 'Page type')}<select disabled={!!draft.documentId} value={draft.kind} onChange={event => setDraft(value => ({ ...value, kind: event.target.value as 'page' | 'decision' }))}><option value="page">{kindName('page', t)}</option><option value="decision">{kindName('decision', t)}</option></select></label>
          <label>{t('提案标题', 'Proposal title')}<input required maxLength={500} value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} /></label>
          <label>{t('提案内容', 'Proposal content')}<textarea rows={13} required value={draft.content} onChange={event => setDraft(value => ({ ...value, content: event.target.value }))} /></label>
          <ByteCount content={draft.content} t={t} />
          <SourcePicker documents={[...documentMap.values()]} ids={draft.sourceIds} onChange={ids => setDraft(value => ({ ...value, sourceIds: ids, sourceRevisions: Object.fromEntries(ids.map(id => [id, value.sourceRevisions[id] ?? documentMap.get(id)!.currentRevisionId])) }))} t={t} />
          <fieldset className="knowledge-link-editor"><legend>{t('知识关系', 'Relationships')}</legend><div><select aria-label={t('关系类型', 'Relationship type')} value={linkRelation} onChange={event => setLinkRelation(event.target.value as KnowledgeRelation)}>{relationTypes.map(item => <option key={item} value={item}>{relationName(item, t)}</option>)}</select><select aria-label={t('关联资料', 'Related document')} value={linkTarget} onChange={event => setLinkTarget(event.target.value)}><option value="">{t('选择资料', 'Choose document')}</option>{snapshot.documents.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button type="button" disabled={!linkTarget} aria-label={t('添加关系', 'Add relationship')} onClick={() => { setDraft(value => ({ ...value, links: value.links.some(link => link.toDocumentId === linkTarget && link.relation === linkRelation) ? value.links : [...value.links, { toDocumentId: linkTarget, relation: linkRelation }] })); setLinkTarget(''); }}><Plus size={15} /></button></div>
            <ul>{draft.links.map((link, index) => <li key={`${link.toDocumentId}:${link.relation}`}>{relationName(link.relation, t)} → {documentMap.get(link.toDocumentId)?.title ?? link.toDocumentId}<button type="button" aria-label={`${t('移除关系', 'Remove relationship')} ${index + 1}`} onClick={() => setDraft(value => ({ ...value, links: value.links.filter((_, i) => i !== index) }))}><X size={13} /></button></li>)}</ul>
          </fieldset>
          <button type="submit" className="knowledge-primary knowledge-wide" disabled={busy || !draft.title.trim() || !draft.content.trim() || bytes(draft.content) > KNOWLEDGE_CONTENT_BYTES}>{t('保存待审提案', 'Save proposal for review')}</button>
        </form>}
        {panel === 'review' && proposal && <ProposalReview proposal={proposal} documents={documentMap} busy={busy || readOnly} onAccept={() => resolveProposal(proposal, true)} onReject={() => resolveProposal(proposal, false)} onSelect={select} onEvidence={selectEvidence} t={t} />}
        {panel === 'evidence' && evidence && <EvidenceInspector key={evidence.revisionId} tenantId={tenantId} reference={evidence} onCurrent={() => select(evidence.documentId)} t={t} />}
        {panel === 'artifacts' && <form onSubmit={event => { event.preventDefault(); saveArtifact(); }}>
          <PanelTitle icon={<Import size={18} />} title={t('选择任务产物入库', 'Save a task artifact')} onClose={() => setPanel('document')} t={t} />
          <p className="knowledge-help">{t('从运行中保存的文本产物读取真实内容，保留画布、节点和运行来源。', 'Uses the actual stored text artifact and retains its canvas, node and run provenance.')}</p>
          {!artifacts.length ? <p className="knowledge-empty-small">{t('当前没有可用的任务产物。任务产出 Markdown 或文本文件后，可回到这里入库。', 'No task artifacts are available. Return after a task produces a Markdown or text file.')}</p> : <>
            <label>{t('任务产物', 'Task artifact')}<select required value={artifactId} onChange={event => { setArtifactId(event.target.value); setArtifactTitle(artifacts.find(item => item.id === event.target.value)?.title ?? ''); }}><option value="">{t('选择已保存的产物', 'Choose a saved artifact')}</option>{artifacts.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <label>{t('入库标题', 'Knowledge title')}<input value={artifactTitle} onChange={event => setArtifactTitle(event.target.value)} maxLength={500} /></label>
            <label>{t('保存方式', 'Save as')}<select value={artifactAction} onChange={event => setArtifactAction(event.target.value as 'source' | 'proposal')}><option value="source">{t('原始资料', 'Original source')}</option><option value="proposal">{t('知识页面提案（待审核）', 'Page proposal (review required)')}</option></select></label>
            {artifactAction === 'proposal' && <SourcePicker documents={snapshot.documents} ids={artifactSources} onChange={setArtifactSources} t={t} />}
            <button className="knowledge-primary knowledge-wide" type="submit" disabled={busy || !artifactId}>{t('保存到知识库', 'Save to knowledge')}</button>
          </>}
        </form>}
        {panel === 'document' && (selected ? <DocumentInspector key={`${selected.id}:${selected.version}`} doc={selected} tenantId={tenantId} documents={documentMap} links={snapshot.links} isContext={selectedIds.includes(selected.id)} onToggleContext={() => toggleContext(selected.id)} onRevise={() => newProposal(selected)} onSelect={select} onEvidence={selectEvidence} onRestore={revision => restore(selected, revision)} busy={busy} readOnly={readOnly} t={t} locale={locale} />
          : <div className="knowledge-inspector-empty"><BookOpen size={34} /><h3>{t('从一份资料开始', 'Start with a source')}</h3><p>{t('导入原文，整理为带引用的页面，再将知识带回任务。', 'Import evidence, compile cited pages, and bring knowledge back into your work.')}</p>{!readOnly && <button type="button" className="knowledge-primary" onClick={() => setPanel('source')}>{t('导入第一份资料', 'Import your first source')}</button>}</div>)}
      </aside>
    </div>
    <footer className="knowledge-footer"><span><span className="knowledge-dot kind-source" />{kindName('source', t)}</span><span><span className="knowledge-dot kind-page" />{kindName('page', t)}</span><span><span className="knowledge-dot kind-decision" />{kindName('decision', t)}</span><span>{readOnly ? t('只读访问', 'Read-only access') : t('变更经提案审核后生效', 'Changes take effect after proposal review')}{canvasId ? ` · ${t('可用于当前画布', 'Available to this canvas')}` : ''}</span></footer>
  </section>;
}

function PanelTitle({ icon, title, onClose, t }: { icon: React.ReactNode; title: string; onClose: () => void; t: Translate }) {
  return <div className="knowledge-panel-title"><h3>{icon}{title}</h3><button type="button" onClick={onClose} aria-label={t('返回知识详情', 'Back to knowledge details')}><X size={16} /></button></div>;
}
function ByteCount({ content, t }: { content: string; t: Translate }) {
  const count = bytes(content);
  return <small className={`knowledge-byte-count ${count > KNOWLEDGE_CONTENT_BYTES ? 'is-over' : ''}`}>{(count / 1024).toFixed(1)} / 256 KiB {count > KNOWLEDGE_CONTENT_BYTES ? t(' · 内容超出限制', ' · Content exceeds limit') : ''}</small>;
}
function SourcePicker({ documents, ids, onChange, t }: { documents: KnowledgeDocument[]; ids: string[]; onChange: (ids: string[]) => void; t: Translate }) {
  const sources = documents;
  return <fieldset className="knowledge-source-picker"><legend>{t('引用来源', 'Cited sources')}</legend>{sources.length ? sources.map(item => <label key={item.id}><input type="checkbox" checked={ids.includes(item.id)} onChange={() => onChange(ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id])} /><span>{item.title}</span></label>) : <p>{t('尚无原始资料；可以先保存提案，再补充有依据的引用。', 'No sources yet. You can draft a proposal and add evidence later.')}</p>}</fieldset>;
}
function Markdown({ content }: { content: string }) {
  return <div className="knowledge-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => safeUrl(href ?? '') ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
    img: ({ src, alt }) => safeUrl(typeof src === 'string' ? src : '') ? <a href={String(src)} target="_blank" rel="noreferrer noopener">{alt || 'Image'}</a> : <span>{alt}</span>,
  }}>{content}</ReactMarkdown></div>;
}
function Provenance({ value, uri, t }: { value: Record<string, unknown>; uri?: string; t: Translate }) {
  return <details className="knowledge-provenance"><summary>{t('来源与记录信息', 'Source and provenance')}</summary>{uri && <p>{safeUrl(uri) ? <a href={uri} target="_blank" rel="noreferrer noopener">{uri}</a> : <span>{uri}</span>}</p>}<pre>{JSON.stringify(value, null, 2)}</pre></details>;
}
function ProposalReview({ proposal, documents, busy, onAccept, onReject, onSelect, onEvidence, t }: { proposal: KnowledgeProposal; documents: Map<string, KnowledgeDocument>; busy: boolean; onAccept: () => void; onReject: () => void; onSelect: (id: string) => void; onEvidence: (ref: EvidenceReference) => void; t: Translate }) {
  const current = proposal.documentId ? documents.get(proposal.documentId) : null;
  const stale = !!current && current.version !== proposal.baseVersion;
  return <div className="knowledge-review"><div className="knowledge-panel-title"><h3><GitBranch size={18} />{t('审核变更提案', 'Review change proposal')}</h3></div><h4>{proposal.title}</h4><p className="knowledge-help">{kindName(proposal.kind, t)} · {proposal.status === 'draft' ? t('待审核', 'Pending review') : proposal.status === 'accepted' ? t('已通过', 'Accepted') : t('已拒绝', 'Rejected')}</p>
    {stale && proposal.status === 'draft' && <p className="knowledge-inline-alert">{t('当前页面已更新，此提案的基础版本已过期。请基于最新页面创建修订。', 'This proposal is based on an older version. Create a revision from the latest page.')}</p>}
    <div className="knowledge-comparison"><section><h5>{t('当前已发布内容', 'Currently published')} {current ? `· v${current.version}` : ''}</h5>{current ? <><strong>{current.title}</strong><pre>{current.content}</pre></> : <p>{t('新页面，暂无已发布内容。', 'New page; no published content yet.')}</p>}</section><section><h5>{t('提案内容', 'Proposed content')} · {t('基于版本', 'Base version')} {proposal.baseVersion}</h5><strong>{proposal.title}</strong><pre>{proposal.content}</pre></section></div>
    <h5>{t('引用原文', 'Source evidence')}</h5><div className="knowledge-linked-list">{proposal.sourceIds.length ? proposal.sourceIds.map(id => <button type="button" key={id} onClick={() => onSelect(id)}><FileText size={14} />{documents.get(id)?.title ?? id}</button>) : <p className="knowledge-help">{t('此提案没有关联原始资料，请核实内容依据。', 'This proposal has no linked sources. Check its evidence.')}</p>}</div>
    <PinnedCitations provenance={proposal.provenance} onEvidence={onEvidence} t={t} />
    {proposal.links.length > 0 && <><h5>{t('提议关系', 'Proposed relationships')}</h5><ul>{proposal.links.map((link, index) => <li key={`${index}:${link.toDocumentId}`}>{relationName(link.relation, t)} → <button className="knowledge-text-button" type="button" onClick={() => onSelect(link.toDocumentId)}>{documents.get(link.toDocumentId)?.title ?? link.toDocumentId}</button></li>)}</ul></>}
    <Provenance value={proposal.provenance} t={t} />
    {proposal.status === 'draft' && <div className="knowledge-review-actions"><button type="button" disabled={busy} onClick={onReject}>{t('拒绝提案', 'Reject proposal')}</button><button className="knowledge-primary" type="button" disabled={busy || stale} onClick={onAccept}><Check size={15} />{t('审核通过并发布', 'Accept and publish')}</button></div>}
    {proposal.acceptedDocumentId && <button className="knowledge-wide" type="button" onClick={() => onSelect(proposal.acceptedDocumentId!)}>{t('查看已发布页面', 'View published page')}</button>}
  </div>;
}

function DocumentInspector({ doc, tenantId, documents, links, isContext, onToggleContext, onRevise, onSelect, onEvidence, onRestore, busy, readOnly, t, locale }: {
  doc: KnowledgeDocument; tenantId: string; documents: Map<string, KnowledgeDocument>; links: KnowledgeLink[]; isContext: boolean;
  onToggleContext: () => void; onRevise: () => void; onSelect: (id: string) => void; onEvidence: (ref: EvidenceReference) => void; onRestore: (revision: KnowledgeRevision) => void;
  busy: boolean; readOnly: boolean; t: Translate; locale: string;
}) {
  const [tab, setTab] = useState<'content' | 'raw' | 'history'>('content');
  const [revisions, setRevisions] = useState<KnowledgeRevision[]>([]);
  const [revisionId, setRevisionId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [nextVersion, setNextVersion] = useState<number | null>(null);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [beforeVersion, setBeforeVersion] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (tab !== 'history') return;
    const controller = new AbortController(); setLoading(true); setError(null);
    void readKnowledgeRevisions(tenantId, doc.id, controller.signal, { beforeVersion }).then(page => {
      if (controller.signal.aborted) return;
      setRevisions(items => beforeVersion === undefined ? page.items : [...items, ...page.items.filter(item => !items.some(existing => existing.id === item.id))]);
      if (beforeVersion === undefined) setRevisionId(page.items.find(item => item.id !== doc.currentRevisionId)?.id ?? page.items[0]?.id ?? '');
      setHistoryTruncated(page.truncated); setNextVersion(page.nextBeforeVersion);
    }).catch(value => { if (!controller.signal.aborted) { setError(value); if (beforeVersion === undefined || (value instanceof SaaSApiError && [401, 403, 404].includes(value.status))) setRevisions([]); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tab, tenantId, doc.id, doc.currentRevisionId, refresh, beforeVersion]);
  const revision = revisions.find(item => item.id === revisionId);
  const related = links.filter(item => item.fromDocumentId === doc.id || item.toDocumentId === doc.id);
  return <div className="knowledge-document"><div className="knowledge-document-meta"><span className={`knowledge-kind kind-${doc.kind}`}>{kindName(doc.kind, t)}</span><span>v{doc.version}</span></div><h3>{doc.title}</h3><p className="knowledge-help"><time dateTime={doc.updatedAt}>{shortDate(doc.updatedAt, locale)}</time></p>
    <div className="knowledge-document-actions"><button type="button" aria-pressed={isContext} onClick={onToggleContext}>{isContext ? <Check size={15} /> : <Plus size={15} />}{isContext ? t('已选为上下文', 'Selected for context') : t('选为上下文', 'Select for context')}</button>{!readOnly && doc.kind !== 'source' && <button type="button" disabled={busy} onClick={onRevise}>{t('修订', 'Revise')}</button>}</div>
    <div className="knowledge-tabs knowledge-detail-tabs">{(['content', 'raw', 'history'] as const).map(item => <button type="button" key={item} aria-pressed={tab === item} onClick={() => { setTab(item); setConfirmRestore(false); }}>{item === 'content' ? t('阅读', 'Read') : item === 'raw' ? t('原文', 'Raw text') : <><History size={13} />{t('历史', 'History')}</>}</button>)}</div>
    {tab === 'content' && <Markdown content={doc.content} />}
    {tab === 'raw' && <pre className="knowledge-raw">{doc.content}</pre>}
    {tab === 'history' && <div className="knowledge-history">{loading && <p role="status">{t('读取修订历史…', 'Loading revisions…')}</p>}{error !== null && <p role="alert">{error instanceof Error ? error.message : String(error)} <button type="button" onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</button></p>}
      {!loading && !error && revisions.length === 0 && <p>{t('没有可用的修订记录。', 'No revisions are available.')}</p>}
      {historyTruncated && <p className="knowledge-help">{t('本次只读取了部分修订，可继续读取更早版本。', 'Only part of the revision history was read. Load earlier versions to continue.')}</p>}
      {nextVersion !== null && <button type="button" disabled={loading} onClick={() => setBeforeVersion(nextVersion)}>{t('读取更早版本', 'Load earlier revisions')}</button>}
      {revisions.length > 0 && <><label>{t('选择修订版本', 'Choose revision')}<select value={revisionId} onChange={event => { setRevisionId(event.target.value); setConfirmRestore(false); }}>{revisions.map(item => <option value={item.id} key={item.id}>v{item.version} · {shortDate(item.createdAt, locale)}{item.id === doc.currentRevisionId ? ` · ${t('当前', 'Current')}` : ''}</option>)}</select></label>{revision && <><h4>{revision.title}</h4><pre className="knowledge-raw">{revision.content}</pre><p className="knowledge-hash">SHA-256: {revision.contentHash}</p><Provenance value={revision.provenance} uri={revision.sourceUri} t={t} />
        {doc.kind !== 'source' && !readOnly && revision.id !== doc.currentRevisionId && (confirmRestore ? <div className="knowledge-restore-confirm"><p>{t('恢复会创建一个新修订版本，并恢复该版本的关系。现有历史保留。', 'Restore creates a new revision with that revision’s relationships. Existing history is retained.')}</p><button type="button" onClick={() => setConfirmRestore(false)}>{t('取消', 'Cancel')}</button><button className="knowledge-primary" type="button" disabled={busy} onClick={() => onRestore(revision)}>{t('确认恢复此版本', 'Confirm restore')}</button></div> : <button type="button" disabled={busy} onClick={() => setConfirmRestore(true)}>{t('恢复到此版本', 'Restore this version')}</button>)}</>}</>}
    </div>}
    <div className="knowledge-document-relations"><h4><Link2 size={14} />{t('关联与引用', 'Relationships and citations')}</h4>{related.length ? related.map(link => {
      const outgoing = link.fromDocumentId === doc.id; const target = outgoing ? link.toDocumentId : link.fromDocumentId;
      return <button type="button" key={link.id} onClick={() => onSelect(target)}><span>{outgoing ? '→' : '←'} {relationName(link.relation, t)}</span><strong>{documents.get(target)?.title ?? target}</strong></button>;
    }) : <p className="knowledge-help">{t('尚未建立关系。知识提案可以添加引用和关联。', 'No relationships yet. A proposal can add citations and links.')}</p>}</div>
    <PinnedCitations provenance={doc.provenance} onEvidence={onEvidence} t={t} />
    <Provenance value={doc.provenance} uri={doc.sourceUri} t={t} /><details className="knowledge-provenance"><summary>{t('版本标识', 'Version identifiers')}</summary><dl><dt>Document</dt><dd>{doc.id}</dd><dt>Revision</dt><dd>{doc.currentRevisionId}</dd><dt>SHA-256</dt><dd>{doc.contentHash}</dd></dl></details>
  </div>;
}

function PinnedCitations({ provenance, onEvidence, t }: { provenance: Record<string, unknown>; onEvidence: (ref: EvidenceReference) => void; t: Translate }) {
  const refs = evidenceReferences(provenance);
  if (!refs.length) return null;
  return <div className="knowledge-pinned-citations"><h5>{t('固定引用版本', 'Pinned evidence versions')}</h5><div className="knowledge-linked-list">{refs.map(ref => <button key={`${ref.documentId}:${ref.revisionId}`} type="button" onClick={() => onEvidence(ref)} aria-label={`${t('读取引用版本：', 'Read cited version: ')}${ref.title}`}><FileText size={14} /><span>{ref.title}<small>{ref.revisionId.slice(0, 12)}</small></span></button>)}</div></div>;
}

function EvidenceInspector({ tenantId, reference, onCurrent, t }: { tenantId: string; reference: EvidenceReference; onCurrent: () => void; t: Translate }) {
  const [revision, setRevision] = useState<KnowledgeRevision | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(null); setRevision(null);
    void readKnowledgeRevisions(tenantId, reference.documentId, controller.signal, { revisionId: reference.revisionId }).then(({ items }) => {
      if (controller.signal.aborted) return;
      const match = items.find(item => item.id === reference.revisionId);
      if (!match || match.contentHash !== reference.contentHash) throw new Error(t('引用版本不可用或校验不一致，请重新读取。', 'The cited version is unavailable or does not match its recorded hash.'));
      setRevision(match);
    }).catch(value => { if (!controller.signal.aborted) setError(value); });
    return () => controller.abort();
  }, [tenantId, reference.documentId, reference.revisionId, reference.contentHash, refresh, t]);
  return <div className="knowledge-evidence-reader"><PanelTitle icon={<FileText size={18} />} title={t('引用时的原文', 'Evidence at citation time')} onClose={onCurrent} t={t} /><h3>{reference.title}</h3><p className="knowledge-help">{t('此处显示引用时保存的修订，不随当前页面更新。', 'This is the cited immutable revision, independent of later page changes.')}</p>{error !== null ? <p role="alert">{error instanceof Error ? error.message : String(error)} <button type="button" onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</button></p> : revision ? <><p className="knowledge-help">v{revision.version} · {revision.id}</p><Markdown content={revision.content} /><Provenance value={revision.provenance} uri={revision.sourceUri} t={t} /></> : <p role="status">{t('正在读取引用版本…', 'Reading cited version…')}</p>}<button type="button" className="knowledge-wide" onClick={onCurrent}>{t('查看资料当前版本', 'View the current document')}</button></div>;
}

function KnowledgeGraph({ documents, links, activeId, selectedIds, onSelect, t }: { documents: KnowledgeDocument[]; links: KnowledgeLink[]; activeId: string | null; selectedIds: string[]; onSelect: (id: string) => void; t: Translate }) {
  const markerId = `knowledge-arrow-${useId().replace(/:/g, '')}`;
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; originX: number; originY: number; id: number } | null>(null);
  const positions = useMemo(() => {
    const counts = { source: 0, page: 0, decision: 0 };
    return new Map(documents.map(item => [item.id, { x: 34 + ['source', 'page', 'decision'].indexOf(item.kind) * 282, y: 76 + counts[item.kind]++ * 122 }]));
  }, [documents]);
  const height = Math.max(450, ...Array.from(positions.values()).map(position => position.y + 140));
  const zoom = (factor: number) => setView(value => ({ ...value, scale: Math.min(2.5, Math.max(0.35, value.scale * factor)) }));
  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('[data-knowledge-node]')) return;
    drag.current = { x: event.clientX, y: event.clientY, originX: view.x, originY: view.y, id: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect(); const ratio = 870 / Math.max(1, rect.width);
    setView(value => ({ ...value, x: drag.current!.originX + (event.clientX - drag.current!.x) * ratio, y: drag.current!.originY + (event.clientY - drag.current!.y) * ratio }));
  };
  return <div className="knowledge-graph-shell"><div className="knowledge-graph-controls"><button type="button" aria-label={t('放大图谱', 'Zoom in graph')} onClick={() => zoom(1.2)}><ZoomIn size={16} /></button><button type="button" aria-label={t('缩小图谱', 'Zoom out graph')} onClick={() => zoom(1 / 1.2)}><ZoomOut size={16} /></button><button type="button" onClick={() => setView({ x: 0, y: 0, scale: 1 })}>{t('重置视图', 'Reset view')}</button></div>
    {documents.length ? <svg className="knowledge-graph" aria-label={t('知识图谱，拖动空白区域平移', 'Knowledge graph; drag empty space to pan')} role="group" viewBox={`0 0 870 ${height}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onWheel={event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoom(event.deltaY < 0 ? 1.08 : 1 / 1.08); } }}>
      <defs><marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" /></marker></defs>
      <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
        {(['source', 'page', 'decision'] as const).map((kind, index) => <text className="knowledge-graph-column" key={kind} x={34 + index * 282} y={40}>{kindName(kind, t)}</text>)}
        {links.map((link, index) => {
          const from = positions.get(link.fromDocumentId); const to = positions.get(link.toDocumentId); if (!from || !to) return null;
          const direction = to.x > from.x ? 1 : to.x < from.x ? -1 : 0;
          const x1 = from.x + (direction === 1 ? 218 : direction === -1 ? 0 : 218); const x2 = to.x + (direction === 1 ? 0 : direction === -1 ? 218 : 218);
          const reciprocal = links.some(other => other.fromDocumentId === link.toDocumentId && other.toDocumentId === link.fromDocumentId && other.id !== link.id);
          const offset = reciprocal ? (link.fromDocumentId < link.toDocumentId ? -12 : 12) : 0;
          const y1 = from.y + 44 + offset; const y2 = to.y + 44 + offset; const bend = direction ? 62 * direction : 62 + (index % 4) * 15;
          const path = link.fromDocumentId === link.toDocumentId ? `M${x1},${y1 - 14} C${x1 + 90},${y1 - 85} ${x1 + 90},${y1 + 85} ${x2},${y2 + 14}`
            : `M${x1},${y1} C${x1 + bend},${y1} ${direction ? x2 - bend : x2 + bend},${y2} ${x2},${y2}`;
          return <g key={link.id} className={`knowledge-graph-edge relation-${link.relation} ${activeId && (link.fromDocumentId === activeId || link.toDocumentId === activeId) ? 'is-active' : ''}`}><title>{`${documents.find(item => item.id === link.fromDocumentId)?.title} ${relationName(link.relation, t)} ${documents.find(item => item.id === link.toDocumentId)?.title}`}</title><path d={path} markerEnd={`url(#${markerId})`} /><text x={direction ? (x1 + x2) / 2 : x1 + bend * 0.75} y={(y1 + y2) / 2 - 7}>{relationName(link.relation, t)}</text></g>;
        })}
        {documents.map(item => {
          const position = positions.get(item.id)!;
          return <g key={item.id} data-knowledge-node="true" className={`knowledge-graph-node kind-${item.kind} ${activeId === item.id ? 'is-active' : ''} ${selectedIds.includes(item.id) ? 'is-selected' : ''}`} transform={`translate(${position.x} ${position.y})`} role="button" tabIndex={0} aria-label={`${t('查看', 'View')} ${item.title}`} aria-pressed={activeId === item.id} onClick={() => onSelect(item.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(item.id); } }}><title>{item.title}</title><rect width="218" height="88" rx="13" /><rect className="knowledge-node-accent" width="4" height="48" y="20" rx="2" /><text className="knowledge-node-title" x="17" y="32">{item.title.length > 16 ? `${item.title.slice(0, 16)}…` : item.title}</text><text className="knowledge-node-meta" x="17" y="58">{kindName(item.kind, t)} · v{item.version}{selectedIds.includes(item.id) ? ' · ✓' : ''}</text></g>;
        })}
      </g>
    </svg> : <div className="knowledge-graph-empty"><GitBranch size={46} strokeWidth={1.2} /><h3>{t('让知识彼此连接', 'Connect what you know')}</h3><p>{t('资料、知识页面和决策会在这里形成可追溯的关系。', 'Sources, pages and decisions form a traceable graph here.')}</p></div>}
  </div>;
}
