import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedExecutionPanel, type ManagedExecutionPanelProps } from '../src/saas/ManagedExecutionPanel';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { readExecutionRuntime } from '../src/saas/managedExecutionApi';

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
const view = (props: Partial<ManagedExecutionPanelProps> = {}) => <SaaSPreferencesProvider><ManagedExecutionPanel tenantId="tenant-a" canvasId="canvas-a" {...props} /></SaaSPreferencesProvider>;
const defaultResponse = (url: string) => url.endsWith('/computer-runtime') ? runtime : url.endsWith('/computer-runs') ? { items: [summary] } : detail;
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('managed execution assistant', () => {
  it('uses the existing engine entry when unavailable and never asks for a second connection', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url.endsWith('/computer-runtime') ? disabled : { items: [] }));
    vi.stubGlobal('fetch', fetcher); render(view());
    expect(await screen.findByText('执行服务尚未就绪')).toBeVisible();
    expect(screen.getByRole('link', { name: '管理我的引擎' })).toHaveAttribute('href', '/?account=engines');
    expect(screen.getByRole('button', { name: '创建并执行' })).toBeDisabled();
    expect(screen.queryByText(/OpenMaus|服务端连接|token/i)).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true);
  });

  it.each([
    [{ ...disabled, capabilities: { workspace: true, approvals: true }, reason: 'Configure an available model in My engines' }, '先选择执行模型', '连接一个模型即可开始。请在「我的引擎」中选择或添加可用模型。'],
    [{ ...disabled, reason: 'Managed execution service is not ready' }, '执行服务尚未就绪', '工作区执行服务暂时不可用，请稍后刷新。'],
  ])('localizes fixed runtime reasons and distinguishes missing models from an unavailable service', async (service, title, reason) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? service : { items: [] })));
    render(view()); expect(await screen.findByText(title as string)).toBeVisible(); expect(screen.getByText(reason as string)).toBeVisible();
    expect(screen.queryByText(service.reason)).toBeNull(); expect(screen.getByRole('link', { name: '管理我的引擎' })).toHaveAttribute('href', '/?account=engines');
  });

  it('ignores the first aborted StrictMode load while immediately loading the second scope', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (!url.endsWith('/computer-runtime')) return json({ items: [] });
      if (++reads > 1) return json(runtime);
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }));
    render(<StrictMode>{view()}</StrictMode>);
    expect(await screen.findByText('工作区执行已就绪')).toBeVisible();
    expect(reads).toBe(2); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('completes task creation, question, one-time approval, artifact download and source import in one panel', async () => {
    let stage = 0;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/computer-runtime')) return json(runtime);
      if (url.endsWith('/computer-runs')) return json(init.method === 'POST' ? { id: 'run-a', status: 'queued' } : { items: [] }, init.method === 'POST' ? 202 : 200);
      if (url.endsWith('/respond')) { stage++; return json({ accepted: true, status: 'allowed' }); }
      if (url.endsWith('/knowledge/sources')) return json(source, 201);
      return json(stage === 0 ? detail : stage === 1 ? { ...detail, approvals: [approval] } : { ...detail, status: 'completed', canRespond: false, canCancel: false, approvals: [{ ...approval, status: 'allowed' }], output: '项目汇总已生成', artifacts: [artifact] });
    });
    const onImported = vi.fn(); const onArtifactsChanged = vi.fn();
    vi.stubGlobal('fetch', fetcher); render(view({ onImported, onArtifactsChanged, knowledgeReferences: [{ revisionId: 'frozen-revision', title: '需求原文' }] }));
    await screen.findByText('工作区执行已就绪');
    expect(screen.getByText('引用 1 份知识版本')).toBeVisible();
    fireEvent.change(screen.getByLabelText('任务目标与角色要求'), { target: { value: '汇总项目文件并输出 Markdown' } });
    fireEvent.change(screen.getByLabelText('推理强度'), { target: { value: 'medium' } });
    expect(fetcher.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '创建并执行' }));
    await screen.findByText('确认输出格式');
    const creation = fetcher.mock.calls.find(([url, init]) => url.endsWith('/computer-runs') && init.method === 'POST');
    expect(JSON.parse(String(creation?.[1].body))).toMatchObject({ runtime: 'openai-agents', model: 'byok_model_a', effort: 'medium', knowledgeRevisionIds: ['frozen-revision'] });
    expect(screen.getByRole('button', { name: '发送回复' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('回复内容'), { target: { value: 'Markdown' } });
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }));
    await screen.findByText('运行命令');
    expect(screen.getByText(/"command": "write report.md"/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '仅允许本次' }));
    await screen.findByText('项目汇总已生成');
    expect(onArtifactsChanged).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '下载' })).toHaveAttribute('href', `${base}/artifacts/artifact-a`);
    const responses = fetcher.mock.calls.filter(([url]) => url.endsWith('/respond')).map(([, init]) => JSON.parse(String(init.body)));
    expect(responses[0]).toMatchObject({ requestId: 'question-a', behavior: 'allow', message: 'Markdown' });
    expect(responses[1]).toMatchObject({ requestId: 'approval-b', behavior: 'allow' });
    fireEvent.click(screen.getByRole('button', { name: '存入知识库' }));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/knowledge/sources'))).toBe(false);
    fireEvent.change(screen.getByLabelText('资料标题'), { target: { value: '汇总原件' } });
    fireEvent.click(screen.getByRole('button', { name: '确认保存原始产物' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(source));
    const imported = fetcher.mock.calls.find(([url]) => url.endsWith('/knowledge/sources'));
    const input = JSON.parse(String(imported?.[1].body));
    expect(input).toMatchObject({ artifactId: 'artifact-a', title: '汇总原件' });
    expect(input).not.toHaveProperty('content');
  });

  it('recovers history and lets the task creator explicitly deny a request', async () => {
    let responded = false;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/respond')) { responded = true; return json({ accepted: true, status: 'denied' }); }
      return json(url.endsWith('/run-a') ? { ...detail, approvals: [{ ...approval, status: responded ? 'denied' : 'pending' }] } : defaultResponse(url));
    });
    vi.stubGlobal('fetch', fetcher); render(view());
    await screen.findByText('运行命令');
    expect(fetcher.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '拒绝本次请求' }));
    await screen.findByText('已拒绝');
    expect(JSON.parse(String(fetcher.mock.calls.find(([url]) => url.endsWith('/respond'))?.[1].body))).toMatchObject({ requestId: 'approval-b', behavior: 'deny' });
  });

  it.each([true, false])('blocks approval and stop for readOnly=%s when the viewer lacks control', async readOnly => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/run-a') ? { ...detail, canRespond: readOnly, canCancel: readOnly, artifacts: [artifact] } : defaultResponse(url))));
    render(view({ readOnly })); await screen.findByText('确认输出格式');
    expect(screen.queryByRole('button', { name: '发送回复' })).toBeNull();
    expect(screen.queryByRole('button', { name: '拒绝本次请求' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止任务' })).toBeNull();
    if (readOnly) { expect(screen.queryByRole('button', { name: '创建并执行' })).toBeNull(); expect(screen.queryByRole('button', { name: '存入知识库' })).toBeNull(); }
  });

  it('uses the existing cancel route and does not treat merely requested cancellation as terminal', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url.endsWith('/cancel') ? { id: 'run-a', status: 'running' } : defaultResponse(url)));
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('确认输出格式');
    fireEvent.click(screen.getByRole('button', { name: '停止任务' }));
    await screen.findByText('停止请求已提交，正在核对结果。');
    expect(fetcher.mock.calls.find(([url]) => url.endsWith('/cancel'))).toEqual([`${base}/runs/run-a/cancel`, expect.objectContaining({ method: 'POST', body: '{}' })]);
    expect(screen.queryByText('任务已停止。')).toBeNull();
  });

  it('does not auto-resubmit an uncertain creation and reconciles with exactly the original identity', async () => {
    const inputs: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/computer-runtime')) return json(runtime);
      if (url.endsWith('/computer-runs') && init.method === 'POST') {
        inputs.push(JSON.parse(String(init.body)));
        return inputs.length === 1 ? json({ error: { code: 'unknown', message: '连接中断' } }, 503) : json({ id: 'run-a', status: 'running' }, 202);
      }
      return json(url.endsWith('/computer-runs') ? { items: [] } : detail);
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('工作区执行已就绪');
    fireEvent.change(screen.getByLabelText('任务目标与角色要求'), { target: { value: '生成报告' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并执行' }));
    await screen.findByText('本次提交结果尚未确认');
    expect(inputs).toHaveLength(1); expect(screen.getByRole('button', { name: '创建并执行' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '刷新执行服务和历史' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新执行服务和历史' })).not.toBeDisabled());
    expect(inputs).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '核对本次提交' }));
    await screen.findByText('确认输出格式'); expect(inputs).toHaveLength(2); expect(inputs[1]).toEqual(inputs[0]);
  });

  it('preserves the exact approval after an unknown result and only reconciles on an explicit click', async () => {
    const inputs: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/respond')) {
        inputs.push(JSON.parse(String(init.body)));
        return inputs.length === 1 ? json({ error: { code: 'unknown', message: '连接中断' } }, 503) : json({ accepted: true, status: 'allowed' });
      }
      return json(url.endsWith('/run-a') ? { ...detail, approvals: [{ ...approval, status: inputs.length > 1 ? 'allowed' : 'pending' }] } : defaultResponse(url));
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('运行命令');
    fireEvent.click(screen.getByRole('button', { name: '仅允许本次' }));
    await screen.findByText('已发送此回应，结果尚待核对。未自动重发。');
    expect(inputs).toHaveLength(1); expect(screen.queryByRole('button', { name: '仅允许本次' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '读取回应状态' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新当前任务' })).not.toBeDisabled());
    expect(inputs).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '核对本次回应' }));
    await screen.findByText('已允许 / 已回复'); expect(inputs[1]).toEqual(inputs[0]);
  });

  it('shows a durable unaccepted approval receipt honestly and never issues a second permission', async () => {
    let responded = false;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/respond')) { responded = true; return json({ accepted: false, status: 'unknown' }); }
      return json(url.endsWith('/run-a') ? { ...detail, approvals: [{ ...approval, status: responded ? 'unknown' : 'pending' }] } : defaultResponse(url));
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('运行命令');
    fireEvent.click(screen.getByRole('button', { name: '仅允许本次' }));
    await screen.findByText('回应结果尚未确认。请读取任务状态，勿重复授权。');
    await screen.findByText('回应结果待核对');
    expect(screen.queryByRole('button', { name: '仅允许本次' })).toBeNull();
    expect(screen.queryByRole('button', { name: '核对本次回应' })).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('checks the 8 KiB reply limit as UTF-8 bytes before sending a question response', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(defaultResponse(url)));
    vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('确认输出格式');
    fireEvent.change(screen.getByLabelText('回复内容'), { target: { value: '中'.repeat(3000) } });
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('回复内容最多 8 KiB');
    expect(fetcher.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
  });

  it('aborts an old tenant detail read and never displays its late messages after switching scope', async () => {
    let resolveOld!: (value: Response) => void; let oldSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes('/tenant-b/')) return json(url.endsWith('/computer-runtime') ? disabled : { items: [] });
      if (url.endsWith('/run-a')) { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { resolveOld = resolve; }); }
      return json(defaultResponse(url));
    }));
    const rendered = render(view()); await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    rendered.rerender(view({ tenantId: 'tenant-b', canvasId: 'canvas-b' })); expect(oldSignal?.aborted).toBe(true);
    await screen.findByText('执行服务尚未就绪'); await act(async () => { resolveOld(json(detail)); });
    expect(screen.queryByText('正在检查文件')).toBeNull(); expect(screen.queryByText('确认输出格式')).toBeNull();
  });

  it('keeps closing available during a request and never cancels the server task on unmount', async () => {
    let observed: AbortSignal | undefined;
    const onClose = vi.fn();
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/run-a')) return new Promise<Response>((_resolve, reject) => { observed = init.signal as AbortSignal; observed.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
      return json(defaultResponse(url));
    });
    vi.stubGlobal('fetch', fetcher); const rendered = render(view({ onClose })); await waitFor(() => expect(observed).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '关闭执行助手' })); expect(onClose).toHaveBeenCalledOnce();
    rendered.unmount(); expect(observed?.aborted).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
  });

  it('rejects a mismatched run identity and displays explicit history truncation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? runtime : url.endsWith('/computer-runs') ? { items: [summary], truncated: true } : { ...detail, id: 'other-run' })));
    render(view()); expect(await screen.findByRole('alert')).toHaveTextContent('返回的数据不完整');
    expect(screen.getByText('仅显示最近的任务记录。')).toBeVisible();
    expect(screen.queryByText('正在检查文件')).toBeNull();
  });

  it('shows full approval arguments while marking truncated messages and results', async () => {
    const command = `${'x'.repeat(9000)} FULL_COMMAND_END`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/run-a') ? {
      ...detail, truncated: true, output: '部分结果', outputTruncated: true,
      messages: [{ ...detail.messages[0], truncated: true }], approvals: [{ ...approval, arguments: { command } }],
    } : defaultResponse(url))));
    render(view()); await screen.findByText('运行命令');
    expect(screen.getByText(/FULL_COMMAND_END/)).toHaveTextContent(command);
    expect(screen.getByText('此消息内容已截断。')).toBeVisible();
    expect(screen.getByText('此结果内容已截断，请查看已保存产物。')).toBeVisible();
    expect(screen.getByText('当前记录超过显示上限，部分历史未展示。')).toBeVisible();
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
