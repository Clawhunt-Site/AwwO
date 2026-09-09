import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { execAgentViaGateway } from '../src/canvas/runTransport';
import { restoreHistory, forgetNode } from '../src/canvas/sessionTransport';
import { getSnapshot, resetAllSessions, attachTurnRun, appendTurn, replaceTurns } from '../src/canvas/sessions';
import { mergeRecoveredManualConversation } from '../src/canvas/runRecoveryDocument';
import { clearSaaSCanvas } from '../src/saas/canvasBridge';

const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'team-node',
  binding: { companyId: 'tenant', agentId: 'agent', agentName: 'Team' }, issueId: 'session' };
beforeEach(() => { localStorage.clear(); clearSaaSCanvas(); resetAllSessions(); forgetNode(node.id); });
afterEach(() => { vi.unstubAllGlobals(); resetAllSessions(); forgetNode(node.id); });

it('keeps identical replies tied to their own accepted run and restores both identities', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    if (init?.method === 'POST') {
      const id = `run-${++calls}`;
      const events = [ { event: 'accepted', issueId: 'session', runId: id, runVisible: true },
        { event: 'delta', text: '我是王伟' }, { event: 'done', status: 'succeeded' } ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    const value = String(_input).includes('/messages') ? { complete: true, messages: [1, 2].flatMap(i => [
      { body: '你是谁', runId: `run-${i}` }, { body: '我是王伟', authorAgentId: 'agent', runId: `run-${i}` },
    ]) } : { conversations: [{ issueId: 'session', agentId: 'agent' }], nextCursor: null };
    return new Response(JSON.stringify(value));
  }));
  for (let i = 0; i < 2; i++) expect((await execAgentViaGateway('/gw', node, '你是谁')).ok).toBe(true);
  expect(getSnapshot(node.id).turns.map(turn => turn.runId)).toEqual(['run-1', 'run-1', 'run-2', 'run-2']);
  resetAllSessions(); forgetNode(node.id);
  await restoreHistory({ gatewayBase: '/gw', node });
  expect(getSnapshot(node.id).history).toBe('loaded');
  expect(getSnapshot(node.id).turns.map(turn => turn.runId)).toEqual(['run-1', 'run-1', 'run-2', 'run-2']);
});

it('anchors a recovered cancellation to its run instead of an earlier identical question', () => {
  const merged = mergeRecoveredManualConversation([
    { role: 'user', text: '重复问题', runId: 'first' },
    { role: 'agent', text: '成功', runId: 'first' },
    { role: 'user', text: '重复问题', runId: 'second' },
  ], { version: 1, id: 'journal', startedAt: 123, scope: [node.id], manual: true, manualMessage: '重复问题',
    nodes: { [node.id]: { nodeId: node.id, threadId: 'default', companyId: 'tenant', agentId: 'agent', issueId: 'session', runId: 'second', state: 'cancelled', output: '部分回复' } } }, node.id);
  expect(merged.map(turn => [turn.text, turn.runId])).toEqual([
    ['重复问题', 'first'], ['成功', 'first'], ['重复问题', 'second'], ['部分回复', 'second'],
  ]);
});

it('does not attach a late identity to replacement history', () => {
  const old = appendTurn(node.id, { role: 'agent', text: '' });
  replaceTurns(node.id, [{ role: 'agent', text: 'Restored', runId: 'restored' }]);
  attachTurnRun(node.id, old, 'late');
  expect(getSnapshot(node.id).turns).toMatchObject([{ runId: 'restored', text: 'Restored' }]);
});
