import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantExecution } from '../src/saas/AssistantExecution';
import { executionModelKey, useManagedExecution } from '../src/saas/useManagedExecution';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { readExecutionRuntime } from '../src/saas/managedExecutionApi';
import { clearSaaSCanvas, configureCanvasKnowledge, configureSaaSCanvas } from '../src/saas/canvasBridge';

const base = '/api/v1/tenants/tenant-a';
const time = '2026-10-01T01:00:00Z';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const runtime = { ready: true, capabilities: { workspace: true, approvals: true }, models: [{ id: 'byok_model_a', label: '已有模型连接', runtime: 'openai-agents', efforts: ['low', 'medium'] }] };
const disabled = { ready: false, reason: '当前没有可用模型', capabilities: { workspace: false, approvals: false }, models: [] };
const summary = { id: 'run-a', status: 'running', prompt: '整理项目文件', createdAt: time, updatedAt: time };
const question = { id: 'request-a', requestId: 'question-a', title: '确认输出格式', description: '你需要什么格式？', kind: 'question', arguments: { choices: ['Markdown', 'CSV'] }, status: 'pending', createdAt: time };
const approval = { ...question, id: 'request-b', requestId: 'approval-b', kind: 'approval', title: '运行命令', description: '创建项目汇总文件', arguments: { command: 'write report.md', cwd: '/workspace' } };
const artifact = { id: 'artifact-a', name: 'report.md', runId: 'run-a', nodeId: 'node-a', canvasId: 'canvas-a', size: 30, contentType: 'text/markdown', sha256: 'hash-a', createdAt: time };
const detail = { ...summary, output: '', error: '', canRespond: true, canCancel: true, truncated: false, messages: [{ id: 'message-a', role: 'assistant', text: '正在检查文件', createdAt: time }], approvals: [question], artifacts: [] };
const source = { id: 'source-a', kind: 'source', title: '汇总原件', content: '# 项目汇总', version: 1, currentRevisionId: 'rev-a', contentHash: 'hash-a', sourceUri: '', provenance: { artifactId: 'artifact-a', runId: 'run-a' }, createdAt: time, updatedAt: time };
const tenant = { id: 'tenant-a', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };

function Harness({ tenantId = 'tenant-a', canvasId = 'canvas-a', readOnly = false }: { tenantId?: string; canvasId?: string; readOnly?: boolean }) {
  const execution = useManagedExecution(tenantId, canvasId, { readOnly });
  return <AssistantExecution execution={execution} />;
}
const view = (props: Parameters<typeof Harness>[0] = {}) => <SaaSPreferencesProvider><Harness {...props} /></SaaSPreferencesProvider>;
const defaultResponse = (url: string) => url.endsWith('/computer-runtime') ? runtime : url.endsWith('/computer-runs') ? { items: [summary] } : detail;
const posts = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
/** The composer is ready once the catalogue has loaded and offered its model. */
const composerReady = () => screen.findByText('模型：已有模型连接');
const task = () => screen.getByRole('textbox', { name: '任务说明' });
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearSaaSCanvas(); });

describe('the canvas assistant’s 直接执行 mode', () => {
  it('reads nothing until the mode is first opened', async () => {
    const fetcher = vi.fn(async (url: string) => json(defaultResponse(url)));
    vi.stubGlobal('fetch', fetcher);
    renderHook(() => useManagedExecution('tenant-a', 'canvas-a'), { wrapper: SaaSPreferencesProvider });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(fetcher).not.toHaveBeenCalled();
    render(view());
    await screen.findByText('确认输出格式');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([`${base}/computer-runtime`, `${base}/canvases/canvas-a/computer-runs`, `${base}/computer-runs/run-a`]));
  });

  it('reads the history again when the mode is opened again, keeping the open task', async () => {
    let items = [summary];
    const fetcher = vi.fn(async (url: string) => json(url.endsWith('/computer-runs') ? { items } : defaultResponse(url)));
    function Reopen({ open }: { open: boolean }) {
      const execution = useManagedExecution('tenant-a', 'canvas-a');
      return open ? <AssistantExecution execution={execution} /> : null;
    }
    vi.stubGlobal('fetch', fetcher);
    const { rerender } = render(<SaaSPreferencesProvider><Reopen open /></SaaSPreferencesProvider>);
    await screen.findByText('确认输出格式');
    const reads = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/computer-runs')).length;
    expect(reads()).toBe(1);
    rerender(<SaaSPreferencesProvider><Reopen open={false} /></SaaSPreferencesProvider>);
    items = [summary, { ...summary, id: 'run-b', prompt: '另一位成员的任务', createdAt: '2026-10-01T02:00:00Z' }];
    rerender(<SaaSPreferencesProvider><Reopen open /></SaaSPreferencesProvider>);
    expect(await screen.findByText('另一位成员的任务')).toBeVisible();
    expect(reads()).toBe(2);
    expect(screen.getByText('确认输出格式')).toBeVisible();
  });

  it('explains an unavailable service with the existing engine entry and never asks for a second connection', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url.endsWith('/computer-runtime') ? disabled : { items: [] }));
    vi.stubGlobal('fetch', fetcher); render(view());
    expect(await screen.findByText('当前没有可用模型')).toBeVisible();
    expect(screen.getByRole('link', { name: '管理我的引擎' })).toHaveAttribute('href', '/?account=engines');
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled();
    fireEvent.change(task(), { target: { value: '整理文件' } });
    // Said once, above the composer, not repeated under it.
    expect(screen.getAllByText('当前没有可用模型')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled();
    expect(screen.queryByText(/OpenMaus|服务端连接|token/i)).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it.each([
    [{ ...disabled, capabilities: { workspace: true, approvals: true }, reason: 'Configure an available model in My engines' }, '连接一个模型即可开始。请在「我的引擎」中选择或添加可用模型。'],
    [{ ...disabled, reason: 'Managed execution service is not ready' }, '工作区执行服务暂时不可用，请稍后重新检查。'],
  ])('puts the fixed service reasons in the reader’s language', async (service, reason) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? service : { items: [] })));
    render(view()); expect(await screen.findByText(reason)).toBeVisible();
    expect(screen.queryByText(service.reason)).toBeNull();
    expect(screen.getByRole('link', { name: '管理我的引擎' })).toHaveAttribute('href', '/?account=engines');
    expect(screen.getByRole('button', { name: '重新检查' })).toBeEnabled();
  });

  it('re-reads the service only when asked to check again', async () => {
    let ready = false;
    const fetcher = vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? (ready ? runtime : disabled) : { items: [] }));
    vi.stubGlobal('fetch', fetcher); render(view());
    await screen.findByText('当前没有可用模型');
    const reads = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/computer-runtime')).length;
    expect(reads()).toBe(1);
    ready = true;
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    await composerReady();
    expect(reads()).toBe(2);
    expect(screen.queryByText('当前没有可用模型')).toBeNull();
  });

  it('loads once under StrictMode, whose double mount opens the mode twice', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!url.endsWith('/computer-runtime')) return json({ items: [] });
      reads++; return json(runtime);
    }));
    render(<StrictMode>{view()}</StrictMode>);
    await composerReady();
    expect(reads).toBe(1); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers example tasks on an empty history and puts the chosen one in the composer without sending it', async () => {
    const fetcher = vi.fn(async (url: string) => json(url.endsWith('/computer-runs') ? { items: [] } : defaultResponse(url)));
    vi.stubGlobal('fetch', fetcher); render(view());
    await composerReady();
    const examples = within(screen.getByRole('group', { name: '示例任务' }));
    fireEvent.click(examples.getAllByRole('button')[0]);
    expect(task()).toHaveValue('把这份需求整理成一页可打开的 HTML 原型，交付 index.html。');
    expect(posts(fetcher)).toHaveLength(0);
  });

  it('runs a task as a conversation: the question, a one-time approval, the result, a download and saving to knowledge', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureCanvasKnowledge(['frozen-revision']);
    let stage = 0;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/computer-runtime')) return json(runtime);
      if (url.endsWith('/computer-runs')) return json(init.method === 'POST' ? { id: 'run-a', status: 'queued' } : { items: init.method ? [] : stage ? [summary] : [] }, init.method === 'POST' ? 202 : 200);
      if (url.endsWith('/respond')) { stage++; return json({ accepted: true, status: 'allowed' }); }
      if (url.endsWith('/knowledge/sources')) return json(source, 201);
      return json(stage === 0 ? detail : stage === 1 ? { ...detail, approvals: [{ ...question, status: 'allowed' }, approval] }
        : { ...detail, status: 'completed', canRespond: false, canCancel: false, approvals: [{ ...question, status: 'allowed' }, { ...approval, status: 'allowed' }], output: '项目汇总已生成', artifacts: [artifact] });
    });
    vi.stubGlobal('fetch', fetcher); render(view());
    await composerReady();
    expect(screen.getByText('将带上 1 份已选知识')).toBeVisible();
    fireEvent.change(task(), { target: { value: '汇总项目文件并输出 Markdown' } });
    fireEvent.change(screen.getByLabelText('思考强度'), { target: { value: 'medium' } });
    expect(posts(fetcher)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }));
    await screen.findByText('确认输出格式');
    const creation = fetcher.mock.calls.find(([url, init]) => url.endsWith('/computer-runs') && init?.method === 'POST');
    expect(JSON.parse(String(creation?.[1]?.body))).toMatchObject({ prompt: '汇总项目文件并输出 Markdown', runtime: 'openai-agents', model: 'byok_model_a', effort: 'medium', knowledgeRevisionIds: ['frozen-revision'] });
    expect(task()).toHaveValue('');
    // Your task appears as your message; the assistant's card under it says what it is doing.
    expect(screen.getByText('等你回应后继续')).toBeVisible();
    expect(screen.getByRole('button', { name: '发送回复' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('你的回复'), { target: { value: 'Markdown' } });
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }));
    await screen.findByText('运行命令');
    // A pending permission shows exactly what it will do before anyone allows it.
    expect(screen.getByText(/"command": "write report.md"/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    await screen.findByText('项目汇总已生成');
    expect(screen.getByRole('link', { name: '下载：report.md' })).toHaveAttribute('href', `${base}/artifacts/artifact-a`);
    const responses = fetcher.mock.calls.filter(([url]) => url.endsWith('/respond')).map(([, init]) => JSON.parse(String(init?.body)));
    expect(responses[0]).toMatchObject({ requestId: 'question-a', behavior: 'allow', message: 'Markdown' });
    expect(responses[1]).toMatchObject({ requestId: 'approval-b', behavior: 'allow' });
    expect(responses[1]).not.toHaveProperty('message');
    fireEvent.click(screen.getByRole('button', { name: '存入知识库' }));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/knowledge/sources'))).toBe(false);
    expect(screen.getByLabelText('存入知识库的标题')).toHaveValue('report.md');
    fireEvent.change(screen.getByLabelText('存入知识库的标题'), { target: { value: '汇总原件' } });
    fireEvent.click(screen.getByRole('button', { name: '存入' }));
    expect(await screen.findByText('文件已存入知识库，可在知识地图中整理并审核。')).toBeVisible();
    const imported = fetcher.mock.calls.find(([url]) => url.endsWith('/knowledge/sources'));
    const input = JSON.parse(String(imported?.[1]?.body));
    expect(input).toMatchObject({ artifactId: 'artifact-a', title: '汇总原件' });
    expect(input).not.toHaveProperty('content');
  });

  it('takes the canvas’s knowledge selection as it changes', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runs') ? { items: [] } : defaultResponse(url))));
    render(view()); await composerReady();
    expect(screen.queryByText(/已选知识/)).toBeNull();
    act(() => configureCanvasKnowledge(['revision-a', 'revision-b']));
    expect(screen.getByText('将带上 2 份已选知识')).toBeVisible();
    act(() => configureCanvasKnowledge([]));
    expect(screen.queryByText(/已选知识/)).toBeNull();
  });

  it('resets the effort when the model changes and offers none for a model without levels', async () => {
    const service = { ...runtime, models: [runtime.models[0], { id: 'plain_model', label: '普通模型', runtime: 'pi' }, { id: 'byok_model_c', label: '第三个模型', runtime: 'openai-agents', efforts: ['low', 'medium'] }] };
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/computer-runtime')) return json(service);
      if (url.endsWith('/computer-runs')) return json(init.method === 'POST' ? { id: 'run-a', status: 'queued' } : { items: [] }, init.method === 'POST' ? 202 : 200);
      return json({ ...detail, approvals: [] });
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await composerReady();
    fireEvent.change(screen.getByLabelText('思考强度'), { target: { value: 'medium' } });
    expect(screen.getByText('模型：已有模型连接 · medium')).toBeVisible();
    fireEvent.change(screen.getByLabelText('执行模型'), { target: { value: executionModelKey('pi', 'plain_model') } });
    expect(screen.queryByLabelText('思考强度')).toBeNull();
    fireEvent.change(screen.getByLabelText('执行模型'), { target: { value: executionModelKey('openai-agents', 'byok_model_a') } });
    expect(screen.getByLabelText('思考强度')).toHaveValue('');
    // A level the next model also offers is still reset: effort belongs to the model it was chosen for.
    fireEvent.change(screen.getByLabelText('思考强度'), { target: { value: 'low' } });
    fireEvent.change(screen.getByLabelText('执行模型'), { target: { value: executionModelKey('openai-agents', 'byok_model_c') } });
    expect(screen.getByLabelText('思考强度')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('执行模型'), { target: { value: executionModelKey('openai-agents', 'byok_model_a') } });
    fireEvent.change(screen.getByLabelText('执行模型'), { target: { value: executionModelKey('pi', 'plain_model') } });
    fireEvent.change(task(), { target: { value: '生成报告' } });
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }));
    await waitFor(() => expect(posts(fetcher)).toHaveLength(1));
    const body = JSON.parse(String(posts(fetcher)[0][1]?.body));
    expect(body).toMatchObject({ runtime: 'pi', model: 'plain_model' });
    expect(body).not.toHaveProperty('effort');
  });

  it('keeps a chosen model the catalogue dropped visible and blocks sending until another is chosen', async () => {
    const two = { ...runtime, models: [runtime.models[0], { id: 'byok_model_b', label: '第二个模型', runtime: 'openai-agents' }] };
    let service: typeof runtime = two;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? service : url.endsWith('/computer-runs') ? { items: [] } : detail)));
    const { result } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a'), { wrapper: SaaSPreferencesProvider });
    act(() => result.current.activate());
    await waitFor(() => expect(result.current.runtime).not.toBeNull());
    act(() => result.current.chooseModel(executionModelKey('openai-agents', 'byok_model_b')));
    act(() => result.current.setPrompt('生成报告'));
    expect(result.current.canSubmit).toBe(true);
    service = runtime;
    act(() => result.current.refreshAll());
    await waitFor(() => expect(result.current.choice.unavailableLabel).toBe('第二个模型'));
    expect(result.current.choice.key).toBe(executionModelKey('openai-agents', 'byok_model_b'));
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.submitBlockedReason).toBe('所选模型已不可用，请重新选择。');
    act(() => result.current.chooseModel(executionModelKey('openai-agents', 'byok_model_a')));
    expect(result.current.choice.unavailableLabel).toBeUndefined();
    expect(result.current.canSubmit).toBe(true);
  });

  it('keeps a model the refreshed list dropped, first and marked unavailable, instead of silently replacing it', async () => {
    let service: typeof runtime = { ...runtime, models: [runtime.models[0], { id: 'byok_model_b', label: '第二个模型', runtime: 'openai-agents' }] };
    const fetcher = vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? service : url.endsWith('/computer-runs') ? { items: [] } : detail));
    vi.stubGlobal('fetch', fetcher); render(view()); await composerReady();
    expect(screen.getByRole('link', { name: '管理我的引擎' })).toHaveAttribute('href', '/?account=engines');
    fireEvent.change(screen.getByLabelText('执行模型'), { target: { value: executionModelKey('openai-agents', 'byok_model_b') } });
    // The engine is removed in My engines; the list is read again only when asked.
    service = runtime;
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/computer-runtime'))).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '刷新模型列表' }));
    expect(await screen.findByText('模型：第二个模型（已不可用）')).toBeVisible();
    const select = screen.getByLabelText('执行模型') as HTMLSelectElement;
    expect(select).toHaveValue(executionModelKey('openai-agents', 'byok_model_b'));
    expect(select.options[0]).toHaveTextContent('第二个模型（已不可用）');
    expect(select.options[0].disabled).toBe(true);
    fireEvent.change(task(), { target: { value: '生成报告' } });
    expect(screen.getByText('所选模型已不可用，请重新选择。')).toBeVisible();
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled();
    fireEvent.change(select, { target: { value: executionModelKey('openai-agents', 'byok_model_a') } });
    expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled();
    expect([...select.options].map(option => option.textContent)).toEqual(['已有模型连接']);
  });

  it('reopens an earlier task from the history and lets its creator deny a request', async () => {
    let responded = false;
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => {
      if (url.endsWith('/respond')) { responded = true; return json({ accepted: true, status: 'denied' }); }
      return json(url.endsWith('/run-a') ? { ...detail, approvals: [{ ...approval, status: responded ? 'denied' : 'pending' }] } : defaultResponse(url));
    });
    vi.stubGlobal('fetch', fetcher); render(view());
    await screen.findByText('运行命令');
    expect(screen.getByText('整理项目文件')).toBeVisible();
    expect(posts(fetcher)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await screen.findByText('已拒绝');
    expect(JSON.parse(String(fetcher.mock.calls.find(([url]) => url.endsWith('/respond'))?.[1]?.body))).toMatchObject({ requestId: 'approval-b', behavior: 'deny' });
    expect(screen.queryByRole('button', { name: '允许一次' })).toBeNull();
  });

  it('opens a delivered file in place with the deliverable viewer and closes it again', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    const page = { ...artifact, id: `a${'B'.repeat(32)}`, name: 'page.html', contentType: 'text/html' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith(`/artifacts/${page.id}`)
      ? new Response('<html><body><h1>Saved page bytes</h1></body></html>', { headers: { 'Content-Disposition': 'attachment; filename="page.html"' } })
      : json(url.endsWith('/run-a') ? { ...detail, status: 'completed', canRespond: false, canCancel: false, approvals: [], artifacts: [page] } : defaultResponse(url))));
    render(view());
    fireEvent.click(await screen.findByRole('button', { name: '预览：page.html' }));
    expect(await screen.findByTitle('page.html · HTML 预览')).toHaveAttribute('srcdoc', expect.stringContaining('Saved page bytes'));
    expect(screen.getByRole('button', { name: '收起预览：page.html' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: '收起预览：page.html' }));
    expect(screen.queryByTitle('page.html · HTML 预览')).toBeNull();
  });

  it('shows and saves an agent’s file name without the characters that disguise it', async () => {
    const disguised = { ...artifact, id: `a${'D'.repeat(32)}`, name: 'invoice\u202Egpj.exe' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/run-a')
      ? { ...detail, status: 'completed', canRespond: false, canCancel: false, approvals: [], artifacts: [disguised] } : defaultResponse(url))));
    render(view());
    const download = await screen.findByRole('link', { name: '下载：invoicegpj.exe' });
    expect(download).toHaveAttribute('download', 'invoicegpj.exe');
    expect(screen.getByText('invoicegpj.exe')).toBeVisible();
    // Saved to knowledge under the same plain name.
    fireEvent.click(screen.getByRole('button', { name: '存入知识库' }));
    expect(screen.getByLabelText('存入知识库的标题')).toHaveValue('invoicegpj.exe');
  });

  it('reads a delivered file only when asked and closes its preview when another task is opened', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    const page = { ...artifact, id: `a${'C'.repeat(32)}`, name: 'page.html', contentType: 'text/html' };
    const other = { ...summary, id: 'run-b', prompt: '另一个任务', createdAt: '2026-10-01T02:00:00Z' };
    const fetcher = vi.fn(async (url: string) => url.endsWith(`/artifacts/${page.id}`)
      ? new Response('<html><body><h1>Saved page bytes</h1></body></html>', { headers: { 'Content-Disposition': 'attachment; filename="page.html"' } })
      : json(url.endsWith('/computer-runs') ? { items: [summary, other] }
        : url.endsWith('/run-a') ? { ...detail, status: 'completed', canRespond: false, canCancel: false, approvals: [], artifacts: [page] }
        : url.endsWith('/run-b') ? { ...detail, ...other, status: 'completed', canRespond: false, canCancel: false, approvals: [], artifacts: [], messages: [] }
        : defaultResponse(url)));
    const reads = () => fetcher.mock.calls.filter(([url]) => url.endsWith(`/artifacts/${page.id}`)).length;
    vi.stubGlobal('fetch', fetcher); render(view());
    const open = await screen.findByRole('button', { name: '预览：page.html' });
    expect(reads()).toBe(0);
    fireEvent.click(open);
    await screen.findByTitle('page.html · HTML 预览');
    expect(reads()).toBe(1);
    // Tasks read oldest first, so the newer one is further down; each folded task opens on its own.
    const thread = within(screen.getByRole('log', { name: '执行记录' }));
    expect(thread.getAllByRole('listitem').map(item => item.textContent).filter(text => text === '整理项目文件' || text === '另一个任务')).toEqual(['整理项目文件', '另一个任务']);
    fireEvent.click(screen.getByRole('button', { name: /^查看任务：另一个任务（/ }));
    await screen.findByText('这次任务没有留下结果或文件。');
    expect(screen.queryByTitle('page.html · HTML 预览')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看任务：整理项目文件（已完成）' }));
    expect(await screen.findByRole('button', { name: '预览：page.html' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTitle('page.html · HTML 预览')).toBeNull();
    expect(reads()).toBe(1);
  });

  it.each([true, false])('offers no answer or stop for readOnly=%s when the viewer cannot control the task', async readOnly => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/run-a') ? { ...detail, canRespond: readOnly, canCancel: readOnly, artifacts: [artifact] } : defaultResponse(url))));
    render(view({ readOnly })); await screen.findByText('确认输出格式');
    expect(screen.queryByRole('button', { name: '发送回复' })).toBeNull();
    expect(screen.queryByRole('button', { name: '拒绝' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    expect(screen.getByText(readOnly ? '只读访问不能回应。' : '只有发起这个任务的人可以回应。')).toBeVisible();
    if (readOnly) {
      expect(screen.queryByRole('form', { name: '执行任务' })).toBeNull();
      expect(screen.queryByRole('button', { name: '存入知识库' })).toBeNull();
      expect(screen.getByText('只读访问：可以查看执行记录，不能发起任务。')).toBeVisible();
      // Reading stays available: the file still downloads.
      expect(screen.getByRole('link', { name: '下载：report.md' })).toBeVisible();
    }
  });

  it('stops through the cancel route and does not call a merely requested stop finished', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url.endsWith('/cancel') ? { id: 'run-a', status: 'running' } : defaultResponse(url)));
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('确认输出格式');
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    await screen.findByText('停止请求已提交，正在核对结果。');
    expect(fetcher.mock.calls.find(([url]) => url.endsWith('/cancel'))).toEqual([`${base}/runs/run-a/cancel`, expect.objectContaining({ method: 'POST', body: '{}' })]);
    expect(screen.queryByText('任务已停止。')).toBeNull();
  });

  it('never resubmits an uncertain creation and reconciles it with exactly the original identity', async () => {
    const inputs: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/computer-runtime')) return json(runtime);
      if (url.endsWith('/computer-runs') && init.method === 'POST') {
        inputs.push(JSON.parse(String(init.body)));
        return inputs.length === 1 ? json({ error: { code: 'unknown', message: '连接中断' } }, 503) : json({ id: 'run-a', status: 'running' }, 202);
      }
      return json(url.endsWith('/computer-runs') ? { items: [] } : detail);
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await composerReady();
    fireEvent.change(task(), { target: { value: '生成报告' } });
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }));
    await screen.findByText('上一次提交的结果还没确认。核对会用原来的提交标识，不会多建一个任务。');
    expect(inputs).toHaveLength(1);
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled();
    expect(task()).toBeDisabled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(inputs).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '核对上次提交' }));
    await screen.findByText('确认输出格式'); expect(inputs).toHaveLength(2); expect(inputs[1]).toEqual(inputs[0]);
  });

  it('keeps the exact response after an unknown outcome and reconciles it only on an explicit click', async () => {
    const inputs: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/respond')) {
        inputs.push(JSON.parse(String(init.body)));
        return inputs.length === 1 ? json({ error: { code: 'unknown', message: '连接中断' } }, 503) : json({ accepted: true, status: 'allowed' });
      }
      return json(url.endsWith('/run-a') ? { ...detail, approvals: [{ ...approval, status: inputs.length > 1 ? 'allowed' : 'pending' }] } : defaultResponse(url));
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('运行命令');
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    await screen.findByText('这条回应已发出，结果还没确认，没有自动重发。');
    expect(inputs).toHaveLength(1); expect(screen.queryByRole('button', { name: '允许一次' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '读取回应状态' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新这个任务' })).not.toBeDisabled());
    expect(inputs).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '核对这条回应' }));
    await screen.findByText('已允许'); expect(inputs[1]).toEqual(inputs[0]);
  });

  it('shows an unaccepted response honestly and never issues a second permission', async () => {
    let responded = false;
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => {
      if (url.endsWith('/respond')) { responded = true; return json({ accepted: false, status: 'unknown' }); }
      return json(url.endsWith('/run-a') ? { ...detail, approvals: [{ ...approval, status: responded ? 'unknown' : 'pending' }] } : defaultResponse(url));
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('运行命令');
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    await screen.findByText('回应结果尚未确认。请读取任务状态，勿重复授权。');
    await screen.findByText('回应结果待核对');
    expect(screen.queryByRole('button', { name: '允许一次' })).toBeNull();
    expect(screen.queryByRole('button', { name: '核对这条回应' })).toBeNull();
    expect(posts(fetcher)).toHaveLength(1);
  });

  it('checks the 8 KiB answer limit in UTF-8 bytes before sending', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(defaultResponse(url)));
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('确认输出格式');
    fireEvent.change(screen.getByLabelText('你的回复'), { target: { value: '中'.repeat(3000) } });
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('回复内容最多 8 KiB');
    expect(posts(fetcher)).toHaveLength(0);
  });

  it('says why a task cannot be sent instead of only disabling the button', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runs') ? { items: [] } : defaultResponse(url))));
    render(view()); await composerReady();
    fireEvent.change(task(), { target: { value: 'x'.repeat(32769) } });
    expect(screen.getByText('任务内容最多 32 KiB。')).toBeVisible();
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled();
  });

  it('aborts the old canvas’s read and never shows its late messages after switching canvas', async () => {
    let resolveOld!: (value: Response) => void; let oldSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes('/tenant-b/')) return json(url.endsWith('/computer-runtime') ? disabled : { items: [] });
      if (url.endsWith('/run-a')) { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { resolveOld = resolve; }); }
      return json(defaultResponse(url));
    }));
    const rendered = render(view()); await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    rendered.rerender(view({ tenantId: 'tenant-b', canvasId: 'canvas-b' })); expect(oldSignal?.aborted).toBe(true);
    await screen.findByText('当前没有可用模型'); await act(async () => { resolveOld(json(detail)); });
    expect(screen.queryByText('正在检查文件')).toBeNull(); expect(screen.queryByText('确认输出格式')).toBeNull();
    expect(screen.queryByText('整理项目文件')).toBeNull();
  });

  it('stops reading when the conversation leaves the screen, never cancels the task, and reads again on return', async () => {
    let observed: AbortSignal | undefined;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/run-a')) return new Promise<Response>((_resolve, reject) => { observed = init.signal as AbortSignal; observed.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
      return json(defaultResponse(url));
    });
    // The state lives with the canvas page; the conversation comes and goes with the mode and the panel.
    function Page({ open }: { open: boolean }) {
      const execution = useManagedExecution('tenant-a', 'canvas-a');
      return open ? <AssistantExecution execution={execution} /> : null;
    }
    vi.stubGlobal('fetch', fetcher);
    const { rerender } = render(<SaaSPreferencesProvider><Page open /></SaaSPreferencesProvider>);
    await waitFor(() => expect(observed).toBeDefined());
    const first = observed!;
    rerender(<SaaSPreferencesProvider><Page open={false} /></SaaSPreferencesProvider>);
    expect(first.aborted).toBe(true);
    const reads = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/run-a')).length;
    const hidden = reads();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(reads()).toBe(hidden);
    rerender(<SaaSPreferencesProvider><Page open /></SaaSPreferencesProvider>);
    await waitFor(() => expect(reads()).toBeGreaterThan(hidden));
    expect(posts(fetcher)).toHaveLength(0);
  });

  it('offers to read a task again when its first read fails, instead of loading forever', async () => {
    let fail = true;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/run-a')) return fail ? json({ error: { code: 'unavailable', message: '暂时不可用' } }, 503) : json(detail);
      return json(defaultResponse(url));
    });
    vi.stubGlobal('fetch', fetcher); render(view());
    expect(await screen.findByText('还没读到这个任务的状态，任务可能仍在运行。')).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByText('确认输出格式')).toBeVisible();
  });

  it('lists a new task at once, before its first read answers', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/computer-runtime')) return json(runtime);
      if (url.endsWith('/computer-runs')) return json(init.method === 'POST' ? { id: 'run-new', status: 'queued' } : { items: [] }, init.method === 'POST' ? 202 : 200);
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await composerReady();
    fireEvent.change(task(), { target: { value: '生成一页原型' } });
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }));
    const thread = within(await screen.findByRole('log', { name: '执行记录' }));
    expect(await thread.findByText('生成一页原型')).toBeVisible();
    expect(thread.getByText('正在读取任务…')).toBeVisible();
  });

  it('opens a pending question’s details as its own, not as a permission', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(defaultResponse(url))));
    render(view()); await screen.findByText('确认输出格式');
    const details = screen.getByText('问题详情').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.queryByText('它要做什么（详情）')).toBeNull();
  });

  it('rejects a mismatched task identity and says when the history is cut short', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? runtime : url.endsWith('/computer-runs') ? { items: [summary], truncated: true } : { ...detail, id: 'other-run' })));
    render(view()); expect(await screen.findByRole('alert')).toHaveTextContent('执行服务返回的数据不完整');
    expect(screen.getByText('只显示最近的任务。')).toBeVisible();
    expect(screen.queryByText('正在检查文件')).toBeNull();
  });

  it('shows a request’s full arguments while marking cut-short messages and results', async () => {
    const command = `${'x'.repeat(9000)} FULL_COMMAND_END`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/run-a') ? {
      ...detail, truncated: true, output: '部分结果', outputTruncated: true,
      messages: [{ ...detail.messages[0], truncated: true }], approvals: [{ ...approval, arguments: { command } }],
    } : defaultResponse(url))));
    render(view()); await screen.findByText('运行命令');
    expect(screen.getByText(/FULL_COMMAND_END/)).toHaveTextContent(command);
    expect(screen.getByText('此条已截断。')).toBeInTheDocument();
    expect(screen.getByText('结果过长已截断，完整内容见下面的文件。')).toBeVisible();
    expect(screen.getByText('记录超过显示上限，部分过程未展示。')).toBeVisible();
  });

  it('folds the process and lists only real counts on the live status line', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/run-a') ? { ...detail, approvals: [], messages: [detail.messages[0], { ...detail.messages[0], id: 'message-b', text: '写入 report.md' }], artifacts: [artifact] } : defaultResponse(url))));
    render(view()); await screen.findByText('正在执行任务');
    const status = screen.getByText('正在执行任务').closest('[role="status"]') as HTMLElement;
    expect(status).toHaveTextContent(/2 条进展 · 1 个文件/);
    expect(status).toHaveTextContent('关闭画布助手不会停止任务。');
    const process = screen.getByText('执行过程（2 条记录）').closest('details') as HTMLDetailsElement;
    expect(process.open).toBe(false);
    expect(within(process).getByText('写入 report.md')).toBeInTheDocument();
  });

  it('times out HTTP reads at 15 seconds without retrying', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal as AbortSignal; signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher); const result = readExecutionRuntime('tenant-a', new AbortController().signal);
    const assertion = expect(result).rejects.toMatchObject({ status: 408, code: 'execution_request_timeout' });
    await vi.advanceTimersByTimeAsync(15000); await assertion; expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
