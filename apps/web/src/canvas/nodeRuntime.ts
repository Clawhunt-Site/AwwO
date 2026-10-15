// AwwO, not the reader, chooses the runtime a node runs its model on (owner decision 2026-10-15: every node ended up
// switched to OpenAI Agents by hand, so the choice is made automatically and is never shown). openai-agents takes every
// model it offers: on Pi a Bedrock call that has sent nothing for 300 s is cut off (Pi's own request timeout covers the
// wait for Bedrock's first stream event, and Claude Opus 5.5 thinks longer than that before it writes) and a reply cut
// at the output limit reads as a runtime failure, while openai-agents bounds a call by the run's own limit and reports
// output_limit. Pi keeps the models only it offers (the Bedrock models without tool support). The server already sets a
// node with no runtime up on openai-agents (node_setup.go defaultRuntime); this is the same choice for a node that names
// a model, made where the model is chosen and again for every node a canvas run executes.
import type { CanvasDocument, CanvasNode, SessionNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';

/** The runtimes a node may run on, most preferred first. A runtime missing here comes after them. */
export const AUTOMATIC_RUNTIME_ORDER: ReadonlyArray<string> = ['openai-agents', 'pi'];

/** One model a runtime offers this workspace (a palette entry). */
export interface RuntimeEntry { runtime: string; model: string; available: boolean }

function rank(runtime: string): number {
  const at = AUTOMATIC_RUNTIME_ORDER.indexOf(runtime);
  return at < 0 ? AUTOMATIC_RUNTIME_ORDER.length : at;
}

/** The entry a node runs `model` on: the ready entry of the most preferred runtime that offers it; none when no ready
 *  runtime offers the model. */
export function automaticEntry<T extends RuntimeEntry>(model: string, entries: ReadonlyArray<T>): T | undefined {
  let best: T | undefined;
  for (const entry of entries) {
    if (!model || entry.model !== model || !entry.available || !entry.runtime) continue;
    if (!best || rank(entry.runtime) < rank(best.runtime)) best = entry;
  }
  return best;
}

/** One entry per model, where its first entry stood: the automatic one, or, when no runtime offering it is ready, its
 *  first entry (so a model the workspace lists but cannot run now still shows as unavailable). */
export function automaticEntries<T extends RuntimeEntry>(entries: ReadonlyArray<T>): T[] {
  const at = new Map<string, number>();
  const result: T[] = [];
  for (const entry of entries) {
    const index = at.get(entry.model);
    if (index === undefined) { at.set(entry.model, result.length); result.push(entry); continue; }
    const current = result[index];
    if (entry.available && (!current.available || rank(entry.runtime) < rank(current.runtime))) result[index] = entry;
  }
  return result;
}

/** Whether AwwO sets this node's runtime: an Agent node it sets up itself. A team's members and a workspace Agent bring
 *  their own runtimes; an image, video or 3D node runs on the media service. A hosted node's binding is the Agent AwwO's
 *  own setup made for it (node_setup.go), so it does not count: setting the node up again on another runtime is what a
 *  model change does too. */
export function choosesRuntime(node: CanvasNode): node is SessionNode {
  return node.kind === 'session' && !mediaKindOf(node.agentKind) && !node.team && !node.agentRef;
}

/** The reasoning-effort levels a runtime's entry for a model advertises (empty: none). */
export type EffortLevels = (runtime: string, model: string) => ReadonlyArray<string>;

/**
 * The node on its automatic runtime, or the node itself when it is already there, names no model, or names one no ready
 * runtime offers (the server then says why it cannot run). A node on Pi with no model runs the workspace's default
 * model, which the server sets up on openai-agents once the runtime is left to it. The effort stays when the new
 * runtime's entry for the model advertises it; otherwise it goes back to the model's own default.
 */
export function withAutomaticRuntime(node: SessionNode, entries: ReadonlyArray<RuntimeEntry>, efforts: EffortLevels): SessionNode {
  if (!choosesRuntime(node)) return node;
  if (!node.model) {
    const defaultReady = node.runtime === 'pi' && entries.some(entry => entry.runtime === AUTOMATIC_RUNTIME_ORDER[0] && entry.available);
    return defaultReady ? { ...node, runtime: '', effort: '' } : node;
  }
  const entry = automaticEntry(node.model, entries);
  if (!entry || entry.runtime === node.runtime) return node;
  const effort = node.effort && efforts(entry.runtime, entry.model).includes(node.effort) ? node.effort : '';
  return { ...node, runtime: entry.runtime, effort };
}

/** The document with every node among `ids` (every node when `ids` is absent) on its automatic runtime; the same
 *  document when nothing moves. */
export function withAutomaticRuntimes(doc: CanvasDocument, ids: ReadonlyArray<string> | undefined, entries: ReadonlyArray<RuntimeEntry>,
  efforts: EffortLevels): CanvasDocument {
  if (!entries.length) return doc;
  const scope = ids ? new Set(ids) : null;
  let changed = false;
  const nodes = doc.nodes.map(node => {
    if (node.kind !== 'session' || (scope && !scope.has(node.id))) return node;
    const next = withAutomaticRuntime(node, entries, efforts);
    if (next !== node) changed = true;
    return next;
  });
  return changed ? { ...doc, nodes } : doc;
}
