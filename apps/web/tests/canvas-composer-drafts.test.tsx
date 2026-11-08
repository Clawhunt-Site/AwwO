import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { COMPOSER_DRAFT_MAX, composerDraftKey, draftIsShared, readComposerDraft, writeComposerDraft } from '../src/canvas/composerDrafts';
import { activeNodeThread, activeThreadId, createNodeThread, getNodeThreads, selectNodeThread, updateNodeDraft, withoutThreadDrafts } from '../src/canvas/nodeThreads';
import * as sessions from '../src/canvas/sessions';

// The surface alone: what it moves on opening, not what a tile draws.
vi.mock('../src/canvas/SessionTile', () => ({ SessionTile: () => null }));

beforeEach(() => {
  cleanup(); localStorage.clear(); sessions.resetAllSessions(); vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});

describe('a chat node\'s unsent message on this device', () => {
  it('is kept per node and conversation, and forgotten once emptied', () => {
    expect(writeComposerDraft('chat', 'default', 'first message')).toBe(true);
    expect(writeComposerDraft('chat', 'thread-2', 'second message')).toBe(true);
    expect(readComposerDraft('chat', 'default')).toBe('first message');
    expect(readComposerDraft('chat', 'thread-2')).toBe('second message');
    expect(readComposerDraft('other', 'default')).toBe('');
    expect(writeComposerDraft('chat', 'default', '')).toBe(true);
    expect(localStorage.getItem(composerDraftKey('chat', 'default'))).toBeNull();
    expect(readComposerDraft('chat', 'thread-2')).toBe('second message');
  });

  it('keeps ids that hold the separator apart', () => {
    expect(composerDraftKey('a:b', 'c')).not.toBe(composerDraftKey('a', 'b:c'));
    writeComposerDraft('a:b', 'c', 'one');
    writeComposerDraft('a', 'b:c', 'two');
    expect([readComposerDraft('a:b', 'c'), readComposerDraft('a', 'b:c')]).toEqual(['one', 'two']);
  });

  it('cuts a text past the cap', () => {
    writeComposerDraft('chat', 'default', 'x'.repeat(COMPOSER_DRAFT_MAX + 10));
    expect(readComposerDraft('chat', 'default')).toHaveLength(COMPOSER_DRAFT_MAX);
  });

  it('reads nothing and reports a refusal where the storage fails', () => {
    const refusing = {
      getItem: () => { throw new DOMException('Storage unavailable', 'SecurityError'); },
      setItem: () => { throw new DOMException('Storage full', 'QuotaExceededError'); },
      removeItem: () => { throw new DOMException('Storage unavailable', 'SecurityError'); },
    };
    expect(readComposerDraft('chat', 'default', refusing)).toBe('');
    expect(writeComposerDraft('chat', 'default', 'kept in the box', refusing)).toBe(false);
    expect(writeComposerDraft('chat', 'default', '', refusing)).toBe(false);
  });

  it('is a chat node\'s only: a media node\'s draft is its prompt, which stays shared', () => {
    for (const kind of ['image', 'video', 'audio', 'model3d'] as const) expect(draftIsShared({ agentKind: kind })).toBe(true);
    for (const kind of ['llm', 'coding'] as const) expect(draftIsShared({ agentKind: kind })).toBe(false);
  });

  it('withoutThreadDrafts empties every conversation\'s draft and leaves a node holding none as it is', () => {
    const plain = createSessionNode('llm', { x: 0, y: 0 });
    expect(withoutThreadDrafts(plain)).toBe(plain);
    const two = updateNodeDraft(createNodeThread(updateNodeDraft(plain, 'first')), 'second');
    const cleared = withoutThreadDrafts(two);
    expect(getNodeThreads(cleared).map(thread => thread.draft)).toEqual(['', '']);
    expect(getNodeThreads(cleared).map(thread => thread.id)).toEqual(getNodeThreads(two).map(thread => thread.id));
    expect(activeThreadId(cleared)).toBe(activeThreadId(two));
    // Only the conversations named.
    expect(getNodeThreads(withoutThreadDrafts(two, new Set(['default']))).map(thread => thread.draft)).toEqual(['', 'second']);
  });
});

describe('chat drafts an earlier release left in the shared document', () => {
  function legacyCanvas(): { chat: SessionNode; secondThread: string; media: SessionNode } {
    const typed = updateNodeDraft({ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'chat' }, 'unsent in the first Session');
    const second = updateNodeDraft(createNodeThread(typed), 'unsent in the second Session');
    const chat = selectNodeThread(second, 'default');
    const media = updateNodeDraft({ ...createSessionNode('image', { x: 700, y: 0 }), id: 'picture' }, 'a lighthouse at dusk');
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [chat, media], view: { x: 0, y: 0, scale: 1 } }));
    return { chat, secondThread: activeThreadId(second), media };
  }

  const savedNode = (id: string) => loadDocumentWithStatus().doc.nodes.find(node => node.id === id) as SessionNode;

  it('move to an editor\'s device when it opens the canvas, out of the document, with no undo step; a media prompt stays', () => {
    const { secondThread } = legacyCanvas();
    render(<CanvasSurface />);
    expect(getNodeThreads(savedNode('chat')).map(thread => thread.draft)).toEqual(['', '']);
    expect(readComposerDraft('chat', 'default')).toBe('unsent in the first Session');
    expect(readComposerDraft('chat', secondThread)).toBe('unsent in the second Session');
    expect(activeNodeThread(savedNode('picture')).draft).toBe('a lighthouse at dusk');
    expect(readComposerDraft('picture', 'default')).toBe('');
    expect(screen.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  });

  it('never write over a draft this device holds for that conversation, and stay for the page that holds none', () => {
    const { secondThread } = legacyCanvas();
    writeComposerDraft('chat', 'default', 'typed on this device');
    render(<CanvasSurface />);
    expect(readComposerDraft('chat', 'default')).toBe('typed on this device');
    // Another person's, or this person's from another device: it stays in the document for that page.
    const threads = getNodeThreads(savedNode('chat'));
    expect(threads.find(thread => thread.id === 'default')?.draft).toBe('unsent in the first Session');
    // The other conversation's moved: this device held none for it.
    expect(threads.find(thread => thread.id === secondThread)?.draft).toBe('');
    expect(readComposerDraft('chat', secondThread)).toBe('unsent in the second Session');
  });

  it('go from the document once the device holds the same, and stay where the device refuses them', () => {
    const { secondThread } = legacyCanvas();
    writeComposerDraft('chat', 'default', 'unsent in the first Session');
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.includes('composer-draft') && key.includes(encodeURIComponent(secondThread))) throw new DOMException('Storage full', 'QuotaExceededError');
      setItem(key, value);
    });
    render(<CanvasSurface />);
    const threads = getNodeThreads(savedNode('chat'));
    expect(threads.find(thread => thread.id === 'default')?.draft).toBe('');
    expect(threads.find(thread => thread.id === secondThread)?.draft).toBe('unsent in the second Session');
  });

  it('stay where they are on a reader\'s page, which saves nothing', () => {
    legacyCanvas();
    const before = localStorage.getItem(CANVAS_STORAGE_KEY);
    render(<CanvasSurface readOnly />);
    expect(localStorage.getItem(CANVAS_STORAGE_KEY)).toBe(before);
    expect(readComposerDraft('chat', 'default')).toBe('');
  });
});
