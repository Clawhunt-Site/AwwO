import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { activeNodeThread, createNodeThread, getNodeThreads, selectNodeThread, updateNodeDraft } from '../src/canvas/nodeThreads';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal } from '../src/canvas/runJournal';
import { resetAllSessions } from '../src/canvas/sessions';

const REQUEST = '  把会员详情改成右侧抽屉  ';
let siblingThreadId: string;

function savedNode(): SessionNode {
  return loadDocumentWithStatus().doc.nodes.find(node => node.id === 'draft-agent') as SessionNode;
}

function openComposer() {
  render(<CanvasSurface />);
  fireEvent.click(screen.getByRole('button', { name: '打开 Draft Agent', exact: true }));
  return screen.getByTestId('composer-input');
}

function sends() {
  return vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).includes('/messages') && init?.method === 'POST');
}

function deferOwnership() {
  let enter!: () => void;
  vi.spyOn(navigator.locks, 'request').mockImplementation(((_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) =>
    new Promise<void>(resolve => { enter = () => { void callback({ name: 'awwo.canvas.execution.v1' }).then(resolve); }; })) as typeof navigator.locks.request);
  return () => act(() => enter());
}

async function stop() {
  await waitFor(() => expect(sends()).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: /停止/ }));
  await waitFor(() => expect(loadRunJournal()).toBeNull());
}

beforeEach(() => {
  localStorage.clear(); resetAllSessions();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn((url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/prepare')) return Promise.resolve({ ok: true, status: 200 });
    if (String(url).includes('/cancel')) return Promise.resolve({ ok: true, status: 200,
      json: async () => ({ confirmed: true, cancelled: true, status: 'cancelled' }) });
    if (String(url).includes('/messages') && init?.method === 'POST') {
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener('abort', fail, { once: true });
      });
    }
    return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  }));
  const first = updateNodeDraft({ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'draft-agent',
    title: 'Draft Agent', runtime: 'codex_local', issueId: 'original-issue',
    binding: { companyId: 'company', agentId: 'agent', agentName: 'Agent' } }, REQUEST);
  const second = updateNodeDraft(createNodeThread(first), '另一个 Session 的未发送任务');
  siblingThreadId = activeNodeThread(second).id;
  const current = selectNodeThread(second, 'default');
  const sibling = updateNodeDraft({ ...createSessionNode('llm', { x: 700, y: 0 }), id: 'sibling', title: 'Sibling' }, '另一个节点的草稿');
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [current, sibling],
    view: { x: 0, y: 0, scale: 1 } }));
});

afterEach(() => { cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('durable manual draft acceptance', () => {
  it('consumes only the accepted Session draft before dispatch and keeps it empty after stop and reload', async () => {
    const input = openComposer();
    expect(input).toHaveValue(REQUEST);
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(loadRunJournal()?.manual).toBe(true));
    expect(input).toHaveValue('');
    expect(activeNodeThread(savedNode())).toMatchObject({ id: 'default', draft: '', issueId: 'original-issue' });
    expect(getNodeThreads(savedNode()).find(thread => thread.id === siblingThreadId)?.draft).toBe('另一个 Session 的未发送任务');
    expect(activeNodeThread(loadDocumentWithStatus().doc.nodes[1] as SessionNode).draft).toBe('另一个节点的草稿');
    expect(loadRunJournal()?.nodes['draft-agent']).toMatchObject({ threadId: 'default', issueId: 'original-issue',
      companyId: 'company', agentId: 'agent', operationId: expect.any(String) });
    await stop();
    cleanup();
    expect(openComposer()).toHaveValue('');
    expect(sends()).toHaveLength(1);
  });

  it.each(['document', 'journal', 'consumed-draft'] as const)('preserves the unsent request when %s persistence fails', async failure => {
    const input = openComposer();
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      const isConsumed = key === CANVAS_STORAGE_KEY && JSON.parse(value).nodes[0].threads
        ?.find((thread: { id: string }) => thread.id === 'default')?.draft === '';
      if ((failure === 'document' && key === CANVAS_STORAGE_KEY)
          || (failure === 'journal' && key === CANVAS_RUN_JOURNAL_KEY)
          || (failure === 'consumed-draft' && isConsumed)) throw new DOMException('Storage full', 'QuotaExceededError');
      setItem(key, value);
    });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('本地存储不可用'));
    expect(input).toHaveValue(REQUEST);
    expect(activeNodeThread(savedNode()).draft).toBe(REQUEST);
    expect(loadRunJournal()).toBeNull();
    expect(sends()).toHaveLength(0);
  });

  it('preserves the draft when another tab owns execution', async () => {
    const input = openComposer();
    vi.spyOn(navigator.locks, 'request').mockImplementation(((_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => callback(null)) as typeof navigator.locks.request);
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('其他标签页正在运行'));
    expect(input).toHaveValue(REQUEST);
    expect(activeNodeThread(savedNode()).draft).toBe(REQUEST);
    expect(loadRunJournal()).toBeNull();
    expect(sends()).toHaveLength(0);
  });

  it('does not clear a newer draft typed while waiting for execution ownership', async () => {
    const input = openComposer();
    const accept = deferOwnership();
    fireEvent.click(screen.getByTestId('composer-send'));
    fireEvent.change(input, { target: { value: '下一条任务：再增加导出按钮' } });
    accept();
    await waitFor(() => expect(loadRunJournal()?.manual).toBe(true));
    expect(input).toHaveValue('下一条任务：再增加导出按钮');
    expect(activeNodeThread(savedNode()).draft).toBe('下一条任务：再增加导出按钮');
    expect(loadRunJournal()?.manualMessage).toContain(REQUEST.trim());
    expect(loadRunJournal()?.manualMessage).not.toContain('再增加导出按钮');
    await stop();
    cleanup();
    expect(openComposer()).toHaveValue('下一条任务：再增加导出按钮');
  });

  it('does not send the previous Session request through a newly selected Session', async () => {
    openComposer();
    const accept = deferOwnership();
    fireEvent.click(screen.getByTestId('composer-send'));
    fireEvent.click(screen.getByRole('button', { name: '打开 Session 2', exact: true }));
    accept();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画布已在其他标签页更新'));
    expect(activeNodeThread(savedNode())).toMatchObject({ id: siblingThreadId, draft: '另一个 Session 的未发送任务' });
    expect(getNodeThreads(savedNode()).find(thread => thread.id === 'default')?.draft).toBe(REQUEST);
    expect(loadRunJournal()).toBeNull();
    expect(sends()).toHaveLength(0);
  });
});
