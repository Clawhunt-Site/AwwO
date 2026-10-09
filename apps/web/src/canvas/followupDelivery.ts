import type { CanvasDocument, CanvasNode } from './canvasDoc';
import { parseContractOutput, type NodeContract } from './nodeContracts';

/** A conversation publishes only an explicit, complete set of declared output fields.
 * Plain answers remain conversation even when a one-field contract accepts arbitrary text. */
export function followupDeliveryContract(node: CanvasNode, output: string): NodeContract | undefined {
  if (node.kind !== 'session' || !node.contract?.outputs.length) return undefined;
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !node.contract.outputs.some(field => Object.hasOwn(value, field.id))) return undefined;
  const parsed = parseContractOutput(node.contract, output);
  if (parsed.errors.length || !Object.values(parsed.values).some(text => text.trim())) return undefined;
  return { version: 1, inputs: [], outputs: node.contract.outputs.map(field => ({ ...field, value: '' })) };
}

/** An old graph cannot restore either a revised node or results invalidated by that revision. */
export function supersededGraphNodes(doc: CanvasDocument, graph?: { canvasId: string; documentVersion?: number }): Set<string> {
  const superseded = new Set(doc.nodes.filter(node => graph?.documentVersion != null && graph.documentVersion >= 1
    && node.lastOutput?.supersedesGraphCanvasId === graph.canvasId
    && (node.lastOutput?.supersedesThroughGraphVersion ?? 0) >= graph.documentVersion).map(node => node.id));
  const edges = doc.edges.filter(edge => edge.kind !== 'feedback' || doc.execution?.mode === 'review');
  const queue = [...superseded];
  for (let i = 0; i < queue.length; i += 1) for (const edge of edges) {
    if (edge.fromNode !== queue[i] || superseded.has(edge.toNode)) continue;
    superseded.add(edge.toNode); queue.push(edge.toNode);
  }
  return superseded;
}
