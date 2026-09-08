import { expect, it } from 'vitest';
import { createDevelopmentTemplate } from '../src/canvas/agentTemplates';
import { emptyDocument, sanitizeDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { preserveThreadRuntime } from '../src/canvas/nodeThreads';
import { CANVAS_BASELINE_KEY, isKnownSyncedCache, rememberCanvasBaseline } from '../src/saas/canvasDraft';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, keys: () => [...values.keys()] };
}

function undoneTemplate(): CanvasDocument {
  const template = createDevelopmentTemplate({ x: 0, y: 0 }, 'zh');
  return { ...emptyDocument(), ...template, updatedAt: 123456, view: { x: 48, y: 189, scale: 1 },
    // Undo preserves session state even on an unrun graph, creating outputValues maps.
    nodes: template.nodes.map(node => preserveThreadRuntime(node, node)) };
}

/** Model JSON object-key reordering by a server without changing values or array order. */
function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorderKeys(item)]));
  return value;
}

it('recognizes an acknowledged undo snapshot after a server reorders nested output-value keys', () => {
  const local = undoneTemplate();
  const server = reorderKeys(local);
  const storage = memoryStorage();
  expect(sanitizeDocument(server)).toEqual(sanitizeDocument(local));
  expect(JSON.stringify(sanitizeDocument(server))).not.toBe(JSON.stringify(sanitizeDocument(local)));
  rememberCanvasBaseline(storage, 6, server);
  expect(isKnownSyncedCache(storage, local)).toBe(true);
  rememberCanvasBaseline(storage, 7, server);
  expect(isKnownSyncedCache(storage, local)).toBe(true);
});

it('recognizes an existing baseline written before canonical serialization was introduced', () => {
  const local = undoneTemplate();
  const storage = memoryStorage();
  storage.setItem(CANVAS_BASELINE_KEY, JSON.stringify({ version: 6, document: JSON.stringify(sanitizeDocument(reorderKeys(local))) }));
  expect(isKnownSyncedCache(storage, local)).toBe(true);
});

it.each([
  ['updated timestamp', (doc: CanvasDocument) => { doc.updatedAt++; }],
  ['viewport', (doc: CanvasDocument) => { doc.view!.scale += 0.1; }],
  ['node title', (doc: CanvasDocument) => { doc.nodes[0].title += ' edited'; }],
  ['nested output value', (doc: CanvasDocument) => {
    const node = doc.nodes[0];
    if (node.kind === 'session') node.threads![0].outputValues!.schema = 'unsaved output';
  }],
  ['node array order', (doc: CanvasDocument) => { doc.nodes.reverse(); }],
  ['edge array order', (doc: CanvasDocument) => { doc.edges.reverse(); }],
  ['contract field order', (doc: CanvasDocument) => {
    const node = doc.nodes[0];
    if (node.kind === 'session') node.contract!.outputs.reverse();
  }],
] as const)('does not treat changed %s as an acknowledged document', (_name, change) => {
  const local = undoneTemplate();
  const storage = memoryStorage();
  rememberCanvasBaseline(storage, 6, local);
  const changed = structuredClone(local);
  change(changed);
  expect(isKnownSyncedCache(storage, changed)).toBe(false);
});

it('preserves a newer acknowledged version and rejects a corrupt marker', () => {
  const old = undoneTemplate();
  const newer = structuredClone(old); newer.nodes[0].title = 'newly acknowledged';
  const storage = memoryStorage();
  rememberCanvasBaseline(storage, 7, newer);
  rememberCanvasBaseline(storage, 6, old);
  expect(isKnownSyncedCache(storage, newer)).toBe(true);
  expect(isKnownSyncedCache(storage, old)).toBe(false);
  expect(JSON.parse(storage.getItem(CANVAS_BASELINE_KEY)!).version).toBe(7);
  storage.setItem(CANVAS_BASELINE_KEY, '{broken');
  expect(isKnownSyncedCache(storage, newer)).toBe(false);
});
