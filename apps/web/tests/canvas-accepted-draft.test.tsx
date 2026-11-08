import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { composerDraftKey, readComposerDraft, writeComposerDraft } from '../src/canvas/composerDrafts';
import { activeNodeThread, createNodeThread, getNodeThreads, selectNodeThread } from '../src/canvas/nodeThreads';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal } from '../src/canvas/runJournal';
import { resetAllSessions } from '../src/canvas/sessions';

const REQUEST = '  把会员详情改成右侧抽屉  ';
let siblingThreadId: string;

function savedNode(): SessionNode {
  return loadDocumentWithStatus().doc.nodes.find(node => node.id === 'draft-agent') as SessionNode;
}

/** A chat node's unsent message is kept on this device, never in the shared document (composerDrafts.ts). */
function draftOf(nodeId: string, threadId: string): string {
  return readComposerDraft(nodeId, threadId);
}

function documentHoldsNoDraft(): boolean {
  return loadDocumentWithStatus().doc.nodes.every(node => node.kind !== 'session' || getNodeThreads(node).every(thread => !thread.draft));
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
  const first = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'draft-agent',
    title: 'Draft Agent', runtime: 'codex_local', issueId: 'original-issue',
    binding: { companyId: 'company', agentId: 'agent', agentName: 'Agent' } };
  const second = createNodeThread(first);
  siblingThreadId = activeNodeThread(second).id;
  const current = selectNodeThread(second, 'default');
  const sibling = { ...createSessionNode('llm', { x: 700, y: 0 }), id: 'sibling', title: 'Sibling' };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [current, sibling],
    view: { x: 0, y: 0, scale: 1 } }));
  writeComposerDraft('draft-agent', 'default', REQUEST);
  writeComposerDraft('draft-agent', siblingThreadId, '另一个 Session 的未发送任务');
  writeComposerDraft('sibling', 'default', '另一个节点的草稿');
});

afterEach(() => { cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('durable manual draft acceptance', () => {
  it('consumes only the accepted Session draft before dispatch and keeps it empty after stop and reload', async () => {
    const input = openComposer();
    expect(input).toHaveValue(REQUEST);
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(loadRunJournal()?.manual).toBe(true));
    expect(input).toHaveValue('');
    expect(activeNodeThread(savedNode())).toMatchObject({ id: 'default', issueId: 'original-issue' });
    expect(draftOf('draft-agent', 'default')).toBe('');
    expect(draftOf('draft-agent', siblingThreadId)).toBe('另一个 Session 的未发送任务');
    expect(draftOf('sibling', 'default')).toBe('另一个节点的草稿');
    expect(documentHoldsNoDraft()).toBe(true);
    expect(loadRunJournal()?.nodes['draft-agent']).toMatchObject({ threadId: 'default', issueId: 'original-issue',
      companyId: 'company', agentId: 'agent', operationId: expect.any(String) });
    await stop();
    cleanup();
    expect(openComposer()).toHaveValue('');
    expect(sends()).toHaveLength(1);
  });

  it.each(['journal', 'consumed-draft'] as const)('preserves the unsent request when %s persistence fails', async failure => {
    const input = openComposer();
    const setItem = localStorage.setItem.bind(localStorage);
    const removeItem = localStorage.removeItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (failure === 'journal' && key === CANVAS_RUN_JOURNAL_KEY) throw new DOMException('Storage full', 'QuotaExceededError');
      setItem(key, value);
    });
    // Consuming the sent message takes it off the device: a storage that refuses that must not dispatch the request.
    vi.spyOn(localStorage, 'removeItem').mockImplementation(key => {
      if (failure === 'consumed-draft' && key === composerDraftKey('draft-agent', 'default')) {
        throw new DOMException('Storage unavailable', 'SecurityError');
      }
      removeItem(key);
    });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('本地存储不可用'));
    expect(input).toHaveValue(REQUEST);
    expect(draftOf('draft-agent', 'default')).toBe(REQUEST);
    expect(loadRunJournal()).toBeNull();
    expect(sends()).toHaveLength(0);
  });

  it('sends a chat message although the document cannot be saved: sending it changes nothing in the document', async () => {
    const input = openComposer();
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === CANVAS_STORAGE_KEY) throw new DOMException('Storage full', 'QuotaExceededError');
      setItem(key, value);
    });
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(loadRunJournal()?.manual).toBe(true));
    expect(input).toHaveValue('');
    expect(draftOf('draft-agent', 'default')).toBe('');
    await stop();
  });

  it('preserves the draft when another tab owns execution', async () => {
    const input = openComposer();
    vi.spyOn(navigator.locks, 'request').mockImplementation(((_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => callback(null)) as typeof navigator.locks.request);
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('其他标签页正在运行'));
    expect(input).toHaveValue(REQUEST);
    expect(draftOf('draft-agent', 'default')).toBe(REQUEST);
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
    expect(draftOf('draft-agent', 'default')).toBe('下一条任务：再增加导出按钮');
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
    fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '打开 对话 2', exact: true }));
    accept();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画布已在其他标签页更新'));
    expect(activeNodeThread(savedNode()).id).toBe(siblingThreadId);
    expect(draftOf('draft-agent', siblingThreadId)).toBe('另一个 Session 的未发送任务');
    expect(draftOf('draft-agent', 'default')).toBe(REQUEST);
    expect(loadRunJournal()).toBeNull();
    expect(sends()).toHaveLength(0);
  });
});
