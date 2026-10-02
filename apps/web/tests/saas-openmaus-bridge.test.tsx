import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenMausBridgePanel, type OpenMausBridgePanelProps } from '../src/saas/OpenMausBridgePanel';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { readOpenMausMessages, readOpenMausStatus } from '../src/saas/openMausApi';

const base = '/api/v1/tenants/tenant-a/openmaus';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const connected = { configured: true, available: true, status: 'connected', message: '本工作区已绑定连接' };
const disabled = { configured: false, available: false, status: 'disabled', message: '未配置 OpenMaus 桥接' };
const bots = { bots: [{ id: 'bot-a', name: 'research', title: '调研 Bot', description: '资料调研', busy: false, activity: '', activeTaskId: 'task-a', tasks: [{ id: 'task-a', title: '市场研究', active: true, busy: false }] }] };
const messages = { botId: 'bot-a', taskId: 'task-a', hasMore: false, messages: [{ id: 'message-a', role: 'assistant', kind: 'text', text: '已经整理好的调研结果', at: '2026-10-01T01:00:00Z', queued: false, needsInput: false, hasImage: false, truncated: false }] };
const source = { id: 'source-openmaus', kind: 'source', title: '调研证据', content: '已经整理好的调研结果', version: 1, currentRevisionId: 'revision-openmaus', contentHash: 'hash', sourceUri: '', provenance: { origin: 'openmaus', botId: 'bot-a', taskId: 'task-a', messageId: 'message-a' }, createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T01:00:00Z' };
const view = (props: Partial<OpenMausBridgePanelProps> = {}) => <SaaSPreferencesProvider><OpenMausBridgePanel tenantId="tenant-a" {...props} /></SaaSPreferencesProvider>;
const selectTask = async () => {
  await screen.findByRole('option', { name: '调研 Bot' });
  fireEvent.change(screen.getByLabelText('Bot'), { target: { value: 'bot-a' } });
  fireEvent.change(screen.getByLabelText('任务会话'), { target: { value: 'task-a' } });
};
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('optional OpenMaus bridge', () => {
  it('normalizes upstream Date.now milliseconds and timezone strings to ISO timestamps', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...messages, messages: [
      { ...messages.messages[0], at: Date.parse('2026-10-01T01:00:00Z') },
      { ...messages.messages[0], id: 'second', at: '2026-10-01T09:00:00+08:00' },
    ] })));
    const result = await readOpenMausMessages('tenant-a', 'bot-a', 'task-a', new AbortController().signal);
    expect(result.messages.map(message => message.at)).toEqual(['2026-10-01T01:00:00.000Z', '2026-10-01T01:00:00.000Z']);
  });

  it.each([null, true, -1, 1.5, 8.65e15, '12345', 'not-a-date', '2026-02-30T00:00:00Z', '2026-10-01T25:00:00Z'])('rejects invalid message timestamp %s', async at => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...messages, messages: [{ ...messages.messages[0], at }] })));
    await expect(readOpenMausMessages('tenant-a', 'bot-a', 'task-a', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_openmaus_response' });
  });

  it('shows an honest disabled state and makes no bot requests or writes, including StrictMode', async () => {
    const fetcher = vi.fn(async () => json(disabled)); vi.stubGlobal('fetch', fetcher);
    render(<StrictMode>{view()}</StrictMode>);
    expect(await screen.findByText('尚未配置桥接')).toBeVisible();
    expect(screen.queryByRole('button', { name: '发送任务' })).toBeNull();
    expect(fetcher.mock.calls.every(([url]) => url === `${base}/status`)).toBe(true);
  });

  it('ignores the real first-request abort during StrictMode effect replay', async () => {
    let attempts = 0;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => ++attempts === 1 ? new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('signal is aborted without reason', 'AbortError')), { once: true });
    }) : json(disabled));
    vi.stubGlobal('fetch', fetcher); render(<StrictMode>{view()}</StrictMode>);
    await screen.findByText('尚未配置桥接');
    expect(screen.queryByRole('alert')).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('aborts a stalled HTTP read at 15 seconds without an automatic retry', async () => {
    vi.useFakeTimers(); let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init.signal as AbortSignal;
      requestSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const result = readOpenMausStatus('tenant-a', new AbortController().signal);
    const assertion = expect(result).rejects.toMatchObject({ status: 408, code: 'openmaus_request_timeout' });
    await vi.advanceTimersByTimeAsync(15000); await assertion;
    expect(requestSignal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires explicit send and does not automatically resend an unknown result or claim completion', async () => {
    let operationId = '';
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/status')) return json(connected);
      if (url.endsWith('/bots')) return json(bots);
      if (url.endsWith('/tasks') && init.method === 'POST') {
        const input = JSON.parse(String(init.body)); operationId = input.operationId;
        return json({ operationId, botId: input.botId, taskId: input.taskId, status: 'unknown', message: '连接中断，发送结果未知' }, 202);
      }
      if (url.endsWith(`/tasks/${operationId}`)) return json({ operationId, botId: 'bot-a', taskId: 'task-a', status: 'sent', message: '请求已送达 Bot' });
      return json(messages);
    });
    vi.stubGlobal('fetch', fetcher); render(view()); await selectTask();
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('发送给此任务的内容'), { target: { value: '只阅读指定资料并总结' } });
    fireEvent.click(screen.getByRole('button', { name: '发送任务' }));
    await screen.findByText('发送结果未知');
    expect(screen.getByRole('button', { name: '发送任务' })).toBeDisabled();
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '查看发送状态' }));
    await screen.findByText('已发送，执行结果待核实');
    expect(screen.getByLabelText('发送给此任务的内容')).toHaveValue('');
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('imports the actual message by ID only after content review and retains provenance in the callback', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => url.endsWith('/status') ? json(connected) : url.endsWith('/bots') ? json(bots) : url.endsWith('/imports') ? json(source, 201) : json(messages));
    const onImported = vi.fn(); vi.stubGlobal('fetch', fetcher); render(view({ onImported })); await selectTask();
    fireEvent.click(screen.getByRole('button', { name: '读取任务消息' }));
    await screen.findByText('已经整理好的调研结果');
    fireEvent.click(screen.getByRole('button', { name: '将此消息存为原始资料' }));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/imports'))).toBe(false);
    fireEvent.change(screen.getByLabelText('资料标题'), { target: { value: '调研证据' } });
    fireEvent.click(screen.getByRole('button', { name: '确认保存原始资料' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ provenance: source.provenance })));
    const write = fetcher.mock.calls.find(([url]) => url.endsWith('/imports'));
    expect(JSON.parse(String(write?.[1].body))).toMatchObject({ botId: 'bot-a', taskId: 'task-a', messageId: 'message-a', title: '调研证据' });
    expect(JSON.parse(String(write?.[1].body))).not.toHaveProperty('content');
  });

  it('aborts a tenant’s pending message read and never displays its late result in another tenant', async () => {
    let resolveOld!: (response: Response) => void; let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes('/tenant-b/')) return json(disabled);
      if (url.endsWith('/status')) return json(connected);
      if (url.endsWith('/bots')) return json(bots);
      oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { resolveOld = resolve; });
    });
    vi.stubGlobal('fetch', fetcher); const rendered = render(view()); await selectTask();
    fireEvent.click(screen.getByRole('button', { name: '读取任务消息' })); await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    rendered.rerender(view({ tenantId: 'tenant-b' }));
    expect(oldSignal?.aborted).toBe(true); await screen.findByText('尚未配置桥接');
    await act(async () => { resolveOld(json(messages)); });
    expect(screen.queryByText('已经整理好的调研结果')).toBeNull();
  });

  it('keeps reader access read-only and exposes input/image/truncation limitations honestly', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/status') ? json(connected) : url.endsWith('/bots') ? json(bots)
      : json({ ...messages, hasMore: true, messages: [{ ...messages.messages[0], needsInput: true, hasImage: true, truncated: true }] })));
    render(view({ readOnly: true })); await selectTask(); fireEvent.click(screen.getByRole('button', { name: '读取任务消息' }));
    await screen.findByText('需要输入或审批，请在 OpenMaus 中处理');
    expect(screen.getByText('消息含图片，请到 OpenMaus 查看')).toBeVisible();
    expect(screen.getByText('此处仅显示部分文本')).toBeVisible();
    expect(screen.queryByRole('button', { name: '发送任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '将此消息存为原始资料' })).toBeNull();
  });

  it('does not substitute messages from another task and clears cached data after 403', async () => {
    let unauthorized = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => unauthorized ? json({ error: { code: 'forbidden' } }, 403)
      : url.endsWith('/status') ? json(connected) : url.endsWith('/bots') ? json(bots) : json({ ...messages, taskId: 'other-task' })));
    render(view()); await selectTask(); fireEvent.click(screen.getByRole('button', { name: '读取任务消息' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('返回的数据不完整');
    expect(screen.queryByText('已经整理好的调研结果')).toBeNull();
    unauthorized = true; fireEvent.click(screen.getByRole('button', { name: '刷新 OpenMaus 状态' }));
    await waitFor(() => expect(screen.queryByLabelText('Bot')).toBeNull());
  });
});
