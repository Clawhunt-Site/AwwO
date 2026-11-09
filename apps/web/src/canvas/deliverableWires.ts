import type { CanvasEdge, CanvasNode } from './canvasDoc';
import type { CanvasTranslate } from './i18n';
import type { ContractField } from './nodeContracts';
import { canFeed, edgeId, isMediaSessionNode, portsFor, type PortSpec } from './ports';

export interface CarriedWires {
  node: CanvasNode;
  edges: CanvasEdge[];
  /** The wires the node's new ports cannot carry: they go with the edit, and the canvas says which. */
  dropped: CanvasEdge[];
}

const port = (node: CanvasNode, side: PortSpec['side'], id: string) => portsFor(node).find(spec => spec.side === side && spec.id === id);

/**
 * A session's wires when it takes its first deliverable form (a contract). Its ports become the form's (`portsFor`), so a
 * wire into its `context` or out of its `result` would lose an end and go (多人同屏, 2026-11-07: a person added the Game
 * deliverable to a session the agents had wired, and every one of its wires went, unsaid). They are carried instead:
 * - each wire into `context` gets an input of its own (an input of a form takes one wire): a text field named after the
 *   node it comes from, and not required, so an empty answer upstream reads as empty, as it did in `context`, instead of
 *   stopping the node. They come in the order a run reads them (top to bottom, then left to right), so its prompt keeps
 *   its order;
 * - each wire out of `result` comes from the form's first output its reader's input can take.
 * A wire neither can carry (a picture or a voice into the node, or a reader no output of the form can feed) is returned
 * in `dropped`. So is every wire of an image, video, audio or 3D node: the API still runs one as a generation, which reads
 * only its `context`, `reference` and `audio` wires (graph_media.go graphMediaPrompt), so a wire carried onto its form
 * would show a connection its generation never reads. A node that had a form already, or has none now, keeps its wires
 * as they are (a field deleted or retyped takes its own wires, as the board shows).
 */
export function carryWiresIntoContract(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>, before: CanvasNode, after: CanvasNode,
  fallbackLabel: string): CarriedWires {
  if (before.kind !== 'session' || before.contract || after.kind !== 'session' || !after.contract) return { node: after, edges: [...edges], dropped: [] };
  const byId = new Map(nodes.map(node => [node.id, node]));
  // Only a wire the canvas showed is carried or named: one whose ends were gone already is left for the canvas to drop
  // with the rest of its kind (reconcileEdges), as before.
  const ends = (edge: CanvasEdge) => {
    const source = edge.fromNode === before.id ? before : byId.get(edge.fromNode);
    const target = edge.toNode === before.id ? before : byId.get(edge.toNode);
    const out = source && port(source, 'output', edge.fromPort);
    const input = target && port(target, 'input', edge.toPort);
    return source && out && input && canFeed(source, out, input) ? { source, out, input } : null;
  };
  const into = edges.filter(edge => edge.toNode === before.id && edge.fromNode !== before.id && ends(edge))
    .sort((a, b) => {
      const na = byId.get(a.fromNode)!;
      const nb = byId.get(b.fromNode)!;
      if (na.y !== nb.y) return na.y - nb.y;
      if (na.x !== nb.x) return na.x - nb.x;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const inputs: ContractField[] = [...after.contract.inputs];
  const taken = new Set(inputs.map(field => field.id));
  const carried = new Map<CanvasEdge, CanvasEdge | null>();
  const media = isMediaSessionNode(before);
  const text: PortSpec = { id: 'in:', side: 'input', dataType: 'text' };
  for (const edge of into) {
    const { source, out } = ends(edge)!;
    // A picture or a voice has no field of a form to go to.
    if (media || edge.toPort !== 'context' || !canFeed(source, out, text)) { carried.set(edge, null); continue; }
    let id = 'context';
    for (let n = 2; taken.has(id); n += 1) id = `context_${n}`;
    taken.add(id);
    inputs.push({ id, label: source.title.trim() || fallbackLabel, type: 'text', required: false, value: '' });
    const toPort = `in:${id}`;
    carried.set(edge, { ...edge, id: edgeId({ nodeId: edge.fromNode, portId: edge.fromPort }, { nodeId: after.id, portId: toPort }), toPort });
  }
  const node: CanvasNode = inputs.length === after.contract.inputs.length ? after : { ...after, contract: { ...after.contract, inputs } };
  const outputs = portsFor(node).filter(spec => spec.side === 'output');
  for (const edge of edges) {
    if (edge.fromNode !== before.id || edge.toNode === before.id) continue;
    const shown = ends(edge);
    if (!shown) continue;
    const out = media ? undefined : outputs.find(spec => canFeed(node, spec, shown.input));
    carried.set(edge, out ? { ...edge, id: edgeId({ nodeId: after.id, portId: out.id }, { nodeId: edge.toNode, portId: edge.toPort }),
      fromPort: out.id, dataType: out.dataType } : null);
  }
  const dropped: CanvasEdge[] = [];
  const kept: CanvasEdge[] = [];
  for (const edge of edges) {
    if (!carried.has(edge)) { kept.push(edge); continue; }
    const next = carried.get(edge);
    if (next) kept.push(next); else dropped.push(edge);
  }
  return { node, edges: kept, dropped };
}

/** What the canvas says of the wires a new deliverable form could not carry, each by the nodes it joined
 *  (「Build the game → Review」), as the document had them before the edit. */
export function droppedWiresNote(t: CanvasTranslate, nodes: ReadonlyArray<CanvasNode>, before: ReadonlyArray<CanvasNode>, dropped: ReadonlyArray<CanvasEdge>): string {
  const title = (id: string) => (nodes.find(node => node.id === id) ?? before.find(node => node.id === id))?.title.trim() || id;
  const wires = dropped.map(edge => `${title(edge.fromNode)} → ${title(edge.toNode)}`).join(t('surface.deliverableWiresSeparator'));
  return dropped.length === 1 ? t('surface.deliverableWireDroppedOne', { wires }) : t('surface.deliverableWiresDroppedMany', { count: dropped.length, wires });
}
