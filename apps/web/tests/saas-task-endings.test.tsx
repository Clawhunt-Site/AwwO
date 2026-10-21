// A customer's report (2026-10-16): a direct task stopped part-way with no way on, and the usage count was a mystery.
// A task card now says why it ended in plain words, how many calls it used and whether they were given back, and
// offers to try it again; the header meter hears when a task ends.
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionHost } from '../src/saas/AssistantExecution';
import { useManagedExecution } from '../src/saas/useManagedExecution';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { ROUTE_USAGE_CHANGED } from '../src/saas/routeUsage';
import { assistantRouteRequest } from '../src/canvas/assistantRouting';
import { clearSaaSCanvas } from '../src/saas/canvasBridge';

const time = '2026-10-16T06:40:00Z';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const runtime = { ready: true, capabilities: { workspace: true, approvals: true }, models: [{ id: 'm', label: '默认模型', runtime: 'openai-agents' }] };
const summary = { id: 'run-a', status: 'failed', prompt: '做一个专属游戏', createdAt: time, updatedAt: '2026-10-16T06:52:00Z', error: '' };
const ended = (fields: Record<string, unknown>) => ({ ...summary, output: '', error: '', canRespond: false, canCancel: false, truncated: false,
  messages: [], approvals: [], artifacts: [], calls: 7, refundedCalls: 0, ...fields });

function Card({ send, readOnly = false }: { send?: (text: string) => void; readOnly?: boolean }) {
  const execution = useManagedExecution('tenant-a', 'canvas-a', { readOnly });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { execution.activate(); execution.setVisible(true); }, []);
  const host = executionHost(execution);
  return <div className="awwo-assistant-messages">{host.renderTask('run-a', send ? { send } : undefined)}</div>;
}
const shown = async (fields: Record<string, unknown>, props: Parameters<typeof Card>[0] = {}) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? runtime
    : url.endsWith('/computer-runs') ? { items: [{ ...summary, ...fields }] } : ended(fields))));
  render(<SaaSPreferencesProvider><Card {...props} /></SaaSPreferencesProvider>);
  // The canvas's latest task opens by itself.
  await screen.findByRole('status');
};
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearSaaSCanvas(); });

describe('a direct task that ended without its result', () => {
  it('says it ran out of time, how many calls it used, and tries again with the same request', async () => {
    const send = vi.fn();
    await shown({ error: 'computer_task_timeout' }, { send });
    expect(await screen.findByText('任务超过了时间上限，没有做完。可以重试，或把它拆成几步分别发。')).toBeVisible();
    expect(screen.getByText(/用了 7 次/)).toBeInTheDocument();
    expect(screen.queryByText(/退还到当天的总次数/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试这个任务' }));
    expect(send).toHaveBeenCalledWith('做一个专属游戏');
  });

  it('says what it had to send outgrew its model, at its start or part-way, and offers no retry that would end the same way', async () => {
    await shown({ error: 'computer_context_limit' }, { send: vi.fn() });
    expect(await screen.findByText('任务要交给模型的内容超出了这个模型一次能读的量，没能继续。可以换一个上下文更大的模型，或把任务拆成几步、每步少带些资料分别发。')).toBeVisible();
    expect(screen.queryByRole('button', { name: '重试这个任务' })).toBeNull();
  });

  it('says the platform failed it and that its calls go back', async () => {
    await shown({ error: 'computer_execution_failed', refundedCalls: 7 }, { send: vi.fn() });
    expect(await screen.findByText('任务在执行途中失败了（执行服务或一次模型调用出了错），没有做完。')).toBeVisible();
    // No number: the daily cap can keep part of it back.
    expect(screen.getByText('这是平台的原因：这次用掉的次数退还到当天的总次数；每天最多退还 32 次，超出的照常计算。')).toBeVisible();
  });

  it('says only the calls a platform time limit cut go back (owner 2026-10-18)', async () => {
    await shown({ error: 'computer_execution_failed', refundedCalls: 1, refundScope: 'cut' }, { send: vi.fn() });
    expect(await screen.findByText('任务在执行途中失败了（执行服务或一次模型调用出了错），没有做完。')).toBeVisible();
    expect(screen.getByText('这是平台的原因：平台的时间限制掐断了调用，被掐断的调用退还到当天的总次数，这个任务的其他调用照常计算；每天最多退还 32 次。')).toBeVisible();
    expect(screen.queryByText(/这次用掉的次数退还/)).toBeNull();
  });

  it('reads a server without the refund scope as every call given back', async () => {
    await shown({ error: 'computer_execution_failed', refundedCalls: 7, refundScope: undefined }, { send: vi.fn() });
    expect(await screen.findByText('这是平台的原因：这次用掉的次数退还到当天的总次数；每天最多退还 32 次，超出的照常计算。')).toBeVisible();
  });

  it('says a restart interrupted it', async () => {
    await shown({ status: 'interrupted', error: 'API restarted before completion' }, { send: vi.fn() });
    expect(await screen.findByText('服务重启，任务被中断了，没有做完。')).toBeVisible();
    expect(screen.getByRole('button', { name: '重试这个任务' })).toBeEnabled();
  });

  it('offers the plans, not a retry, when the allowance ran out, and nothing to a viewer', async () => {
    await shown({ error: 'quota_exceeded' }, { send: vi.fn() });
    await screen.findByText(/今天的调用次数用完了/);
    expect(screen.queryByRole('button', { name: '重试这个任务' })).toBeNull();
    cleanup();
    // A refusal that would come again either.
    await shown({ error: 'credits_exhausted' }, { send: vi.fn() });
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: '重试这个任务' })).toBeNull();
    cleanup();
    await shown({ error: 'computer_execution_failed' }, { readOnly: true, send: vi.fn() });
    await screen.findByText(/任务在执行途中失败了/);
    expect(screen.queryByRole('button', { name: '重试这个任务' })).toBeNull();
  });

  it('tells the header meter once when a task it reads has ended', async () => {
    const heard = vi.fn();
    window.addEventListener(ROUTE_USAGE_CHANGED, heard);
    try {
      await shown({ status: 'completed', error: '', output: '做好了' }, { send: vi.fn() });
      await screen.findByText('做好了');
      await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('button', { name: '重试这个任务' })).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(ROUTE_USAGE_CHANGED, heard);
    }
  });
});

describe('the router reads how earlier tasks ended', () => {
  it('names a task’s outcome when the host knows it, and the old words when it does not', () => {
    const doc = { version: 1, nodes: [], edges: [] } as never;
    const messages = [{ id: 'u', role: 'user', content: '做一个专属游戏', route: 'execute' }, { id: 'a', role: 'assistant', content: '', route: 'execute', taskId: 'run-a' }] as never;
    const known = assistantRouteRequest('继续', ['plan', 'execute'], doc, messages, id => id === 'run-a' ? 'failed part-way: the execution service or a model call failed' : undefined);
    expect(known.recent[1].text).toBe('(a direct task in the workspace: failed part-way: the execution service or a model call failed)');
    expect(assistantRouteRequest('继续', ['plan', 'execute'], doc, messages).recent[1].text).toBe('(a task was started in the workspace)');
  });
});
