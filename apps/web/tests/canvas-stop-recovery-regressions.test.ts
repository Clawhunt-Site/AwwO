import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatFrame } from '../src/canvasAgentChat';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import * as sessions from '../src/canvas/sessions';
import { cancelConversationRunViaGateway, execAgentViaGateway } from '../src/canvas/runTransport';
import { runGraph, type RunNodeStatus } from '../src/canvas/runGraph';

const streamMock = vi.fn();
vi.mock('../src/canvasAgentChat', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/canvasAgentChat')>();
  return { ...original, streamAgentConversation: (...args: unknown[]) => streamMock(...args) };
});

function node(): SessionNode {
  return {
    ...createSessionNode('coding', { x: 0, y: 0 }),
    id: 'node-1',
    title: 'Frontend',
    issueId: 'issue-1',
    binding: { companyId: 'company-1', agentId: 'agent-1', agentName: 'Frontend' },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  streamMock.mockReset();
  sessions.resetAllSessions();
});

describe('native Stop recovery regressions', () => {
  it('uses confirmed native cancellation when a buffered success frame races the Stop response', async () => {
    const controller = new AbortController();
    let resolveCancel!: (value: { confirmed: true; cancelled: true; status: 'cancelled' }) => void;
    const cancelRun = vi.fn(() => new Promise<{ confirmed: true; cancelled: true; status: 'cancelled' }>(resolve => { resolveCancel = resolve; }));
    streamMock.mockImplementation(async (...args: unknown[]) => {
      const emit = args[4] as (frame: AgentChatFrame) => void;
      emit({ event: 'accepted', issueId: 'issue-1', runId: 'run-1', runVisible: true });
      controller.abort();
      emit({ event: 'delta', text: 'A partial checkpoint before Stop.' });
      emit({ event: 'done', status: 'succeeded' });
      resolveCancel({ confirmed: true, cancelled: true, status: 'cancelled' });
    });
    const result = await execAgentViaGateway('/gateway', node(), 'Stop the foreground task', { signal: controller.signal, cancelRun });
    expect(result).toMatchObject({ ok: false, cancelled: true, detail: '已取消', output: 'A partial checkpoint before Stop.' });
    expect(sessions.getSnapshot('node-1').turns.at(-1)?.text).toContain('已停止');
  });

  it('keeps an early Stop recoverable when the stream detaches before accepted', async () => {
    const controller = new AbortController();
    const fresh = { ...node(), issueId: null };
    const cancelRun = vi.fn();
    const states: RunNodeStatus[] = [];
    streamMock.mockImplementation(async (...args: unknown[]) => {
      controller.abort();
      (args[4] as (frame: AgentChatFrame) => void)({ event: 'error', detail: 'aborted' });
    });
    const summary = await runGraph({ nodes: [fresh], edges: [], signal: controller.signal,
      execAgent: n => execAgentViaGateway('/gateway', n, 'message', {
        signal: controller.signal, operationId: '11111111-1111-4111-8111-111111111111', cancelRun,
      }), onStatus: (_id, state) => states.push(state) });
    expect(cancelRun).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ state: 'running', unconfirmed: true });
    expect(summary.cancelled).toBe(0);
    expect(sessions.getSnapshot('node-1').turns.at(-1)?.text).not.toContain('已停止');
  });

  it('sends a pending early Stop when accepted finally supplies its native identity', async () => {
    const controller = new AbortController();
    const cancelRun = vi.fn(async () => ({ confirmed: true, cancelled: true, status: 'cancelled' }));
    streamMock.mockImplementation(async (...args: unknown[]) => {
      controller.abort();
      expect(cancelRun).not.toHaveBeenCalled();
      (args[4] as (frame: AgentChatFrame) => void)({ event: 'accepted', issueId: 'fresh-issue', runId: 'fresh-run', runVisible: true });
    });
    const result = await execAgentViaGateway('/gateway', { ...node(), issueId: null }, 'message', {
      signal: controller.signal, operationId: '11111111-1111-4111-8111-111111111111', cancelRun,
    });
    expect(cancelRun).toHaveBeenCalledWith('/gateway', node().binding, 'fresh-issue', 'fresh-run');
    expect(result).toMatchObject({ cancelled: true, ok: false });
  });
  it('gives the native cancel request its own deadline signal', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return Promise.reject(new Error('fixture network interruption'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await cancelConversationRunViaGateway(
      '/gateway',
      node().binding!,
      'issue-1',
      'run-1',
    );

    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({ confirmed: false, cancelled: false, status: 'running' });
  });

  it('lets a confirmed Stop win when no_run arrives before cancellation resolves', async () => {
    const controller = new AbortController();
    let resolveCancel!: (value: { confirmed: true; cancelled: true; status: 'cancelled' }) => void;
    const cancelRun = vi.fn(() => new Promise<{ confirmed: true; cancelled: true; status: 'cancelled' }>(resolve => {
      resolveCancel = resolve;
    }));
    streamMock.mockImplementation(async (...args: unknown[]) => {
      const onFrame = args[4] as (frame: AgentChatFrame) => void;
      onFrame({ event: 'accepted', issueId: 'issue-1', runId: null, runVisible: false });
      controller.abort();
      onFrame({ event: 'no_run', issueId: 'issue-1', detail: 'message delivered; no live run appeared in time' });
      resolveCancel({ confirmed: true, cancelled: true, status: 'cancelled' });
    });

    const result = await execAgentViaGateway('/gateway', node(), 'Please stop safely', {
      signal: controller.signal,
      cancelRun,
    });

    expect(cancelRun).toHaveBeenCalledWith('/gateway', node().binding, 'issue-1', null);
    expect(result).toMatchObject({ ok: false, cancelled: true, detail: '已取消' });
    expect(result).not.toHaveProperty('unconfirmed', true);
    const reply = sessions.getSnapshot('node-1').turns.at(-1)?.text ?? '';
    expect(reply).toContain('已停止');
    expect(reply).not.toContain('暂无可见运行');
  });

  it('does not append a transcript or dispatch when a serialized node reaches the executor after Stop', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await execAgentViaGateway('/gateway', node(), 'must never send', {
      signal: controller.signal,
      operationId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result).toMatchObject({ ok: false, cancelled: true, detail: 'cancelled_before_dispatch' });
    expect(streamMock).not.toHaveBeenCalled();
    expect(sessions.getSnapshot('node-1').turns).toEqual([]);
  });

  it('never reports succeeded when the native turn produced no delivery text', async () => {
    streamMock.mockImplementation(async (...args: unknown[]) => {
      const onFrame = args[4] as (frame: AgentChatFrame) => void;
      onFrame({ event: 'accepted', issueId: 'issue-1', runId: 'run-1', runVisible: true });
      onFrame({ event: 'done', status: 'succeeded' });
    });

    await expect(execAgentViaGateway('/gateway', node(), 'return a deliverable')).resolves.toMatchObject({
      ok: false, output: '', detail: 'empty_delivery',
    });
  });

  it('does not keep a run locked when the prepare-only request fails before any delivery request', async () => {
    streamMock.mockImplementation(async (...args: unknown[]) => {
      const onFrame = args[4] as (frame: AgentChatFrame) => void;
      onFrame({ event: 'error', detail: 'operation claim rejected', code: 'operation_prepare_failed' });
    });

    const result = await execAgentViaGateway('/gateway', node(), 'never dispatched', {
      operationId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result).toMatchObject({ ok: false, detail: 'operation claim rejected' });
    expect(result).not.toHaveProperty('unconfirmed');
  });

  it('does not turn an incomplete stream into success when Stop only observes that the run already succeeded', async () => {
    const controller = new AbortController();
    let emit!: (frame: AgentChatFrame) => void;
    let finishStream!: () => void;
    let resolveCancel!: (value: { confirmed: true; cancelled: false; status: 'succeeded' }) => void;
    const cancelRun = vi.fn(() => new Promise<{ confirmed: true; cancelled: false; status: 'succeeded' }>(resolve => {
      resolveCancel = resolve;
    }));
    streamMock.mockImplementation((...args: unknown[]) => {
      emit = args[4] as (frame: AgentChatFrame) => void;
      emit({ event: 'accepted', issueId: 'issue-1', runId: 'run-1', runVisible: true });
      return new Promise<void>(resolve => { finishStream = resolve; });
    });

    const pending = execAgentViaGateway('/gateway', node(), 'Keep delivery honest', {
      signal: controller.signal,
      cancelRun,
    });
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    controller.abort();
    await vi.waitFor(() => expect(cancelRun).toHaveBeenCalled());
    emit({ event: 'error', detail: 'persisted output was incomplete' });
    finishStream();
    resolveCancel({ confirmed: true, cancelled: false, status: 'succeeded' });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      unconfirmed: true,
      detail: 'native_terminal_output_unconfirmed',
    });
  });
});
