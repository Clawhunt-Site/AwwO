// 多人同屏 / Multiplayer: the page's canvas change engine (src/canvas/multiplayer/changes.ts) on the cases the API runs
// too (apps/canvas-change-vectors.json), on random canvases, and carrying a page's own edits, and its undo and redo
// steps, over the changes of others and over the answers to its own (docs/awwo-canvas-live-collaboration.md,
// "Concurrency").
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANVAS_COLLECTIONS, CanvasOpError, NODE_COLLECTIONS, applyOp, applyOps, collectionOf, compareKeys, diffDocuments, findRecord,
  isCanvasCollection, isExcludedKey, isNodeCollection, isRecordPlace, isWholeRecordCollection, orderedRecords, othersOps, parsePath,
  pendingOps, rebaseAfterAck, rebaseOverMove, rebaseWorking, recordKey, recordKeyName, recordKeys, sameValue, valueAt,
} from '../src/canvas/multiplayer/changes';
import type { CanvasOp } from '../src/canvas/multiplayer/types';

type Json = Record<string, unknown>;

interface ApplyCase { name: string; before: Json; ops: CanvasOp[]; after?: Json; applied?: boolean[]; error?: number }
interface DiffCase { name: string; a: Json; b: Json; ops: CanvasOp[] }
// process.cwd() is apps/web when the suite runs.
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../canvas-change-vectors.json'), 'utf8')) as { apply: ApplyCase[]; diff: DiffCase[] };

/** Freezes a value all the way down, so anything that changes it in place throws. */
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) frozen(item);
  }
  return value;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The last character of the Basic Multilingual Plane, and one beyond it (two UTF-16 surrogates). */
const LAST_BMP = String.fromCharCode(0xffff);
const ASTRAL = String.fromCodePoint(0x1f600);

/** A copy of a document with a change made to it; the document itself is never changed. */
function changed<T>(doc: T, change: (copy: Json) => void): T {
  const out = copy(doc) as Json;
  change(out);
  return frozen(out) as T;
}

const nodesOf = (doc: object): Json[] => ((doc as Json).nodes ?? []) as Json[];
const nodeIn = (doc: object, id: string): Json | undefined => nodesOf(doc).find(node => node.id === id);
const idsOf = (list: unknown): unknown[] => (list as Json[]).map(item => item.id);

function refusal(run: () => unknown): CanvasOpError {
  try {
    run();
  } catch (error) {
    if (error instanceof CanvasOpError) return error;
    throw error;
  }
  throw new Error('the op was not refused');
}

describe('the cases the API runs too', () => {
  it('reads them', () => {
    expect(vectors.apply.length).toBeGreaterThanOrEqual(16);
    expect(vectors.diff.length).toBeGreaterThanOrEqual(11);
  });

  for (const c of vectors.apply) {
    it(`apply: ${c.name}`, () => {
      const before = frozen(copy(c.before));
      if (c.error !== undefined) {
        expect(refusal(() => applyOps(before, c.ops)).index).toBe(c.error);
        return;
      }
      const { doc, applied } = applyOps(before, c.ops);
      expect(doc).toEqual(c.after);
      expect(sameValue(doc, c.after)).toBe(true);
      expect(applied).toEqual(c.applied);
    });
  }

  for (const c of vectors.diff) {
    it(`diff: ${c.name}`, () => {
      const a = frozen(copy(c.a)), b = frozen(copy(c.b));
      const ops = diffDocuments(a, b);
      expect(ops).toEqual(c.ops);
      expect(sameValue(ops, c.ops)).toBe(true);
      // And the ops, through JSON as between the API and a page, do turn a into b.
      expect(diffDocuments(applyOps(a, copy(ops)).doc, b)).toEqual([]);
    });
  }
});

describe('paths', () => {
  const none = { collection: '', record: '', sub: '', subRecord: '', key: '' };

  it('reads every place the contract names', () => {
    expect(parsePath(['nodes'])).toEqual({ ...none, collection: 'nodes' });
    expect(parsePath(['nodes', 'n1'])).toEqual({ ...none, collection: 'nodes', record: 'n1' });
    expect(parsePath(['nodes', 'n1', 'title'])).toEqual({ ...none, collection: 'nodes', record: 'n1', key: 'title' });
    expect(parsePath(['nodes', 'n1', 'threads'])).toEqual({ ...none, collection: 'nodes', record: 'n1', sub: 'threads', key: 'threads' });
    expect(parsePath(['nodes', 'n1', 'fields', 'f1'])).toEqual({ ...none, collection: 'nodes', record: 'n1', sub: 'fields', subRecord: 'f1' });
    expect(parsePath(['nodes', 'n1', 'threads', 't1', 'draft']))
      .toEqual({ collection: 'nodes', record: 'n1', sub: 'threads', subRecord: 't1', key: 'draft' });
    // Only a node holds conversations: a display's "threads" is a field like any other.
    expect(parsePath(['displays', 'd1', 'threads'])).toEqual({ ...none, collection: 'displays', record: 'd1', key: 'threads' });
    expect(parsePath(['edges', 'e1'])).toEqual({ ...none, collection: 'edges', record: 'e1' });
    expect(parsePath(['doc', 'execution'])).toEqual({ ...none, key: 'execution' });
    // A slot as Go's strconv.Atoi reads one: a sign, leading zeros, the whole 64-bit range.
    for (const slot of ['3', '+3', '-3', '007', '9223372036854775807', '-9223372036854775808', '0009223372036854775807']) {
      expect(parsePath(['waypoints', slot]).record).toBe(slot);
    }
  });

  it('refuses what the API refuses', () => {
    const refused: unknown[] = [
      [], ['nope'], ['nodes', ''], ['doc'], ['doc', 'a', 'b'], ['doc', 'view'], ['doc', 'version'], ['doc', 'updatedAt'],
      ['doc', 'nodes'], ['doc', 'waypoints'], ['waypoints', 'x'], ['waypoints', '1.5'], ['waypoints', ' 1'], ['waypoints', '+'],
      ['waypoints', '9223372036854775808'], ['waypoints', '-9223372036854775809'], ['waypoints', '12345678901234567890'],
      ['waypoints', '3', 'view'], ['edges', 'e', 'toPort'], ['nodes', 'a', 'id'], ['displays', 'd', 'id'], ['nodes', 'a', 'title', 'x'],
      ['displays', 'd', 'x', 'y'], ['edges', 'e', 'threads', 't'], ['nodes', 'a', 'threads', 't', 'id'],
      ['nodes', 'a', 'threads', 't', 'draft', 'more'], ['nodes', 'a'.repeat(201)], [1], ['nodes', 5], ['nodes', null], 'nodes', null,
    ];
    for (const path of refused) expect(() => parsePath(path as string[]), JSON.stringify(path)).toThrow(CanvasOpError);
  });

  it('measures a part in UTF-8 bytes, as the API does', () => {
    const fits = (part: string) => {
      try {
        parsePath(['nodes', part]);
        return true;
      } catch {
        return false;
      }
    };
    expect(fits('a'.repeat(200))).toBe(true);
    expect(fits('é'.repeat(100))).toBe(true); // 2 bytes each
    expect(fits(`${'é'.repeat(100)}a`)).toBe(false);
    expect(fits('中'.repeat(66))).toBe(true); // 3 bytes each: 67 of them are 201 bytes in 67 characters
    expect(fits('中'.repeat(67))).toBe(false);
    expect(fits('\u{1F600}'.repeat(50))).toBe(true); // 4 bytes each
    expect(fits(`${'\u{1F600}'.repeat(50)}a`)).toBe(false);
    expect(fits(`${'\ud800'.repeat(66)}ab`)).toBe(true); // a lone surrogate is the 3-byte U+FFFD there
    expect(fits('\ud800'.repeat(67))).toBe(false);
  });

  it('tells a record from a field, a collection and a document key', () => {
    for (const path of [['nodes', 'n'], ['edges', 'e'], ['waypoints', '1'], ['nodes', 'n', 'threads', 't']]) {
      expect(isRecordPlace(parsePath(path))).toBe(true);
    }
    for (const path of [['nodes'], ['nodes', 'n', 'threads'], ['nodes', 'n', 'title'], ['nodes', 'n', 'threads', 't', 'draft'], ['doc', 'x']]) {
      expect(isRecordPlace(parsePath(path))).toBe(false);
    }
  });

  it('names the places of a document', () => {
    expect(CANVAS_COLLECTIONS).toEqual(['nodes', 'edges', 'displays', 'waypoints']);
    expect(NODE_COLLECTIONS).toEqual(['threads', 'fields']);
    expect(['version', 'updatedAt', 'view'].every(isExcludedKey)).toBe(true);
    expect(isExcludedKey('execution')).toBe(false);
    expect(CANVAS_COLLECTIONS.every(isCanvasCollection)).toBe(true);
    expect(isCanvasCollection('doc')).toBe(false);
    expect(isNodeCollection('threads') && isNodeCollection('fields') && !isNodeCollection('title')).toBe(true);
    expect(CANVAS_COLLECTIONS.map(recordKeyName)).toEqual(['id', 'id', 'id', 'slot']);
    expect(CANVAS_COLLECTIONS.map(isWholeRecordCollection)).toEqual([false, true, false, true]);
  });
});

describe('records and values', () => {
  it('names a record by its id, and a saved view by its slot as a decimal integer', () => {
    expect(recordKey({ id: 'n1' }, 'id')).toBe('n1');
    expect(recordKey({ id: '' }, 'id')).toBeUndefined();
    expect(recordKey({ id: 3 }, 'id')).toBeUndefined();
    expect(recordKey({ slot: '3' }, 'slot')).toBe('3');
    expect(recordKey({ slot: 3 }, 'slot')).toBe('3');
    expect(recordKey({ slot: 3.0 }, 'slot')).toBe('3');
    expect(recordKey({ slot: -0 }, 'slot')).toBe('0');
    expect(recordKey({ slot: 1e18 }, 'slot')).toBe('1000000000000000000');
    expect(recordKey({ slot: 2 ** 60 }, 'slot')).toBe('1152921504606846976'); // exactly, where String() would round
    expect(recordKey({ slot: -(2 ** 63) }, 'slot')).toBe('-9223372036854775808');
    expect(recordKey({ slot: 2 ** 63 }, 'slot')).toBeUndefined();
    expect(recordKey({ slot: 3.5 }, 'slot')).toBeUndefined();
    expect(recordKey({ slot: true }, 'slot')).toBeUndefined();
    for (const item of [['n1'], null, 'n1', 7, Object.create({ id: 'inherited' })]) expect(recordKey(item, 'id')).toBeUndefined();
  });

  it('finds the first record with a key, and lists keys once each', () => {
    const list = [{ id: 'b', n: 1 }, 'junk', { id: 'a' }, { id: 'b', n: 2 }];
    expect(findRecord(list, 'id', 'b')).toBe(0);
    expect(findRecord(list, 'id', 'a')).toBe(2);
    expect(findRecord(list, 'id', 'x')).toBe(-1);
    expect(findRecord(undefined, 'id', 'b')).toBe(-1);
    expect(recordKeys(list, 'id')).toEqual(['b', 'a']);
    expect(collectionOf({ nodes: list }, 'nodes')).toBe(list);
    expect(collectionOf({ nodes: 'x' }, 'nodes')).toBeUndefined();
    expect(collectionOf({}, 'constructor')).toBeUndefined();
  });

  it('orders records as an order op does, and gives the list itself when nothing moves', () => {
    const list = frozen([{ id: 'a' }, 'junk', { id: 'b' }, { id: 'a', again: true }, { id: 'c' }]);
    const out = orderedRecords(list, 'id', ['c', 'x', 'a', 'c']);
    expect(out).toEqual([{ id: 'c' }, { id: 'a' }, 'junk', { id: 'b' }, { id: 'a', again: true }]);
    expect(out[0]).toBe(list[4]);
    expect(orderedRecords(list, 'id', ['a'])).toBe(list);
    expect(orderedRecords(list, 'id', [])).toBe(list);
  });

  it('compares values as JSON values', () => {
    expect(sameValue(1, 1.0)).toBe(true);
    expect(sameValue('a', 'a')).toBe(true);
    expect(sameValue(1, '1')).toBe(false);
    expect(sameValue(true, false)).toBe(false);
    expect(sameValue(null, undefined)).toBe(false);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue({}, null)).toBe(false);
    expect(sameValue({}, 'x')).toBe(false);
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(sameValue({ a: 1 }, { b: 1 })).toBe(false);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue([1, 2], [1, 3])).toBe(false);
    expect(sameValue([undefined], [null])).toBe(true);
    expect(sameValue([1], { 0: 1 })).toBe(false);
    expect(sameValue({ 0: 1 }, [1])).toBe(false);
    // What an object only inherits is no key of it.
    expect(sameValue(Object.create({ a: 1 }), { a: 1 })).toBe(false);
    expect(sameValue({ a: 1 }, Object.assign(Object.create({ a: 1 }), { b: 1 }))).toBe(false);
  });

  it('orders keys by code point, as the API orders them by their UTF-8 bytes', () => {
    const astral = ASTRAL, last = LAST_BMP;
    expect(compareKeys(astral, last)).toBeGreaterThan(0); // JavaScript's own order puts the surrogates first
    expect(compareKeys(last, astral)).toBeLessThan(0);
    expect(compareKeys('\u{1F600}', '\u{1F601}')).toBeLessThan(0);
    expect(compareKeys('a', 'a')).toBe(0);
    expect(compareKeys('ab', 'a')).toBeGreaterThan(0);
    expect([astral, last, 'b', 'a', 'ab', '中', 'B'].sort(compareKeys)).toEqual(['B', 'a', 'ab', 'b', '中', last, astral]);
  });
});

describe('applying ops', () => {
  const doc = frozen({ version: 2, nodes: [{ id: 'n1', title: 'A', threads: [{ id: 't1', draft: '' }] }], edges: [] });
  const fine: CanvasOp = { op: 'set', path: ['nodes', 'n1', 'title'], value: 'B' };

  it('refuses the ops the API refuses, naming the op, and changes nothing', () => {
    const refused: unknown[] = [
      null, 'set', {}, { path: ['nodes', 'n1'] }, { op: 'move', path: ['nodes', 'n1'] },
      { op: 'set', path: ['nodes', 'n1', 'title'] }, { op: 'set', path: ['nodes', 'n1', 'title'], value: undefined },
      { op: 'set', path: ['nodes'], value: [] }, { op: 'del', path: ['nodes'] },
      { op: 'order', path: ['doc', 'execution'], ids: [] }, { op: 'order', path: ['nodes', 'n1'], ids: [] },
      { op: 'order', path: ['nodes', 'n1', 'title'], ids: [] }, { op: 'order', path: ['nodes', 'n1', 'threads', 't1'], ids: [] },
      { op: 'order', path: ['waypoints'], ids: [] }, { op: 'order', path: ['nodes'], ids: 'n1' }, { op: 'order', path: ['nodes'], ids: [1] },
      { op: 'order', path: ['nodes'], ids: Array.from({ length: 4097 }, (_, i) => `n${i}`) },
      { op: 'set', path: ['nodes', 'n2'], value: { id: 'n3' } }, { op: 'set', path: ['nodes', 'n2'], value: 'n2' },
      { op: 'set', path: ['nodes', 'n1', 'threads', 't2'], value: { id: 't3' } }, { op: 'set', path: ['waypoints', '3'], value: { slot: 4 } },
      { op: 'set', path: ['waypoints', '03'], value: { slot: 3 } }, { op: 'set', path: ['nodes', 'n1', 'id'], value: 'x' },
      { op: 'set', path: 'nodes', value: 1 },
    ];
    for (const op of refused) {
      const error = refusal(() => applyOps(doc, [fine, op as CanvasOp]));
      expect(error.index, JSON.stringify(op)).toBe(1);
      expect(error.message).toMatch(/^op 1: ./);
      expect(error.name).toBe('CanvasOpError');
    }
    expect(refusal(() => applyOp(doc, { op: 'set', path: ['doc', 'view'], value: 1 })).index).toBe(0);
    expect(refusal(() => parsePath(['nope'])).index).toBe(-1);
    expect(applyOps(doc, [{ op: 'order', path: ['nodes'], ids: Array.from({ length: 4096 }, (_, i) => `n${i}`) }]).applied).toEqual([true]);
  });

  it("reads an order's ids as the API reads them: null as none, a null id as one that names no record", () => {
    const nodes = frozen({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const order = (ids: unknown) => ({ op: 'order', path: ['nodes'], ids }) as unknown as CanvasOp;
    expect(applyOps(nodes, [order(null)])).toEqual({ doc: nodes, applied: [true] });
    expect(applyOps(nodes, [order(null)]).doc).toBe(nodes);
    // As the API reads it through JSON (canvas_changes.go canvasOp, a list of strings): [null, "c"] is ["", "c"].
    expect(applyOps(nodes, JSON.parse('[{"op":"order","path":["nodes"],"ids":null}]') as CanvasOp[]).doc).toBe(nodes);
    expect(idsOf(applyOps(nodes, [order([null, 'c', null])]).doc.nodes)).toEqual(['c', 'a', 'b']);
    expect(idsOf(applyOps({ nodes: [{ id: 'a' }, { id: '' }, { id: 'c' }] }, [order([null, 'c'])]).doc.nodes)).toEqual(['c', 'a', '']);
    // What the API cannot read as a list of strings stays refused, and a null id counts toward the bound.
    for (const ids of [[1], [true], [['a']], 'c', {}, 7]) expect(refusal(() => applyOps(nodes, [order(ids)])).index, JSON.stringify(ids)).toBe(0);
    expect(refusal(() => applyOps(nodes, [order(Array.from({ length: 4097 }, () => null))])).reason).toBe('too many ids to order');
    expect(applyOps(nodes, [order(Array.from({ length: 4096 }, () => null))]).doc).toBe(nodes);
  });

  it('passes on an error that is no refusal', () => {
    const broken = { op: 'set', value: 1, get path(): string[] { throw new Error('a broken op'); } };
    let thrown: unknown;
    try {
      applyOps(doc, [broken as unknown as CanvasOp]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CanvasOpError);
    expect((thrown as Error).message).toBe('a broken op');
  });

  it('gives the document itself when nothing changes', () => {
    const base = frozen({
      version: 2,
      nodes: [{ id: 'a', title: 'A', threads: [{ id: 't', draft: 'x' }] }, { id: 'b', title: 'B' }],
      edges: [{ id: 'e', fromNode: 'a' }],
      execution: { mode: 'review', maxRounds: 2 },
    });
    const ops: CanvasOp[] = [
      { op: 'set', path: ['nodes', 'a', 'title'], value: 'A' },
      { op: 'del', path: ['nodes', 'a', 'nothing'] },
      { op: 'set', path: ['nodes', 'a', 'threads', 't', 'draft'], value: 'x' },
      { op: 'del', path: ['nodes', 'a', 'threads', 't', 'nothing'] },
      { op: 'del', path: ['nodes', 'a', 'threads', 'gone'] },
      { op: 'set', path: ['nodes', 'b'], value: { title: 'B', id: 'b' } },
      { op: 'set', path: ['nodes', 'a', 'threads', 't'], value: { draft: 'x', id: 't' } },
      { op: 'del', path: ['nodes', 'gone'] },
      { op: 'set', path: ['doc', 'execution'], value: { maxRounds: 2, mode: 'review' } },
      { op: 'del', path: ['doc', 'nothing'] },
      { op: 'order', path: ['nodes'], ids: ['a', 'b'] },
      { op: 'order', path: ['nodes', 'a', 'threads'], ids: ['t'] },
      { op: 'set', path: ['nodes', 'gone', 'title'], value: 'lost' },
      { op: 'set', path: ['nodes', 'a', 'threads', 'gone', 'draft'], value: 'lost' },
      { op: 'order', path: ['edges'] } as unknown as CanvasOp, // an order that lists no ids
    ];
    const result = applyOps(base, ops);
    expect(result.doc).toBe(base);
    expect(result.applied).toEqual([true, true, true, true, false, true, true, false, true, true, true, true, false, false, true]);
    expect(applyOps(base, []).doc).toBe(base);
  });

  it('shares every part it does not change', () => {
    const base = frozen({ version: 2, nodes: [{ id: 'a', threads: [{ id: 't', draft: 'x' }, { id: 'u' }] }, { id: 'b' }], edges: [{ id: 'e' }] });
    const { doc: next, applied } = applyOp(base, { op: 'set', path: ['nodes', 'a', 'threads', 't', 'draft'], value: 'y' });
    expect(applied).toBe(true);
    expect(next).not.toBe(base);
    expect(next.edges).toBe(base.edges);
    expect(next.nodes[1]).toBe(base.nodes[1]);
    expect(next.nodes[0].threads![1]).toBe(base.nodes[0].threads![1]);
    expect(next.nodes[0].threads![0]).toEqual({ id: 't', draft: 'y' });
    const ordered = applyOp(base, { op: 'order', path: ['nodes', 'a', 'threads'], ids: ['u', 't'] }).doc;
    expect(idsOf(ordered.nodes[0].threads)).toEqual(['u', 't']);
    expect(ordered.nodes[0].threads![0]).toBe(base.nodes[0].threads![1]);
    const removed = applyOp(base, { op: 'del', path: ['nodes', 'a', 'threads', 't'] });
    expect(removed).toEqual({ doc: { ...base, nodes: [{ id: 'a', threads: [{ id: 'u' }] }, { id: 'b' }] }, applied: true });
  });

  it('writes what the API writes where a delete finds no list, and an order makes one', () => {
    // Go keeps the list it did not find, which JSON writes as null.
    expect(applyOps({ version: 2 }, [{ op: 'del', path: ['displays', 'd1'] }])).toEqual({ doc: { version: 2, displays: null }, applied: [false] });
    expect(applyOps({ displays: 'x' }, [{ op: 'del', path: ['displays', 'd1'] }]).doc).toEqual({ displays: null });
    const empty = frozen({ displays: null });
    expect(applyOps(empty, [{ op: 'del', path: ['displays', 'd1'] }]).doc).toBe(empty);
    expect(applyOps({ nodes: [{ id: 'n' }] }, [{ op: 'del', path: ['nodes', 'n', 'threads', 't'] }]))
      .toEqual({ doc: { nodes: [{ id: 'n', threads: null }] }, applied: [false] });
    expect(applyOps({ version: 2 }, [{ op: 'order', path: ['edges'], ids: ['e1'] }]).doc).toEqual({ version: 2, edges: [] });
    expect(applyOps({ nodes: [{ id: 'n', fields: 'x' }] }, [{ op: 'order', path: ['nodes', 'n', 'fields'], ids: [] }]).doc)
      .toEqual({ nodes: [{ id: 'n', fields: [] }] });
    // A record set into what is no list makes one.
    expect(applyOps({ nodes: 'broken' }, [{ op: 'set', path: ['nodes', 'n'], value: { id: 'n' } }]).doc).toEqual({ nodes: [{ id: 'n' }] });
    expect(applyOps({ nodes: [{ id: 'n', threads: 'x' }] }, [{ op: 'set', path: ['nodes', 'n', 'threads', 't'], value: { id: 't' } }]).doc)
      .toEqual({ nodes: [{ id: 'n', threads: [{ id: 't' }] }] });
    // A saved view by its slot, however the number is written.
    expect(applyOps({ waypoints: [{ slot: 3, label: 'a' }] }, [{ op: 'set', path: ['waypoints', '3'], value: { slot: 3.0, label: 'b' } }]).doc)
      .toEqual({ waypoints: [{ slot: 3, label: 'b' }] });
  });

  it('keeps "__proto__" and "constructor" ordinary keys', () => {
    const base = frozen(JSON.parse('{"version":2,"nodes":[{"id":"constructor","title":"A"}]}') as Json);
    const { doc: next } = applyOps(base, [
      { op: 'set', path: ['doc', '__proto__'], value: { polluted: true } },
      { op: 'set', path: ['nodes', 'constructor', '__proto__'], value: 1 },
      { op: 'set', path: ['nodes', 'toString'], value: { id: 'toString' } },
    ]);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(JSON.stringify(next)).toBe('{"version":2,"nodes":[{"id":"constructor","title":"A","__proto__":1},{"id":"toString"}],"__proto__":{"polluted":true}}');
    expect(({} as Json).polluted).toBeUndefined();
    expect(valueAt(next, ['doc', '__proto__'])).toEqual({ polluted: true });
    expect(valueAt(next, ['nodes', 'constructor', '__proto__'])).toBe(1);
    expect(valueAt({}, ['doc', 'constructor'])).toBeUndefined();
    expect(Object.keys(applyOps(next, [{ op: 'del', path: ['doc', '__proto__'] }]).doc)).toEqual(['version', 'nodes']);
    expect(diffDocuments({}, JSON.parse('{"__proto__":1}') as Json)).toEqual([{ op: 'set', path: ['doc', '__proto__'], value: 1 }]);
  });
});

describe('diffs', () => {
  it('rebuilds a collection that is no list of records from its readable records', () => {
    const a = { nodes: [{ id: 'a' }, 'junk', { id: 'gone' }, { id: 'gone', again: true }] };
    const b = { nodes: [{ id: 'a' }, { id: 'n' }, { id: 'n', again: true }] };
    expect(diffDocuments(a, b)).toEqual([
      { op: 'del', path: ['nodes', 'gone'] }, { op: 'del', path: ['nodes', 'gone'] },
      { op: 'set', path: ['nodes', 'a'], value: { id: 'a' } }, { op: 'set', path: ['nodes', 'n'], value: { id: 'n' } },
    ]);
    expect(diffDocuments({ edges: [{ id: 'e' }] }, { edges: [{ id: 'e' }, 7] })).toEqual([{ op: 'set', path: ['edges', 'e'], value: { id: 'e' } }]);
    expect(diffDocuments({ edges: [{ id: 'e' }, 7] }, { version: 2 })).toEqual([{ op: 'del', path: ['edges', 'e'] }]);
    expect(diffDocuments({ version: 2 }, { edges: ['junk', { id: 'e' }] })).toEqual([{ op: 'set', path: ['edges', 'e'], value: { id: 'e' } }]);
    // A record listed twice keeps its first place; the later one is inert, so it makes no op.
    expect(diffDocuments({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'a', x: 1 }] }, { nodes: [{ id: 'a' }, { id: 'b' }] })).toEqual([]);
  });

  it("orders a record's keys as the API does", () => {
    const a = { nodes: [{ id: 'n', [LAST_BMP]: 1, [ASTRAL]: 1, b: 1, a: 1, B: 1 }] };
    const b = { nodes: [{ id: 'n', [LAST_BMP]: 2, [ASTRAL]: 2, b: 2, a: 2, B: 2 }] };
    // By UTF-8 bytes U+FFFF (EF BF BF) comes before U+1F600 (F0 9F 98 80); JavaScript's own sort puts it after.
    expect(diffDocuments(a, b).map(op => op.path[2])).toEqual(['B', 'a', 'b', LAST_BMP, ASTRAL]);
  });

  it('compares conversations and form fields by id only when both sides are lists of records', () => {
    const node = (threads: unknown) => ({ nodes: [{ id: 'n', threads }] });
    expect(diffDocuments(node([{ id: 't1' }]), node([{ id: 't1' }, 'junk'])))
      .toEqual([{ op: 'set', path: ['nodes', 'n', 'threads'], value: [{ id: 't1' }, 'junk'] }]);
    expect(diffDocuments(node([{ id: 't1' }, 'junk']), node([{ id: 't1' }]))).toEqual([{ op: 'set', path: ['nodes', 'n', 'threads'], value: [{ id: 't1' }] }]);
    expect(diffDocuments(node([{ id: 't1' }]), { nodes: [{ id: 'n' }] })).toEqual([{ op: 'del', path: ['nodes', 'n', 'threads'] }]);
    expect(diffDocuments(node([{ id: 'a', x: 1 }, { id: 'b' }]), node([{ id: 'b' }, { id: 'a', x: 2 }]))).toEqual([
      { op: 'set', path: ['nodes', 'n', 'threads', 'a', 'x'], value: 2 },
      { op: 'order', path: ['nodes', 'n', 'threads'], ids: ['b', 'a'] },
    ]);
    // A form field holds no records of its own, and a display's "threads" is a value.
    expect(diffDocuments({ nodes: [{ id: 'n', fields: [{ id: 'f', fields: [{ id: 'x' }] }] }] }, { nodes: [{ id: 'n', fields: [{ id: 'f', fields: [{ id: 'y' }] }] }] }))
      .toEqual([{ op: 'set', path: ['nodes', 'n', 'fields', 'f', 'fields'], value: [{ id: 'y' }] }]);
    expect(diffDocuments({ displays: [{ id: 'd', threads: [{ id: 'x' }] }] }, { displays: [{ id: 'd', threads: [{ id: 'y' }] }] }))
      .toEqual([{ op: 'set', path: ['displays', 'd', 'threads'], value: [{ id: 'y' }] }]);
  });

  it('gives saved views no order, and the version, the clock and the camera no op', () => {
    expect(diffDocuments({ waypoints: [{ slot: 1 }, { slot: 3 }] }, { waypoints: [{ slot: 1 }, { slot: 2 }, { slot: 3 }] }))
      .toEqual([{ op: 'set', path: ['waypoints', '2'], value: { slot: 2 } }]);
    expect(diffDocuments({ waypoints: [{ slot: 3 }, { slot: 1 }] }, { waypoints: [{ slot: 1 }, { slot: 3 }] })).toEqual([]);
    expect(diffDocuments({ version: 2, updatedAt: 1, view: null }, { version: 3, updatedAt: 2, view: { x: 1 } })).toEqual([]);
  });

  it('reads a key whose value is undefined as no key', () => {
    expect(diffDocuments({ a: undefined, nodes: [{ id: 'n', x: undefined }] }, { nodes: [{ id: 'n' }] })).toEqual([]);
    expect(diffDocuments({ nodes: [{ id: 'n' }] }, { a: undefined, nodes: [{ id: 'n', x: undefined }] })).toEqual([]);
    expect(diffDocuments({ a: 1 }, { a: undefined })).toEqual([{ op: 'del', path: ['doc', 'a'] }]);
  });

  it('gives a page the ops it has not sent', () => {
    const confirmed = { version: 2, nodes: [{ id: 'n', title: 'A' }] };
    const working = { version: 2, nodes: [{ id: 'n', title: 'B' }] };
    expect(pendingOps(confirmed, working)).toEqual(diffDocuments(confirmed, working));
    expect(pendingOps(confirmed, confirmed)).toEqual([]);
  });
});

describe('valueAt', () => {
  const doc = frozen({
    version: 2,
    nodes: [{ id: 'n', title: 'T', threads: [{ id: 't', draft: 'd' }], fields: 'broken' }],
    waypoints: [{ slot: 3, label: 'L' }],
    execution: { mode: 'review' },
  });

  it('reads each place a path names', () => {
    expect(valueAt(doc, ['doc', 'execution'])).toBe(doc.execution);
    expect(valueAt(doc, ['nodes'])).toBe(doc.nodes);
    expect(valueAt(doc, ['nodes', 'n'])).toBe(doc.nodes[0]);
    expect(valueAt(doc, ['nodes', 'n', 'title'])).toBe('T');
    expect(valueAt(doc, ['nodes', 'n', 'threads'])).toBe(doc.nodes[0].threads);
    expect(valueAt(doc, ['nodes', 'n', 'threads', 't'])).toBe(doc.nodes[0].threads[0]);
    expect(valueAt(doc, ['nodes', 'n', 'threads', 't', 'draft'])).toBe('d');
    expect(valueAt(doc, ['waypoints', '3'])).toBe(doc.waypoints[0]);
  });

  it('gives undefined for what is not there and for a path that names no place', () => {
    const absent = [
      ['nodes', 'x'], ['nodes', 'x', 'title'], ['nodes', 'n', 'nothing'], ['nodes', 'n', 'threads', 'x'], ['nodes', 'n', 'threads', 'x', 'draft'],
      ['nodes', 'n', 'fields', 'f'], ['nodes', 'x', 'threads', 't'], ['displays'], ['doc', 'nothing'], ['waypoints', '03'],
      ['doc', 'view'], ['nope'], ['nodes', 'n', 'id'],
    ];
    for (const path of absent) expect(valueAt(doc, path), path.join('/')).toBeUndefined();
  });
});

// ---- Random canvases ----

interface Random { int(n: number): number; chance(p: number): boolean; pick<T>(list: readonly T[]): T; shuffle<T>(list: readonly T[]): T[] }

/** A small seeded generator (mulberry32), so a failing case runs again the same. */
function seeded(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    int,
    chance: p => next() < p,
    pick: list => list[int(list.length)],
    shuffle: list => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

const TEXTS = ['', 'A', 'B', '后端接口', 'face \u{1F600}', 'two\nlines'];
const NODE_KEYS = ['kind', 'title', 'x', 'y', 'w', 'h', 'persona', 'lastOutput', 'preview', 'binding'];
const SUB_KEYS = { threads: ['draft', 'title', 'preview', 'lastOutput'], fields: ['label', 'value'] } as const;
const EDGE_KEYS = ['fromNode', 'fromPort', 'toNode', 'toPort', 'dataType'];
const DISPLAY_KEYS = ['nodeId', 'x', 'y', 'title'];
const WAYPOINT_KEYS = ['view', 'label'];
const DOC_KEYS = ['execution', 'title', 'notes'];
const SLOTS = [1, 2, 3, 4, 5, 6];
// A node's conversations or form fields that are no list of records: compared and replaced whole.
const NOT_RECORDS: readonly unknown[] = ['broken', [1, 'x'], [{ id: 't0' }, 'junk'], [{ draft: 'no id' }], [{ id: '' }], null, {}];

function randomValue(r: Random, depth = 0): unknown {
  switch (r.int(depth > 1 ? 5 : 7)) {
    case 0: return r.int(5);
    case 1: return r.pick([0.5, -1, 1000, 2.25]);
    case 2: return r.pick(TEXTS);
    case 3: return null;
    case 4: return r.chance(0.5);
    case 5: return Array.from({ length: r.int(3) }, () => randomValue(r, depth + 1));
    default: return randomObject(r, ['k', 'text', 'at', 'source'], depth + 1);
  }
}

/** An object with some of the keys, in a shuffled order (so two equal objects may list their keys differently). */
function randomObject(r: Random, keys: readonly string[], depth = 0, fixed: [string, unknown][] = []): Json {
  const entries = keys.filter(() => r.chance(0.6)).map((key): [string, unknown] => [key, randomValue(r, depth)]);
  return Object.fromEntries(r.shuffle([...fixed, ...entries]));
}

const withId = (r: Random, id: unknown, keys: readonly string[]): Json => randomObject(r, keys, 0, [['id', id]]);
const waypoint = (r: Random, slot: unknown): Json => randomObject(r, WAYPOINT_KEYS, 0, [['slot', slot]]);

function someIds(r: Random, prefix: string, n: number): string[] {
  return r.shuffle(Array.from({ length: n }, (_, i) => `${prefix}${i}`).filter(() => r.chance(0.6)));
}

function randomNode(r: Random, id: string): Json {
  const node = withId(r, id, NODE_KEYS);
  const shape = r.int(6);
  for (const name of NODE_COLLECTIONS) {
    if (shape === 3 || (shape === 0 && name === 'threads') || (shape === 1 && name === 'fields')) {
      node[name] = someIds(r, name[0], 4).map(sub => withId(r, sub, SUB_KEYS[name]));
    }
  }
  if (shape === 2) node[r.pick(NODE_COLLECTIONS)] = r.pick(NOT_RECORDS);
  return node;
}

function randomCanvas(r: Random): Json {
  const doc: Json = { version: 2, updatedAt: r.int(1000), view: r.chance(0.5) ? { x: r.int(9), y: r.int(9), scale: 1 } : null };
  if (r.chance(0.9)) doc.nodes = someIds(r, 'n', 8).map(id => randomNode(r, id));
  if (r.chance(0.8)) doc.edges = someIds(r, 'e', 6).map(id => withId(r, id, EDGE_KEYS));
  if (r.chance(0.5)) doc.displays = someIds(r, 'd', 4).map(id => withId(r, id, DISPLAY_KEYS));
  if (r.chance(0.5)) doc.waypoints = r.shuffle(SLOTS).slice(0, r.int(4)).map(slot => waypoint(r, slot));
  for (const key of DOC_KEYS) if (r.chance(0.3)) doc[key] = randomValue(r);
  return doc;
}

/** New ids for the records one writer makes, distinct from every other writer's and from the generated ones. */
function freshIds(tag: string): (prefix: string) => string {
  let count = 0;
  return prefix => `${prefix}_${tag}${count++}`;
}

const isRecordList = (value: unknown): value is Json[] => Array.isArray(value)
  && value.every(item => typeof item === 'object' && item !== null && !Array.isArray(item) && typeof (item as Json).id === 'string' && (item as Json).id !== '');

function editFields(r: Random, item: Json, keys: readonly string[]): Json {
  const out = { ...item };
  const key = r.pick(keys);
  if (r.chance(0.3)) delete out[key];
  else out[key] = randomValue(r);
  return out;
}

/** A list of records edited at random: some taken out, some changed, new ones put anywhere, sometimes reordered. Records
 *  left alone are the same objects, as a page's edits leave them. */
function editList(r: Random, list: readonly Json[], change: (item: Json) => Json, make: () => Json): Json[] {
  let out = list.filter(() => !r.chance(0.2)).map(item => (r.chance(0.3) ? change(item) : item));
  for (let n = r.int(3); n > 0; n--) out.splice(r.int(out.length + 1), 0, make());
  if (r.chance(0.25)) out = r.shuffle(out);
  return out;
}

/** `tidy`: the node's conversations and form fields stay lists of records, as a page keeps them. */
function editNode(r: Random, node: Json, fresh: (prefix: string) => string, tidy: boolean): Json {
  const out = r.chance(0.7) ? editFields(r, node, NODE_KEYS) : { ...node };
  for (const name of NODE_COLLECTIONS) {
    const current = out[name];
    if (!r.chance(0.4) || (tidy && current !== undefined && !isRecordList(current))) continue;
    if (!tidy && r.chance(0.15)) out[name] = r.pick(NOT_RECORDS);
    else if (!tidy && r.chance(0.1)) delete out[name];
    else out[name] = editList(r, isRecordList(current) ? current : [], item => editFields(r, item, SUB_KEYS[name]), () => withId(r, fresh(name[0]), SUB_KEYS[name]));
  }
  return out;
}

/** A canvas as one writer edits it: records of every kind changed, added, taken out and reordered, document keys too. */
function editCanvas(r: Random, doc: Json, fresh: (prefix: string) => string, tidy = false): Json {
  const out: Json = { ...doc, updatedAt: r.int(1000) };
  if (r.chance(0.3)) out.view = randomValue(r);
  const lists: [string, (item: Json) => Json, () => Json][] = [
    ['nodes', item => editNode(r, item, fresh, tidy), () => randomNode(r, fresh('n'))],
    ['edges', item => withId(r, item.id, EDGE_KEYS), () => withId(r, fresh('e'), EDGE_KEYS)],
    ['displays', item => editFields(r, item, DISPLAY_KEYS), () => withId(r, fresh('d'), DISPLAY_KEYS)],
  ];
  for (const [name, change, make] of lists) {
    if (!r.chance(0.6)) continue;
    const current = out[name];
    if (r.chance(0.05)) delete out[name];
    else out[name] = editList(r, Array.isArray(current) ? current as Json[] : [], change, make);
  }
  if (r.chance(0.4)) {
    const current = Array.isArray(out.waypoints) ? out.waypoints as Json[] : [];
    const used = new Set(current.map(item => item.slot));
    let next = current.filter(() => !r.chance(0.3)).map(item => (r.chance(0.3) ? waypoint(r, item.slot) : item));
    for (const slot of r.shuffle(SLOTS.filter(s => !used.has(s))).slice(0, r.int(3))) next.splice(r.int(next.length + 1), 0, waypoint(r, slot));
    if (r.chance(0.3)) next = r.shuffle(next);
    out.waypoints = next;
  }
  for (const key of DOC_KEYS) {
    if (!r.chance(0.2)) continue;
    if (r.chance(0.3)) delete out[key];
    else out[key] = randomValue(r);
  }
  return out;
}

/** A document as the canvas reads it: without the keys no change carries, an empty collection as none, and saved views
 *  by slot (they have no order of their own). */
function canonical(doc: object): Json {
  const out: Json = {};
  for (const [key, item] of Object.entries(doc)) {
    if (isExcludedKey(key) || item === undefined || (isCanvasCollection(key) && Array.isArray(item) && item.length === 0)) continue;
    out[key] = key === 'waypoints' && Array.isArray(item) ? [...item as Json[]].sort((x, y) => (x.slot as number) - (y.slot as number)) : item;
  }
  return out;
}

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean => prefix.length <= path.length && prefix.every((part, i) => part === path[i]);

/** True when the document holds what a path's value lives in: its record, and a conversation's or form field's list of
 *  records and the record itself. */
function holdsPlaceOf(doc: object, path: readonly string[]): boolean {
  if (path[0] === 'doc' || path.length <= 2) return true;
  if (valueAt(doc, path.slice(0, 2)) === undefined) return false;
  if (path.length === 3) return true;
  return isRecordList(valueAt(doc, path.slice(0, 3))) && (path.length === 4 || valueAt(doc, path.slice(0, 4)) !== undefined);
}

describe('random canvases', () => {
  it('a diff applied to its first document gives the second, sharing every record no op names', () => {
    const r = seeded(20261106);
    const fresh = freshIds('b');
    const seen = { changes: 0, orders: 0, inside: 0, whole: 0 };
    for (let i = 0; i < 300; i++) {
      const a = frozen(randomCanvas(r));
      const b = frozen(i % 3 === 0 ? randomCanvas(r) : editCanvas(r, a, fresh));
      const ops = diffDocuments(a, b);
      if (ops.length) seen.changes++;
      seen.orders += ops.filter(op => op.op === 'order').length;
      seen.inside += ops.filter(op => op.path.length >= 4).length;
      seen.whole += ops.filter(op => op.path.length === 3 && isNodeCollection(op.path[2])).length;
      const { doc } = applyOps(a, ops);
      expect(canonical(doc), `case ${i}`).toEqual(canonical(b));
      expect(diffDocuments(doc, b), `case ${i}`).toEqual([]);
      expect(applyOps(a, copy(ops)).doc, `case ${i}`).toEqual(doc);
      if (ops.length === 0) expect(doc).toBe(a);
      const named = new Set(ops.filter(op => op.path.length > 1).map(op => `${op.path[0]}/${op.path[1]}`));
      for (const name of CANVAS_COLLECTIONS) {
        const before = collectionOf(a, name) ?? [];
        for (const item of collectionOf(doc, name) ?? []) {
          const key = recordKey(item, recordKeyName(name)) as string;
          if (!named.has(`${name}/${key}`)) expect(item, `case ${i}: ${name}/${key}`).toBe(before[findRecord(before, recordKeyName(name), key)]);
        }
      }
    }
    // The cases reach every kind of op: orders, ops inside conversations and form fields, lists compared whole.
    expect(seen.changes).toBeGreaterThan(250);
    expect(seen.orders).toBeGreaterThan(100);
    expect(seen.inside).toBeGreaterThan(200);
    expect(seen.whole).toBeGreaterThan(50);
  });

  it("carries a page's own edits over another writer's change: its edits stay, the other's land, deleted records go", () => {
    const r = seeded(611);
    const theirs = freshIds('r'), mine = freshIds('l');
    const seen = { deleted: 0, landed: 0, kept: 0, conflicts: 0 };
    for (let i = 0; i < 300; i++) {
      const confirmed = frozen(randomCanvas(r));
      const ops = diffDocuments(confirmed, frozen(editCanvas(r, confirmed, theirs)));
      const after = frozen(applyOps(confirmed, ops).doc);
      // A page with no edits of its own becomes the server's document: records, values and order alike.
      const plain = rebaseWorking(confirmed, confirmed, after, ops);
      expect(canonical(plain), `case ${i}`).toEqual(canonical(after));
      expect(pendingOps(after, plain), `case ${i}`).toEqual([]);

      const working = frozen(editCanvas(r, confirmed, mine));
      const own = diffDocuments(confirmed, working);
      const rebased = rebaseWorking(working, confirmed, after, ops);
      if (ops.length === 0) expect(rebased).toBe(working);
      for (const op of ops) {
        if (op.op === 'order') continue;
        if (op.op === 'del' && isRecordPlace(parsePath(op.path))) {
          expect(valueAt(rebased, op.path), `case ${i}: ${op.path.join('/')} is deleted`).toBeUndefined();
          seen.deleted++;
        } else if (holdsPlaceOf(working, op.path) && sameValue(valueAt(working, op.path), valueAt(confirmed, op.path))) {
          expect(sameValue(valueAt(rebased, op.path), valueAt(after, op.path)), `case ${i}: ${op.path.join('/')} lands`).toBe(true);
          seen.landed++;
        }
      }
      for (const op of own) {
        if (op.op === 'order' || ops.some(other => other.op === 'del' && isRecordPlace(parsePath(other.path)) && startsWith(op.path, other.path))) continue;
        expect(sameValue(valueAt(rebased, op.path), valueAt(working, op.path)), `case ${i}: ${op.path.join('/')} stays`).toBe(true);
        seen.kept++;
        // Both writers changed this very path: the page's edit stays where the server now holds the other's.
        if (ops.some(other => sameValue(other.path, op.path)) && !sameValue(valueAt(after, op.path), valueAt(working, op.path))) seen.conflicts++;
      }
    }
    expect(seen.deleted).toBeGreaterThan(100);
    expect(seen.landed).toBeGreaterThan(300);
    expect(seen.kept).toBeGreaterThan(300);
    expect(seen.conflicts).toBeGreaterThan(20);
  });

  it("leaves a page nothing to send again once its change is answered, whatever the server refused", () => {
    const r = seeded(1106);
    const mine = freshIds('l');
    const seen = { refused: 0, orders: 0, back: 0 };
    for (let i = 0; i < 300; i++) {
      const confirmed = frozen(randomCanvas(r));
      const working = frozen(editCanvas(r, confirmed, mine));
      const sent = pendingOps(confirmed, working);
      // The server applies some of the ops and refuses the others (a fence, a claim, a field it keeps).
      const taken = i % 4 === 0 ? sent : sent.filter(() => r.chance(0.6));
      const refused = sent.filter(op => !taken.includes(op));
      seen.refused += refused.length;
      seen.orders += refused.filter(op => op.op === 'order').length;
      seen.back += refused.filter(op => op.op === 'del' && isRecordPlace(parsePath(op.path))).length;
      const answered = applyOps(confirmed, taken).doc;
      const after = frozen(applyOps(confirmed, diffDocuments(confirmed, answered)).doc);
      const acked = rebaseAfterAck(working, sent, after);
      expect(pendingOps(after, acked), `case ${i}`).toEqual([]);
      if (taken.length === sent.length) expect(acked, `case ${i}`).toBe(working);
    }
    expect(seen.refused).toBeGreaterThan(500);
    expect(seen.orders).toBeGreaterThan(30);
    expect(seen.back).toBeGreaterThan(50);
  });

  it('keeps every edit made after sending, once the change is answered', () => {
    const r = seeded(2026);
    const mine = freshIds('l'), later = freshIds('m');
    let overlapping = 0;
    for (let i = 0; i < 200; i++) {
      const confirmed = frozen(randomCanvas(r));
      const working = frozen(editCanvas(r, confirmed, mine));
      const sent = pendingOps(confirmed, working);
      const after = frozen(applyOps(confirmed, sent).doc);
      const newer = frozen(editCanvas(r, working, later));
      const since = pendingOps(working, newer);
      overlapping += since.filter(op => sent.some(other => startsWith(op.path, other.path) || startsWith(other.path, op.path))).length;
      const acked = rebaseAfterAck(newer, sent, after);
      expect(acked, `case ${i}`).toBe(newer);
      // So does the whole rebase of the move: an undo pressed while the change was out (the step before the edit) too.
      const rebase = rebaseOverMove(confirmed, after, sent);
      expect(rebase(newer), `case ${i}`).toBe(newer);
      expect(rebase(confirmed), `case ${i}`).toBe(confirmed);
    }
    // Many of the later edits are of the very paths the page had sent.
    expect(overlapping).toBeGreaterThan(100);
  });

  it("leaves the page's undo step as it was over the answer to its own change, whatever the server took of it", () => {
    const r = seeded(77);
    const mine = freshIds('l');
    const seen = { taken: 0, refused: 0, records: 0, deleted: 0, orders: 0 };
    for (let i = 0; i < 300; i++) {
      // The server's document the page knew when it sent: its undo step from before the edit too.
      const confirmed = frozen(randomCanvas(r));
      const working = frozen(editCanvas(r, confirmed, mine));
      const sent = pendingOps(confirmed, working);
      const taken = i % 4 === 0 ? sent : sent.filter(() => r.chance(0.6));
      seen.taken += taken.length;
      seen.refused += sent.length - taken.length;
      seen.records += taken.filter(op => op.op === 'set' && isRecordPlace(parsePath(op.path))).length;
      seen.deleted += taken.filter(op => op.op === 'del' && isRecordPlace(parsePath(op.path))).length;
      seen.orders += taken.filter(op => op.op === 'order').length;
      const answered = applyOps(confirmed, taken).doc;
      const after = frozen(applyOps(confirmed, diffDocuments(confirmed, answered)).doc);
      expect(othersOps(diffDocuments(confirmed, after), confirmed, after, sent), `case ${i}`).toEqual([]);
      const rebase = rebaseOverMove(confirmed, after, sent);
      expect(rebase(confirmed), `case ${i}`).toBe(confirmed);
      expect(pendingOps(after, rebase(working)), `case ${i}`).toEqual([]);
    }
    // The cases reach every kind of op the server takes or refuses: field edits, new records, deletions and orders.
    expect(seen.taken).toBeGreaterThan(1000);
    expect(seen.refused).toBeGreaterThan(400);
    expect(seen.records).toBeGreaterThan(450);
    expect(seen.deleted).toBeGreaterThan(200);
    expect(seen.orders).toBeGreaterThan(140);
  });

  it("brings another writer's change of the same move into the page's undo step wherever the page did not write", () => {
    const r = seeded(9001);
    const theirs = freshIds('r'), mine = freshIds('l');
    const seen = { landed: 0, deleted: 0, own: 0 };
    for (let i = 0; i < 300; i++) {
      const confirmed = frozen(randomCanvas(r));
      const working = frozen(editCanvas(r, confirmed, mine));
      const sent = pendingOps(confirmed, working);
      // Another writer's change (a page's) reached the server first and the page's went over it; one move answers both.
      const first = diffDocuments(confirmed, frozen(editCanvas(r, confirmed, theirs, true)));
      const answered = applyOps(applyOps(confirmed, first).doc, sent).doc;
      const after = frozen(applyOps(confirmed, diffDocuments(confirmed, answered)).doc);
      const rebase = rebaseOverMove(confirmed, after, sent);
      const undo = rebase(confirmed);
      for (const op of first) {
        if (op.op === 'order') continue;
        if (op.op === 'del' && isRecordPlace(parsePath(op.path))) {
          // Gone from the undo step too, unless the page wrote that very record (deleted it, or set a wire or view whole).
          if (sent.some(own => own.op !== 'order' && startsWith(op.path, own.path))) continue;
          expect(valueAt(undo, op.path), `case ${i}: ${op.path.join('/')} is deleted`).toBeUndefined();
          seen.deleted++;
        } else if (!sent.some(own => startsWith(op.path, own.path) || startsWith(own.path, op.path))) {
          expect(sameValue(valueAt(undo, op.path), valueAt(after, op.path)), `case ${i}: ${op.path.join('/')} lands`).toBe(true);
          seen.landed++;
        }
      }
      // The page's own edits, where the server holds them, stay out of it.
      for (const op of sent) {
        if (op.op !== 'set' || !sameValue(valueAt(after, op.path), op.value)) continue;
        expect(sameValue(valueAt(undo, op.path), valueAt(confirmed, op.path)), `case ${i}: ${op.path.join('/')} is the page's`).toBe(true);
        seen.own++;
      }
      // And the working document ends with every value of the server's (an order the other changed meanwhile aside).
      expect(pendingOps(after, rebase(working)).filter(op => op.op !== 'order'), `case ${i}`).toEqual([]);
    }
    expect(seen.landed).toBeGreaterThan(600);
    expect(seen.deleted).toBeGreaterThan(250);
    expect(seen.own).toBeGreaterThan(850);
  });

  it('agrees with the server on every value when another change came first', () => {
    const r = seeded(4242);
    const theirs = freshIds('r'), mine = freshIds('l');
    let both = 0;
    for (let i = 0; i < 200; i++) {
      const confirmed = frozen(randomCanvas(r));
      const working = frozen(editCanvas(r, confirmed, mine));
      const sent = pendingOps(confirmed, working);
      // Another writer's change (a page's, so its nodes' lists stay lists of records) reaches the server first; the
      // page's change is applied over it.
      const first = diffDocuments(confirmed, frozen(editCanvas(r, confirmed, theirs, true)));
      const afterFirst = frozen(applyOps(confirmed, first).doc);
      const answered = applyOps(afterFirst, sent).doc;
      const afterMine = frozen(applyOps(afterFirst, diffDocuments(afterFirst, answered)).doc);
      const acked = rebaseAfterAck(rebaseWorking(working, confirmed, afterFirst, first), sent, afterMine);
      // Every value agrees. Left to send, at most: an order the other writer changed meanwhile, and the delete of a
      // wire or saved view the other writer deleted while the page's whole new version of it was on its way (the server
      // took that as a new record; the page has the other's delete).
      const deleted = (op: CanvasOp) => op.op === 'del' && first.some(other => other.op === 'del' && sameValue(other.path, op.path));
      expect(pendingOps(afterMine, acked).filter(op => op.op !== 'order' && !deleted(op)), `case ${i}`).toEqual([]);
      both += sent.filter(op => first.some(other => sameValue(other.path, op.path))).length;
    }
    // Often both writers changed the very same path.
    expect(both).toBeGreaterThan(50);
  });
});

// ---- A page's own edits over others' changes ----

/** Another participant's change from the server's document `before` to `target`: its effective ops and the server's
 *  document after it, as the page works it out. */
function remote(before: Json, target: Json) {
  const ops = diffDocuments(before, target);
  return { ops, after: frozen(applyOps(before, ops).doc) };
}

const base = frozen({
  version: 2,
  updatedAt: 1,
  nodes: [
    { id: 'a', kind: 'session', title: 'A', x: 0, y: 0, preview: 'p', threads: [{ id: 't1', draft: '' }, { id: 't2', draft: '' }] },
    { id: 'b', kind: 'form', title: 'B', x: 100, y: 0, fields: [{ id: 'f1', label: 'L', value: '' }] },
    { id: 'c', kind: 'session', title: 'C', x: 200, y: 0 },
  ],
  edges: [{ id: 'e1', fromNode: 'a', fromPort: 'result', toNode: 'b', toPort: 'context', dataType: 'text' }],
  waypoints: [],
  view: null,
}) as Json;

describe("a page's own edits over others' changes", () => {
  it('keeps both edits of different fields of one node', () => {
    const working = changed(base, d => { nodeIn(d, 'a')!.title = 'Mine'; });
    const theirs = remote(base, changed(base, d => { nodeIn(d, 'a')!.x = 50; }));
    const rebased = rebaseWorking(working, base, theirs.after, theirs.ops);
    expect(nodeIn(rebased, 'a')).toMatchObject({ title: 'Mine', x: 50 });
    expect(nodeIn(rebased, 'b')).toBe(nodeIn(working, 'b'));
    expect(pendingOps(theirs.after, rebased)).toEqual([{ op: 'set', path: ['nodes', 'a', 'title'], value: 'Mine' }]);
  });

  it("keeps the page's unsent edit of a field another writer changed, which the server holds meanwhile", () => {
    const working = changed(base, d => { nodeIn(d, 'a')!.title = 'Mine'; });
    const theirs = remote(base, changed(base, d => { nodeIn(d, 'a')!.title = 'Theirs'; }));
    expect(nodeIn(theirs.after, 'a')!.title).toBe('Theirs');
    const rebased = rebaseWorking(working, base, theirs.after, theirs.ops);
    expect(rebased).toBe(working);
    expect(pendingOps(theirs.after, rebased)).toEqual([{ op: 'set', path: ['nodes', 'a', 'title'], value: 'Mine' }]);
  });

  it('takes away a node another writer deleted, though the page edited it', () => {
    const working = changed(base, d => { nodeIn(d, 'c')!.title = 'Mine'; nodeIn(d, 'a')!.title = 'Kept'; });
    const theirs = remote(base, changed(base, d => { d.nodes = nodesOf(d).filter(node => node.id !== 'c'); }));
    const rebased = rebaseWorking(working, base, theirs.after, theirs.ops);
    expect(idsOf(rebased.nodes)).toEqual(['a', 'b']);
    expect(pendingOps(theirs.after, rebased)).toEqual([{ op: 'set', path: ['nodes', 'a', 'title'], value: 'Kept' }]);
  });

  it("brings in another writer's new node where the server has it, ahead of the page's own new node", () => {
    const working = changed(base, d => { nodesOf(d).push({ id: 'mine', kind: 'form', title: 'M' }); });
    const theirs = remote(base, changed(base, d => { nodesOf(d).push({ id: 'theirs', kind: 'session', title: 'T' }); }));
    const rebased = rebaseWorking(working, base, theirs.after, theirs.ops);
    expect(idsOf(rebased.nodes)).toEqual(['a', 'b', 'c', 'theirs', 'mine']);
    expect(pendingOps(theirs.after, rebased)).toEqual([{ op: 'set', path: ['nodes', 'mine'], value: { id: 'mine', kind: 'form', title: 'M' } }]);
    // One put in the middle goes there too, and one put first goes first.
    const middle = remote(base, changed(base, d => { nodesOf(d).splice(1, 0, { id: 'mid' }); nodesOf(d).unshift({ id: 'top' }); }));
    expect(idsOf(rebaseWorking(working, base, middle.after, middle.ops).nodes)).toEqual(['top', 'a', 'mid', 'b', 'c', 'mine']);
  });

  it('keeps a node the page deleted, unsent, deleted though another writer edited it', () => {
    const working = changed(base, d => { d.nodes = nodesOf(d).filter(node => node.id !== 'b'); d.edges = []; });
    const theirs = remote(base, changed(base, d => {
      nodeIn(d, 'b')!.title = 'Renamed';
      (nodeIn(d, 'b')!.fields as Json[]).push({ id: 'f2', label: 'New', value: '' });
    }));
    const rebased = rebaseWorking(working, base, theirs.after, theirs.ops);
    expect(rebased).toBe(working);
    expect(pendingOps(theirs.after, rebased)).toEqual([{ op: 'del', path: ['nodes', 'b'] }, { op: 'del', path: ['edges', 'e1'] }]);
  });

  it("applies another writer's order, keeping the page's own new records after it", () => {
    const working = changed(base, d => { nodesOf(d).push({ id: 'mine' }); d.nodes = nodesOf(d).filter(node => node.id !== 'a'); });
    const theirs = remote(base, changed(base, d => { d.nodes = [nodeIn(d, 'c'), nodeIn(d, 'a'), nodeIn(d, 'b')]; }));
    expect(theirs.ops).toEqual([{ op: 'order', path: ['nodes'], ids: ['c', 'a', 'b'] }]);
    const rebased = rebaseWorking(working, base, theirs.after, theirs.ops);
    expect(idsOf(rebased.nodes)).toEqual(['c', 'b', 'mine']);
    const threads = remote(base, changed(base, d => { nodeIn(d, 'a')!.threads = [...(nodeIn(d, 'a')!.threads as Json[])].reverse(); }));
    expect(idsOf(nodeIn(rebaseWorking(base, base, threads.after, threads.ops), 'a')!.threads)).toEqual(['t2', 't1']);
    // An order of a node the page does not hold, or of a list it holds none of, does nothing.
    expect(rebaseWorking(working, base, threads.after, threads.ops)).toBe(working);
    const bare = frozen({ version: 2 });
    expect(rebaseWorking(bare, base, theirs.after, theirs.ops)).toBe(bare);
  });

  it("keeps a list the page put in an order of its own, unsent, over another writer's order, to go with its next save", () => {
    const working = changed(base, d => { d.nodes = [nodeIn(d, 'b'), nodeIn(d, 'a'), nodeIn(d, 'c')]; });
    const theirs = remote(base, changed(base, d => { d.nodes = [nodeIn(d, 'c'), nodeIn(d, 'a'), nodeIn(d, 'b')]; }));
    const rebased = rebaseWorking(working, base, theirs.after, theirs.ops);
    expect(rebased).toBe(working);
    expect(pendingOps(theirs.after, rebased)).toEqual([{ op: 'order', path: ['nodes'], ids: ['b', 'a', 'c'] }]);
    // An undo step in the server's order takes the other's.
    expect(idsOf(rebaseWorking(base, base, theirs.after, theirs.ops).nodes)).toEqual(['c', 'a', 'b']);
    // A node's conversations alike, where the other's new one still comes in.
    const reversed = changed(base, d => { nodeIn(d, 'a')!.threads = [...(nodeIn(d, 'a')!.threads as Json[])].reverse(); });
    const newFirst = remote(base, changed(base, d => { nodeIn(d, 'a')!.threads = [{ id: 't3' }, ...(nodeIn(d, 'a')!.threads as Json[])]; }));
    expect(newFirst.ops).toEqual([
      { op: 'set', path: ['nodes', 'a', 'threads', 't3'], value: { id: 't3' } },
      { op: 'order', path: ['nodes', 'a', 'threads'], ids: ['t3', 't1', 't2'] },
    ]);
    const kept = rebaseWorking(reversed, base, newFirst.after, newFirst.ops);
    expect(idsOf(nodeIn(kept, 'a')!.threads)).toEqual(['t3', 't2', 't1']);
    expect(pendingOps(newFirst.after, kept)).toEqual([{ op: 'order', path: ['nodes', 'a', 'threads'], ids: ['t3', 't2', 't1'] }]);
    // Records the page added or deleted are no order of its own: the other's order lands, its new records after it.
    const grown = changed(base, d => { nodesOf(d).splice(1, 0, { id: 'mine' }); d.nodes = nodesOf(d).filter(node => node.id !== 'c'); });
    expect(idsOf(rebaseWorking(grown, base, theirs.after, theirs.ops).nodes)).toEqual(['a', 'b', 'mine']);
  });

  it("takes others' edits inside conversations and form fields, and brings their new ones in where the server has them", () => {
    const working = changed(base, d => { (nodeIn(d, 'a')!.threads as Json[])[0].draft = 'mine'; });
    const theirs = remote(base, changed(base, d => {
      (nodeIn(d, 'a')!.threads as Json[])[1].draft = 'theirs';
      (nodeIn(d, 'a')!.threads as Json[]).splice(1, 0, { id: 't3', draft: 'new' });
      (nodeIn(d, 'b')!.fields as Json[])[0].value = '42';
    }));
    const rebased = rebaseWorking(working, base, theirs.after, theirs.ops);
    expect(nodeIn(rebased, 'a')!.threads).toEqual([{ id: 't1', draft: 'mine' }, { id: 't3', draft: 'new' }, { id: 't2', draft: 'theirs' }]);
    expect(nodeIn(rebased, 'b')!.fields).toEqual([{ id: 'f1', label: 'L', value: '42' }]);
    expect(pendingOps(theirs.after, rebased)).toEqual([{ op: 'set', path: ['nodes', 'a', 'threads', 't1', 'draft'], value: 'mine' }]);
  });

  it('takes away a conversation another writer deleted, and leaves a list the page replaced whole', () => {
    const edited = changed(base, d => { (nodeIn(d, 'a')!.threads as Json[])[1].draft = 'typing'; });
    const theirs = remote(base, changed(base, d => {
      nodeIn(d, 'a')!.threads = [(nodeIn(d, 'a')!.threads as Json[])[0], { id: 't9' }];
      (nodeIn(d, 'a')!.threads as Json[])[0].draft = 'theirs';
    }));
    expect(nodeIn(rebaseWorking(edited, base, theirs.after, theirs.ops), 'a')!.threads).toEqual([{ id: 't1', draft: 'theirs' }, { id: 't9' }]);
    // A page that replaced the list whole (here, with something that is no list of records) keeps it.
    const replaced = changed(base, d => { nodeIn(d, 'a')!.threads = 'mine'; });
    expect(rebaseWorking(replaced, base, theirs.after, theirs.ops)).toBe(replaced);
    const dropped = changed(base, d => { delete nodeIn(d, 'a')!.threads; });
    expect(rebaseWorking(dropped, base, theirs.after, theirs.ops)).toBe(dropped);
    const mixed = changed(base, d => { nodeIn(d, 'a')!.threads = [{ id: 't1', draft: 'mine' }, 'not a conversation']; });
    expect(rebaseWorking(mixed, base, theirs.after, theirs.ops)).toBe(mixed);
    // A field another writer gives a conversation the page deleted does nothing.
    const without = changed(base, d => { nodeIn(d, 'a')!.threads = [(nodeIn(d, 'a')!.threads as Json[])[0]]; });
    const titled = remote(base, changed(base, d => { (nodeIn(d, 'a')!.threads as Json[])[1].title = 'new'; }));
    expect(titled.ops).toEqual([{ op: 'set', path: ['nodes', 'a', 'threads', 't2', 'title'], value: 'new' }]);
    expect(rebaseWorking(without, base, titled.after, titled.ops)).toBe(without);
  });

  it('takes the removal of a field only where the page left it alone', () => {
    const theirs = remote(base, changed(base, d => { delete nodeIn(d, 'a')!.preview; d.execution = { mode: 'review', maxRounds: 2 }; }));
    const untouched = rebaseWorking(base, base, theirs.after, theirs.ops);
    expect(nodeIn(untouched, 'a')).not.toHaveProperty('preview');
    expect(untouched.execution).toEqual({ mode: 'review', maxRounds: 2 });
    const edited = changed(base, d => { nodeIn(d, 'a')!.preview = 'mine'; });
    expect(nodeIn(rebaseWorking(edited, base, theirs.after, theirs.ops), 'a')!.preview).toBe('mine');
  });

  it("replaces a wire whole where the page left it, and keeps the page's own version of it", () => {
    const theirs = remote(base, changed(base, d => { (d.edges as Json[])[0].toPort = 'reference'; }));
    expect(theirs.ops).toEqual([{ op: 'set', path: ['edges', 'e1'], value: { ...(base.edges as Json[])[0], toPort: 'reference' } }]);
    expect((rebaseWorking(base, base, theirs.after, theirs.ops).edges as Json[])[0].toPort).toBe('reference');
    const mine = changed(base, d => { (d.edges as Json[])[0].dataType = 'json'; });
    expect(rebaseWorking(mine, base, theirs.after, theirs.ops)).toBe(mine);
  });

  it('carries an undo step over the same way, so undoing never takes back the other writer', () => {
    const past = base; // the page's step before its own edit
    const present = changed(base, d => { nodeIn(d, 'a')!.title = 'Mine'; });
    const theirs = remote(base, changed(base, d => { nodeIn(d, 'b')!.title = 'Theirs'; }));
    const undone = rebaseWorking(past, base, theirs.after, theirs.ops);
    expect(nodeIn(undone, 'b')!.title).toBe('Theirs');
    expect(nodeIn(undone, 'a')!.title).toBe('A');
    expect(nodeIn(rebaseWorking(present, base, theirs.after, theirs.ops), 'b')!.title).toBe('Theirs');
  });

  it("takes the server's value, not the op's, so what the page normalized carries over", () => {
    const ops: CanvasOp[] = [{ op: 'set', path: ['nodes', 'c', 'w'], value: -5 }];
    const after = changed(base, d => { nodeIn(d, 'c')!.w = 40; }); // the page's reading of the server's document
    expect(nodeIn(rebaseWorking(base, base, after, ops), 'c')!.w).toBe(40);
    // Where the page's reading holds no such record (it dropped one it could not read), the field is left alone.
    const dropped = changed(base, d => { d.nodes = nodesOf(d).filter(node => node.id !== 'c'); });
    expect(rebaseWorking(base, base, dropped, [{ op: 'set', path: ['nodes', 'c', 'title'], value: 'X' }])).toBe(base);
  });

  it('passes over an op that names no place, and one it cannot take', () => {
    const ops = [
      { op: 'set', path: ['doc', 'view'], value: 1 }, { op: 'move', path: ['nodes', 'a'] }, { op: 'set', path: ['nodes'], value: [] },
      { op: 'set', path: ['nodes', 'a', 'threads', 't9', 'draft'], value: 'x' }, { op: 'order', path: ['nodes'], ids: 'a' },
      { op: 'order', path: ['doc', 'execution'], ids: [] }, { op: 'order', path: ['nodes', 'c', 'threads'], ids: ['t1'] },
      { op: 'order', path: ['nodes'], ids: [7, 'c'] },
    ] as unknown as CanvasOp[];
    const rebased = rebaseWorking(base, base, base, ops);
    expect(idsOf(rebased.nodes)).toEqual(['c', 'a', 'b']);
    expect(rebaseWorking(base, base, base, ops.slice(0, 7))).toBe(base);
  });

  it('puts a record that comes in after the records the page holds, passing over what is no record', () => {
    const before = frozen({ nodes: [{ id: 'a' }, 'junk'] });
    const after = frozen({ nodes: [{ id: 'a' }, 'junk', { id: 'theirs' }] });
    const working = frozen({ nodes: [{ id: 'a' }, { id: 'mine' }] });
    const rebased = rebaseWorking(working, before, after, [{ op: 'set', path: ['nodes', 'theirs'], value: { id: 'theirs' } }]);
    expect(idsOf(rebased.nodes)).toEqual(['a', 'theirs', 'mine']);
  });

  it("takes away a conversation someone deleted even where the server's document no longer holds its node", () => {
    const rebased = rebaseWorking(base, base, { version: 2, nodes: [] }, [{ op: 'del', path: ['nodes', 'a', 'threads', 't1'] }]);
    expect(idsOf(nodeIn(rebased, 'a')!.threads)).toEqual(['t2']);
  });
});

describe("a page's own change, once answered", () => {
  it('takes the value the server keeps in place of the one sent', () => {
    const working = changed(base, d => { nodeIn(d, 'a')!.skills = ['mine']; });
    const sent = pendingOps(base, working);
    const after = changed(base, d => { nodeIn(d, 'a')!.skills = ['kept', 'by', 'the server']; });
    const acked = rebaseAfterAck(working, sent, after);
    expect(nodeIn(acked, 'a')!.skills).toEqual(['kept', 'by', 'the server']);
    expect(pendingOps(after, acked)).toEqual([]);
  });

  it('keeps an edit made after sending', () => {
    const working = changed(base, d => { nodeIn(d, 'a')!.title = 'AB'; });
    const sent = pendingOps(base, working);
    const typed = changed(working, d => { nodeIn(d, 'a')!.title = 'ABC'; });
    const after = applyOps(base, sent).doc;
    const acked = rebaseAfterAck(typed, sent, after);
    expect(acked).toBe(typed);
    expect(pendingOps(after, acked)).toEqual([{ op: 'set', path: ['nodes', 'a', 'title'], value: 'ABC' }]);
  });

  it('undoes what the server refused: a field, a new node, a deletion, a new conversation', () => {
    const working = changed(base, d => {
      nodeIn(d, 'a')!.persona = 'p2';
      nodesOf(d).push({ id: 'new', kind: 'session' });
      d.nodes = nodesOf(d).filter(node => node.id !== 'b');
      (nodeIn(d, 'c') as Json).threads = [];
      (nodeIn(d, 'a')!.threads as Json[]).push({ id: 't3' });
    });
    const sent = pendingOps(base, working);
    const acked = rebaseAfterAck(working, sent, base);
    expect(pendingOps(base, acked)).toEqual([]);
    expect(idsOf(acked.nodes)).toEqual(['a', 'b', 'c']);
    expect(nodeIn(acked, 'b')).toBe(nodeIn(base, 'b'));
  });

  it("takes the server's order while the page has not moved what it sent", () => {
    const working = changed(base, d => { d.nodes = [nodeIn(d, 'c'), nodeIn(d, 'b'), nodeIn(d, 'a')]; });
    const sent = pendingOps(base, working);
    expect(sent).toEqual([{ op: 'order', path: ['nodes'], ids: ['c', 'b', 'a'] }]);
    // Another writer's node came in meanwhile; the server put the page's order first.
    const after = changed(base, d => { d.nodes = [nodeIn(d, 'c'), nodeIn(d, 'b'), nodeIn(d, 'a'), { id: 'x' }]; });
    const withTheirs = changed(working, d => { nodesOf(d).splice(1, 0, { id: 'x' }); });
    expect(idsOf(rebaseAfterAck(withTheirs, sent, after).nodes)).toEqual(['c', 'b', 'a', 'x']);
    // Refused: the server's order comes back.
    expect(idsOf(rebaseAfterAck(working, sent, base).nodes)).toEqual(['a', 'b', 'c']);
    // Moved again since, or with a new node of the page's own: the page's order stays.
    const moved = changed(working, d => { d.nodes = [nodeIn(d, 'b'), nodeIn(d, 'c'), nodeIn(d, 'a')]; });
    expect(rebaseAfterAck(moved, sent, base)).toBe(moved);
    const grown = changed(working, d => { nodesOf(d).splice(1, 0, { id: 'mine' }); });
    expect(rebaseAfterAck(grown, sent, base)).toBe(grown);
    // A server without the list leaves the page's as it is.
    expect(rebaseAfterAck(working, sent, { version: 2 })).toBe(working);
  });

  it('puts a node the server would not delete back where it was, with its order', () => {
    const working = changed(base, d => { d.nodes = [nodeIn(d, 'c'), nodeIn(d, 'b')]; });
    const sent = pendingOps(base, working);
    expect(sent).toEqual([{ op: 'del', path: ['nodes', 'a'] }, { op: 'order', path: ['nodes'], ids: ['c', 'b'] }]);
    const acked = rebaseAfterAck(working, sent, base);
    expect(idsOf(acked.nodes)).toEqual(['a', 'b', 'c']);
    expect(pendingOps(base, acked)).toEqual([]);
  });

  it('leaves a field whose record the server no longer has, and passes over what names no place', () => {
    const working = changed(base, d => { nodeIn(d, 'c')!.title = 'Mine'; });
    const sent = pendingOps(base, working);
    const gone = changed(base, d => { d.nodes = nodesOf(d).filter(node => node.id !== 'c'); });
    expect(rebaseAfterAck(working, sent, gone)).toBe(working);
    const odd = [{ op: 'set', path: ['doc', 'view'], value: 1 }, { op: 'move', path: ['nodes', 'a'] }, { op: 'set', path: ['nodes', 'a', 'title'] }] as unknown as CanvasOp[];
    expect(rebaseAfterAck(working, odd, base)).toBe(working);
  });
});

// ---- A move that answers the page's own change ----

/** The answer to the page's change of `working`, sent from `confirmed`: the ops sent, and the server's document after
 *  it (`answered`: the sent ops applied, unless given) as the page reads it, through its effective ops. */
function saved(confirmed: Json, working: Json, answered?: object) {
  const sent = pendingOps(confirmed, working);
  const server = answered ?? applyOps(confirmed, sent).doc;
  return { sent, after: frozen(applyOps(confirmed, diffDocuments(confirmed, server)).doc) };
}

// The page's documents here: `base` is the server's document it knew when it sent, and its undo step from before the
// edit; the working document holds the edit (and is the redo step once the edit is undone).
describe("a move that answers the page's own change", () => {
  it('leaves the undo step of a saved field edit as it was, so an undo still takes the edit back', () => {
    const working = changed(base, d => { nodeIn(d, 'a')!.title = 'Mine'; });
    const { sent, after } = saved(base, working);
    const rebase = rebaseOverMove(base, after, sent);
    expect(rebase(base)).toBe(base);
    expect(rebase(working)).toBe(working);
    expect(pendingOps(after, rebase(base))).toEqual([{ op: 'set', path: ['nodes', 'a', 'title'], value: 'A' }]);
    // Carried as another writer's, the page's own edit would land in its undo step.
    expect(nodeIn(rebaseWorking(base, base, after, diffDocuments(base, after)), 'a')!.title).toBe('Mine');
  });

  it('keeps a node the page made and saved out of its undo step, whatever the server made of it', () => {
    const made = { id: 'new', kind: 'session', title: 'N', x: 10, skills: ['mine'] };
    const working = changed(base, d => { nodesOf(d).push(made); });
    const { sent, after } = saved(base, working);
    expect(sent).toEqual([{ op: 'set', path: ['nodes', 'new'], value: made }]);
    const rebase = rebaseOverMove(base, after, sent);
    expect(rebase(base)).toBe(base);
    expect(rebase(working)).toBe(working);
    expect(pendingOps(after, rebase(base))).toEqual([{ op: 'del', path: ['nodes', 'new'] }]);
    // The server kept the skills out: the working document takes its node, the undo step still has none.
    const kept = saved(base, working, changed(working, d => { delete nodeIn(d, 'new')!.skills; }));
    const over = rebaseOverMove(base, kept.after, kept.sent);
    expect(over(base)).toBe(base);
    expect(nodeIn(over(working), 'new')).toEqual({ id: 'new', kind: 'session', title: 'N', x: 10 });
    expect(pendingOps(kept.after, over(working))).toEqual([]);
    // Carried as another writer's, the page's own node would come into its undo step.
    expect(nodeIn(rebaseWorking(base, base, kept.after, diffDocuments(base, kept.after)), 'new')).toBeDefined();
  });

  it('keeps a node the page deleted and saved, and its wire, in its undo steps, so an undo brings them back', () => {
    const working = changed(base, d => { d.nodes = nodesOf(d).filter(node => node.id !== 'b'); d.edges = []; });
    const { sent, after } = saved(base, working);
    expect(sent).toEqual([{ op: 'del', path: ['nodes', 'b'] }, { op: 'del', path: ['edges', 'e1'] }]);
    const rebase = rebaseOverMove(base, after, sent);
    expect(rebase(base)).toBe(base);
    expect(rebase(working)).toBe(working);
    // Undone, both go back with the next save, where they were.
    const restored = applyOps(after, pendingOps(after, rebase(base))).doc;
    expect(diffDocuments(restored, base)).toEqual([]);
    expect(idsOf(restored.nodes)).toEqual(['a', 'b', 'c']);
    // Carried as another writer's, the page's own deletion would take b from every step.
    expect(nodeIn(rebaseWorking(base, base, after, diffDocuments(base, after)), 'b')).toBeUndefined();
  });

  it('keeps an undo pressed while the save was out, and sends it next', () => {
    const edited = changed(base, d => { nodeIn(d, 'c')!.x = 250; });
    const { sent, after } = saved(base, edited);
    const undone = base; // the working document once the undo went back to the step before the edit
    const rebase = rebaseOverMove(base, after, sent);
    expect(rebase(undone)).toBe(undone);
    expect(pendingOps(after, rebase(undone))).toEqual([{ op: 'set', path: ['nodes', 'c', 'x'], value: 200 }]);
    // The redo step, which holds the edit, is the server's document there.
    expect(rebase(edited)).toBe(edited);
    expect(pendingOps(after, rebase(edited))).toEqual([]);
  });

  it("brings others' edits and deletions of the same move into every step", () => {
    const working = changed(base, d => { nodeIn(d, 'a')!.title = 'Mine'; });
    const sent = pendingOps(base, working);
    // Another writer's change reached the server first; the page's went over it.
    const theirs = remote(base, changed(base, d => { nodeIn(d, 'b')!.title = 'Theirs'; d.nodes = nodesOf(d).filter(node => node.id !== 'c'); }));
    const after = frozen(applyOps(theirs.after, sent).doc);
    const rebase = rebaseOverMove(base, after, sent);
    expect(nodesOf(rebase(base)).map(node => [node.id, node.title])).toEqual([['a', 'A'], ['b', 'Theirs']]);
    expect(pendingOps(after, rebase(working))).toEqual([]);
  });

  it("brings another writer's later edit of a path the page sent into its undo steps; the page's last edit stays its own", () => {
    const working = changed(base, d => { nodeIn(d, 'a')!.title = 'Mine'; });
    const sent = pendingOps(base, working);
    const later = changed(applyOps(base, sent).doc, d => { nodeIn(d, 'a')!.title = 'Theirs, later'; });
    const rebase = rebaseOverMove(base, later, sent);
    expect(nodeIn(rebase(base), 'a')!.title).toBe('Theirs, later');
    expect(nodeIn(rebase(working), 'a')!.title).toBe('Theirs, later');
    // The other wrote first and the page's edit went over it: the server holds the page's, the undo step what it held.
    const first = remote(base, changed(base, d => { nodeIn(d, 'a')!.title = 'Theirs, first'; }));
    expect(rebaseOverMove(base, frozen(applyOps(first.after, sent).doc), sent)(base)).toBe(base);
  });

  it('gives the working document back what the server refused, and leaves the undo step', () => {
    const working = changed(base, d => {
      nodeIn(d, 'a')!.title = 'Mine';
      nodesOf(d).push({ id: 'new' });
      d.nodes = nodesOf(d).filter(node => node.id !== 'c');
    });
    const sent = pendingOps(base, working);
    const rebase = rebaseOverMove(base, base, sent); // the server took none of it
    expect(rebase(base)).toBe(base);
    expect(pendingOps(base, rebase(working))).toEqual([]);
    // A refused edit another writer's overtook: the other's, in every step.
    const theirs = remote(base, changed(base, d => { nodeIn(d, 'a')!.title = 'Theirs'; }));
    const over = rebaseOverMove(base, theirs.after, sent);
    expect(nodeIn(over(base), 'a')!.title).toBe('Theirs');
    expect(nodeIn(over(working), 'a')!.title).toBe('Theirs');
  });

  it("keeps a page's saved order out of its undo steps, and brings another writer's later order into them", () => {
    const working = changed(base, d => { d.nodes = [nodeIn(d, 'c'), nodeIn(d, 'b'), nodeIn(d, 'a')]; });
    const { sent, after } = saved(base, working);
    expect(sent).toEqual([{ op: 'order', path: ['nodes'], ids: ['c', 'b', 'a'] }]);
    const rebase = rebaseOverMove(base, after, sent);
    expect(rebase(base)).toBe(base);
    expect(rebase(working)).toBe(working);
    const later = changed(after, d => { d.nodes = [nodeIn(d, 'b'), nodeIn(d, 'a'), nodeIn(d, 'c')]; });
    const over = rebaseOverMove(base, later, sent);
    expect(idsOf(over(base).nodes)).toEqual(['b', 'a', 'c']);
    expect(idsOf(over(working).nodes)).toEqual(['b', 'a', 'c']);
    expect(pendingOps(later, over(working))).toEqual([]);
  });

  it('is the identity for a move that changes nothing, and the rebase over others for one with no change of the page', () => {
    const working = changed(base, d => { nodeIn(d, 'a')!.title = 'Mine'; });
    const still = rebaseOverMove(base, base);
    expect(still(base)).toBe(base);
    expect(still(working)).toBe(working);
    const theirs = remote(base, changed(base, d => { nodeIn(d, 'b')!.title = 'Theirs'; }));
    expect(rebaseOverMove(base, theirs.after)(working)).toEqual(rebaseWorking(working, base, theirs.after, theirs.ops));
    expect(othersOps(theirs.ops, base, theirs.after)).toEqual(theirs.ops);
  });

  it("names the ops of a move that the page's own change accounts for", () => {
    const before = frozen({
      nodes: [{ id: 'a', threads: [{ id: 't1' }] }, { id: 'b', persona: 'p', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }],
      edges: [{ id: 'e1' }, { id: 'e2' }],
      waypoints: [{ slot: 3, label: 'old' }],
    });
    const sent: CanvasOp[] = [
      { op: 'set', path: ['nodes', 'a', 'threads'], value: [{ id: 't9' }] }, // a list set whole: the ops inside it are its own
      { op: 'del', path: ['nodes', 'b', 'persona'] }, // deleted, as the server holds it
      { op: 'set', path: ['nodes', 'c', 'title'], value: 'Mine' }, // another writer's edit came after it
      { op: 'del', path: ['nodes', 'b', 'title'] }, // set again by another writer
      { op: 'set', path: ['nodes', 'd', 'title'], value: 'Mine' }, // its node deleted by another writer
      { op: 'order', path: ['edges'], ids: ['e2', 'e1'] },
      { op: 'set', path: ['waypoints', '3'], value: { slot: 3, label: 'mine' } }, // a slot anyone may set: its value decides
    ];
    const after = frozen({
      nodes: [{ id: 'a', threads: [{ id: 't9' }] }, { id: 'b', title: 'B, theirs' }, { id: 'c', title: 'Theirs' }],
      edges: [{ id: 'e2' }, { id: 'e1' }],
      waypoints: [{ slot: 3, label: 'theirs' }],
    });
    const moved = diffDocuments(before, after);
    expect(othersOps(moved, before, after, sent)).toEqual([
      { op: 'del', path: ['nodes', 'd'] },
      { op: 'set', path: ['nodes', 'b', 'title'], value: 'B, theirs' },
      { op: 'set', path: ['nodes', 'c', 'title'], value: 'Theirs' },
      { op: 'set', path: ['waypoints', '3'], value: { slot: 3, label: 'theirs' } },
    ]);
    // An op that names no place, or holds no value, accounts for nothing.
    const odd = [{ op: 'set', path: ['doc', 'view'], value: 1 }, { op: 'set', path: ['nodes', 'b', 'persona'] }, { op: 'move', path: ['nodes', 'a'] }] as unknown as CanvasOp[];
    expect(othersOps(moved, before, after, odd)).toEqual(moved);
  });
});
