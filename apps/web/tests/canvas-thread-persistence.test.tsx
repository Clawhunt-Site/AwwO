import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { readComposerDraft } from '../src/canvas/composerDrafts';
import { activeNodeThread, activeThreadId, createNodeThread, getNodeThreads, rebindNodeThread, selectNodeThread, sessionStoreKey, updateNodeDraft } from '../src/canvas/nodeThreads';
import { loadRunJournal } from '../src/canvas/runJournal';
import * as sessions from '../src/canvas/sessions';
import type { SessionTileProps } from '../src/canvas/SessionTile';

vi.mock('../src/canvas/SessionTile', () => ({
  SessionTile: ({ node, onUpdateNode, onDraftChange, onIssueId, onRunNode, onConfigure, configurationPanel, onToggleDeliverables, onSend }: SessionTileProps) => node.kind === 'session' ? <div>
    <button onClick={() => onUpdateNode?.(createNodeThread(node))}>Create local session</button>
    <button onClick={() => onDraftChange?.(node.id, activeThreadId(node), 'Persist my draft')}>Write draft</button>
    <button onClick={() => onDraftChange?.(node.id, activeThreadId(node), 'A newer prompt')}>Write newer draft</button>
    <button onClick={() => onSend?.(node, getNodeThreads(node).find(thread => thread.id === activeThreadId(node))?.draft ?? '', () => {})}>Send the draft</button>
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

it('keeps a chat node\'s draft on this device per Session and routes a late real server ID to its original record', () => {
  const node = prepare();
  render(<CanvasSurface />);
  fireEvent.click(screen.getByText('Write draft'));
  fireEvent.click(screen.getByText('Create local session'));
  fireEvent.click(screen.getByText('Old response arrives'));
  const saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(saved.issueId).toBeNull();
  expect(getNodeThreads(saved)).toHaveLength(2);
  expect(getNodeThreads(saved).find(thread => thread.id === 'default')).toMatchObject({ issueId: 'late-original-server-id' });
  // The unsent message is this person's: on the device, under its own Session, and nowhere in the shared document.
  expect(getNodeThreads(saved).map(thread => thread.draft)).toEqual(['', '']);
  expect(readComposerDraft(node.id, 'default')).toBe('Persist my draft');
  expect(readComposerDraft(node.id, activeThreadId(saved))).toBe('');
  // Draft keystrokes and server acknowledgements are silent; one undo only reverses selection.
  fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
  const restored = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(restored.issueId).toBe('late-original-server-id');
  expect(activeThreadId(restored)).toBe('default');
  expect(getNodeThreads(restored)).toHaveLength(2);
  expect(readComposerDraft(node.id, 'default')).toBe('Persist my draft');
});

it('keeps a media node\'s prompt in the document, where its runs and everyone on the canvas read it', () => {
  const node = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'picture' };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
  render(<CanvasSurface />);
  fireEvent.click(screen.getByText('Write draft'));
  expect(activeNodeThread(loadDocumentWithStatus().doc.nodes[0] as SessionNode).draft).toBe('Persist my draft');
  expect(readComposerDraft('picture', 'default')).toBe('');
});

describe('a media node’s prompt sent from its box', () => {
  const PROMPT = 'A red bicycle at dusk';
  function picture(): void {
    const node = updateNodeDraft({ ...createSessionNode('image', { x: 0, y: 0 }), id: 'picture', model: 'rh.seedream-v5-pro',
      binding: { companyId: 'company', agentId: 'agent', agentName: 'Agent' } }, PROMPT);
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
  }
  const prompt = () => activeNodeThread(loadDocumentWithStatus().doc.nodes[0] as SessionNode).draft;
  // Dispatched: the run was accepted (its journal goes again as soon as this test's run fails).
  const dispatched = () => vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/prepare'));
  function deferOwnership() {
    let enter!: () => void;
    vi.spyOn(navigator.locks, 'request').mockImplementation(((_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) =>
      new Promise<void>(resolve => { enter = () => { void callback({ name: 'awwo.canvas.execution.v1' }).then(resolve); }; })) as typeof navigator.locks.request);
    return () => act(() => enter());
  }

  it('is consumed in the document once the run is accepted', async () => {
    picture();
    render(<CanvasSurface />);
    fireEvent.click(screen.getByText('Send the draft'));
    await waitFor(() => expect(dispatched()).toBe(true));
    expect(prompt()).toBe('');
  });

  it('stays when a newer one was written while the run waited for ownership', async () => {
    picture();
    render(<CanvasSurface />);
    const accept = deferOwnership();
    fireEvent.click(screen.getByText('Send the draft'));
    fireEvent.click(screen.getByText('Write newer draft'));
    accept();
    // Accepted with the prompt it was sent with; the newer one is not consumed.
    await waitFor(() => expect(dispatched()).toBe(true));
    expect(prompt()).toBe('A newer prompt');
  });

  it('stays, and nothing is dispatched, when the document cannot take its consumption', async () => {
    picture();
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      const consumed = key === CANVAS_STORAGE_KEY && JSON.parse(value).nodes[0].threads?.[0]?.draft === '';
      if (consumed) throw new DOMException('Storage full', 'QuotaExceededError');
      setItem(key, value);
    });
    render(<CanvasSurface />);
    fireEvent.click(screen.getByText('Send the draft'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('本地存储不可用'));
    expect(prompt()).toBe(PROMPT);
    expect(loadRunJournal()).toBeNull();
    expect(dispatched()).toBe(false);
  });
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

it('persists delivery expansion as one idempotent view change without moving or resizing the node or adding undo steps', () => {
  // The drawer takes a share of an opened node's width (2026-10-15): it no longer widens or moves the saved node.
  const first = prepare();
  render(<CanvasSurface />);
  fireEvent.click(screen.getByText('Open delivery drawer'));
  fireEvent.click(screen.getByText('Open delivery drawer'));
  let saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(saved).toMatchObject({ deliverablesOpen: true, w: first.w, x: first.x });
  expect(screen.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  cleanup(); render(<CanvasSurface />);
  fireEvent.click(screen.getByText('Open delivery drawer'));
  saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(saved).toMatchObject({ deliverablesOpen: true, w: first.w, x: first.x });
  fireEvent.click(screen.getByText('Close delivery drawer'));
  saved = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
  expect(saved).toMatchObject({ deliverablesOpen: false, w: first.w, x: first.x });
  expect(screen.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});
