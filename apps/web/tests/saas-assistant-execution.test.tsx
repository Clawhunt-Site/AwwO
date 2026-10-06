import { Fragment, StrictMode, useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskStartUnconfirmed } from '../src/canvas/assistantRouting';
import { executionHost } from '../src/saas/AssistantExecution';
import { executionModelKey, useManagedExecution } from '../src/saas/useManagedExecution';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { readExecutionRuntime } from '../src/saas/managedExecutionApi';
import { SaaSApiError } from '../src/saas/api';
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

// What the canvas does with the host: activates it when it opens, shows the conversation, and sends a message
// the server routed to execution through start. The composer here stands in for the assistant's one composer.
function Conversation({ execution, open = true }: { execution: ReturnType<typeof useManagedExecution>; open?: boolean }) {
  const host = executionHost(execution);
  const [tasks, setTasks] = useState<Array<{ id: string; prompt: string }>>([]);
  const [text, setText] = useState('');
  const [failure, setFailure] = useState('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { execution.activate(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { execution.setVisible(open); }, [open]);
  if (!open) return null;
  const send = () => {
    setFailure('');
    const prompt = text;
    host.start(prompt).then(id => { setTasks(previous => [...previous, { id, prompt }]); setText(''); }, (error: Error) => setFailure(error.message));
  };
  return <div className="awwo-assistant-messages" role="log" aria-label="执行记录">
    {host.renderEarlier(new Set(tasks.map(task => task.id)), true)}
    <ol>{tasks.map(task => <Fragment key={task.id}><li>{task.prompt}</li><li>{host.renderTask(task.id)}</li></Fragment>)}</ol>
    {host.renderNotices(true)}
    {host.settings}
    {!execution.readOnly && <form onSubmit={event => { event.preventDefault(); send(); }}>
      <textarea aria-label="任务说明" value={text} disabled={execution.busy} onChange={event => setText(event.target.value)} />
      <button type="submit" disabled={!host.ready || execution.busy || !text.trim()}>开始执行</button>
    </form>}
    {failure && <p role="alert">{failure}</p>}
  </div>;
}
function Harness({ tenantId = 'tenant-a', canvasId = 'canvas-a', readOnly = false, open = true }: { tenantId?: string; canvasId?: string; readOnly?: boolean; open?: boolean }) {
  const execution = useManagedExecution(tenantId, canvasId, { readOnly });
  return <Conversation key={`${tenantId}/${canvasId}`} execution={execution} open={open} />;
}
const view = (props: Parameters<typeof Harness>[0] = {}) => <SaaSPreferencesProvider><Harness {...props} /></SaaSPreferencesProvider>;
const defaultResponse = (url: string) => url.endsWith('/computer-runtime') ? runtime : url.endsWith('/computer-runs') ? { items: [summary] } : detail;
const posts = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
/** The composer is ready once the catalogue has loaded and offered its model. */
const composerReady = () => screen.findByText('直接执行用：已有模型连接');
const task = () => screen.getByRole('textbox', { name: '任务说明' });
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearSaaSCanvas(); });

describe('the canvas assistant’s tasks', () => {
  it('reads nothing until the canvas activates it', async () => {
    const fetcher = vi.fn(async (url: string) => json(defaultResponse(url)));
    vi.stubGlobal('fetch', fetcher);
    renderHook(() => useManagedExecution('tenant-a', 'canvas-a'), { wrapper: SaaSPreferencesProvider });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(fetcher).not.toHaveBeenCalled();
    render(view());
    await screen.findByText('确认输出格式');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([`${base}/computer-runtime`, `${base}/canvases/canvas-a/computer-runs`, `${base}/computer-runs/run-a`]));
  });

  it('reads the history again when the conversation is shown again, keeping the open task', async () => {
    let items = [summary];
    const fetcher = vi.fn(async (url: string) => json(url.endsWith('/computer-runs') ? { items } : defaultResponse(url)));
    function Reopen({ open }: { open: boolean }) {
      const execution = useManagedExecution('tenant-a', 'canvas-a');
      return <Conversation execution={execution} open={open} />;
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
    expect(screen.getByRole('button', { name: '重新检查执行服务' })).toBeEnabled();
  });

  it('re-reads the service only when asked to check again', async () => {
    let ready = false;
    const fetcher = vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? (ready ? runtime : disabled) : { items: [] }));
    vi.stubGlobal('fetch', fetcher); render(view());
    await screen.findByText('当前没有可用模型');
    const reads = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/computer-runtime')).length;
    expect(reads()).toBe(1);
    ready = true;
    fireEvent.click(screen.getByRole('button', { name: '重新检查执行服务' }));
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
    // The response's 'being checked' line is answered by the task's end, and goes.
    await waitFor(() => expect(screen.queryByText('回应已提交，正在核对任务状态。')).toBeNull());
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
    expect(screen.getByText('直接执行用：已有模型连接 · medium')).toBeVisible();
    fireEvent.change(screen.getByLabelText('直接执行的模型'), { target: { value: executionModelKey('pi', 'plain_model') } });
    expect(screen.queryByLabelText('思考强度')).toBeNull();
    fireEvent.change(screen.getByLabelText('直接执行的模型'), { target: { value: executionModelKey('openai-agents', 'byok_model_a') } });
    expect(screen.getByLabelText('思考强度')).toHaveValue('');
    // A level the next model also offers is still reset: effort belongs to the model it was chosen for.
    fireEvent.change(screen.getByLabelText('思考强度'), { target: { value: 'low' } });
    fireEvent.change(screen.getByLabelText('直接执行的模型'), { target: { value: executionModelKey('openai-agents', 'byok_model_c') } });
    expect(screen.getByLabelText('思考强度')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('直接执行的模型'), { target: { value: executionModelKey('openai-agents', 'byok_model_a') } });
    fireEvent.change(screen.getByLabelText('直接执行的模型'), { target: { value: executionModelKey('pi', 'plain_model') } });
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
    expect(result.current.startBlockedReason).toBeUndefined();
    service = runtime;
    act(() => result.current.refreshAll());
    await waitFor(() => expect(result.current.choice.unavailableLabel).toBe('第二个模型'));
    expect(result.current.choice.key).toBe(executionModelKey('openai-agents', 'byok_model_b'));
    expect(result.current.startBlockedReason).toBe('所选模型已不可用，请重新选择。');
    await expect(result.current.start('生成报告')).rejects.toThrow('所选模型已不可用，请重新选择。');
    act(() => result.current.chooseModel(executionModelKey('openai-agents', 'byok_model_a')));
    expect(result.current.choice.unavailableLabel).toBeUndefined();
    expect(result.current.startBlockedReason).toBeUndefined();
  });

  it('keeps a model the refreshed list dropped, first and marked unavailable, instead of silently replacing it', async () => {
    let service: typeof runtime = { ...runtime, models: [runtime.models[0], { id: 'byok_model_b', label: '第二个模型', runtime: 'openai-agents' }] };
    const fetcher = vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? service : url.endsWith('/computer-runs') ? { items: [] } : detail));
    vi.stubGlobal('fetch', fetcher); render(view()); await composerReady();
    expect(screen.getByRole('link', { name: '管理我的引擎' })).toHaveAttribute('href', '/?account=engines');
    fireEvent.change(screen.getByLabelText('直接执行的模型'), { target: { value: executionModelKey('openai-agents', 'byok_model_b') } });
    // The engine is removed in My engines; the list is read again only when asked.
    service = runtime;
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/computer-runtime'))).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '刷新模型列表' }));
    expect(await screen.findByText('直接执行用：第二个模型（已不可用）')).toBeVisible();
    const select = screen.getByLabelText('直接执行的模型') as HTMLSelectElement;
    expect(select).toHaveValue(executionModelKey('openai-agents', 'byok_model_b'));
    expect(select.options[0]).toHaveTextContent('第二个模型（已不可用）');
    expect(select.options[0].disabled).toBe(true);
    fireEvent.change(task(), { target: { value: '生成报告' } });
    // A task cannot start, so the assistant's messages are planned until another model is chosen.
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

  it('reads a task it is not showing before stopping it, and stops none that has ended', async () => {
    const other = { ...summary, id: 'run-b', prompt: '另一个任务', createdAt: '2026-10-01T00:00:00Z' };
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => {
      if (url.endsWith('/cancel')) return json({ id: 'run-a', status: 'cancelled' });
      if (url.endsWith('/computer-runs')) return json({ items: [summary, other] });
      if (url.endsWith('/computer-runs/run-b')) return json({ ...detail, ...other, status: 'completed', canCancel: false });
      return json(defaultResponse(url));
    });
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a'), { wrapper: SaaSPreferencesProvider });
    act(() => { result.current.activate(); result.current.setVisible(true); });
    await waitFor(() => expect(result.current.run?.id).toBe('run-a'));
    // The list, read once, still has run-b running; it has ended since.
    expect(result.current.finished('run-b')).toBe(false);
    await act(async () => { await result.current.stopTask('run-b'); });
    expect(fetcher.mock.calls.map(([url]) => url)).toContain(`${base}/computer-runs/run-b`);
    expect(posts(fetcher)).toHaveLength(0);
    await act(async () => { await result.current.stopTask('run-a'); });
    expect(posts(fetcher).map(([url]) => url)).toEqual([`${base}/runs/run-a/cancel`]);
  });

  it('rejects a start whose outcome is unknown as unconfirmed, and a refused one as an error to show', async () => {
    let refuse = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => url.endsWith('/computer-runs') && init.method === 'POST'
      ? refuse ? json({ error: { code: 'invalid_request', message: '任务内容无效' } }, 400) : json({ error: { code: 'unknown', message: '连接中断' } }, 503)
      : json(url.endsWith('/computer-runs') ? { items: [] } : defaultResponse(url))));
    const started = async () => {
      const { result, unmount } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a'), { wrapper: SaaSPreferencesProvider });
      act(() => result.current.activate());
      await waitFor(() => expect(result.current.startBlockedReason).toBeUndefined());
      let failure: unknown;
      await act(async () => { failure = await result.current.start('生成报告').catch((error: unknown) => error); });
      const pending = result.current.pendingSubmission;
      unmount();
      return { failure, pending };
    };
    const unknown = await started();
    expect(unknown.failure).toBeInstanceOf(TaskStartUnconfirmed);
    expect(unknown.pending).not.toBeNull();
    refuse = true;
    const refused = await started();
    expect(refused.failure).toBeInstanceOf(Error);
    expect(refused.failure).not.toBeInstanceOf(TaskStartUnconfirmed);
    expect(refused.pending).toBeNull();
  });

  it('names the task a reconcile confirmed, for the canvas’s unconfirmed request', async () => {
    const creations: Array<{ operationId: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/computer-runs') && init.method === 'POST') {
        creations.push(JSON.parse(String(init.body)));
        return creations.length === 1 ? json({ error: { code: 'unknown', message: '连接中断' } }, 503) : json({ id: `run-z${creations.length > 2 ? '2' : ''}`, status: 'running' }, 202);
      }
      return json(url.endsWith('/computer-runs') ? { items: [] } : defaultResponse(url));
    }));
    const { result } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a'), { wrapper: SaaSPreferencesProvider });
    act(() => result.current.activate());
    await waitFor(() => expect(result.current.startBlockedReason).toBeUndefined());
    await act(async () => { await result.current.start('生成报告').catch(() => undefined); });
    expect(result.current.confirmedTask).toBe('');
    expect(executionHost(result.current).confirmedTask).toBeUndefined();
    act(() => result.current.reconcile());
    await waitFor(() => expect(result.current.confirmedTask).toBe('run-z'));
    expect(executionHost(result.current).confirmedTask).toBe('run-z');
    // The same text sent again later is a new task, not a replay of the reconciled one.
    await act(async () => { await result.current.start('生成报告').catch(() => undefined); });
    const operations = creations.map(body => body.operationId);
    expect(operations).toHaveLength(3);
    expect(operations[1]).toBe(operations[0]);
    expect(operations[2]).not.toBe(operations[0]);
  });

  it('leaves a refused start’s and stop’s words to the canvas: one message, in the reader’s words', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/computer-runs') && init.method === 'POST') return json({ error: { code: 'forbidden', message: 'Forbidden' } }, 403);
      if (url.endsWith('/cancel')) return json({ error: { code: 'invalid_state', message: 'Run is not active' } }, 400);
      if (url.endsWith('/computer-runs/run-gone')) return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
      return json(url.endsWith('/computer-runs') ? { items: [summary] } : defaultResponse(url));
    }));
    const { result } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a'), { wrapper: SaaSPreferencesProvider });
    act(() => { result.current.activate(); result.current.setVisible(true); });
    await waitFor(() => expect(result.current.run?.id).toBe('run-a'));
    let stopFailure: unknown;
    await act(async () => { stopFailure = await result.current.stopTask('run-a').catch((error: unknown) => error); });
    expect(stopFailure).toBeInstanceOf(Error);
    expect(stopFailure).not.toBeInstanceOf(SaaSApiError);
    // A task it is not showing is read first; that read fails in the reader's words too.
    let readFailure: unknown;
    await act(async () => { readFailure = await result.current.stopTask('run-gone').catch((error: unknown) => error); });
    expect(readFailure).toBeInstanceOf(Error);
    expect(readFailure).not.toBeInstanceOf(SaaSApiError);
    let startFailure: unknown;
    await act(async () => { startFailure = await result.current.start('生成报告').catch((error: unknown) => error); });
    expect(startFailure).toBeInstanceOf(Error);
    expect(startFailure).not.toBeInstanceOf(SaaSApiError);
    // The canvas says it; the host shows no second alert of its own, and forgets what a lost access read.
    expect(result.current.error).toBeNull();
    expect(result.current.history.items).toEqual([]);
  });

  it.each([true, false])('says where messages go while tasks cannot start, as far as the canvas can take them (planAvailable=%s)', async planAvailable => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? disabled : url.endsWith('/computer-runs') ? { items: [] } : detail)));
    function Notices() {
      const execution = useManagedExecution('tenant-a', 'canvas-a');
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => { execution.activate(); }, []);
      return <>{executionHost(execution).renderNotices(planAvailable)}</>;
    }
    render(<SaaSPreferencesProvider><Notices /></SaaSPreferencesProvider>);
    const box = await screen.findByText(/暂时不能直接执行任务。/);
    if (planAvailable) expect(box).toHaveTextContent('消息会用来调整画布。');
    else expect(box).not.toHaveTextContent('消息会用来调整画布。');
  });

  it('says why a task cannot start when the service is ready but no model is chosen', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? { ...runtime, models: [] } : url.endsWith('/computer-runs') ? { items: [] } : detail)));
    function Notices() {
      const execution = useManagedExecution('tenant-a', 'canvas-a');
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => { execution.activate(); }, []);
      return <>{executionHost(execution).renderNotices(true)}</>;
    }
    render(<SaaSPreferencesProvider><Notices /></SaaSPreferencesProvider>);
    expect(await screen.findByText('暂时不能直接执行任务：先选择执行模型。 消息会用来调整画布。')).toBeVisible();
  });

  it.each([
    ['computer_busy', '工作区正忙：它一次只运行一个任务。等当前任务结束后再试。'],
    ['credits_exhausted', '本期套餐点数已用完。可以把节点换成默认模型继续，点数在下次续费后重置；需要更多点数可以请工作区所有者在「套餐与点数」里升级。'],
    ['some_new_code', '任务没有完成（some_new_code）。'],
  ])('says why a task ended without its result (%s) as a sentence', async (code, sentence) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/run-a') ? { ...detail, status: 'failed', error: code, canRespond: false, canCancel: false, approvals: [] } : defaultResponse(url))));
    render(view());
    expect(await screen.findByText(sentence)).toBeVisible();
  });

  it('keeps a known service ready while it is read again', async () => {
    let hold = false;
    let release = () => {};
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/computer-runtime') && hold) await new Promise<void>(resolve => { release = resolve; });
      return json(url.endsWith('/computer-runs') ? { items: [] } : defaultResponse(url));
    }));
    const { result } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a'), { wrapper: SaaSPreferencesProvider });
    act(() => result.current.activate());
    await waitFor(() => expect(result.current.startBlockedReason).toBeUndefined());
    hold = true;
    act(() => result.current.refreshAll());
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.startBlockedReason).toBeUndefined();
    await act(async () => { release(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it.each([true, false])('says when the canvas’s tasks could not be read, and reads them again on request (readOnly=%s)', async readOnly => {
    let runs: 'hold' | 'fail' | 'none' = readOnly ? 'hold' : 'fail';
    let release = () => {};
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/computer-runs')) {
        if (runs === 'hold') await new Promise<void>(resolve => { release = resolve; });
        return runs === 'none' ? json({ items: [] }) : json({ error: { code: 'unavailable', message: '暂时不可用' } }, 503);
      }
      return json(defaultResponse(url));
    }));
    render(view({ readOnly }));
    if (readOnly) {
      // A viewer has only the list, so it says it is being read.
      expect(await screen.findByText('正在读取这张画布的任务…')).toBeVisible();
      runs = 'fail';
      await act(async () => { release(); });
    }
    expect(await screen.findByText('没读到这张画布的任务。')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    runs = 'none';
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    await waitFor(() => expect(screen.queryByText('没读到这张画布的任务。')).toBeNull());
    if (readOnly) expect(screen.getByText('这张画布还没有任务。')).toBeVisible();
    else expect(screen.queryByText('这张画布还没有任务。')).toBeNull();
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
    await screen.findByText('上一次提交的任务结果还没确认。核对会用原来的提交标识，不会多建一个任务。');
    expect(inputs).toHaveLength(1);
    // Until it is reconciled no task starts: the assistant's messages are planned meanwhile.
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled();
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

  it('says why a task cannot be started, and sends nothing', async () => {
    const fetcher = vi.fn(async (url: string) => json(url.endsWith('/computer-runs') ? { items: [] } : defaultResponse(url)));
    vi.stubGlobal('fetch', fetcher); render(view()); await composerReady();
    fireEvent.change(task(), { target: { value: 'x'.repeat(32769) } });
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('任务内容最多 32 KiB。');
    expect(posts(fetcher)).toHaveLength(0);
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
      return <Conversation execution={execution} open={open} />;
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
