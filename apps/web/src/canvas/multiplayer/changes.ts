// 多人同屏 / Multiplayer: the canvas change engine of the page (docs/awwo-canvas-live-collaboration.md, "The document
// change model" and "Concurrency"). A canvas document is changed by ops on paths, applied in the server's order. This
// file applies ops exactly as the API does (backend/internal/app/canvas_changes.go), works out the ops between two
// documents op for op as the API does, and carries a page's documents (its working document and its undo and redo
// steps) over a move of the server's document it knows: others' changes, and the answer to its own (rebaseOverMove).
// Both engines run the cases of apps/canvas-change-vectors.json.
//
// Every function takes and gives plain JSON documents and never changes what it is given: a result shares every part
// that did not change with its input, and is the input itself when nothing changed, so React skips what is the same. A
// key whose value is undefined is no key, as in JSON.

import type { CanvasOp } from './types';

type JsonObject = Record<string, unknown>;
type List = readonly unknown[];

/** The collections of records a canvas document holds, in the order a diff visits them. */
export const CANVAS_COLLECTIONS = ['nodes', 'edges', 'displays', 'waypoints'] as const;
export type CanvasCollection = typeof CANVAS_COLLECTIONS[number];
/** A node's own collections of records (a session node's conversations, a form node's fields), by id. */
export const NODE_COLLECTIONS = ['threads', 'fields'] as const;
export type NodeCollection = typeof NODE_COLLECTIONS[number];

const RECORD_KEY: Readonly<Record<CanvasCollection, 'id' | 'slot'>> = { nodes: 'id', edges: 'id', displays: 'id', waypoints: 'slot' };
const EXCLUDED_KEYS: ReadonlySet<string> = new Set(['version', 'updatedAt', 'view']);
/** The longest path part the API takes, in UTF-8 bytes. */
const MAX_PATH_PART_BYTES = 200;
/** The most ids one order op lists. */
const MAX_ORDER_IDS = 4096;
const INT64_MAX = '9223372036854775807';
const INT64_MIN_DIGITS = '9223372036854775808';

/** The keys no change carries: the document's version tag (always 2), each page's own clock and each person's camera. */
export function isExcludedKey(key: string): boolean {
  return EXCLUDED_KEYS.has(key);
}

export function isCanvasCollection(key: string): key is CanvasCollection {
  return key === 'nodes' || key === 'edges' || key === 'displays' || key === 'waypoints';
}

export function isNodeCollection(key: string): key is NodeCollection {
  return key === 'threads' || key === 'fields';
}

/** The key a collection's records are named by: a saved view's slot, every other record's id. */
export function recordKeyName(collection: CanvasCollection): 'id' | 'slot' {
  return RECORD_KEY[collection];
}

/** Wires and saved views are compared and replaced whole: they are small and have no field of their own to merge. */
export function isWholeRecordCollection(collection: CanvasCollection): boolean {
  return collection === 'edges' || collection === 'waypoints';
}

/** An op the engine refuses, exactly where the API refuses it (its PATCH answers 400 invalid_op). `index` is the op's
 *  place among the ops it came with; -1 for a path read on its own. */
export class CanvasOpError extends Error {
  constructor(public readonly reason: string, public readonly index = -1) {
    super(index >= 0 ? `op ${index}: ${reason}` : reason);
    this.name = 'CanvasOpError';
  }
}

function refuse(reason: string): never {
  throw new CanvasOpError(reason);
}

// ---- Plain JSON values ----

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** A key's value as JSON reads it: its own value, never one its prototype offers ("constructor", "__proto__"). */
function own(object: object, key: string): unknown {
  return hasOwn(object, key) ? (object as JsonObject)[key] : undefined;
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The keys of an object that hold a value. */
function keysOf(object: object): string[] {
  return Object.keys(object).filter(key => (object as JsonObject)[key] !== undefined);
}

/** True when two values are the same JSON value: numbers by value, objects regardless of their keys' order, a key whose
 *  value is undefined as no key and an undefined list item as null (as JSON.stringify writes them). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aList = Array.isArray(a);
  if (aList !== Array.isArray(b)) return false;
  if (aList) {
    const left = a as List, right = b as List;
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (!sameValue(left[i] ?? null, right[i] ?? null)) return false;
    return true;
  }
  const keys = keysOf(a);
  if (keys.length !== keysOf(b).length) return false;
  for (const key of keys) if (!sameValue((a as JsonObject)[key], own(b, key))) return false;
  return true;
}

/** Orders keys as the API does, by their UTF-8 bytes: code point order. It differs from JavaScript's own string order
 *  only for a character beyond U+FFFF (two UTF-16 surrogates) against one from U+E000 to U+FFFF. */
export function compareKeys(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    const xSurrogate = x >= 0xd800 && x <= 0xdfff, ySurrogate = y >= 0xd800 && y <= 0xdfff;
    if (xSurrogate === ySurrogate) return x - y;
    return xSurrogate ? 1 : -1;
  }
  return a.length - b.length;
}

function sortedKeys(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort(compareKeys);
}

/** The object with one key set; a new object, so even a key named "__proto__" is an ordinary key. */
function setKey<T extends object>(object: T, key: string, value: unknown): T {
  const out = { ...object } as JsonObject;
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  return out as T;
}

/** The object with one key set, or the object itself when it holds that value already. */
function withKey<T extends object>(object: T, key: string, value: unknown): T {
  return hasOwn(object, key) && sameValue((object as JsonObject)[key], value) ? object : setKey(object, key, value);
}

/** The object without one key, or the object itself when it holds none. */
function withoutKey<T extends object>(object: T, key: string): T {
  if (own(object, key) === undefined) return object;
  const out = { ...object } as JsonObject;
  delete out[key];
  return out as T;
}

const replaced = (list: List, index: number, item: unknown): unknown[] => list.map((old, i) => (i === index ? item : old));
const removed = (list: List, index: number): unknown[] => list.filter((_, i) => i !== index);
const inserted = (list: List, index: number, item: unknown): unknown[] => [...list.slice(0, index), item, ...list.slice(index)];

// ---- Records ----

/** A record's key as a path names it: its id, or a saved view's slot written as a decimal integer (3, 3.0 and 3e0 are
 *  all "3", as the API reads them). Undefined for an item that is no record: not an object, no id or an empty one, or
 *  a slot that is no whole number. A slot beyond 2^53 is read as JSON.parse gave it (rounded), where the API reads its
 *  exact digits; the canvas's own saved views are the slots 1 to 9 (canvasDoc.ts). */
export function recordKey(record: unknown, keyName: string): string | undefined {
  if (!isObject(record)) return undefined;
  const value = own(record, keyName);
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (keyName === 'slot' && typeof value === 'number' && Number.isInteger(value) && value >= -(2 ** 63) && value < 2 ** 63) {
    return BigInt(value).toString();
  }
  return undefined;
}

/** The index of the first record with that key, or -1. Later records with the same key are inert: every op reaches the
 *  first, in the server and in every page alike. */
export function findRecord(list: List | undefined, keyName: string, key: string): number {
  if (!list) return -1;
  for (let i = 0; i < list.length; i++) if (recordKey(list[i], keyName) === key) return i;
  return -1;
}

/** The list a document (or a node) holds under a collection's name; undefined when that key holds no list. */
export function collectionOf(holder: object, name: string): List | undefined {
  const value = own(holder, name);
  return Array.isArray(value) ? value : undefined;
}

/** The keys of a list's records in their order, each once (an item that is no record is passed over). */
export function recordKeys(list: List, keyName: string): string[] {
  const keys = new Set<string>();
  for (const item of list) {
    const key = recordKey(item, keyName);
    if (key !== undefined) keys.add(key);
  }
  return [...keys];
}

/** An order op's result: the listed records that exist first, in the listed order, then every other item in its order.
 *  The list itself when that moves nothing. */
export function orderedRecords<T>(list: readonly T[], keyName: string, ids: readonly string[]): T[] {
  const first = new Map<string, number>();
  list.forEach((item, index) => {
    const key = recordKey(item, keyName);
    if (key !== undefined && !first.has(key)) first.set(key, index);
  });
  const out: T[] = [];
  const taken = new Set<number>();
  // An id names the first record with it; an id listed again names a record taken already.
  for (const id of ids) {
    const index = first.get(id);
    if (index === undefined || taken.has(index)) continue;
    out.push(list[index]);
    taken.add(index);
  }
  list.forEach((item, index) => {
    if (!taken.has(index)) out.push(item);
  });
  return out.every((item, index) => item === list[index]) ? (list as T[]) : out;
}

// ---- Paths ----

/** A parsed path; '' is "none". A document key has no collection; a record or a collection has no key; only a node's
 *  threads and fields have a sub-collection (for the path naming that list itself, `sub` and `key` are both its name). */
export interface CanvasPlace {
  collection: CanvasCollection | '';
  record: string;
  sub: NodeCollection | '';
  subRecord: string;
  /** A field of the record (or of the sub-record), or the document key. */
  key: string;
}

/** True for a place that is a record (a node, wire, 预览展示 window, saved view, conversation or form field), not a field
 *  of one, a collection or a document key. */
export function isRecordPlace(place: CanvasPlace): boolean {
  return place.collection !== '' && place.record !== '' && place.key === '' && (place.sub === '' || place.subRecord !== '');
}

/** A string's length in UTF-8 bytes, as the API measures it (a lone surrogate is the 3-byte U+FFFD it becomes there). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) as number;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** A saved view's slot in a path: what Go's strconv.Atoi reads, an optional sign and decimal digits within 64 bits. */
function isSlotNumber(text: string): boolean {
  const match = /^([+-]?)0*([0-9]+)$/.exec(text);
  if (!match) return false;
  const digits = match[2];
  return digits.length < 19 || (digits.length === 19 && digits <= (match[1] === '-' ? INT64_MIN_DIGITS : INT64_MAX));
}

/** Reads a path as the API does; which of its forms an op may take is the op's to say. Throws CanvasOpError for a path
 *  the API refuses. */
export function parsePath(path: readonly unknown[]): CanvasPlace {
  if (!Array.isArray(path)) refuse('a path is a list of strings');
  for (const part of path) {
    if (typeof part !== 'string') refuse('a path is a list of strings');
    if (part === '' || utf8Length(part) > MAX_PATH_PART_BYTES) refuse('a path part is empty or longer than 200 characters');
  }
  if (path.length === 0) refuse('empty path');
  const parts = path as readonly string[];
  const head = parts[0];
  if (head === 'doc') {
    const key = parts[1];
    if (parts.length !== 2 || isExcludedKey(key) || isCanvasCollection(key)) {
      refuse('a document path names one key other than a collection, version, updatedAt or view');
    }
    return { collection: '', record: '', sub: '', subRecord: '', key };
  }
  if (!isCanvasCollection(head)) refuse(`unknown collection ${JSON.stringify(head)}`);
  if (parts.length === 1) return { collection: head, record: '', sub: '', subRecord: '', key: '' };
  const record = parts[1];
  if (head === 'waypoints' && !isSlotNumber(record)) refuse('a waypoint is named by its slot number');
  if (parts.length === 2) return { collection: head, record, sub: '', subRecord: '', key: '' };
  const field = parts[2];
  if (parts.length === 3) {
    if (isWholeRecordCollection(head)) refuse(`${head} are changed whole`);
    if (field === RECORD_KEY[head]) refuse("a record's id is not a field");
    return { collection: head, record, sub: head === 'nodes' && isNodeCollection(field) ? field : '', subRecord: '', key: field };
  }
  if (parts.length > 5) refuse('path too long');
  if (head !== 'nodes' || !isNodeCollection(field)) refuse("only a node's threads and fields hold records");
  const key = parts.length === 5 ? parts[4] : '';
  if (key === 'id') refuse("a record's id is not a field");
  return { collection: head, record, sub: field, subRecord: parts[3], key };
}

function placeOf(path: unknown): CanvasPlace | undefined {
  try {
    return parsePath(path as readonly unknown[]);
  } catch {
    return undefined;
  }
}

// ---- Apply ----

/** The ids of an order op as the API reads them (Go's JSON reading of a list of strings): none when it lists none or
 *  is null, and a null id as "", which names no record. */
function orderIds(ids: unknown): readonly string[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' && id !== null)) refuse('order lists ids');
  if (ids.length > MAX_ORDER_IDS) refuse('too many ids to order');
  return ids.some(id => id === null) ? ids.map(id => (id === null ? '' : id as string)) : ids as readonly string[];
}

/** One op applied (canvas_changes.go applyCanvasOp). `applied` is false when the op had nothing to act on (a record,
 *  or a field of a record, that is not there), which is no error: the record went in a change applied before it. */
function applyOne(doc: JsonObject, op: CanvasOp): { doc: JsonObject; applied: boolean } {
  const raw: { op?: unknown; path?: unknown; value?: unknown; ids?: unknown } = isObject(op) ? op : refuse('an op is an object');
  const place = parsePath(raw.path as readonly unknown[]);
  let value: unknown;
  let ids: readonly string[] = [];
  switch (raw.op) {
    case 'set':
      if (raw.value === undefined) refuse('set needs a value');
      value = raw.value;
      break;
    case 'del':
      break;
    case 'order':
      if (place.collection === '' || (place.record !== '' && place.sub === '') || place.subRecord !== '' || place.collection === 'waypoints') {
        refuse("order names a collection: nodes, edges, displays, or a node's threads or fields");
      }
      ids = orderIds(raw.ids);
      break;
    default:
      refuse(`unknown op ${String(raw.op)}`);
  }
  if (place.collection === '') { // a document key (order was refused above)
    return { doc: raw.op === 'set' ? withKey(doc, place.key, value) : withoutKey(doc, place.key), applied: true };
  }
  const keyName = RECORD_KEY[place.collection];
  const current = own(doc, place.collection);
  const list = Array.isArray(current) ? current : undefined;
  if (place.record === '') {
    if (raw.op !== 'order') refuse('a collection is changed by its records');
    // As the API does, a collection that is not a list is made one (empty) by ordering it.
    const ordered = orderedRecords(list ?? [], keyName, ids);
    return { doc: ordered === current ? doc : setKey(doc, place.collection, ordered), applied: true };
  }
  const index = findRecord(list, keyName, place.record);
  if (place.key === '' && place.sub === '') { // the record itself (order was refused above)
    const next = putRecordAsTheAPIDoes(list, index, keyName, place.record, raw.op === 'set', value);
    return { doc: listPut(doc, place.collection, current, next.list), applied: next.applied };
  }
  if (index < 0) return { doc, applied: false }; // a field of a record that is not there
  const record = (list as List)[index] as JsonObject; // findRecord finds objects only
  let nextRecord: JsonObject;
  let applied = true;
  if (place.subRecord === '') {
    if (raw.op === 'order') { // a node's threads or fields put in order; a value that is no list is made one
      const subCurrent = own(record, place.key);
      const ordered = orderedRecords(Array.isArray(subCurrent) ? subCurrent : [], 'id', ids);
      nextRecord = ordered === subCurrent ? record : setKey(record, place.key, ordered);
    } else {
      nextRecord = raw.op === 'set' ? withKey(record, place.key, value) : withoutKey(record, place.key);
    }
  } else { // inside a node's threads or fields
    const subCurrent = own(record, place.sub);
    const subList = Array.isArray(subCurrent) ? subCurrent : undefined;
    const subIndex = findRecord(subList, 'id', place.subRecord);
    if (place.key === '') { // a conversation or form field itself
      const next = putRecordAsTheAPIDoes(subList, subIndex, 'id', place.subRecord, raw.op === 'set', value);
      nextRecord = listPut(record, place.sub, subCurrent, next.list);
      applied = next.applied;
    } else {
      if (subIndex < 0) return { doc, applied: false }; // a field of a conversation or form field that is not there
      const subRecord = (subList as List)[subIndex] as JsonObject;
      const nextSub = raw.op === 'set' ? withKey(subRecord, place.key, value) : withoutKey(subRecord, place.key);
      nextRecord = nextSub === subRecord ? record : setKey(record, place.sub, replaced(subList as List, subIndex, nextSub));
    }
  }
  return { doc: nextRecord === record ? doc : setKey(doc, place.collection, replaced(list as List, index, nextRecord)), applied };
}

/** The holder with its list (the value it held: `current`) given as `next`. As the API does, a delete that found no list
 *  writes the key as none (null): Go keeps the list it did not find, and a missing list is null in JSON. */
function listPut<T extends object>(holder: T, key: string, current: unknown, next: List | undefined): T {
  if (Array.isArray(current) && next === current) return holder;
  return next ? setKey(holder, key, next) : withKey(holder, key, null);
}

/** A record set or deleted (canvas_changes.go applyToRecord). A set replaces the first record with that key or appends
 *  the value; a delete that finds nothing leaves the list as it is (undefined when there was none). */
function putRecordAsTheAPIDoes(list: List | undefined, index: number, keyName: string, key: string, set: boolean, value: unknown): { list: List | undefined; applied: boolean } {
  if (!set) return index < 0 ? { list, applied: false } : { list: removed(list as List, index), applied: true };
  if (recordKey(value, keyName) !== key) refuse(`a record set here must carry ${keyName} ${JSON.stringify(key)}`);
  if (index < 0) return { list: [...(list ?? []), value], applied: true };
  return { list: sameValue((list as List)[index], value) ? list : replaced(list as List, index, value), applied: true };
}

/** One op applied to a document; see applyOps. */
export function applyOp<D extends object>(doc: D, op: CanvasOp): { doc: D; applied: boolean } {
  const { doc: next, applied } = applyOps(doc, [op]);
  return { doc: next, applied: applied[0] };
}

/** The ops applied in order, as the server applies them. `applied[i]` is false when `ops[i]` had nothing to act on (a
 *  record, or a field of a record, that is not there: the API answers it `gone`). An op the API refuses throws a
 *  CanvasOpError naming its index, and nothing is changed. */
export function applyOps<D extends object>(doc: D, ops: readonly CanvasOp[]): { doc: D; applied: boolean[] } {
  let current = doc as unknown as JsonObject;
  const applied: boolean[] = [];
  ops.forEach((op, index) => {
    try {
      const result = applyOne(current, op);
      current = result.doc;
      applied.push(result.applied);
    } catch (error) {
      if (error instanceof CanvasOpError) throw new CanvasOpError(error.reason, index);
      throw error;
    }
  });
  return { doc: current as unknown as D, applied };
}

// ---- Diff ----

/** The ops that turn `a` into `b`, exactly as the API works them out (canvas_changes.go diffCanvas): the collections in
 *  the order nodes, edges, displays, waypoints, then the document's other keys in sorted order. Within a collection the
 *  deletions come first (in a's order), then the sets and field changes (in b's order), then one order op when the adds
 *  and removals alone would not give b's order; within a record the keys go in sorted order. A node's conversations and
 *  form fields are compared one level deeper, by id, when both sides hold records with distinct ids; wires and saved
 *  views are compared whole, and saved views have no order. The keys no change carries are left out. */
export function diffDocuments(a: object, b: object): CanvasOp[] {
  const ops: CanvasOp[] = [];
  for (const name of CANVAS_COLLECTIONS) {
    diffCollection(ops, [name], collectionOf(a, name), collectionOf(b, name), RECORD_KEY[name], isWholeRecordCollection(name), name === 'nodes');
  }
  for (const key of sortedKeys(keysOf(a), keysOf(b))) {
    if (!isExcludedKey(key) && !isCanvasCollection(key)) diffValue(ops, ['doc', key], a, b, key);
  }
  return ops;
}

/** The ops a page has not sent: what turns the server's document as it knows it into the one it shows. */
export function pendingOps(confirmed: object, working: object): CanvasOp[] {
  return diffDocuments(confirmed, working);
}

/** The op for one key, which `a` or `b` (or both) holds: a delete, a set, or none when both hold the same value. */
function diffValue(ops: CanvasOp[], path: string[], a: object, b: object, key: string): void {
  const before = own(a, key), after = own(b, key);
  if (after === undefined) ops.push({ op: 'del', path });
  else if (before === undefined || !sameValue(before, after)) ops.push({ op: 'set', path, value: after });
}

interface Keyed { keys: string[]; byKey: Map<string, JsonObject> }

/** A list read as records with distinct keys, in order; undefined when an item is no record (then it is compared whole).
 *  A record listed twice keeps its first place, as findRecord does. */
function keyedRecords(list: List | undefined, keyName: string): Keyed | undefined {
  const keyed: Keyed = { keys: [], byKey: new Map() };
  for (const item of list ?? []) {
    const key = recordKey(item, keyName);
    if (key === undefined) return undefined;
    if (keyed.byKey.has(key)) continue;
    keyed.keys.push(key);
    keyed.byKey.set(key, item as JsonObject);
  }
  return keyed;
}

function diffCollection(ops: CanvasOp[], path: string[], a: List | undefined, b: List | undefined, keyName: string, whole: boolean, nodes: boolean): void {
  const aKeyed = keyedRecords(a, keyName), bKeyed = keyedRecords(b, keyName);
  if (!aKeyed || !bKeyed) {
    // Not a list of records on one side: it is rebuilt record by record from b's readable records.
    const bBy = new Map<string, unknown>();
    for (const item of b ?? []) {
      const key = recordKey(item, keyName);
      if (key !== undefined && !bBy.has(key)) bBy.set(key, item);
    }
    for (const item of a ?? []) {
      const key = recordKey(item, keyName);
      if (key !== undefined && !bBy.has(key)) ops.push({ op: 'del', path: [...path, key] });
    }
    for (const [key, item] of bBy) ops.push({ op: 'set', path: [...path, key], value: item });
    return;
  }
  for (const key of aKeyed.keys) if (!bKeyed.byKey.has(key)) ops.push({ op: 'del', path: [...path, key] });
  for (const key of bKeyed.keys) {
    const before = aKeyed.byKey.get(key), after = bKeyed.byKey.get(key) as JsonObject;
    if (before === undefined || whole) {
      if (!before || !sameValue(before, after)) ops.push({ op: 'set', path: [...path, key], value: after });
    } else if (!sameValue(before, after)) {
      diffRecord(ops, [...path, key], before, after, keyName, nodes);
    }
  }
  // The shared records' order, once every add and removal is in: the adds land at the end, as apply puts them. Saved
  // views have no order of their own (the canvas lists them by slot).
  if (path[0] === 'waypoints') return;
  const order = changedOrder(aKeyed.keys, bKeyed.keys);
  if (order) ops.push({ op: 'order', path: [...path], ids: order });
}

/** b's keys when applying the adds and removals alone would not leave b's order; undefined when they would. */
function changedOrder(aKeys: string[], bKeys: string[]): string[] | undefined {
  const inA = new Set(aKeys), inB = new Set(bKeys);
  const expected = [...aKeys.filter(key => inB.has(key)), ...bKeys.filter(key => !inA.has(key))];
  return expected.some((key, i) => key !== bKeys[i]) ? [...bKeys] : undefined;
}

function diffRecord(ops: CanvasOp[], path: string[], a: JsonObject, b: JsonObject, keyName: string, node: boolean): void {
  for (const key of sortedKeys(keysOf(a), keysOf(b))) {
    if (key === keyName) continue;
    if (node && isNodeCollection(key)) {
      const before = own(a, key), after = own(b, key);
      if (Array.isArray(before) && Array.isArray(after) && keyedRecords(before, 'id') && keyedRecords(after, 'id')) {
        diffCollection(ops, [...path, key], before, after, 'id', false, false);
        continue;
      }
    }
    diffValue(ops, [...path, key], a, b, key);
  }
}

// ---- Reading and writing at a path ----

/** What a place holds: `value` (undefined when absent), and `holder`, false when the place is a field of a record (or
 *  of a conversation or form field) that is not there. */
interface Found { holder: boolean; value: unknown }

function lookup(doc: object, place: CanvasPlace): Found {
  if (place.collection === '') return { holder: true, value: own(doc, place.key) };
  if (place.record === '') return { holder: true, value: own(doc, place.collection) };
  const list = collectionOf(doc, place.collection);
  const index = findRecord(list, RECORD_KEY[place.collection], place.record);
  const record = index < 0 ? undefined : (list as List)[index] as JsonObject;
  if (place.key === '' && place.sub === '') return { holder: true, value: record };
  if (!record) return { holder: false, value: undefined };
  if (place.subRecord === '') return { holder: true, value: own(record, place.key) };
  const subList = collectionOf(record, place.sub);
  const subIndex = findRecord(subList, 'id', place.subRecord);
  const subRecord = subIndex < 0 ? undefined : (subList as List)[subIndex] as JsonObject;
  if (place.key === '') return { holder: true, value: subRecord };
  return subRecord ? { holder: true, value: own(subRecord, place.key) } : { holder: false, value: undefined };
}

/** The value a path names in a document: a document key's value, a record (the first with that id), a field of one, a
 *  collection; undefined when it is not there or the path names no place. */
export function valueAt(doc: object, path: readonly string[]): unknown {
  const place = placeOf(path);
  return place ? lookup(doc, place).value : undefined;
}

/** Where a record that comes into `list` goes: right after the nearest record before it in `reference` (the server's
 *  list, which holds it) that `list` holds, or first when `list` holds none of them. So the records both hold stay in
 *  the server's order and a page's own new records stay after them, and the next diff needs no order op. */
function insertionIndex(list: List, keyName: string, key: string, reference: List | undefined): number {
  const at = findRecord(reference, keyName, key);
  for (let i = at - 1; i >= 0; i--) {
    const before = recordKey((reference as List)[i], keyName);
    const index = before === undefined ? -1 : findRecord(list, keyName, before);
    if (index >= 0) return index + 1;
  }
  return 0;
}

/** A list with one record put (value) or taken out (undefined); the list itself when that changes nothing. */
function putRecord(list: List | undefined, keyName: string, key: string, value: unknown, reference: List | undefined): List | undefined {
  const index = findRecord(list, keyName, key);
  if (value === undefined) return index < 0 ? list : removed(list as List, index);
  if (index >= 0) return sameValue((list as List)[index], value) ? list : replaced(list as List, index, value);
  const items = list ?? [];
  return inserted(items, insertionIndex(items, keyName, key, reference), value);
}

/** The document with the value at a place (a document key, a record or a field) set, or taken out when `value` is
 *  undefined. A field of a record the document does not hold is left alone, and so is a conversation or form field of
 *  a node whose list of them the page has replaced whole or taken away (its own newer edit); a record that comes in
 *  goes where `reference` (the server's document) has it. */
function putAt(doc: JsonObject, place: CanvasPlace, value: unknown, reference: object): JsonObject {
  if (place.collection === '') return value === undefined ? withoutKey(doc, place.key) : withKey(doc, place.key, value);
  if (place.record === '') return doc; // a collection is changed by its records
  const keyName = RECORD_KEY[place.collection];
  const current = own(doc, place.collection);
  const list = Array.isArray(current) ? current : undefined;
  const referenceList = collectionOf(reference, place.collection);
  if (place.key === '' && place.sub === '') {
    const next = putRecord(list, keyName, place.record, value, referenceList);
    return next === list ? doc : setKey(doc, place.collection, next);
  }
  const index = findRecord(list, keyName, place.record);
  if (index < 0) return doc;
  const record = (list as List)[index] as JsonObject;
  let nextRecord: JsonObject;
  if (place.subRecord === '') {
    nextRecord = value === undefined ? withoutKey(record, place.key) : withKey(record, place.key, value);
  } else {
    const subList = own(record, place.sub);
    if (!Array.isArray(subList) || !keyedRecords(subList, 'id')) return doc;
    if (place.key === '') {
      const at = findRecord(referenceList, keyName, place.record);
      const referenceSub = at < 0 ? undefined : collectionOf((referenceList as List)[at] as JsonObject, place.sub);
      const nextSub = putRecord(subList, 'id', place.subRecord, value, referenceSub);
      nextRecord = nextSub === subList ? record : setKey(record, place.sub, nextSub);
    } else {
      const subIndex = findRecord(subList, 'id', place.subRecord);
      if (subIndex < 0) return doc;
      const subRecord = subList[subIndex] as JsonObject;
      const nextSub = value === undefined ? withoutKey(subRecord, place.key) : withKey(subRecord, place.key, value);
      nextRecord = nextSub === subRecord ? record : setKey(record, place.sub, replaced(subList, subIndex, nextSub));
    }
  }
  return nextRecord === record ? doc : setKey(doc, place.collection, replaced(list as List, index, nextRecord));
}

/** The document with the list a collection place names (a canvas collection, or a node's threads or fields) given by
 *  `next`; the document itself when there is no such list or `next` leaves it as it is. */
function withList(doc: JsonObject, place: CanvasPlace, next: (list: List, keyName: string) => List): JsonObject {
  if (place.collection === '') return doc;
  const current = collectionOf(doc, place.collection);
  if (!current) return doc;
  const keyName = RECORD_KEY[place.collection];
  if (place.record === '') {
    const list = next(current, keyName);
    return list === current ? doc : setKey(doc, place.collection, list);
  }
  const index = findRecord(current, keyName, place.record);
  if (index < 0) return doc;
  const record = current[index] as JsonObject;
  const subList = collectionOf(record, place.sub);
  if (!subList) return doc;
  const list = next(subList, 'id');
  return list === subList ? doc : setKey(doc, place.collection, replaced(current, index, setKey(record, place.sub, list)));
}

function opIds(op: CanvasOp): readonly string[] {
  const ids = (op as { ids?: unknown }).ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** True when the records a list and a reference list (none: no list) both hold stand in the same order in each: the
 *  page has not put them in another order of its own. */
function inReferenceOrder(list: List, reference: unknown, keyName: string): boolean {
  const keys = recordKeys(list, keyName);
  const held = new Set(keys);
  const shared = Array.isArray(reference) ? recordKeys(reference, keyName).filter(key => held.has(key)) : [];
  const inShared = new Set(shared);
  return keys.filter(key => inShared.has(key)).every((key, i) => key === shared[i]);
}

/** True when a list holds the records an order op listed (those it holds) in the order it listed them. */
function inListedOrder(list: List, keyName: string, ids: readonly string[]): boolean {
  const listed = new Set(ids);
  const keys = recordKeys(list, keyName).filter(key => listed.has(key));
  const held = new Set(keys);
  const wanted = [...listed].filter(id => held.has(id));
  return keys.every((key, i) => key === wanted[i]);
}

// ---- Rebase ----

/** A page's working document carried over another participant's change (the contract's "A page's own edits win until
 *  they are sent"). `confirmedBefore` and `confirmedAfter` are the server's document as the page knows it before and
 *  after that change, whose ops are `ops`. For each op in turn:
 *  - a set or delete of a path is taken (working gets confirmedAfter's value there, or loses it) only where working
 *    still holds confirmedBefore's value, so a page's own edit of that path stays to go with its next save;
 *  - a record someone deleted goes from working too, edited or not;
 *  - an order op is taken while working holds the records it shares with confirmedBefore in confirmedBefore's order: it
 *    moves the listed records working holds first and keeps the rest after them, its own new records too. A list the
 *    page put in another order keeps the page's order, to go with its next save;
 *  - a field op whose record working does not hold does nothing, nor does an op inside a node's conversations or
 *    form fields when working no longer holds them as a list of records (the page replaced that list whole);
 *  - a record that comes in goes where confirmedAfter has it among the records working holds.
 *  confirmedAfter's values are taken rather than the ops' own, so whatever the caller normalized there carries over.
 *  The undo and redo steps of a page are carried over the same way, so an undo never takes back someone else's edit.
 *  Others' ops only: carried as another writer's, the page's own answered edit would land in its undo steps and its own
 *  deletion take the record from all of them, so a move that answers its change leaves those out (othersOps). */
export function rebaseWorking<D extends object>(working: D, confirmedBefore: object, confirmedAfter: object, ops: readonly CanvasOp[]): D {
  let doc = working as unknown as JsonObject;
  for (const op of ops) {
    const place = placeOf(op.path);
    if (!place) continue;
    if (op.op === 'order') {
      const ids = opIds(op);
      const reference = lookup(confirmedBefore, place).value;
      doc = withList(doc, place, (list, keyName) => (inReferenceOrder(list, reference, keyName) ? orderedRecords(list, keyName, ids) : list));
      continue;
    }
    if (op.op !== 'set' && op.op !== 'del') continue;
    if (op.op === 'del' && isRecordPlace(place)) {
      doc = putAt(doc, place, undefined, confirmedAfter);
      continue;
    }
    if (!sameValue(lookup(doc, place).value, lookup(confirmedBefore, place).value)) continue;
    const after = lookup(confirmedAfter, place);
    if (after.holder) doc = putAt(doc, place, after.value, confirmedAfter);
  }
  return doc as unknown as D;
}

/** A page's working document once the server has answered the page's own change (`sent`, its ops): each path it sent
 *  takes the server's value (confirmedAfter's), unless the page has changed it again since; so a field the server keeps
 *  (a preserved skill list, a refused op) never loops back as an endless save. For a sent order op the server's order
 *  is taken while working still holds the records it sent in the order it sent them (less any it no longer holds) and
 *  no record the server does not know: a record of the page's own made since keeps working's order as it is, while
 *  records the server gave back (a refused delete) or others added go where the server has them. A document that came
 *  holding a record the change deleted is a step from before that deletion (an undo step, or an undo of it since): its
 *  order of that list is its own. */
export function rebaseAfterAck<D extends object>(working: D, sent: readonly CanvasOp[], confirmedAfter: object): D {
  let doc = working as unknown as JsonObject;
  // The records the change deleted that the document holds as it comes, by the path of their list.
  const undeleted = new Map<string, Set<string>>();
  for (const op of sent) {
    const place = op.op === 'del' ? placeOf(op.path) : undefined;
    if (!place || !isRecordPlace(place) || lookup(doc, place).value === undefined) continue;
    const list = JSON.stringify(op.path.slice(0, -1));
    undeleted.set(list, (undeleted.get(list) ?? new Set<string>()).add(op.path[op.path.length - 1]));
  }
  for (const op of sent) {
    const place = placeOf(op.path);
    if (!place) continue;
    if (op.op === 'order') {
      const sentIds = new Set(opIds(op));
      const afterList = lookup(confirmedAfter, place).value;
      const stillHeld = undeleted.get(JSON.stringify(op.path));
      doc = withList(doc, place, (list, keyName) => {
        const keys = recordKeys(list, keyName);
        if (stillHeld && keys.some(key => stillHeld.has(key))) return list;
        const held = new Set(keys);
        const afterKeys = Array.isArray(afterList) ? recordKeys(afterList, keyName) : [];
        const known = new Set(afterKeys);
        const sentOrder = [...sentIds].filter(id => held.has(id));
        const heldOrder = keys.filter(key => sentIds.has(key));
        if (heldOrder.some((key, i) => key !== sentOrder[i]) || keys.some(key => !sentIds.has(key) && !known.has(key))) return list;
        return orderedRecords(list, keyName, afterKeys);
      });
      continue;
    }
    const now = lookup(doc, place).value;
    const unchanged = op.op === 'set' ? op.value !== undefined && sameValue(now, op.value) : op.op === 'del' && now === undefined;
    if (!unchanged) continue;
    const after = lookup(confirmedAfter, place);
    if (after.holder) doc = putAt(doc, place, after.value, confirmedAfter);
  }
  return doc as unknown as D;
}

// ---- A move of the confirmed document ----

/** A path of the page's own answered change that the server's document after the move holds as the page sent it. */
interface OwnPath { op: 'set' | 'del' | 'order'; path: readonly string[] }

const startsWith = (path: unknown, prefix: readonly string[]): boolean =>
  Array.isArray(path) && prefix.length <= path.length && prefix.every((part, i) => part === path[i]);

/** The paths of `sent` (the page's own answered change) at which `after` ended with what the page sent: a set's path
 *  holding the value sent, or a record the set made that `before` lacked (its id is the page's alone, whatever the server
 *  made of it; a saved view's slot is anyone's, so its value decides); a delete's path holding nothing; an order's list
 *  holding the records it listed (those it still holds) in its order. */
function ownPaths(sent: readonly CanvasOp[], before: object, after: object): OwnPath[] {
  const out: OwnPath[] = [];
  for (const op of sent) {
    const place = placeOf(op.path);
    if (!place) continue;
    if (op.op === 'set') {
      if (op.value === undefined) continue;
      const now = lookup(after, place);
      const made = isRecordPlace(place) && place.collection !== 'waypoints' && lookup(before, place).value === undefined;
      if (made || (now.holder && sameValue(now.value, op.value))) out.push({ op: 'set', path: op.path });
    } else if (op.op === 'del') {
      if (lookup(after, place).value === undefined) out.push({ op: 'del', path: op.path });
    } else if (op.op === 'order' && place.collection !== '' && place.subRecord === '' && (place.record === '' || place.sub !== '')) {
      const list = lookup(after, place).value;
      const keyName = place.record === '' ? RECORD_KEY[place.collection] : 'id';
      if (Array.isArray(list) && inListedOrder(list, keyName, opIds(op))) out.push({ op: 'order', path: op.path });
    }
  }
  return out;
}

/** True when an op of the move is the page's own at one of its own paths: any op at or inside a set's path, the delete
 *  of a deleted path, the order of a list put in order. */
function accountsFor(own: OwnPath, op: CanvasOp): boolean {
  if (own.op === 'set') return startsWith(op.path, own.path);
  return op.op === own.op && startsWith(op.path, own.path) && op.path.length === own.path.length;
}

/** The ops of a move of the page's confirmed document (`moved`, from `before` to `after`) to carry over the page's
 *  documents as another writer's (rebaseWorking): all but those the page's own answered change (`sent`) accounts for
 *  (ownPaths), so its own edits, new records and deletions never reach its undo steps. Someone else's write over a path
 *  the page sent, after the page, still does, as does what the server did beyond the page's ops (a wire whose node went);
 *  a path both wrote, the page last, is the page's, as the server holds it. All of `moved` with no `sent`. */
export function othersOps(moved: readonly CanvasOp[], before: object, after: object, sent: readonly CanvasOp[] = []): CanvasOp[] {
  const own = sent.length ? ownPaths(sent, before, after) : [];
  if (!own.length) return [...moved];
  return moved.filter(op => !own.some(path => accountsFor(path, op)));
}

/** The rebase of a page's documents (its working document and each undo and redo step) over one move of the server's
 *  document it knows, from `before` to `after` (as the page reads them), worked out once for the move. `sent`: the ops of
 *  the page's own change the move answers, less those the server held back; none for others' changes alone. Each path
 *  the page sent takes the server's value unless the document changed it again since (rebaseAfterAck), so an undo step
 *  keeps what it held and an undo pressed while the change was out stays, to go next; every other op is carried as
 *  another writer's (rebaseWorking over othersOps). A document nothing changes in comes back itself. */
export function rebaseOverMove(before: object, after: object, sent: readonly CanvasOp[] = []): <D extends object>(doc: D) => D {
  const theirs = othersOps(diffDocuments(before, after), before, after, sent);
  if (!theirs.length && !sent.length) return doc => doc;
  return <D extends object>(doc: D): D => {
    const acked = sent.length ? rebaseAfterAck(doc, sent, after) : doc;
    return theirs.length ? rebaseWorking(acked, before, after, theirs) : acked;
  };
}
