import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { activeNodeThread, updateNodeDraft } from '../src/canvas/nodeThreads';
import { loadRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { persistRecoveredManualConversation, hasManualRecoveryCapacity } from '../src/canvas/runRecoveryDocument';
import { forgetNode } from '../src/canvas/sessionTransport';
import { getSnapshot, resetAllSessions } from '../src/canvas/sessions';

const ID = 'retention-node';
const DRAFT = '第51轮请求';

function fullSession() {
  const node = updateNodeDraft({ ...createSessionNode('llm', { x: 0, y: 0 }), id: ID, title: 'Retention Agent',
    runtime: 'codex_local', issueId: 'issue', binding: { companyId: 'company', agentId: 'agent', agentName: 'Agent' } }, DRAFT);
  const history: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 50; index += 1) {
    const operation = `old-operation-${index}`;
    const run = `old-run-${index}`;
    const request = `Old request ${index}`;
    const output = `Old reply ${index}`;
    const saved: CanvasRunJournal = { version: 1, id: operation, startedAt: index + 1, scope: [ID], manual: true, manualMessage: request,
      nodes: { [ID]: { nodeId: ID, threadId: 'default', companyId: 'company', agentId: 'agent', issueId: 'issue',
        operationId: operation, runId: run, state: 'done', output } } };
    expect(persistRecoveredManualConversation(node, saved)).toBe(true);
    history.push(...nativeRound(operation, run, request, output));
  }
  expect(hasManualRecoveryCapacity(node, DRAFT)).toBe(false);
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
  return { node, history };
}

function nativeRound(operation: string, run: string, request: string, output: string) {
  return [{ id: `${operation}-user`, body: request,
    metadata: { version: 1, sections: [{ title: 'AwwO conversation', rows: [{ type: 'key_value', label: 'Operation', value: operation }] }] } },
  { id: `${operation}-agent`, body: output, authorAgentId: 'agent', createdByRunId: run }];
}

function transport(history: Array<Record<string, unknown>>, mode: 'complete' | 'partial' | 'unreadable') {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  let deferred: Promise<unknown> | undefined;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'POST') posts.push({ url: path, body: JSON.parse(String(init.body)) });
    if (path.endsWith('/prepare')) return { ok: true, status: 201 };
    if (path.endsWith('/messages') && init?.method === 'POST') {
      const request = JSON.parse(String(init.body));
      history.push(...nativeRound(request.operationId, 'new-run', request.message, 'NEW-RESULT'));
      const frames = [{ event: 'accepted', issueId: 'issue', runId: 'new-run', runVisible: true },
        { event: 'delta', text: 'NEW-RESULT' }, { event: 'done', status: 'succeeded' }];
      return { ok: true, status: 200, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(frames.map(frame => `event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`).join('')));
        controller.close();
      } }) };
    }
    if (path.endsWith('/settle')) return { ok: true, json: async () => ({ confirmed: true, status: 'succeeded', holdId: 'hold' }) };
    if (path.endsWith('/conversations/company')) return { ok: true, json: async () => ({ conversations: [{ issueId: 'issue' }] }) };
    if (path.endsWith('/messages')) {
      if (deferred) return deferred;
      return { ok: mode !== 'unreadable', status: mode === 'unreadable' ? 503 : 200,
        json: async () => ({ complete: mode === 'complete', messages: history }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetcher);
  return { posts, fetcher, holdHistory() {
    let resolve!: (value: unknown) => void;
    deferred = new Promise(next => { resolve = next; });
    return () => { deferred = undefined; resolve({ ok: true, json: async () => ({ complete: true, messages: history }) }); };
  } };
}

function open() {
  render(<CanvasSurface />);
  fireEvent.click(screen.getByRole('button', { name: '打开 Retention Agent', exact: true }));
  return screen.getByTestId('composer-input');
}

function fallbackRaw() {
  const key = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .find(name => name?.startsWith('awwo.canvas.manual-recovery.v1:'))!;
  return localStorage.getItem(key)!;
}

beforeEach(() => {
  localStorage.clear(); resetAllSessions(); forgetNode(ID);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); forgetNode(ID); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['partial', 'unreadable'] as const)('refuses a known-full Session before dispatch when native history is %s, preserving the draft and fallbacks', async mode => {
  const f = fullSession();
  const original = fallbackRaw();
  const remote = transport(f.history, mode);
  const input = open();
  fireEvent.click(screen.getByTestId('composer-send'));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('本地存储不可用'));
  expect(remote.posts).toHaveLength(0);
  expect(loadRunJournal()).toBeNull();
  expect(input).toHaveValue(DRAFT);
  expect(input).toBeEnabled();
  expect(activeNodeThread(loadDocumentWithStatus().doc.nodes[0] as SessionNode).draft).toBe(DRAFT);
  expect(fallbackRaw()).toBe(original);
});

it('runs the 51st turn after complete native history proves every retired fallback', async () => {
  const f = fullSession();
  const remote = transport(f.history, 'complete');
  const input = open();
  fireEvent.click(screen.getByTestId('composer-send'));
  await waitFor(() => expect(remote.posts.filter(post => post.url.endsWith('/messages'))).toHaveLength(1));
  await waitFor(() => expect(loadRunJournal()).toBeNull());
  expect(input).toHaveValue('');
  expect(input).toBeEnabled();
  expect(getSnapshot(ID).turns.some(turn => turn.role === 'agent' && turn.text === 'NEW-RESULT')).toBe(true);
  expect(JSON.parse(fallbackRaw()).records).toHaveLength(0);
  expect(hasManualRecoveryCapacity(f.node, 'Next request')).toBe(true);
});

it('keeps a newer draft typed during the native capacity read while sending only the original request', async () => {
  const f = fullSession();
  const remote = transport(f.history, 'complete');
  const input = open();
  await waitFor(() => expect(getSnapshot(ID).history).toBe('loaded'));
  const release = remote.holdHistory();
  const previousReads = remote.fetcher.mock.calls.filter(([url, init]) => String(url).endsWith('/messages') && init?.method !== 'POST').length;
  fireEvent.click(screen.getByTestId('composer-send'));
  await waitFor(() => expect(remote.fetcher.mock.calls.filter(([url, init]) => String(url).endsWith('/messages') && init?.method !== 'POST').length).toBeGreaterThan(previousReads));
  fireEvent.change(input, { target: { value: '下一条未发送草稿' } });
  act(release);
  await waitFor(() => expect(remote.posts.filter(post => post.url.endsWith('/messages'))).toHaveLength(1));
  await waitFor(() => expect(loadRunJournal()).toBeNull());
  expect(remote.posts.find(post => post.url.endsWith('/messages'))?.body.message).toBe(DRAFT);
  expect(input).toHaveValue('下一条未发送草稿');
  expect(activeNodeThread(loadDocumentWithStatus().doc.nodes[0] as SessionNode).draft).toBe('下一条未发送草稿');
});
