// Typed ports and wires for the session canvas.
//
// Ported from the previous canvas's node model (since-deleted apps/web/src/studio/model.ts) and the
// workflow document's port/reconcile helpers, NARROWED to one node family. The old model
// carried a `family` discriminator because three unrelated node kinds shared a surface;
// that fusion is gone. Now every node is either an agent-session tile or a user-authored
// form, so ports are DERIVED from the node itself (portsFor) rather than stored alongside it
// — there is no second source of truth that could drift from the node's own configuration.
//
// Data types are closed: 'text' is the lingua franca (form output, LLM/coding output, every
// session's context input); image sessions additionally take an image reference and emit
// images. The old cross-family 'any' wildcard is deliberately NOT carried over: with one
// family no port can ever emit 'any', so keeping the wildcard would only be a hole through
// which a type-mismatched wire could be smuggled in from stored data.
// Contract fields additionally expose number, boolean and file channels; Markdown shares text.
//
// Coordinates are one unified world system; wires are drawn directly in world coords via
// `edgeBezierPath`, origin-agnostic.

import type { CanvasEdge, CanvasNode } from './canvasDoc';
import type { Bounds } from './viewport';
import { boundsOfBoxes } from './viewport';

export type PortSide = 'input' | 'output';

/** Closed set of channels a wire can carry. */
export type DataType = 'text' | 'image' | 'video' | 'number' | 'boolean' | 'file';

export interface PortSpec {
  id: string;
  side: PortSide;
  dataType: DataType;
  label?: string;
  /**
   * An input that accepts MANY upstreams at once (outputs always fan out freely).
   *
   * `context` is multi because that is the whole point of wiring a graph: "combine the plan and
   * the brand voice into the implementation" is the shape people actually build. The run engine
   * was always written for it — runGraph collects every incoming edge and buildNodeMessage labels
   * each upstream by source — but canConnect used to refuse the second wire, so the engine's
   * capability was unreachable from the canvas.
   *
   * `reference` (an image session's source image) stays single: it is one picture, not a pile.
   */
  multi?: boolean;
}

export interface PortRef {
  nodeId: string;
  portId: string;
}

/**
 * The typed ports a node exposes, derived from its own kind/agentKind. Order is stable and
 * meaningful: it drives the vertical anchor layout in `portAnchorWorld`.
 *
 * - form:               output 'data' (text)
 * - contract session:   input 'in:<id>' / output 'out:<id>' with each field's declared type
 * - session llm/coding: input 'context' (text, MULTI)                       → output 'result' (text)
 * - session image:      input 'context' (text, MULTI) + 'reference' (image) → output 'result' (image)
 * - session model3d:    input 'context' (text, MULTI) + 'reference' (image) → output 'result' (file)
 */
export function portsFor(node: CanvasNode): PortSpec[] {
  if (node.kind === 'form') {
    return [{ id: 'data', side: 'output', dataType: 'text' }];
  }
  if (node.contract) {
    return [
      ...node.contract.inputs.map((field): PortSpec => ({
        id: `in:${field.id}`, side: 'input', label: field.label,
        dataType: field.type === 'markdown' || field.type === 'html' ? 'text' : field.type,
      })),
      ...node.contract.outputs.map((field): PortSpec => ({
        id: `out:${field.id}`, side: 'output', label: field.label,
        dataType: field.type === 'markdown' || field.type === 'html' ? 'text' : field.type,
      })),
    ];
  }
  const ports: PortSpec[] = [{ id: 'context', side: 'input', dataType: 'text', multi: true }];
  // A picture wired here is the generation's reference where the node's model takes one (image edit, image-to-3D).
  if (node.agentKind === 'image' || node.agentKind === 'video' || node.agentKind === 'model3d') ports.push({ id: 'reference', side: 'input', dataType: 'image' });
  ports.push({ id: 'result', side: 'output', dataType: node.agentKind === 'image' || node.agentKind === 'video' ? node.agentKind
    : node.agentKind === 'model3d' ? 'file' : 'text' });
  return ports;
}

function portSpec(node: CanvasNode, side: PortSide, portId: string): PortSpec | undefined {
  return portsFor(node).find((p) => p.side === side && p.id === portId);
}

/**
 * World-space anchor of a port on its node: inputs sit on the left edge, outputs on the right,
 * each side's ports distributed evenly down the box.
 *
 * Returns null when the node does not expose that port (e.g. 'reference' after an image
 * session was switched to LLM). Callers must skip drawing rather than fall back to a made-up
 * point — a wire rendered from an invented anchor would show a connection that does not exist.
 * `reconcileEdges` already removes such wires from the document, so a null here means the
 * caller is drawing from unreconciled state.
 */
export function portAnchorWorld(node: CanvasNode, portId: string): { x: number; y: number } | null {
  const ports = portsFor(node);
  const spec = ports.find((p) => p.id === portId);
  if (!spec) return null;
  const sameSide = ports.filter((p) => p.side === spec.side);
  const index = sameSide.indexOf(spec);
  const x = spec.side === 'input' ? node.x : node.x + node.w;
  const y = node.y + (node.h * (index + 1)) / (sameSide.length + 1);
  return { x, y };
}

/** AABB of all nodes (for fit-to-content), via the shared viewport box math. */
export function boundsOfNodes(nodes: ReadonlyArray<CanvasNode>): Bounds {
  return boundsOfBoxes(nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })));
}

/** Are two port data types compatible for a connection? Exact match (see the header note). */
export function arePortTypesCompatible(outType: DataType, inType: DataType): boolean {
  return outType === inType;
}

/** Is `node` an image, video or 3D node (its `result` is the generated files)? */
export function isMediaSessionNode(node: CanvasNode): boolean {
  return node.kind === 'session' && !node.contract && (node.agentKind === 'image' || node.agentKind === 'video' || node.agentKind === 'model3d');
}

/**
 * May this output feed this input? The same type, or a media node's result (a picture, a clip, a 3D model) into a text
 * input: that input then reads the files the generation stored, by the paths a page names them with, so a canvas run
 * hands its media to the page that uses them. The API applies the same rule to a run's graph (edgeTypesFit).
 */
export function canFeed(fromNode: CanvasNode, out: PortSpec, inp: PortSpec): boolean {
  if (arePortTypesCompatible(out.dataType, inp.dataType)) return true;
  return inp.dataType === 'text' && out.id === 'result' && isMediaSessionNode(fromNode)
    && (out.dataType === 'image' || out.dataType === 'video' || out.dataType === 'file');
}

/**
 * Is this wire canFeed's one cross-type case, a media node's result feeding a text input? Such a wire never holds its
 * target back: a file that was not made leaves that input a note (mediaMissingText) and the node goes on without it, as
 * the API's scheduler does (softMediaEdge), so a page is never lost for one picture.
 */
export function isSoftMediaFeed(fromNode: CanvasNode, toNode: CanvasNode, edge: { fromPort: string; toPort: string }): boolean {
  const out = portSpec(fromNode, 'output', edge.fromPort);
  const inp = portSpec(toNode, 'input', edge.toPort);
  return !!out && !!inp && !arePortTypesCompatible(out.dataType, inp.dataType) && canFeed(fromNode, out, inp);
}

/**
 * Can we connect `from` to `to`?
 *  - both ports exist on their nodes; `from` resolves to an OUTPUT, `to` to an INPUT,
 *  - different nodes (no self-loop),
 *  - compatible data types,
 *  - the exact wire does not already exist (re-connecting the same pair is a no-op, not a dupe),
 *  - a SINGLE input isn't already occupied; a MULTI input accepts as many upstreams as you like.
 */
export function canConnect(
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
  from: PortRef,
  to: PortRef,
): boolean {
  if (from.nodeId === to.nodeId) return false;
  const fromNode = nodes.find((n) => n.id === from.nodeId);
  const toNode = nodes.find((n) => n.id === to.nodeId);
  if (!fromNode || !toNode) return false;
  const out = portSpec(fromNode, 'output', from.portId);
  const inp = portSpec(toNode, 'input', to.portId);
  if (!out || !inp) return false;
  if (!canFeed(fromNode, out, inp)) return false;
  const already = edges.some(
    (e) =>
      e.toNode === to.nodeId && e.toPort === to.portId && e.fromNode === from.nodeId && e.fromPort === from.portId,
  );
  if (already) return false;
  if (!inp.multi) {
    const occupied = edges.some((e) => e.toNode === to.nodeId && e.toPort === to.portId);
    if (occupied) return false;
  }
  return true;
}

/** Create an edge id stable from its endpoints (dedupe-friendly). */
export function edgeId(from: PortRef, to: PortRef): string {
  return `${from.nodeId}:${from.portId}->${to.nodeId}:${to.portId}`;
}

/**
 * Re-validate wires against the CURRENT node/port specs and re-derive each edge's dataType
 * from its real source port (never trust a stored or guessed type). Drops edges whose endpoint
 * node or port no longer exists (e.g. an image session's 'reference' input after the node was
 * switched to LLM) or whose port types no longer match. Pure — used by both the persistence
 * path and in-memory cleanup after a node-config change.
 */
export function reconcileEdges(
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
): CanvasEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: CanvasEdge[] = [];
  for (const e of edges) {
    const fromNode = byId.get(e.fromNode);
    const toNode = byId.get(e.toNode);
    if (!fromNode || !toNode) continue;
    const outSpec = portSpec(fromNode, 'output', e.fromPort);
    const inSpec = portSpec(toNode, 'input', e.toPort);
    if (!outSpec || !inSpec) continue;
    if (!canFeed(fromNode, outSpec, inSpec)) continue;
    out.push({ ...e, dataType: outSpec.dataType });
  }
  return out;
}

/**
 * SVG cubic-bezier path between two world points with horizontal control handles — drawn
 * directly in world coordinates (origin-agnostic). The handle length grows with horizontal
 * distance but never collapses below a floor, so near-vertical or backward links still curve
 * legibly.
 */
export function edgeBezierPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}
