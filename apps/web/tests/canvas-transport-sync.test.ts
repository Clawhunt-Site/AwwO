import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchConversationMessages } from '../src/canvasAgentChat';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { beginConversationPresentation, updateConversationPresentation } from '../src/canvas/conversationPresentation';
import { prepareManualHistoryCapacity, persistManualHistoryWithNativeProof } from '../src/canvas/manualHistoryRetention';
import { hasManualRecoveryCapacity, mergeRecoveredManualConversation, persistRecoveredManualConversation } from '../src/canvas/runRecoveryDocument';
import type { CanvasRunJournal } from '../src/canvas/runJournal';
import { execAgentViaGateway } from '../src/canvas/runTransport';
import { forgetNode, restoreHistory } from '../src/canvas/sessionTransport';
import * as sessions from '../src/canvas/sessions';
import { clearSaaSCanvas } from '../src/saas/canvasBridge';

const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'sync-node', issueId: 'session',
  binding: { companyId: 'tenant', agentId: 'agent', agentName: 'Agent' } };
const scope = (name: string) => { configureCanvasStorage('user', 'tenant', name); return canvasStorage(); };
const response = (messages: unknown[], complete: unknown = true) => new Response(JSON.stringify({ messages, complete }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function journal(index = 0): CanvasRunJournal {
  return { version: 1, id: `journal-${index}`, startedAt: index + 1, scope: [node.id], manual: true,
    manualMessage: `request-${index}`, nodes: { [node.id]: { nodeId: node.id, threadId: 'default',
      companyId: 'tenant', agentId: 'agent', issueId: 'session', operationId: `operation-${index}`,
      runId: `run-${index}`, state: 'done', output: `reply-${index}` } } };
}
function fullHistory(store: ReturnType<typeof canvasStorage>) {
  const messages: Record<string, unknown>[] = [];
  for (let index = 0; index < 50; index += 1) {
    const saved = journal(index);
    expect(persistRecoveredManualConversation(node, saved, store)).toBe(true);
    messages.push({ body: saved.manualMessage, runId: `run-${index}` },
      { body: saved.nodes[node.id].output, runId: `run-${index}`, authorAgentId: 'agent' });
  }
  return messages;
}
const snapshot = (store: ReturnType<typeof canvasStorage>) => Object.fromEntries(store.keys().map(key => [key, store.getItem(key)]));

beforeEach(() => { localStorage.clear(); clearSaaSCanvas(); scope('a'); sessions.resetAllSessions(); forgetNode(node.id); });
afterEach(() => { vi.unstubAllGlobals(); sessions.resetAllSessions(); forgetNode(node.id); localStorage.clear(); });

describe('native and SaaS transport integration', () => {
  it('preserves SaaS member identity alongside independently parsed native history provenance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([{ body: 'exact input', runId: 'saas-run', createdByRunId: 'native-run',
      id: 'comment', createdAt: '2026-09-08T10:00:00Z', metadata: { version: 1,
        sections: [{ title: 'AwwO conversation', rows: [{ type: 'key_value', label: 'Operation', value: 'native-operation' }] }] } }])));
    expect(await fetchConversationMessages('/gateway', 'tenant', 'session')).toEqual([
      { role: 'user', text: 'exact input', runId: 'saas-run', nativeRunId: 'native-run', nativeCommentId: 'comment',
        nativeOperationId: 'native-operation', createdAt: Date.parse('2026-09-08T10:00:00Z') },
    ]);
  });

  it.each([false, undefined])('keeps SaaS identity-bearing history unreadable without complete proof (%s)', async complete => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [{ body: 'partial', runId: 'run' }], complete }))));
    expect(await fetchConversationMessages('/gateway', 'tenant', 'session')).toBeNull();
  });

  it('prunes only the captured canvas after complete SaaS history proves all 50 rounds', async () => {
    const a = canvasStorage(); const messages = fullHistory(a);
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const result = prepareManualHistoryCapacity('/gateway', node, 'next request', () => true);
    const b = scope('b'); fullHistory(b); const beforeB = snapshot(b);
    pending.resolve(response(messages));
    expect(await result).toBe(true);
    expect(hasManualRecoveryCapacity(node, 'next', a)).toBe(true);
    expect(snapshot(b)).toEqual(beforeB);
    expect(Object.values(snapshot(a)).map(value => JSON.parse(value!).records)).toEqual([[]]);
  });

  it('retains every fallback when a late complete history result belongs to an abandoned context', async () => {
    const a = canvasStorage(); const messages = fullHistory(a); const beforeA = snapshot(a);
    const pending = deferred<Response>(); let current = true;
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const result = prepareManualHistoryCapacity('/gateway', node, 'next request', () => current);
    current = false; const b = scope('b');
    pending.resolve(response(messages));
    expect(await result).toBe(false);
    expect(snapshot(a)).toEqual(beforeA); expect(b.keys()).toEqual([]);
  });

  it('persists fallback in the originating canvas when incomplete history finishes after a switch', async () => {
    const a = canvasStorage(); const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const result = persistManualHistoryWithNativeProof('/gateway', node, journal());
    const b = scope('b'); pending.resolve(response([{ body: 'request-0', runId: 'run-0' }], false));
    expect(await result).toBe(true);
    expect(a.keys()).toHaveLength(1); expect(b.keys()).toEqual([]);
    expect(JSON.parse(Object.values(snapshot(a))[0]!).records[0]).toMatchObject({ runId: 'run-0', agentText: 'reply-0' });
  });

  it('does not retire fallback when server history exposes conflicting native and SaaS run identities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([
      { body: 'request-0', runId: 'another-run', createdByRunId: 'run-0' },
      { body: 'reply-0', authorAgentId: 'agent', runId: 'another-run', createdByRunId: 'run-0' },
    ])));
    expect(await persistManualHistoryWithNativeProof('/gateway', node, journal())).toBe(true);
    const stored = Object.values(snapshot(canvasStorage()));
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!).records[0]).toMatchObject({ runId: 'run-0', agentText: 'reply-0' });
  });

  it('never lets a matching SaaS run conceal conflicting native execution identity', () => {
    const saved = journal();
    const history = [{ role: 'user' as const, text: 'request-0', runId: 'run-0', nativeRunId: 'different-run' },
      { role: 'agent' as const, text: 'reply-0', runId: 'run-0', nativeRunId: 'different-run' }];
    const merged = mergeRecoveredManualConversation(history, saved, node.id);
    expect(merged).toHaveLength(4);
    expect(merged.slice(0, 2)).toEqual(history);
    expect(merged.slice(2).map(turn => turn.runId)).toEqual(['run-0', 'run-0']);
    expect(mergeRecoveredManualConversation(merged, saved, node.id)).toEqual(merged);
  });

  it('keeps accepted run IDs and display metadata while late stream frames update only the captured canvas', async () => {
    const a = canvasStorage(); let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/prepare')
      ? new Response('{}') : new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }))));
    const running = execAgentViaGateway('/gateway', node, 'raw execution input', { operationId: 'operation-0',
      presentation: { displayText: 'User draft', inputKind: 'manual' } });
    await vi.waitFor(() => expect(controller).toBeDefined());
    const b = scope('b');
    const frames = [{ event: 'accepted', issueId: 'session', runId: 'run-0', runVisible: true },
      { event: 'delta', text: 'reply-0' }, { event: 'done', status: 'succeeded' }];
    controller!.enqueue(new TextEncoder().encode(frames.map(frame => `event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`).join('')));
    controller!.close();
    expect(await running).toMatchObject({ ok: true, output: 'reply-0' });
    expect(sessions.getSnapshot(node.id).turns).toEqual([
      expect.objectContaining({ role: 'user', runId: 'run-0', recoveryOperationId: 'operation-0', text: 'raw execution input',
        presentation: expect.objectContaining({ displayText: 'User draft' }) }),
      expect.objectContaining({ role: 'agent', runId: 'run-0', text: 'reply-0', presentation: expect.objectContaining({ outputState: 'final' }) }),
    ]);
    expect(JSON.parse(Object.values(snapshot(a))[0]!).records[0]).toMatchObject({ runId: 'run-0', outputText: 'reply-0' });
    expect(b.keys()).toEqual([]);
  });

  it('restores both identity kinds using the presentation cache captured before a workspace switch', async () => {
    const a = canvasStorage();
    beginConversationPresentation(node, 'operation-0', 'request-0', { inputKind: 'manual', displayText: 'Canvas A' }, a);
    updateConversationPresentation(node, 'operation-0', { runId: 'run-0', outputText: 'reply-0', outputState: 'final' }, a);
    const pending = deferred<Response>();
    const fetcher = vi.fn((input: unknown) => String(input).includes('/messages') ? pending.promise
      : Promise.resolve(new Response(JSON.stringify({ conversations: [{ issueId: 'session' }] }))));
    vi.stubGlobal('fetch', fetcher);
    const restoring = restoreHistory({ gatewayBase: '/gateway', node });
    await vi.waitFor(() => expect(fetcher.mock.calls).toHaveLength(2));
    const b = scope('b');
    beginConversationPresentation(node, 'operation-0', 'request-0', { inputKind: 'manual', displayText: 'Canvas B' }, b);
    updateConversationPresentation(node, 'operation-0', { runId: 'run-0', outputText: 'reply-0', outputState: 'failed' }, b);
    pending.resolve(response([{ body: 'request-0', runId: 'run-0' }, { body: 'reply-0', authorAgentId: 'agent', runId: 'run-0' }]));
    await restoring;
    const restored = sessions.getSnapshot(node.id);
    expect(restored.history).toBe('loaded');
    expect(restored.turns.map(turn => turn.runId)).toEqual(['run-0', 'run-0']);
    expect(restored.turns.map(turn => turn.nativeRunId)).toEqual(['run-0', 'run-0']);
    expect(restored.turns[1].presentation).toMatchObject({ outputState: 'final' });
  });
});
