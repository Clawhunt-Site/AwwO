import { expect, it } from 'vitest';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { activeThreadId } from '../src/canvas/nodeThreads';
import { currentGraphRunEntry } from '../src/canvas/currentGraphRun';
import type { CanvasRunJournal } from '../src/canvas/runJournal';

const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node',
  binding: { companyId: 'tenant', agentId: 'agent', agentName: 'Agent' }, issueId: 'session' };
function journal(): CanvasRunJournal {
  return { version: 1, id: 'graph-operation', startedAt: 1, scope: [node.id],
    serverGraph: { id: 'graph', tenantId: 'tenant', canvasId: 'canvas' },
    nodes: { node: { nodeId: node.id, threadId: activeThreadId(node), companyId: 'tenant', agentId: 'agent',
      issueId: 'session', runId: 'new-run', state: 'running' } } };
}
it('selects the admitted run from the matching executing node and thread', () => {
  const active = journal();
  expect(currentGraphRunEntry(node, active)).toBe(active.nodes.node);
  active.nodes.node.runId = null; active.nodes.node.state = 'blocked';
  expect(currentGraphRunEntry(node, active)?.state).toBe('blocked');
});
it.each(['scope', 'cached', 'thread', 'tenant', 'agent', 'native'])('does not replace history with unrelated %s records', mismatch => {
  const active = journal();
  if (mismatch === 'scope') active.scope = ['downstream'];
  if (mismatch === 'cached') active.nodes.node.state = 'cached';
  if (mismatch === 'thread') active.nodes.node.threadId = 'another-thread';
  if (mismatch === 'tenant') active.nodes.node.companyId = 'another-tenant';
  if (mismatch === 'agent') active.nodes.node.agentId = 'another-agent';
  if (mismatch === 'native') delete active.serverGraph;
  expect(currentGraphRunEntry(node, active)).toBeUndefined();
});
