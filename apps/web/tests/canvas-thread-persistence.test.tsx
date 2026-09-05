import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { activeNodeThread, activeThreadId, createNodeThread, getNodeThreads, rebindNodeThread, selectNodeThread, sessionStoreKey } from '../src/canvas/nodeThreads';
import * as sessions from '../src/canvas/sessions';
import type { SessionTileProps } from '../src/canvas/SessionTile';

vi.mock('../src/canvas/SessionTile', () => ({
  SessionTile: ({ node, onUpdateNode, onDraftChange, onIssueId, onRunNode, onConfigure, configurationPanel, onToggleDeliverables }: SessionTileProps) => node.kind === 'session' ? <div>
    <button onClick={() => onUpdateNode?.(createNodeThread(node))}>Create local session</button>
    <button onClick={() => onDraftChange?.(node.id, activeThreadId(node), 'Persist my draft')}>Write draft</button>
    <button onClick={() => onIssueId?.(node.id, 'late-original-server-id', 'default')}>Old response arrives</button>
    <button onClick={() => onRunNode?.(node.id)}>Execute current session</button>
    <button onClick={() => onConfigure?.(node.id)}>Configure session</button>
    <button onClick={() => {
      const other = getNodeThreads(node).find(thread => thread.id !== activeThreadId(node));
      if (other) onUpdateNode?.(selectNodeThread(node, other.id));
    }}>Select other session</button>
    <button onClick={() => onToggleDeliverables?.(node.id, true)}>Open delivery drawer</button>
    <button onClick={() => onToggleDeliverables?.(node.id, false)}>Close delivery drawer</button>
    {configurationPanel}
  </div> : null,
}));

beforeEach(() => {
  cleanup(); localStorage.clear(); sessions.resetAllSessions(); vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});

function prepare(): SessionNode {
  const node = { ...createSessionNode('coding', { x: 0, y: 0 }),
    binding: { companyId: 'company', agentId: 'agent', agentName: 'Agent' }, runtime: 'runtime' };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
  return node;
}

it('persists per-session drafts and routes a late real server ID to its original record', () => {
  prepare();
  render(<CanvasSurface />);
  fireEvent.click(screen.getByText('Write draft'));
  fireEvent.click(screen.getByText('Create local session'));
  fireEvent.click(screen.getByText('Old response arrives'));
  const saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(activeNodeThread(saved).draft).toBe('');
  expect(saved.issueId).toBeNull();
  expect(getNodeThreads(saved)).toHaveLength(2);
  expect(getNodeThreads(saved).find(thread => thread.id === 'default')).toMatchObject({ draft: 'Persist my draft', issueId: 'late-original-server-id' });
  // Draft keystrokes and server acknowledgements are silent; one undo only reverses selection.
  fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
  const restored = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(restored.issueId).toBe('late-original-server-id');
  expect(activeNodeThread(restored).draft).toBe('Persist my draft');
  expect(getNodeThreads(restored)).toHaveLength(2);
});

it('rejects programmatic session changes and graph runs while an active conversation is streaming', () => {
  const node = prepare();
  sessions.setStreaming(sessionStoreKey(node), true);
  render(<CanvasSurface />);
  fireEvent.click(screen.getByText('Create local session'));
  expect(getNodeThreads(loadDocumentWithStatus().doc.nodes[0] as SessionNode)).toHaveLength(1);
  fireEvent.click(screen.getByText('Execute current session'));
  expect(screen.getByRole('alert')).toHaveTextContent('请等待当前会话完成');
  sessions.setStreaming(sessionStoreKey(node), false);
  fireEvent.click(screen.getByText('Create local session'));
  expect(getNodeThreads(loadDocumentWithStatus().doc.nodes[0] as SessionNode)).toHaveLength(2);
});

it('retargets the open inspector to the selected Session before saving configuration', () => {
  const first = { ...prepare(), persona: 'First persona', runtime: 'first-runtime', issueId: 'first-issued-thread' };
  const second = { ...rebindNodeThread(first, { companyId: 'company', agentId: 'second-agent', agentName: 'Second agent' }),
    persona: 'Second persona', runtime: 'second-runtime', issueId: 'second-issued-thread' };
  const current = selectNodeThread(second, 'default');
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [current], view: { x: 0, y: 0, scale: 1 } }));
  render(<CanvasSurface />);
  fireEvent.click(screen.getByText('Configure session'));
  expect(screen.getByRole('textbox', { name: '人设 / 系统提示词' })).toHaveValue('First persona');
  fireEvent.click(screen.getByText('Select other session'));
  expect(screen.getByRole('textbox', { name: '人设 / 系统提示词' })).toHaveValue('Second persona');
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  const saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(saved.runtime).toBe('second-runtime');
  expect(saved.persona).toBe('Second persona');
  expect(saved.binding?.agentId).toBe('second-agent');
  expect(saved.issueId).toBe('second-issued-thread');
  expect(getNodeThreads(saved)).toHaveLength(2);
});

it('persists delivery expansion as one idempotent view change without moving siblings or adding undo steps', () => {
  const first = prepare();
  render(<CanvasSurface />);
  fireEvent.click(screen.getByText('Open delivery drawer'));
  fireEvent.click(screen.getByText('Open delivery drawer'));
  let saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(saved).toMatchObject({ deliverablesOpen: true, w: first.w + 260, x: first.x - 130 });
  expect(screen.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  cleanup(); render(<CanvasSurface />);
  fireEvent.click(screen.getByText('Open delivery drawer'));
  saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(saved.w).toBe(first.w + 260);
  fireEvent.click(screen.getByText('Close delivery drawer'));
  saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(saved).toMatchObject({ deliverablesOpen: false, w: first.w, x: first.x });
  expect(screen.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});
