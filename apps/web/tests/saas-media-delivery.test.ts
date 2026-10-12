import { describe, expect, it } from 'vitest';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasResult, deliveredItems } from '../src/canvas/canvasResultModel';
import type { CanvasRunJournal } from '../src/canvas/runJournal';
import { applyRecoveredDocument, runInputFingerprint, type FingerprintedRunJournal } from '../src/canvas/runRecoveryDocument';

// What the API answers a 3D node's run with: its stored model and the provider's preview picture.
const MODEL = JSON.stringify({
  type: 'awwo.media', version: 1, kind: 'model3d', model: 'tripo.p1',
  items: [
    { artifactId: 'a2EHUlcwqI6D2Y7Zkp3_86L6NOxYmvFTB', name: 'model-1.glb', contentType: 'model/gltf-binary', size: 6_513_420 },
    { artifactId: 'aPreviewZ8x2kq_91LmN0', name: 'model-1-preview.webp', contentType: 'image/webp', size: 48_210 },
  ],
});
const EARLIER_MODEL = MODEL.replace('model-1.glb', 'model-0.glb');
const PICTURE = JSON.stringify({
  type: 'awwo.media', version: 1, kind: 'image', model: 'xt.seedream-5-pro',
  items: [{ artifactId: 'aImageQ3v9Lm2Xp7', name: 'image-1.png', contentType: 'image/png', size: 120_000 }],
});

function node(id: string, agentKind: 'model3d' | 'image' | 'llm'): SessionNode {
  return {
    ...createSessionNode(agentKind, { x: 0, y: 0 }), id, title: `${agentKind} ${id}`,
    model: agentKind === 'model3d' ? 'tripo.p1' : agentKind === 'image' ? 'xt.seedream-5-pro' : 'gpt-5.5',
    binding: { companyId: 'company-1', agentId: `agent-${id}`, agentName: id },
  };
}

function documentOf(...nodes: SessionNode[]): CanvasDocument {
  return { ...emptyDocument(), nodes, edges: [] };
}

/** The journal a Send typed in one node's chat leaves behind (a manual run of that node alone). */
function sendJournal(doc: CanvasDocument, id: string, item: Partial<CanvasRunJournal['nodes'][string]>): FingerprintedRunJournal {
  const value: CanvasRunJournal = {
    version: 1, id: `send-${id}`, startedAt: 1_000, scope: [id], manual: true, manualMessage: 'Sci-fi assault rifleman hero',
    nodes: { [id]: { nodeId: id, threadId: 'default', companyId: 'company-1', agentId: `agent-${id}`, issueId: `issue-${id}`, runId: `run-${id}`, state: 'done', output: MODEL, ...item } },
  };
  return { ...value, inputFingerprint: runInputFingerprint(doc, value.scope) };
}

describe('a media node generates its own delivery', () => {
  it('publishes a 3D node\'s finished generation as its delivery, so 交付物 and 成果 show it', () => {
    const doc = documentOf(node('hero', 'model3d'));
    expect(canvasResult(doc).final).toBeNull();

    const sent = applyRecoveredDocument(doc, sendJournal(doc, 'hero', {}));
    expect(sent.nodes[0].lastOutput).toEqual({ text: MODEL, at: 1_000, source: 'run' });
    expect(canvasResult(sent).final).toMatchObject({ kind: 'media', state: 'run' });
    expect(deliveredItems(sent).map(item => [item.kind, item.label])).toEqual([['model', 'model-1.glb'], ['image', 'model-1-preview.webp']]);
  });

  it('replaces an earlier generation and keeps it when the new one fails, is cancelled or is unfinished', () => {
    const before = documentOf({ ...node('hero', 'model3d'), lastOutput: { text: EARLIER_MODEL, at: 10, source: 'run' } });
    expect(applyRecoveredDocument(before, sendJournal(before, 'hero', {})).nodes[0].lastOutput?.text).toBe(MODEL);
    for (const item of [{ state: 'failed' as const, output: 'Tripo: content moderation' }, { state: 'cancelled' as const, output: MODEL },
      { state: 'done' as const, output: MODEL, partial: true }]) {
      expect(applyRecoveredDocument(before, sendJournal(before, 'hero', item)).nodes[0].lastOutput?.text).toBe(EARLIER_MODEL);
    }
  });

  it('publishes a picture for an image node, but never another kind\'s record or an ordinary chat reply', () => {
    const picture = documentOf(node('poster', 'image'));
    expect(applyRecoveredDocument(picture, sendJournal(picture, 'poster', { output: PICTURE })).nodes[0].lastOutput?.text).toBe(PICTURE);

    const wrongKind = documentOf(node('hero', 'model3d'));
    expect(applyRecoveredDocument(wrongKind, sendJournal(wrongKind, 'hero', { output: PICTURE })).nodes[0].lastOutput ?? null).toBeNull();

    const writer = documentOf(node('writer', 'llm'));
    for (const output of ['A plain answer in the chat.', PICTURE]) {
      expect(applyRecoveredDocument(writer, sendJournal(writer, 'writer', { output })).nodes[0].lastOutput ?? null).toBeNull();
    }
  });

  it('leaves the node alone when the send belonged to an earlier Agent of that node', () => {
    const doc = documentOf(node('hero', 'model3d'));
    const rebound = applyRecoveredDocument(doc, sendJournal(doc, 'hero', { agentId: 'agent-before-rebinding' }));
    expect(rebound.nodes[0].lastOutput ?? null).toBeNull();
  });
});
