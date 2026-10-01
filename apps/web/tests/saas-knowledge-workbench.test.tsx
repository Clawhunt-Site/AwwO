import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeWorkbench, type KnowledgeWorkbenchProps } from '../src/saas/KnowledgeWorkbench';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { KnowledgeDocument, KnowledgeProposal, KnowledgeSnapshot } from '../src/saas/knowledgeApi';

const base = '/api/v1/tenants/tenant-a/knowledge';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const document = (patch: Partial<KnowledgeDocument> = {}): KnowledgeDocument => ({ id: 'source-a', kind: 'source', title: '访谈原文', content: '客户需要中文检索。', version: 1, currentRevisionId: 'revision-source-a', contentHash: 'source-hash', sourceUri: 'https://example.com/source', provenance: { origin: 'manual' }, createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T01:00:00Z', ...patch });
const page = (patch: Partial<KnowledgeDocument> = {}) => document({ id: 'page-a', kind: 'page', title: '用户需求', content: '支持中文查询。', currentRevisionId: 'revision-page-a', ...patch });
const proposal = (patch: Partial<KnowledgeProposal> = {}): KnowledgeProposal => ({ id: 'proposal-a', documentId: null, kind: 'page', title: '访谈总结', content: '客户需要中文检索。[访谈原文](https://example.com/source)', baseVersion: 0, status: 'draft', sourceIds: ['source-a'], links: [], provenance: {}, createdAt: '2026-10-01T02:00:00Z', resolvedAt: null, acceptedDocumentId: null, ...patch });
const snapshot = (patch: Partial<KnowledgeSnapshot> = {}): KnowledgeSnapshot => ({ documents: [document()], links: [], proposals: [], ...patch });
const view = (props: Partial<KnowledgeWorkbenchProps> = {}) => <SaaSPreferencesProvider><KnowledgeWorkbench tenantId="tenant-a" onTaskContext={() => {}} {...props} /></SaaSPreferencesProvider>;
const inspector = () => within(screen.getByRole('complementary', { name: '知识详情' }));
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('knowledge workbench', () => {
  it('does not surface a cancelled first read during StrictMode effect replay', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ++attempts === 1 ? new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('signal is aborted without reason', 'AbortError')), { once: true });
    }) : json(snapshot())));
    render(<StrictMode>{view()}</StrictMode>);
    await screen.findByRole('button', { name: '查看 访谈原文' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('completes source import, proposal review, linked graph and immutable task context', async () => {
    let state = snapshot({ documents: [] });
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      const input = init.body ? JSON.parse(String(init.body)) : null;
      if (url === `${base}/sources`) { state = snapshot({ documents: [document({ title: input.title, content: input.content })] }); return json(state.documents[0]); }
      if (url === `${base}/proposals`) { const next = proposal({ title: input.title, content: input.content, sourceIds: input.sourceIds, links: input.links }); state = { ...state, proposals: [next] }; return json(next); }
      if (url.endsWith('/proposal-a/accept')) { const next = page({ title: state.proposals[0].title, content: state.proposals[0].content }); state = { documents: [...state.documents, next], links: [{ id: 'link-a', fromDocumentId: next.id, toDocumentId: 'source-a', relation: 'cites', revisionId: next.currentRevisionId }], proposals: [{ ...state.proposals[0], status: 'accepted', acceptedDocumentId: next.id }] }; return json(next); }
      if (url.includes('/context?')) return json({ text: '引用版本 revision-page-a\n客户需要中文检索。', items: [{ ...state.documents[1], documentId: 'page-a', revisionId: 'revision-page-a' }], truncated: false });
      return json(state);
    });
    const onTaskContext = vi.fn(); vi.stubGlobal('fetch', fetcher); render(view({ onTaskContext }));
    await screen.findByRole('button', { name: '导入第一份资料' });
    fireEvent.click(screen.getByRole('button', { name: '导入第一份资料' }));
    fireEvent.change(screen.getByLabelText('资料标题'), { target: { value: '访谈原文' } });
    fireEvent.change(screen.getByLabelText('原文内容'), { target: { value: '客户需要中文检索。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存原始资料' }));
    await screen.findByRole('button', { name: '查看 访谈原文' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择上下文：访谈原文' }));
    fireEvent.click(screen.getByRole('button', { name: '新建知识提案' }));
    fireEvent.change(screen.getByLabelText('提案标题'), { target: { value: '访谈总结' } });
    fireEvent.change(screen.getByLabelText('提案内容'), { target: { value: '客户需要中文检索。' } });
    expect(screen.getByRole('checkbox', { name: '访谈原文' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '保存待审提案' }));
    await screen.findByRole('button', { name: '审核通过并发布' });
    expect(inspector().getByText('新页面，暂无已发布内容。')).toBeVisible();
    const sent = JSON.parse(String(fetcher.mock.calls.find(([url]) => url.endsWith('/proposals'))?.[1].body));
    expect(sent.sourceRevisionIds).toEqual(['revision-source-a']);
    fireEvent.click(screen.getByRole('button', { name: '审核通过并发布' }));
    await screen.findByRole('button', { name: '查看 访谈总结' });
    expect(screen.getByRole('group', { name: /知识图谱/ }).querySelectorAll('.knowledge-graph-edge')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    fireEvent.click(screen.getByRole('button', { name: '资料 2' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择上下文：访谈总结' }));
    fireEvent.click(screen.getByRole('button', { name: '加入任务' }));
    await waitFor(() => expect(onTaskContext).toHaveBeenCalledWith(expect.stringContaining('revision-page-a'), [expect.objectContaining({ documentId: 'page-a', revisionId: 'revision-page-a' })]));
    expect(fetcher.mock.calls.every(([, init]) => init.credentials === 'include')).toBe(true);
  });

  it('searches Chinese content, preserves reciprocal graph edges, and opens source evidence', async () => {
    const state = snapshot({ documents: [document(), page()], links: [
      { id: 'forward', fromDocumentId: 'page-a', toDocumentId: 'source-a', relation: 'cites', revisionId: 'revision-page-a' },
      { id: 'reverse', fromDocumentId: 'source-a', toDocumentId: 'page-a', relation: 'supports', revisionId: 'revision-source-a' },
    ] });
    vi.stubGlobal('fetch', vi.fn(async () => json(state))); render(view());
    await screen.findByRole('button', { name: '查看 用户需求' });
    const paths = [...screen.getByRole('group', { name: /知识图谱/ }).querySelectorAll('.knowledge-graph-edge path')];
    expect(paths).toHaveLength(2); expect(paths[0].getAttribute('d')).not.toEqual(paths[1].getAttribute('d'));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), { target: { value: '查询' } });
    expect(screen.queryByRole('checkbox', { name: '选择上下文：访谈原文' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: '选择上下文：用户需求' })).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '查看 用户需求' }));
    fireEvent.click(inspector().getByRole('button', { name: /→ 引用\s*访谈原文/ }));
    fireEvent.click(inspector().getByText('来源与记录信息'));
    expect(inspector().getByRole('link', { name: 'https://example.com/source' })).toHaveAttribute('href', 'https://example.com/source');
    fireEvent.click(screen.getByRole('button', { name: '放大图谱' }));
    fireEvent.click(screen.getByRole('button', { name: '重置视图' }));
  });

  it('clears sensitive data and aborts late responses on a tenant switch', async () => {
    let resolveOld!: (response: Response) => void; let oldSignal: AbortSignal | undefined; let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url === base && calls++ === 0) return json(snapshot());
      if (url === base) { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { resolveOld = resolve; }); }
      return json(snapshot({ documents: [document({ id: 'new-source', title: '新工作区资料', content: '另一个工作区', currentRevisionId: 'new-revision' })] }));
    }));
    const rendered = render(view()); await screen.findByRole('button', { name: '查看 访谈原文' });
    fireEvent.click(screen.getByRole('button', { name: '刷新知识库' })); await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    rendered.rerender(view({ tenantId: 'tenant-b' }));
    expect(screen.queryByRole('button', { name: '查看 访谈原文' })).toBeNull(); expect(oldSignal?.aborted).toBe(true);
    await screen.findByRole('button', { name: '查看 新工作区资料' });
    await act(async () => { resolveOld(json(snapshot({ documents: [document({ title: '过期的私密资料' })] }))); });
    expect(screen.queryByText('过期的私密资料')).toBeNull();
  });

  it('keeps drafts after write failure, reuses operation IDs for retry, and exposes version conflicts', async () => {
    let attempts = 0;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => url.endsWith('/proposals') && init.method === 'POST'
      ? (++attempts === 1 ? json({ error: { code: 'unavailable', message: '存储服务暂时不可用' } }, 503) : json({ error: { code: 'version_conflict', message: 'changed' } }, 409))
      : json(snapshot({ documents: [page()] })));
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByRole('button', { name: '修订' });
    fireEvent.click(screen.getByRole('button', { name: '修订' }));
    fireEvent.change(screen.getByLabelText('提案内容'), { target: { value: '用户修订仍需保留' } });
    fireEvent.click(screen.getByRole('button', { name: '保存待审提案' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('存储服务暂时不可用');
    expect(screen.getByLabelText('提案内容')).toHaveValue('用户修订仍需保留');
    fireEvent.click(screen.getByRole('button', { name: '保存待审提案' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('知识版本已变化'));
    const writes = fetcher.mock.calls.filter(([, init]) => init.method === 'POST').map(([, init]) => JSON.parse(String(init.body)));
    expect(writes[0].operationId).toBe(writes[1].operationId); expect(writes[0].baseVersion).toBe(1);
    expect(screen.getByLabelText('提案内容')).toHaveValue('用户修订仍需保留');
  });

  it('rejects a proposal without mutating knowledge and restores through a new version', async () => {
    let state = snapshot({ documents: [page({ version: 2, currentRevisionId: 'revision-page-2', content: '第二版' })], proposals: [proposal({ documentId: 'page-a', baseVersion: 2 })] });
    const prior = { id: 'revision-page-1', documentId: 'page-a', version: 1, title: '用户需求', content: '第一版', contentHash: 'old-hash', createdAt: '2026-09-30T01:00:00Z', provenance: {}, sourceUri: '', parentRevisionId: null, links: [] };
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/reject')) { state = { ...state, proposals: [{ ...state.proposals[0], status: 'rejected' }] }; return json(state.proposals[0]); }
      if (url.endsWith('/revisions')) return json({ items: [prior] });
      if (url.endsWith('/restore')) { state = { ...state, documents: [page({ version: 3, currentRevisionId: 'revision-page-3', content: prior.content })] }; return json(state.documents[0]); }
      return json(state);
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByRole('button', { name: '查看 用户需求' });
    fireEvent.click(screen.getByRole('button', { name: '提案 1' }));
    fireEvent.click(screen.getByRole('button', { name: /访谈总结\s*待审核/ }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝提案' }));
    await screen.findByText('已拒绝提案，现有知识未改变。');
    expect(state.documents[0].content).toBe('第二版');
    fireEvent.click(screen.getByRole('button', { name: '查看 用户需求' }));
    fireEvent.click(screen.getByRole('button', { name: '历史' }));
    await screen.findByText('第一版'); fireEvent.click(screen.getByRole('button', { name: '恢复到此版本' }));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/restore'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认恢复此版本' }));
    await screen.findByText('已创建恢复版本，完整历史仍然保留。');
    const input = JSON.parse(String(fetcher.mock.calls.find(([url]) => url.endsWith('/restore'))?.[1].body));
    expect(input).toMatchObject({ revisionId: 'revision-page-1', expectedVersion: 2 });
    expect(state.documents[0].version).toBe(3);
  });

  it('imports a UTF-8 Markdown file and rejects unsupported files without a write', async () => {
    const fetcher = vi.fn(async () => json(snapshot())); vi.stubGlobal('fetch', fetcher); render(view());
    await screen.findByRole('button', { name: '查看 访谈原文' }); fireEvent.click(screen.getByRole('button', { name: '导入资料' }));
    const file = new File(['# 中文资料'], '会议记录.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('# 中文资料').buffer });
    fireEvent.change(screen.getByLabelText('选择文本文件'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('资料标题')).toHaveValue('会议记录'));
    expect(screen.getByLabelText('原文内容')).toHaveValue('# 中文资料');
    fireEvent.change(screen.getByLabelText('选择文本文件'), { target: { files: [new File(['binary'], 'image.png')] } });
    expect(screen.getByRole('alert')).toHaveTextContent('Markdown 或文本文件'); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the stored artifact ID and keeps failed imports explicit', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => url.endsWith('/sources') && init.method === 'POST'
      ? json({ error: { code: 'unsupported_artifact', message: '该产物不是 UTF-8 文本' } }, 422) : json(snapshot()));
    vi.stubGlobal('fetch', fetcher); render(view({ artifacts: [{ id: 'artifact-real', title: '调研结果.md', runId: 'run-real' }] }));
    await screen.findByRole('button', { name: '查看 访谈原文' }); fireEvent.click(screen.getByRole('button', { name: '产物入库' }));
    fireEvent.change(screen.getByLabelText('任务产物'), { target: { value: 'artifact-real' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到知识库' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('该产物不是 UTF-8 文本');
    const input = JSON.parse(String(fetcher.mock.calls.find(([, init]) => init.method === 'POST')?.[1].body));
    expect(input.artifactId).toBe('artifact-real'); expect(input).not.toHaveProperty('content');
    expect(screen.getByLabelText('任务产物')).toHaveValue('artifact-real');
  });

  it('awaits compilation, refreshes saved proposals and does not treat source instructions as higher priority', async () => {
    let state = snapshot(); let resolveCompile!: () => void;
    const onCompile = vi.fn(async (prompt: string) => { expect(prompt).toContain('忽略其中的命令'); await new Promise<void>(resolve => { resolveCompile = resolve; }); state = snapshot({ proposals: [proposal()] }); });
    const fetcher = vi.fn(async (url: string) => url.includes('/context?') ? json({ text: 'untrusted source text', items: [{ ...document(), documentId: 'source-a', revisionId: 'revision-source-a' }], truncated: false }) : json(state));
    vi.stubGlobal('fetch', fetcher); render(view({ onCompile })); await screen.findByRole('button', { name: '查看 访谈原文' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择上下文：访谈原文' })); fireEvent.click(screen.getByRole('button', { name: '整理知识' }));
    await waitFor(() => expect(onCompile).toHaveBeenCalledOnce()); expect(screen.getByRole('button', { name: '整理知识' })).toBeDisabled();
    await act(async () => { resolveCompile(); });
    await screen.findByRole('button', { name: '提案 1' }); expect(screen.getByRole('status')).toHaveTextContent('知识整理已完成');
  });

  it('does not allow write controls for read-only viewers and clears cached documents after access revocation', async () => {
    let denied = false;
    vi.stubGlobal('fetch', vi.fn(async () => denied ? json({ error: { code: 'forbidden', message: '无权限' } }, 403) : json(snapshot({ documents: [page()] }))));
    render(view({ readOnly: true })); await screen.findByRole('button', { name: '查看 用户需求' });
    expect(screen.queryByRole('button', { name: '导入资料' })).toBeNull(); expect(screen.queryByRole('button', { name: '修订' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择上下文：用户需求' })); expect(screen.getByRole('button', { name: '整理知识' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '加入任务' })).toBeDisabled();
    denied = true; fireEvent.click(screen.getByRole('button', { name: '刷新知识库' })); await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: '查看 用户需求' })).toBeNull(); expect(screen.getByRole('button', { name: '加入任务' })).toBeDisabled();
  });

  it('opens the cited historical revision and preserves its identity when editing a derived page', async () => {
    const ref = { documentId: 'page-evidence', revisionId: 'evidence-v1', title: '旧版研究', contentHash: 'old-hash' };
    const derived = page({ title: '衍生结论', provenance: { sourceRevisions: [ref] } });
    const current = page({ id: 'page-evidence', title: '新版研究', version: 2, currentRevisionId: 'evidence-v2', content: '新版证据文字' });
    const prior = { id: 'evidence-v1', documentId: 'page-evidence', version: 1, title: '旧版研究', content: '引用时的旧版证据', contentHash: 'old-hash', sourceUri: '', provenance: {}, createdAt: '2026-09-30T00:00:00Z', parentRevisionId: null, links: [] };
    const state = snapshot({ documents: [derived, current], links: [{ id: 'citation', fromDocumentId: 'page-a', toDocumentId: 'page-evidence', relation: 'cites', revisionId: 'revision-page-a' }] });
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => url.includes('/revisions') ? json({ items: [prior] })
      : url.endsWith('/proposals') && init.method === 'POST' ? json(proposal({ documentId: 'page-a', baseVersion: 1 })) : json(state));
    vi.stubGlobal('fetch', fetcher); render(view());
    await screen.findByRole('button', { name: '读取引用版本：旧版研究' });
    fireEvent.click(screen.getByRole('button', { name: '读取引用版本：旧版研究' }));
    expect(await screen.findByText('引用时的旧版证据')).toBeVisible();
    expect(inspector().queryByText('新版证据文字')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看 衍生结论' }));
    fireEvent.click(screen.getByRole('button', { name: '修订' }));
    fireEvent.change(screen.getByLabelText('提案内容'), { target: { value: '保留引用的修订' } });
    fireEvent.click(screen.getByRole('button', { name: '保存待审提案' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init.method === 'POST')).toBe(true));
    const input = JSON.parse(String(fetcher.mock.calls.find(([, init]) => init.method === 'POST')?.[1].body));
    expect(input.sourceIds).toEqual(['page-evidence']); expect(input.sourceRevisionIds).toEqual(['evidence-v1']);
    expect(input).not.toHaveProperty('sourceRevisions');
  });

  it('reports limited snapshots and searches the server without losing selected context', async () => {
    const fetcher = vi.fn(async (url: string) => url.includes('?q=') ? json(snapshot({ documents: [document({ id: 'outside-list', title: '隐藏研究', content: '额外结果' })], truncated: false }))
      : url.includes('/context?') ? json({ text: '原始选择', items: [{ ...document(), documentId: 'source-a', revisionId: 'revision-source-a' }], truncated: false })
      : json(snapshot({ truncated: true })));
    const onTaskContext = vi.fn(); vi.stubGlobal('fetch', fetcher); render(view({ onTaskContext }));
    await screen.findByText('资料较多，当前只显示部分记录。输入关键词并点击搜索，可检索完整知识库。');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择上下文：访谈原文' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识库' }), { target: { value: '隐藏研究' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '搜索完整知识库' }));
    await screen.findByRole('button', { name: '查看 隐藏研究' });
    expect(fetcher.mock.calls.some(([url]) => url === `${base}?q=${encodeURIComponent('隐藏研究')}`)).toBe(true);
    expect(screen.getByText('已选择 1 / 8')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '加入任务' }));
    await waitFor(() => expect(onTaskContext).toHaveBeenCalledWith('原始选择', [expect.objectContaining({ documentId: 'source-a' })]));
  });

  it('loads bounded revision pages and keeps already-read versions selectable', async () => {
    const revision = (version: number) => ({ id: `revision-${version}`, documentId: 'page-a', version, title: '用户需求', content: `第${version}版`, contentHash: `hash-${version}`, sourceUri: '', provenance: {}, createdAt: '2026-10-01T00:00:00Z', parentRevisionId: version > 1 ? `revision-${version - 1}` : null, links: [] });
    const fetcher = vi.fn(async (url: string) => url.includes('beforeVersion=2') ? json({ items: [revision(1)], truncated: false, nextBeforeVersion: null })
      : url.includes('/revisions') ? json({ items: [revision(3), revision(2)], truncated: true, nextBeforeVersion: 2 })
      : json(snapshot({ documents: [page({ version: 3, currentRevisionId: 'revision-3' })] })));
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByRole('button', { name: '查看 用户需求' });
    fireEvent.click(screen.getByRole('button', { name: '历史' }));
    await screen.findByText('本次只读取了部分修订，可继续读取更早版本。');
    fireEvent.click(screen.getByRole('button', { name: '读取更早版本' }));
    await screen.findByRole('option', { name: /^v1/ });
    expect(screen.getByRole('option', { name: /^v3/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('选择修订版本'), { target: { value: 'revision-1' } });
    expect(screen.getByText('第1版')).toBeVisible();
    expect(screen.queryByRole('button', { name: '读取更早版本' })).toBeNull();
  });
});
