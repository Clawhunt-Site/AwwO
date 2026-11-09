// The pages an Agent invited to the canvas hands in (多人同屏): a node's result it wrote over MCP. The server keeps such a
// result as handed in by that Agent (canvas_change_write.go: source "manual", by {kind: "agent", name}), and it reaches
// a viewer's browser as the Agent wrote it, never through AwwO's engine. So it is held as a market Agent's page is
// (marketPages.ts; the owner's choice, 2026-11-08): it shows still, its scripts not run, until its reader chooses to run
// it, for that delivery and where it is shown, and running it loads pictures and media by URL only from the CDNs
// (studio/liveDocument.ts MARKET_PAGE_CSP). A run, or a person's own publication, replaces the result and the hold with
// it.
//
// A run's result made from words an Agent wrote is held the same way (the owner's choice of 2026-11-08): an assemble
// node copies its template and its inputs into its page as they are, a form hands on its fields' labels and values, an
// image, video, 3D or edit node's file listing names its title, and a session follows its persona. The server keeps,
// on each node, the fingerprints of the texts an Agent wrote there and of each result held for an Agent's words
// (agentWritten, canvas_agent_words.go): a text counts as the Agent's while it matches one, and a result held once stays
// held after what fed it is gone. agentPageHolds reads the same rules the server does; both are checked against
// backend/internal/app/testdata/agent_words_vectors.json. A session that only reads an Agent's words as its input is
// not held for them, as for a person's (docs/awwo-canvas-live-collaboration.md, "An agent's page"). A file a held result
// stored reaches only a page held itself, whatever page names it (liveDocument.ts buildLiveDocument).
import { createContext, useCallback, useContext } from 'react';
import { sanitizeOutputAuthor, type AgentWrittenEntry, type CanvasDocument, type CanvasEdge, type CanvasNode } from './canvasDoc';
import { MarketPagesContext } from './marketPages';

/** The name of the Agent that handed a result in ('' where it has none), or undefined for any other result. Reads a
 *  result as a page holds it or as a run's admitted canvas does (the server's own record). */
export function handedInBy(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const { source, by } = output as { source?: unknown; by?: unknown };
  return source === 'manual' ? sanitizeOutputAuthor(by)?.name : undefined;
}

/** Every control character, and the invisible ones that would change or hide what a sentence around a name shows:
 *  direction marks, embeddings, overrides and isolates, zero-width spaces and joiners, line and paragraph separators, tags. */
const UNSHOWN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/** An Agent's name as a sentence shows it ('' where nothing of it can be shown). */
export function agentDisplayName(name: string): string {
  return name.replace(UNSHOWN, '').trim();
}

/** Why a node's result is held for an Agent invited to the canvas: that Agent handed it in, or it is made from words the
 *  Agents named wrote ('' for one with no name). */
export interface AgentPageHold { handedIn: boolean; names: string[] }

const encoder = new TextEncoder();
/** Fingerprints worked out already, by text, the latest read last: the canvas reads the same texts again at each change.
 *  At most FINGERPRINTS_KEPT texts and FINGERPRINT_CHARS characters of them are kept (results run to several MiB). */
const fingerprints = new Map<string, string>();
const FINGERPRINTS_KEPT = 4096;
const FINGERPRINT_CHARS = 8 * 1024 * 1024;
let fingerprintChars = 0;

/** A text's fingerprint as the server keeps it (canvas_agent_words.go agentTextHash): FNV-1a 64 of its UTF-8 bytes, as
 *  16 hex digits. */
export function agentTextHash(text: string): string {
  const known = fingerprints.get(text);
  if (known !== undefined) {
    fingerprints.delete(text);
    fingerprints.set(text, known);
    return known;
  }
  const bytes = encoder.encode(text);
  // The 64-bit hash in two 32-bit halves; its prime is 2^40 + 0x1b3, so the high half takes the low one shifted by 8.
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < bytes.length; i += 1) {
    lo = (lo ^ bytes[i]) >>> 0;
    const low = lo * 0x1b3;
    hi = (hi * 0x1b3 + Math.floor(low / 0x100000000) + ((lo << 8) >>> 0)) >>> 0;
    lo = low >>> 0;
  }
  const out = hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
  // The ones read longest ago go: a canvas with more texts than this keeps most of them, never rereads them all. A text
  // larger than the whole budget is not kept.
  if (text.length > FINGERPRINT_CHARS) return out;
  while (fingerprints.size && (fingerprints.size >= FINGERPRINTS_KEPT || fingerprintChars + text.length > FINGERPRINT_CHARS)) {
    const oldest = fingerprints.keys().next().value!;
    fingerprints.delete(oldest);
    fingerprintChars -= oldest.length;
  }
  fingerprints.set(text, out);
  fingerprintChars += text.length;
  return out;
}

const MEDIA_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'model3d', 'audio']);

/** A form's fields as a run reads them: the first of each id. */
function firstFields<T extends { id: string }>(fields: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return fields.filter(field => !seen.has(field.id) && Boolean(seen.add(field.id)));
}

/** Two strings in code point order, as the server sorts them (the byte order of their UTF-8): JavaScript's own order is
 *  of UTF-16 units, which puts an emoji before a fullwidth letter. */
export function byCodePoint(a: string, b: string): number {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!, y = b.codePointAt(j)!;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}

/** The names a hold carries, the first in code point order (canvas_agent_words.go agentHoldNamesMax): a page is held while
 *  one is left, so the names a canvas holds never make a hold, or the work of finding it, grow. */
const HOLD_NAMES_MAX = 8;

/** A set's first HOLD_NAMES_MAX names in code point order. */
function firstNames(set: Set<string>): Set<string> {
  return set.size <= HOLD_NAMES_MAX ? set : new Set([...set].sort(byCodePoint).slice(0, HOLD_NAMES_MAX));
}

/** One node as agentPageHolds reads it: the names its own result is held for (`own`), what its output hands on whatever it
 *  delivered (`gives`), whether its result reaches a wire, whether it takes the words its wires bring, and the names it
 *  is held for once its wires are read (`names`). */
interface HoldState { handedIn: boolean; takes: boolean; delivers: boolean; own: Set<string>; gives: Set<string>; names: Set<string> }

/** One node as agentPageHolds starts from it (canvas_agent_words.go newAgentHoldState): the names its own result is held
 *  for, what its output hands on whatever it delivered (a form's fields, a media node's title), whether its result
 *  reaches a wire, and whether its result takes the words its wires bring (an assemble node's run). `anew`: as a run
 *  making the node's result again reads it (agentRunHolds): by the persona and the template it has and the wires into it,
 *  never by the result it had. */
function holdState(node: CanvasNode, anew = false): HoldState {
  const byHash = new Map<string, string[]>();
  for (const entry of node.agentWritten ?? []) {
    const names = byHash.get(entry.h);
    if (names) names.push(entry.by);
    else byHash.set(entry.h, [entry.by]);
  }
  const state: HoldState = { handedIn: false, takes: false, delivers: false, own: new Set(), gives: new Set(), names: new Set() };
  const match = (text: string | undefined, into: Set<string>) => {
    if (!text || !byHash.size) return;
    for (const name of byHash.get(agentTextHash(text)) ?? []) into.add(name);
  };
  const media = node.kind === 'session' && MEDIA_KINDS.has(node.agentKind);
  const out = anew || !node.lastOutput?.text ? null : node.lastOutput;
  if (out) {
    if (out.source === 'manual' && out.by) {
      state.handedIn = true;
      state.own.add(out.by.name);
    } else if (out.source !== 'case') match(out.text, state.own);
  }
  // A run's result follows the node's own persona (a session with no Agent chosen, not a media node) and an assemble
  // node's template, and an assemble node's takes the words its wires bring. A run never follows an Agent's persona the
  // node no longer shows (the API refuses it, agentPersonaDrift), so a conversation's persona counts for nothing here.
  if (anew || out?.source === 'run') {
    if (node.kind === 'session' && !node.agentRef && !media) match(node.persona, state.own);
    if (node.kind === 'assemble') {
      match(node.template, state.own);
      state.takes = true;
    }
  }
  // A partial result hands its words on too: a review loop's unapproved round is read by the steps after it.
  if (anew || out) state.delivers = node.kind !== 'form';
  if (node.kind === 'form') {
    for (const field of firstFields(node.fields)) {
      match(field.label, state.gives);
      match(field.value, state.gives);
    }
  } else if (node.kind === 'edit' || media) match(node.title, state.gives);
  state.own = firstNames(state.own);
  state.gives = firstNames(state.gives);
  return state;
}

/**
 * Which results of a canvas are held for an Agent invited to it, as the server reads them (canvas_agent_words.go
 * agentPageHolds): a result an Agent handed in; any other but a copied case's whose text a fingerprint of its node
 * matches; a run's result of a session running its own persona (no Agent chosen, not a media node) while that persona is
 * an Agent's text, and of an assemble node while its template is; and a run's result of an assemble node while a wire
 * into it comes from a form with a label or value an Agent wrote, from an image, video, 3D or edit node whose title an
 * Agent wrote, or from a node whose result is held, through a chain of assemble nodes too. Each hold carries the first
 * HOLD_NAMES_MAX names, in code point order, of all the Agents it is for, so it is the same whatever order the nodes are in.
 */
export function agentPageHolds(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<Pick<CanvasEdge, 'fromNode' | 'toNode'>>): ReadonlyMap<string, AgentPageHold> {
  return settledHolds(nodes, edges, NONE_ANEW);
}

const NONE_ANEW: ReadonlySet<string> = new Set();

/** The Agents whose words a run's results are made from, by the canvas the run was admitted with (a run's record,
 *  GraphNodeOutput): agentPageHolds with each node the run made anew (`ran`: all it ran but those it reused) read as such
 *  a run reads it, by its persona, template and wires, not by the result it had then; the rest, whose results the run
 *  read as they were, as the canvas reads them. */
export function agentRunHolds(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<Pick<CanvasEdge, 'fromNode' | 'toNode'>>, ran: ReadonlySet<string>): ReadonlyMap<string, AgentPageHold> {
  return settledHolds(nodes, edges, ran);
}

/** The names on their way in settledHolds, the first in code point order taken first (a binary heap). */
class Arrivals {
  private items: { name: string; id: string }[] = [];
  private before(i: number, j: number): boolean {
    const a = this.items[i], b = this.items[j];
    const order = byCodePoint(a.name, b.name);
    return order !== 0 ? order < 0 : a.id < b.id;
  }
  private swap(i: number, j: number) { [this.items[i], this.items[j]] = [this.items[j], this.items[i]]; }
  push(name: string, id: string) {
    this.items.push({ name, id });
    for (let i = this.items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): { name: string; id: string } | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      this.items[0] = last;
      for (let i = 0; ;) {
        const left = 2 * i + 1, right = left + 1;
        let next = i;
        if (left < this.items.length && this.before(left, next)) next = left;
        if (right < this.items.length && this.before(right, next)) next = right;
        if (next === i) break;
        this.swap(i, next);
        i = next;
      }
    }
    return first;
  }
}

/** The holds, names reaching nodes in code point order, each along each wire at most once (canvas_agent_words.go
 *  agentPageHoldsWith): a node keeps the first HOLD_NAMES_MAX that reach it, so the work is that many names times the
 *  wires (each through a heap, so with its logarithm), whatever the order the nodes are in. */
function settledHolds(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<Pick<CanvasEdge, 'fromNode' | 'toNode'>>, anew: ReadonlySet<string>): ReadonlyMap<string, AgentPageHold> {
  const states = new Map<string, HoldState>();
  const arrivals = new Arrivals();
  for (const node of nodes) {
    if (states.has(node.id)) continue;
    const state = holdState(node, anew.has(node.id));
    states.set(node.id, state);
    for (const name of state.own) arrivals.push(name, node.id);
  }
  const targets = new Map<string, string[]>();
  for (const edge of edges) {
    const from = states.get(edge.fromNode);
    if (edge.fromNode === edge.toNode || !from || !states.get(edge.toNode)?.takes) continue;
    const list = targets.get(edge.fromNode);
    if (list) list.push(edge.toNode);
    else targets.set(edge.fromNode, [edge.toNode]);
    for (const name of from.gives) arrivals.push(name, edge.toNode);
  }
  for (let arrival = arrivals.pop(); arrival; arrival = arrivals.pop()) {
    const state = states.get(arrival.id)!;
    if (state.names.has(arrival.name) || state.names.size === HOLD_NAMES_MAX) continue;
    state.names.add(arrival.name);
    if (state.delivers) for (const to of targets.get(arrival.id) ?? []) arrivals.push(arrival.name, to);
  }
  const out = new Map<string, AgentPageHold>();
  for (const [id, state] of states) if (state.names.size) out.set(id, { handedIn: state.handedIn, names: [...state.names].sort(byCodePoint) });
  return out;
}

/** The fingerprints a node keeps of texts it no longer holds (canvas_agent_words.go agentWrittenStaleMax). */
const STALE_MAX = 16;
/** The names one fingerprint is kept under, the first ones (canvas_agent_words.go agentWrittenNamesMax). */
const NAMES_MAX = 8;

const entryKey = (entry: AgentWrittenEntry) => `${entry.h}\n${entry.by}`;

/** A node's texts an Agent's words reach a page through (canvas_agent_words.go agentNodeTexts). */
function nodeTexts(node: CanvasNode): string[] {
  const texts = [node.title];
  if (node.kind === 'session') texts.push(node.persona);
  if (node.kind === 'assemble') texts.push(node.template);
  if (node.kind === 'form') for (const field of firstFields(node.fields)) texts.push(field.label, field.value);
  if (node.lastOutput) texts.push(node.lastOutput.text);
  // A session's other conversations keep their results, which its panel still shows, and their personas, which a switch
  // back to one brings back.
  if (node.kind === 'session') {
    for (const thread of node.threads ?? []) {
      if (thread.persona) texts.push(thread.persona);
      if (thread.lastOutput) texts.push(thread.lastOutput.text);
    }
  }
  return texts.filter(Boolean);
}

/** Whether two versions of a canvas read alike to agentPageHolds and recordAgentPages: the same nodes in the same order,
 *  each with the same texts, results and fingerprints, and the same wires; a node moved or resized changes no hold. */
export function sameAgentInputs(a: Pick<CanvasDocument, 'nodes' | 'edges'>, b: Pick<CanvasDocument, 'nodes' | 'edges'>): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  for (let i = 0; i < a.nodes.length; i += 1) {
    const x = a.nodes[i], y = b.nodes[i];
    if (x === y) continue;
    if (x.id !== y.id || x.kind !== y.kind || x.title !== y.title || x.lastOutput !== y.lastOutput || x.agentWritten !== y.agentWritten) return false;
    if (x.kind === 'session' && y.kind === 'session'
      && (x.persona !== y.persona || x.agentKind !== y.agentKind || x.agentRef !== y.agentRef || x.threads !== y.threads)) return false;
    if (x.kind === 'assemble' && y.kind === 'assemble' && x.template !== y.template) return false;
    if (x.kind === 'form' && y.kind === 'form' && x.fields !== y.fields) return false;
  }
  return a.edges.every((edge, i) => edge.fromNode === b.edges[i].fromNode && edge.toNode === b.edges[i].toNode);
}

/** A node's fingerprints within bounds, as the server keeps them (canvas_agent_words.go pruneAgentWritten): of each text
 *  the first NAMES_MAX names it was kept under, each one of a text the node holds now, and of the rest the STALE_MAX that
 *  came last. */
function bounded(node: CanvasNode, entries: AgentWrittenEntry[]): AgentWrittenEntry[] {
  if (entries.length <= Math.min(STALE_MAX, NAMES_MAX)) return entries;
  const names = new Map<string, number>();
  const first = entries.filter(entry => {
    const count = names.get(entry.h) ?? 0;
    if (count === NAMES_MAX) return false;
    names.set(entry.h, count + 1);
    return true;
  });
  const current = new Set(nodeTexts(node).map(agentTextHash));
  let stale = 0;
  const kept: AgentWrittenEntry[] = [];
  for (let i = first.length - 1; i >= 0; i -= 1) {
    if (!current.has(first[i].h)) {
      if (stale === STALE_MAX) continue;
      stale += 1;
    }
    kept.push(first[i]);
  }
  return kept.length === entries.length ? entries : kept.reverse();
}

function withEntries<T extends CanvasNode>(node: T, entries: AgentWrittenEntry[]): T {
  const kept = bounded(node, entries);
  if (kept.length) return { ...node, agentWritten: kept };
  const bare = { ...node };
  delete bare.agentWritten;
  return bare;
}

/** `next` with each node that is in `from` keeping every fingerprint it has there too: only the server writes them, so a
 *  step back (an undo), a page's own edit or a change carried onto this page never takes one away. The same document
 *  when none is missing. */
export function keepAgentWritten(from: Pick<CanvasDocument, 'nodes'>, next: CanvasDocument): CanvasDocument {
  if (from.nodes === next.nodes) return next;
  const kept = new Map<string, AgentWrittenEntry[]>();
  for (const node of from.nodes) if (node.agentWritten?.length && !kept.has(node.id)) kept.set(node.id, node.agentWritten);
  if (!kept.size) return next;
  let changed = false;
  const nodes = next.nodes.map(node => {
    const old = kept.get(node.id);
    if (!old || node.agentWritten === old) return node;
    const own = node.agentWritten ?? [];
    const have = new Set(own.map(entryKey));
    const missing = old.filter(entry => !have.has(entryKey(entry)));
    if (!missing.length) return node;
    changed = true;
    return withEntries(node, [...missing, ...own]);
  });
  return changed ? { ...next, nodes } : next;
}

/** `next` with each node also keeping those of its fingerprints in `own` (the page's document before a change was carried
 *  onto it) that are of a text the node holds now. The answer to a save brings a node's fingerprints as the server kept
 *  them when the save reached it: one of a value then cleared may have gone as stale, though an undo pressed since brought
 *  the value back. The page keeps it, and its next save sends it again (a person's write may add fingerprints,
 *  canvas_agent_words.go keepAgentWritten). The same document when none comes back. */
export function keepCurrentAgentWritten(own: Pick<CanvasDocument, 'nodes'>, next: CanvasDocument): CanvasDocument {
  if (own.nodes === next.nodes) return next;
  const mine = new Map<string, AgentWrittenEntry[]>();
  for (const node of own.nodes) if (node.agentWritten?.length && !mine.has(node.id)) mine.set(node.id, node.agentWritten);
  if (!mine.size) return next;
  let changed = false;
  const nodes = next.nodes.map(node => {
    const entries = mine.get(node.id);
    if (!entries || node.agentWritten === entries) return node;
    const now = node.agentWritten ?? [];
    const have = new Set(now.map(entryKey));
    const missing = entries.filter(entry => !have.has(entryKey(entry)));
    if (!missing.length) return node;
    const current = new Set(nodeTexts(node).map(agentTextHash));
    const back = missing.filter(entry => current.has(entry.h));
    if (!back.length) return node;
    changed = true;
    return withEntries(node, [...now, ...back]);
  });
  return changed ? { ...next, nodes } : next;
}

/** `next` with each result held for an Agent's words fingerprinted, and each held in `prev`, whether `next` still shows it
 *  or replaced it, as the server does at every write (canvas_agent_words.go recordAgentPages): what an Agent's words made
 *  stays held on this page too, before the server answers and after what fed it is gone, and a held result replaced is
 *  still the Agent's should an undo bring it back. The same document when there is none. */
export function recordAgentPages(prev: CanvasDocument, next: CanvasDocument): CanvasDocument {
  const carries = (doc: CanvasDocument) => doc.nodes.some(node => node.agentWritten?.length || node.lastOutput?.by);
  // A node moved or resized holds nothing new (a drag commits on every frame).
  if ((!carries(next) && !carries(prev)) || (prev !== next && sameAgentInputs(prev, next))) return next;
  const holds = agentPageHolds(next.nodes, next.edges);
  let before: ReadonlyMap<string, AgentPageHold> | null = null;
  const prior = new Map<string, CanvasNode>();
  for (const node of prev.nodes) if (!prior.has(node.id)) prior.set(node.id, node);
  const seen = new Set<string>();
  let changed = false;
  const nodes = next.nodes.map(node => {
    if (seen.has(node.id)) return node;
    seen.add(node.id);
    const entries = [...(node.agentWritten ?? [])];
    let keys: Set<string> | null = null;
    const add = (text: string | undefined, names: ReadonlyArray<string> | undefined) => {
      if (!text || !names?.length) return;
      const h = agentTextHash(text);
      keys ??= new Set(entries.map(entryKey));
      for (const by of names) {
        const entry = { h, by };
        if (keys.has(entryKey(entry))) continue;
        keys.add(entryKey(entry));
        entries.push(entry);
      }
    };
    add(node.lastOutput?.text, holds.get(node.id)?.names);
    const was = prior.get(node.id)?.lastOutput;
    if (was) {
      before ??= agentPageHolds(prev.nodes, prev.edges);
      add(was.text, before.get(node.id)?.names);
    }
    if (entries.length === (node.agentWritten?.length ?? 0)) return node;
    changed = true;
    return withEntries(node, entries);
  });
  return changed ? { ...next, nodes } : next;
}

const NO_HOLDS: ReadonlyMap<string, AgentPageHold> = new Map();
/** The canvas's agentPageHolds, for the views that show a node's page (CanvasSurface provides it). */
export const AgentPagesContext = createContext<ReadonlyMap<string, AgentPageHold>>(NO_HOLDS);

/** Why a node's current result is held for an invited Agent, if it is. */
export function useAgentPage(nodeId: string | null | undefined): AgentPageHold | undefined {
  const holds = useContext(AgentPagesContext);
  return nodeId ? holds.get(nodeId) : undefined;
}

/** Whether a node's result is held, for an invited Agent (agentPageHolds) or a market Agent's words (marketPages.ts): a file
 *  it stored reaches only a page held itself (canvasAssets.ts canvasResolver, liveDocument.ts buildLiveDocument). */
export function useHeldPageNodes(): (nodeId: string) => boolean {
  const agents = useContext(AgentPagesContext);
  const market = useContext(MarketPagesContext);
  return useCallback((nodeId: string) => agents.has(nodeId) || market.has(nodeId), [agents, market]);
}

/** What a view hands a held page (ArtifactPreview, LivePage): the Agent that handed it in, or the Agents whose words it is
 *  made from. */
export function agentPageProps(hold: AgentPageHold | undefined): { handedInBy?: string; agentWords?: string[] } {
  if (!hold) return {};
  return hold.handedIn ? { handedInBy: hold.names[0] ?? '' } : { agentWords: hold.names };
}

/** The Agents a node's fingerprints say wrote a text (an earlier Session's result, say), none twice; undefined for none. */
export function fingerprintNames(node: CanvasNode, text: string): string[] | undefined {
  if (!text || !node.agentWritten?.length) return undefined;
  const h = agentTextHash(text);
  const names = [...new Set(node.agentWritten.filter(entry => entry.h === h).map(entry => entry.by))].sort(byCodePoint);
  return names.length ? names : undefined;
}

/** The Agents a held page's line names, as agentDisplayName shows them, none twice. */
export function agentNamesShown(names: ReadonlyArray<string>): string[] {
  return [...new Set(names.map(agentDisplayName).filter(Boolean))];
}

/** Several Agents' names in a sentence: 「Claude Code」、「Codex」 or “Claude Code”, “Codex”. */
export function agentNamesList(names: ReadonlyArray<string>, locale: 'zh' | 'en'): string {
  return locale === 'zh' ? names.map(name => `「${name}」`).join('、') : names.map(name => `“${name}”`).join(', ');
}
