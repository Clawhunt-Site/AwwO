import { isMarketReference, type CanvasDocument, type CanvasEdge, type CanvasNode, type NodeOutput } from './canvasDoc';
import type { ContractField } from './nodeContracts';
import { mediaMissingText } from './mediaOutput';
import { nodeTeamFingerprint } from './nodeTeam';
import { isMediaSessionNode, isMediaSourceNode } from './ports';
import { taskFrameFingerprint } from './taskFrame';

function fieldKey(field: ContractField, output = false): unknown[] {
  return [field.id, field.label, field.type, field.required, field.value, field.help?.trim() || '', output ? field.placeholder?.trim() || '' : ''];
}

/** What a node is asked: everything that shapes its task in a prompt or what it delivers. Layout and previews are not. */
function askKey(node: CanvasNode): string {
  if (node.kind === 'form') {
    return JSON.stringify([node.kind, node.title, node.fields.map((field) => [field.id, field.label, field.value])]);
  }
  if (node.kind === 'assemble') {
    return JSON.stringify([node.kind, node.title, node.template, node.fileName ?? '', node.contract.version,
      node.contract.inputs.map(field => fieldKey(field)), node.contract.outputs.map(field => fieldKey(field, true))]);
  }
  // An edit is its timeline; its title names its film's files in a downstream prompt.
  if (node.kind === 'edit') return JSON.stringify([node.kind, node.title, node.timeline]);
  const contract = node.contract
    ? [node.contract.version, node.contract.inputs.map(field => fieldKey(field)), node.contract.outputs.map(field => fieldKey(field, true))]
    : null;
  return JSON.stringify([node.kind, node.title, node.agentKind, node.persona, contract, taskFrameFingerprint(node.taskFrame)]);
}

/** How AwwO's engine answers a session: its runtime, model, effort, bound Agent, conversation, team and Agent reference.
 *  A run's result comes from them; a result handed in by hand does not. Other kinds have none. */
function engineKey(node: CanvasNode): string {
  if (node.kind !== 'session') return '';
  const binding = node.binding ? [node.binding.companyId, node.binding.agentId, node.binding.agentName] : null;
  return JSON.stringify([node.runtime, node.model, node.effort, binding, node.issueId, node.activeThreadId || 'default',
    nodeTeamFingerprint(node.team), node.agentRef ?? null]);
}

function outputKey(output: NodeOutput | null | undefined): string {
  return JSON.stringify(output ? [output.text, output.source, output.at, output.partial === true] : null);
}

/** What a node gives the nodes wired to it: a form its fields, as they are now; any other node its result, unless that is
 *  a failed run's evidence, which no reader is given. */
function hasResult(node: CanvasNode | undefined): boolean {
  return node?.kind === 'form' || Boolean(node?.lastOutput && !node.lastOutput.partial);
}

/** What a media node or an edit with no result gives a text input it feeds: a note that it made no file, which names it
 *  (mediaMissingText), so a run goes on without it. None for any other node, or one with a result. */
function missingNote(node: CanvasNode | undefined): string | null {
  return node && isMediaSourceNode(node) && !hasResult(node) ? mediaMissingText(node) : null;
}

/** What a node gives the nodes wired to it besides its result's own text, which a change of its settings can change while
 *  its result stays (a case recording through any setting, a hand-in through its engine): the name their prompts quote it
 *  by and its kind (a media delivery's lines name both), the frame a market Agent's text is put in, and the fields their
 *  wires read out of its result and which of them it must hold (a result missing a required one is refused upstream);
 *  for a media node or an edit that made nothing, its note. Nothing for a node with no
 *  result otherwise, nor for a form, which passes its fields on whenever it is reached. */
function gives(node: CanvasNode | undefined): string | null {
  if (!node || node.kind === 'form') return null;
  if (!hasResult(node)) return missingNote(node);
  const session = node.kind === 'session' ? node : null;
  const fields = (session ? session.contract : node.kind === 'assemble' ? node.contract : undefined)?.outputs.map(field => [field.id, field.type, field.required]) ?? null;
  return JSON.stringify([node.title, session ? session.agentKind : node.kind, Boolean(session && isMarketReference(session.agentRef)), fields]);
}

/** Saved feedback is inactive in Workflow, so it cannot invalidate same-turn outputs. */
function executionEdges(doc: CanvasDocument): CanvasEdge[] {
  return doc.edges.filter(edge => edge.kind !== 'feedback' || doc.execution?.mode === 'review');
}

/** Multiplicity matters to prompt input, while storage ids and wire-list order do not. The ports of a node in `moved` are
 *  left out: its wires were carried onto its new deliverable form's ports, each to the input or output it now has. */
function edgeCounts(edges: ReadonlyArray<CanvasEdge>, moved: ReadonlySet<string>): Map<string, { count: number; edge: CanvasEdge }> {
  const counts = new Map<string, { count: number; edge: CanvasEdge }>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.fromNode, moved.has(edge.fromNode) ? '' : edge.fromPort, edge.toNode, moved.has(edge.toNode) ? '' : edge.toPort,
      edge.dataType, edge.kind ?? 'data']);
    counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, edge });
  }
  return counts;
}

/**
 * A session that takes its first deliverable form while it has no result (deliverableWires.ts carries its wires onto the
 * form's ports): the nodes it feeds could not have run on it, as a text session without a result holds its readers back,
 * so moving a wire from its `result` to the form's output changes nothing they were given. A media node is not one: its
 * wires are not carried, and a picture it has not made leaves its readers a note instead of holding them back.
 */
function movedToForm(old: CanvasNode | undefined, node: CanvasNode): boolean {
  return old?.kind === 'session' && !old.contract && node.kind === 'session' && Boolean(node.contract) && !hasResult(old) && !isMediaSessionNode(old);
}

/** Why a node's result may be stale. `hard`: for more than its own engine settings (a hand-in goes only then). `fed`: a
 *  result wired into it was replaced or went (the only staleness a case recording has). */
interface Reach { hard: boolean; fed: boolean }

/**
 * Clear stale results after a document mutation, without mutating either document.
 *
 * A result is stale when something it was made from changed, and staleness travels only along results:
 * - A node's own settings make its own result stale. A wire into a node, added, removed or changed, makes the node's
 *   result stale whatever its source: a wire changes what the node is given before its source has a result (it takes the
 *   place of an input's own value, and a picture not made yet leaves a note). A deleted node makes its readers' results
 *   stale, and so does a change of what a node gives them besides its result's text (`gives`: the name they quote it by,
 *   the fields they read out of it, a media node's note when it made nothing), even where its own result stays. A replaced output
 *   (manual or run, including a failed run's evidence and a removed output, and a first result, but not evidence where
 *   there was nothing) makes every result below it stale; a run's recovery reads the results it lays over the canvas
 *   through this too (runRecoveryDocument.ts). A change of the run policy makes every result stale.
 * - Any other staleness travels only along results: a node whose result is taken back makes its readers' results stale
 *   in turn, and a node with no result (it never ran, or what it made is gone already) made nothing its readers used, so
 *   a change of its settings, or one that reaches it, stops there. Picking a model for a node that never ran takes
 *   nothing back below it (an agent's hand-in below it was emptied so on 2026-11-07, while the 多人同屏 tutorial was
 *   recorded), nor do its wires carried onto the ports of its first deliverable form (movedToForm); its first result,
 *   when it comes, replaces what was there.
 *
 * Traversal includes both graphs, so deletion cannot hide an old dependency. An explicit new manual publication is
 * retained even when a simultaneous edit would invalidate that node. The caller validates manual publications before
 * applying this freshness policy.
 *
 * A result handed in by hand (`source: 'manual'`: published by a person, picked out of a conversation, or handed in by an
 * agent over MCP) was not made by its node's engine, so the node's runtime, model, effort, bound Agent, conversation, team
 * and Agent reference leave it in place (in 多人同屏 only a person can pick a node's model, often after an agent has handed
 * its result in). Opening another conversation publishes none (nodeThreads.ts), and on a node already bound to an Agent
 * another runtime, model, effort or Agent opens one (CanvasSurface saveInspector), so in practice a hand-in stays through
 * them while its node is not bound (an agent's new node is not, until it is set up or run). What the node is asked (its title, task,
 * kind, deliverable form or task frame), a wire into it, and a result upstream replaced or taken back take it back as
 * they take back a run's result.
 *
 * A case recording (`source: 'case'`) is a copied case's delivery, kept for reference rather than produced by this node's
 * settings, so settings, wires and structure leave it in place; only a replaced upstream output, on which it no longer
 * stands, clears it (and so, in turn, the recordings and results made from it).
 */
export function invalidateOutputs(prev: CanvasDocument, next: CanvasDocument): CanvasDocument {
  const before = new Map(prev.nodes.map((node) => [node.id, node]));
  const after = new Map(next.nodes.map((node) => [node.id, node]));
  const previousEdges = executionEdges(prev);
  const nextEdges = executionEdges(next);
  const readers = new Map<string, Set<string>>();
  for (const edge of [...previousEdges, ...nextEdges]) {
    const targets = readers.get(edge.fromNode) ?? new Set<string>();
    targets.add(edge.toNode);
    readers.set(edge.fromNode, targets);
  }

  const reached = new Map<string, Reach>();
  const queue: string[] = [];
  // A node is looked at again whenever it is reached for a stronger reason, so that a hand-in kept for an engine setting
  // still goes when a result it stood on goes too. Reasons only grow, so this ends, cycles included.
  const reach = (id: string, hard: boolean, fed = false) => {
    const known = reached.get(id);
    if (known && (known.hard || !hard) && (known.fed || !fed)) return;
    reached.set(id, { hard: hard || Boolean(known?.hard), fed: fed || Boolean(known?.fed) });
    queue.push(id);
  };
  const reachReaders = (id: string, fed: boolean) => { for (const reader of readers.get(id) ?? []) reach(reader, true, fed); };

  if (JSON.stringify(prev.execution) !== JSON.stringify(next.execution)) next.nodes.forEach(node => reach(node.id, true));
  for (const node of prev.nodes) {
    if (!after.has(node.id)) reachReaders(node.id, false);
  }
  const published = new Set<string>();
  for (const node of next.nodes) {
    const old = before.get(node.id);
    if (old && askKey(old) !== askKey(node)) reach(node.id, true);
    else if (old && engineKey(old) !== engineKey(node)) reach(node.id, false);
    // A change of what it gives its readers reaches them, whether or not its own result stays.
    if (old && gives(old) !== gives(node)) reachReaders(node.id, false);
    if (outputKey(old?.lastOutput) !== outputKey(node.lastOutput)) {
      if (node.lastOutput?.source === 'manual') published.add(node.id);
      // A failed run's evidence where there was nothing gives its readers nothing new.
      if (hasResult(old) || hasResult(node)) reachReaders(node.id, true);
    }
  }

  const moved = new Set(next.nodes.filter(node => movedToForm(before.get(node.id), node)).map(node => node.id));
  const oldEdges = edgeCounts(previousEdges, moved);
  const newEdges = edgeCounts(nextEdges, moved);
  for (const key of new Set([...oldEdges.keys(), ...newEdges.keys()])) {
    const old = oldEdges.get(key);
    const current = newEdges.get(key);
    if (old?.count !== current?.count) reach((current ?? old)!.edge.toNode, true);
  }

  const takesBack = (node: CanvasNode, why: Reach): boolean => {
    if (published.has(node.id) || node.lastOutput == null) return false;
    if (node.lastOutput.source === 'case') return why.fed;
    if (node.lastOutput.source === 'manual') return why.hard;
    return true;
  };
  for (let i = 0; i < queue.length; i += 1) {
    const node = after.get(queue[i]);
    const why = reached.get(queue[i])!;
    // A replaced result reaches everything below it, as the results there will be made from it again. Anything else is
    // passed on by a form, whose fields are what it gives, or by a result its readers were given and this change takes
    // back.
    if (!node || !(why.fed || node.kind === 'form' || (takesBack(node, why) && !node.lastOutput!.partial))) continue;
    reachReaders(node.id, why.fed);
  }

  let changed = false;
  const nodes = next.nodes.map((node) => {
    const why = reached.get(node.id);
    if (!why || !takesBack(node, why)) return node;
    changed = true;
    return { ...node, lastOutput: null };
  });
  return changed ? { ...next, nodes } : next;
}
