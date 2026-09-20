import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSessionNode, emptyDocument, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { createNodeThread, selectNodeThread, updateNodeDraft } from '../src/canvas/nodeThreads';
import { InspectorPanel } from '../src/canvas/InspectorPanel';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function referenced(): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'research', title: '真实研究 Agent',
    runtime: 'pi', model: 'existing-model', effort: '', persona: 'AUTHORITATIVE INSTRUCTIONS',
    agentRef: { source: 'workspace', agentId: 'agent-a' },
    binding: { companyId: 'tenant', agentId: 'agent-a', agentName: 'Shared researcher' }, issueId: 'session-a' };
}

it('round-trips the selected identity and restores references per conversation', () => {
  const first = updateNodeDraft(referenced(), 'Keep this draft');
  let next = createNodeThread(first);
  const nextID = next.activeThreadId!;
  next = { ...next, agentRef: { source: 'workspace', agentId: 'agent-b' },
    binding: { companyId: 'tenant', agentId: 'agent-b', agentName: 'Other' }, issueId: 'session-b' };
  const loaded = sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [next] }))).nodes[0] as SessionNode;
  expect(loaded.agentRef?.agentId).toBe('agent-b');
  const previous = selectNodeThread(loaded, 'default');
  expect(previous.agentRef?.agentId).toBe('agent-a');
  expect(previous.binding?.agentId).toBe('agent-a');
  expect(previous.issueId).toBe('session-a');
  expect(selectNodeThread(previous, nextID).agentRef?.agentId).toBe('agent-b');
});

it('does not attach a newer reference to an old custom conversation', () => {
  const custom = { ...referenced(), agentRef: undefined };
  const newer = { ...createNodeThread(custom), agentRef: { source: 'workspace' as const, agentId: 'agent-b' } };
  expect(selectNodeThread(newer, 'default').agentRef).toBeUndefined();
  const malformed = { ...referenced(), agentRef: { source: 'market', agentId: 'unsafe' } };
  expect(sanitizeDocument({ ...emptyDocument(), nodes: [malformed] }).nodes).toHaveLength(0);
  const malformedHistory = { ...referenced(), threads: [{ id: 'old', agentRef: { source: 'market', agentId: 'unsafe' } }] };
  expect(sanitizeDocument({ ...emptyDocument(), nodes: [malformedHistory] }).nodes).toHaveLength(0);
});

it('invalidates delivered output and detached run recovery when only the selected Agent identity changes', () => {
  const node: SessionNode = { ...referenced(), lastOutput: { source: 'run', text: 'Old answer', at: 1 } };
  const before = { ...emptyDocument(), nodes: [node] };
  const after = { ...before, nodes: [{ ...node, agentRef: { source: 'workspace' as const, agentId: 'agent-b' } }] };
  expect(runInputFingerprint(before, [node.id])).not.toBe(runInputFingerprint(after, [node.id]));
  expect(invalidateOutputs(before, after).nodes[0].lastOutput).toBeNull();
  expect(before.nodes[0].lastOutput?.text).toBe('Old answer');
});

it('keeps shared configuration read-only and initializes without writing shared instructions', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const initialize = vi.fn(async () => {});
  const close = vi.fn();
  render(<InspectorPanel node={referenced()} liveCompanies={[{ id: 'tenant', name: 'Workspace' }]} apiBase="/api"
    onSave={vi.fn()} onClose={close} onInitialize={initialize} />);
  expect(screen.getByLabelText('人设 / 系统提示词')).toBeDisabled();
  expect(screen.getByRole('radio', { name: '编程 Agent' })).toBeDisabled();
  expect(screen.getByLabelText('名称')).not.toBeDisabled();
  expect(screen.getByLabelText('Runtime')).toHaveTextContent('Pi');
  expect(screen.getByLabelText('模型')).toHaveTextContent('existing-model');
  expect(screen.getByLabelText('推理强度')).toHaveTextContent('未设置');
  expect(screen.queryByRole('combobox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
  await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
  expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ agentRef: { source: 'workspace', agentId: 'agent-a' }, binding: { companyId: 'tenant', agentId: 'agent-a', agentName: 'Shared researcher' } }));
  expect(fetch).not.toHaveBeenCalled();
});

it('detaches only the selection intent and preserves history for server initialization', async () => {
  const initialize = vi.fn(async () => {});
  render(<InspectorPanel node={referenced()} liveCompanies={[{ id: 'tenant', name: 'Workspace' }]} apiBase="/api"
    onSave={vi.fn()} onClose={vi.fn()} onInitialize={initialize} />);
  fireEvent.click(screen.getByRole('button', { name: '解除引用，使用独立自定义 Agent' }));
  expect(screen.getByLabelText('人设 / 系统提示词')).not.toBeDisabled();
  fireEvent.change(screen.getByLabelText('人设 / 系统提示词'), { target: { value: 'CUSTOM' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
  await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
  expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ agentRef: undefined, persona: 'CUSTOM', issueId: 'session-a', binding: { companyId: 'tenant', agentId: 'agent-a', agentName: 'Shared researcher' } }));
});
