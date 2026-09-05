import { beforeEach, expect, it, vi } from 'vitest';
import { createSessionNode, emptyDocument, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { activeNodeThread, activeThreadId, createNodeThread, getNodeThreads, preserveThreadRuntime,
  rebindNodeThread, selectNodeThread, sessionStoreKey, updateNodeDraft, updateThreadIssueId,
  updateThreadPreview } from '../src/canvas/nodeThreads';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import * as sessions from '../src/canvas/sessions';
import { restoreHistory, sendMessage } from '../src/canvas/sessionTransport';
import { createGatewayExecutor } from '../src/canvas/runTransport';
import type { AgentChatFrame } from '../src/canvasAgentChat';

const streamMock = vi.fn();
const indexMock = vi.fn();
const messagesMock = vi.fn();
vi.mock('../src/canvasAgentChat', async original => ({
  ...await original<typeof import('../src/canvasAgentChat')>(),
  streamAgentConversation: (...args: unknown[]) => streamMock(...args),
  fetchConversationIndex: (...args: unknown[]) => indexMock(...args),
  fetchConversationMessages: (...args: unknown[]) => messagesMock(...args),
}));

function node(): SessionNode {
  return { ...createSessionNode('coding', { x: 0, y: 0 }),
    binding: { companyId: 'company', agentId: 'agent', agentName: 'Agent' },
    issueId: 'server-first', preview: 'First reply',
    contract: { version: 1, inputs: [], outputs: [{ id: 'result', label: '交付物', type: 'text', required: true, value: 'Original draft' }] },
    lastOutput: { text: 'Original published output', source: 'run', at: 42 },
  };
}

beforeEach(() => {
  sessions.resetAllSessions(); streamMock.mockReset(); indexMock.mockReset(); messagesMock.mockReset();
});

it('loads a legacy conversation without changing its real issue or transcript key', () => {
  const legacy = node();
  expect(activeNodeThread(legacy)).toMatchObject({ id: 'default', issueId: 'server-first', preview: 'First reply', draft: '' });
  expect(sessionStoreKey(legacy)).toBe(legacy.id);
  expect(legacy.threads).toBeUndefined();
});

it('persists the delivery drawer state alongside expanded node geometry', () => {
  const expanded = { ...node(), w: 900, deliverablesOpen: true };
  const loaded = sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [expanded] }))).nodes[0] as SessionNode;
  expect(loaded.deliverablesOpen).toBe(true);
  expect(loaded.w).toBe(900);
});

it('round-trips distinct drafts, issue IDs and output drafts while selection clears publication', () => {
  const first = updateNodeDraft(node(), 'First unsent draft');
  let second = createNodeThread(first);
  const secondId = activeThreadId(second);
  expect(second.issueId).toBeNull();
  expect(second.lastOutput).toBeNull();
  expect(second.contract!.outputs[0].value).toBe('');
  second = updateNodeDraft(second, 'Second unsent draft');
  second = updateThreadIssueId(second, secondId, 'server-second');
  const persisted = sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [second] }))).nodes[0] as SessionNode;
  const restored = selectNodeThread(persisted, 'default');
  expect(restored.issueId).toBe('server-first');
  expect(activeNodeThread(restored).draft).toBe('First unsent draft');
  expect(restored.contract!.outputs[0].value).toBe('Original draft');
  expect(restored.lastOutput).toBeNull();
  expect(getNodeThreads(restored).find(thread => thread.id === 'default')?.lastOutput?.text).toBe('Original published output');
  const selectedSecond = selectNodeThread(restored, secondId);
  expect(selectedSecond.issueId).toBe('server-second');
  expect(activeNodeThread(selectedSecond).draft).toBe('Second unsent draft');
});

it('routes a late issue/preview callback to its captured conversation without changing the active one', () => {
  const newer = createNodeThread(node());
  const result = updateThreadPreview(updateThreadIssueId(newer, 'default', 'late-first'), 'default', 'Late first reply');
  expect(result.issueId).toBeNull();
  expect(result.preview).toBe('');
  expect(getNodeThreads(result).find(thread => thread.id === 'default')).toMatchObject({ issueId: 'late-first', preview: 'Late first reply' });
  expect(updateThreadIssueId(result, 'does-not-exist', 'unknown')).toBe(result);
});

it('retains newly created conversations and server identities when restoring an older undo snapshot', () => {
  const before = node();
  let live = createNodeThread(before);
  const id = activeThreadId(live);
  live = updateNodeDraft(updateThreadIssueId(live, id, 'server-new'), 'Keep this draft');
  live = updateThreadIssueId(live, 'default', 'server-first-latest');
  const restored = preserveThreadRuntime(before, live);
  expect(restored.issueId).toBe('server-first-latest');
  expect(getNodeThreads(restored)).toHaveLength(2);
  expect(getNodeThreads(restored).find(thread => thread.id === id)).toMatchObject({ issueId: 'server-new', draft: 'Keep this draft' });
});

it('preserves a real binding together with its issued thread across a pre-bind undo snapshot', () => {
  const before = { ...node(), binding: null, issueId: null, runtime: '', persona: '', lastOutput: null };
  const live = { ...rebindNodeThread(before, node().binding), runtime: 'bound-runtime', persona: 'Bound persona', issueId: 'real-issued-thread' };
  const restored = preserveThreadRuntime(before, live);
  expect(restored.binding?.agentId).toBe('agent');
  expect(restored.issueId).toBe('real-issued-thread');
  expect(restored.runtime).toBe('bound-runtime');
  expect(activeNodeThread(restored)).toMatchObject({ binding: { agentId: 'agent' }, issueId: 'real-issued-thread' });
});

it('retains newest historical output evidence when restoring an older undo snapshot', () => {
  const before = node();
  const live = { ...before, lastOutput: { text: 'Newly delivered', source: 'run' as const, at: 99 } };
  const restored = preserveThreadRuntime(before, live);
  expect(activeNodeThread(restored).lastOutput?.text).toBe('Newly delivered');
});

it('keeps old conversations addressed to the original agent after rebinding', () => {
  const first = node();
  const rebound = rebindNodeThread(first, { companyId: 'company', agentId: 'new-agent', agentName: 'New agent' });
  expect(rebound.issueId).toBeNull();
  expect(rebound.binding?.agentId).toBe('new-agent');
  const prior = selectNodeThread(rebound, 'default');
  expect(prior.issueId).toBe('server-first');
  expect(prior.binding?.agentId).toBe('agent');
});

it('binds a never-connected draft in place without creating another Session row', () => {
  const draft = updateNodeDraft({ ...node(), binding: null, issueId: null, lastOutput: null }, 'Keep my draft');
  const bound = rebindNodeThread(draft, { companyId: 'company', agentId: 'new-agent', agentName: 'New agent' });
  expect(getNodeThreads(bound)).toHaveLength(1);
  expect(activeThreadId(bound)).toBe('default');
  expect(activeNodeThread(bound).draft).toBe('Keep my draft');
  expect(bound.binding?.agentId).toBe('new-agent');
});

it('invalidates downstream when switching two local conversations that both lack server IDs', () => {
  const first = { ...node(), issueId: null };
  const downstream = { ...node(), id: 'downstream' };
  const prev = { ...emptyDocument(), nodes: [first, downstream], edges: [{ id: 'edge', fromNode: first.id, fromPort: 'out:result', toNode: downstream.id, toPort: 'context', dataType: 'text' as const }] };
  const next = invalidateOutputs(prev, { ...prev, nodes: [createNodeThread(first), downstream] });
  expect(next.nodes.every(item => item.lastOutput == null)).toBe(true);
});

it('isolates transcript restoration and local-send guards between two conversations in one node', async () => {
  const first = node();
  const second = createNodeThread(first);
  // Use the actual selected conversation identity; no local ID is ever sent as a server issue.
  const selected = { ...second, issueId: 'server-second' };
  streamMock.mockImplementation(async (_base, _company, _agent, _text, emit) => {
    emit({ event: 'delta', text: 'First live reply' });
    emit({ event: 'done', status: 'succeeded' });
  });
  await sendMessage({ gatewayBase: '/gateway', node: first, text: 'First message' });
  indexMock.mockResolvedValue([]);
  messagesMock.mockResolvedValue([{ role: 'agent', text: 'Second stored reply' }]);
  await restoreHistory({ gatewayBase: '/gateway', node: selected });
  expect(messagesMock.mock.calls[0][2]).toBe('server-second');
  expect(sessions.getSnapshot(sessionStoreKey(first)).turns.map(turn => turn.text)).toContain('First live reply');
  expect(sessions.getSnapshot(sessionStoreKey(selected)).turns.map(turn => turn.text)).toEqual(['Second stored reply']);
});

it('finishes an old history request in its own store after selection changes', async () => {
  const first = node();
  const second = createNodeThread(first);
  let resolveMessages!: (value: unknown) => void;
  indexMock.mockResolvedValue([]);
  messagesMock.mockReturnValue(new Promise(resolve => { resolveMessages = resolve; }));
  const pending = restoreHistory({ gatewayBase: '/gateway', node: first });
  await Promise.resolve();
  sessions.appendTurn(sessionStoreKey(second), { role: 'user', text: 'New local conversation' });
  resolveMessages([{ role: 'agent', text: 'Old remote history' }]);
  await pending;
  expect(sessions.getSnapshot(sessionStoreKey(second)).turns.map(turn => turn.text)).toEqual(['New local conversation']);
  expect(sessions.getSnapshot(sessionStoreKey(first)).turns.map(turn => turn.text)).toEqual(['Old remote history']);
});

it('graph execution writes to the selected conversation and reports the captured local identity', async () => {
  const selected = createNodeThread(node());
  const callback = vi.fn();
  streamMock.mockImplementation(async (_base: string, _company: string, _agent: string, _text: string, emit: (frame: AgentChatFrame) => void) => {
    emit({ event: 'accepted', issueId: 'server-created', runId: 'run', runVisible: true });
    emit({ event: 'delta', text: 'Graph reply' });
    emit({ event: 'done', status: 'succeeded' });
  });
  const execute = createGatewayExecutor({ gatewayBase: '/gateway', onIssueId: callback });
  expect((await execute(selected, 'Run this selected conversation')).ok).toBe(true);
  expect(callback).toHaveBeenCalledWith(selected.id, 'server-created', activeThreadId(selected));
  expect((streamMock.mock.calls[0][5] as { issueId?: string }).issueId).toBeUndefined();
  expect(sessions.getSnapshot(sessionStoreKey(selected)).turns.map(turn => turn.text)).toContain('Graph reply');
  expect(sessions.getSnapshot(selected.id).turns).toEqual([]);
});
