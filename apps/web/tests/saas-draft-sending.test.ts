import { beforeEach, expect, it } from 'vitest';
import { createSessionNode, emptyDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { CANVAS_DRAFT_PREFIX, acknowledgeCanvasDraft, canvasDocumentHash, persistCanvasDraft, readCanvasDrafts, restorableCanvasDraftBase } from '../src/saas/canvasDraft';

// A draft's record of the save its page had out (CanvasDraft.sending), on its own.
const documentAt = (title: string, x = 0): CanvasDocument => ({ ...emptyDocument(), updatedAt: 1, view: { x: 0, y: 0, scale: 1 },
  nodes: [{ ...createSessionNode('llm', { x, y: 0 }), id: 'node-a', title }] });
beforeEach(() => { localStorage.clear(); configureCanvasStorage('user-a', 'tenant-a', 'canvas-a'); });

it('hashes a document as the server keeps it: object key order aside, every value counted', () => {
  const document = documentAt('画布', 10);
  const reordered = JSON.parse(JSON.stringify({ edges: document.edges, ...document }));
  expect(canvasDocumentHash(reordered)).toBe(canvasDocumentHash(document));
  expect(canvasDocumentHash(documentAt('画布', 11))).not.toBe(canvasDocumentHash(document));
});

it('records the save out only in a draft built on that save\'s base', () => {
  const storage = canvasStorage();
  const sending = { baseVersion: 7, hash: canvasDocumentHash(documentAt('送出的', 1)) };
  expect(persistCanvasDraft(storage, 'tab-a', 7, documentAt('之后的', 2), sending).sending).toEqual(sending);
  expect(readCanvasDrafts(storage)[0].draft?.sending).toEqual(sending);
  expect(persistCanvasDraft(storage, 'tab-a', 8, documentAt('之后的', 2), sending).sending).toBeUndefined();
  expect(persistCanvasDraft(storage, 'tab-a', 8, documentAt('之后的', 2), null).sending).toBeUndefined();
});

it('reads a draft whose record of the save out is damaged as a plain draft', () => {
  const storage = canvasStorage();
  const draft = persistCanvasDraft(storage, 'tab-a', 7, documentAt('草稿'));
  storage.setItem(`${CANVAS_DRAFT_PREFIX}tab-a`, JSON.stringify({ ...draft, sending: { baseVersion: 'seven' } }));
  const [read] = readCanvasDrafts(storage);
  expect(read.draft).not.toBeNull();
  expect(read.draft?.sending).toBeUndefined();
  expect(read.draft?.document.nodes[0].title).toBe('草稿');
});

it('drops the record once the save it describes is acknowledged and the draft moves onto it', () => {
  const storage = canvasStorage();
  const sent = persistCanvasDraft(storage, 'tab-a', 7, documentAt('送出的', 1));
  persistCanvasDraft(storage, 'tab-a', 7, documentAt('之后的', 2), { baseVersion: 7, hash: canvasDocumentHash(sent.document) });
  acknowledgeCanvasDraft(storage, sent, 8);
  const [read] = readCanvasDrafts(storage);
  expect(read.draft).toMatchObject({ baseVersion: 8, document: { nodes: [{ title: '之后的' }] } });
  expect(read.draft?.sending).toBeUndefined();
  expect(JSON.parse(read.raw)).not.toHaveProperty('sending');
});

it('restores onto the cloud only when the cloud is that very save, one version on, and its page has closed', () => {
  const storage = canvasStorage();
  const sent = documentAt('送出的', 1);
  const draft = persistCanvasDraft(storage, 'tab-a', 7, documentAt('之后的', 2), { baseVersion: 7, hash: canvasDocumentHash(sent) });
  expect(restorableCanvasDraftBase(draft, { version: 7, document: documentAt('原文') }, true)).toBe(7);
  expect(restorableCanvasDraftBase(draft, { version: 8, document: JSON.parse(JSON.stringify(sent)) }, true)).toBe(8);
  // That page may still be open (another tab has the canvas): only its own base.
  expect(restorableCanvasDraftBase(draft, { version: 8, document: sent }, false)).toBeNull();
  expect(restorableCanvasDraftBase(draft, { version: 7, document: documentAt('原文') }, false)).toBe(7);
  // Another document at that version (another device's, or one the server changed), the cloud further on, or no record:
  // not over it.
  expect(restorableCanvasDraftBase(draft, { version: 8, document: documentAt('另一台设备', 9) }, true)).toBeNull();
  expect(restorableCanvasDraftBase(draft, { version: 8, document: documentAt('送出的', 1.5) }, true)).toBeNull();
  expect(restorableCanvasDraftBase(draft, { version: 9, document: sent }, true)).toBeNull();
  const plain = persistCanvasDraft(storage, 'tab-b', 7, documentAt('之后的', 2));
  expect(restorableCanvasDraftBase(plain, { version: 8, document: sent }, true)).toBeNull();
  // An earlier release's cache has no known base at all.
  expect(restorableCanvasDraftBase({ ...draft, legacyCache: true }, { version: 7, document: sent }, true)).toBeNull();
  // The cloud's hash is asked for only when it can decide.
  let asked = 0;
  expect(restorableCanvasDraftBase(draft, { version: 7, document: sent }, true, () => { asked++; return ''; })).toBe(7);
  expect(restorableCanvasDraftBase(draft, { version: 8, document: sent }, false, () => { asked++; return ''; })).toBeNull();
  expect(asked).toBe(0);
});
