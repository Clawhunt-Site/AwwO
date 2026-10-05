// What a canvas has delivered, read from its document alone: its steps in order, what each step has
// published, and which published result is the canvas's own (its 成果). Pure, so the canvas's 成果 view
// and the workspace's gallery always agree.
//
// Only a node's published output counts (lastOutput); a conversation's earlier result does not. Where it
// came from and how complete it is are kept as recorded: a manual publication is never called a run's
// result, a copied case's recording is never called this canvas's run, and a failed run's partial capture
// is evidence, never a delivered result.
import type { CanvasDocument, CanvasNode, NodeOutput } from './canvasDoc';
import { getAgentTemplateForNode } from './agentTemplates';
import { deliveryPresentation } from './fileDeliveryPresentation';
import { mediaKindOf } from './mediaCatalog';
import { parseMediaOutput } from './mediaOutput';
import { emptyContract } from './nodeContracts';
import { nodeDepths } from './nodePresentation';

/** What a published result is, by the richest field it carries. */
export type DeliveryKind = 'html' | 'media' | 'file' | 'markdown' | 'text';
/** run: a run's complete result · partial: a failed run's capture · manual: published by hand · case: a copied
 *  production case's recorded delivery (real, but not run in this workspace) · none: nothing yet. */
export type DeliveryState = 'run' | 'partial' | 'manual' | 'case' | 'none';

export interface StepDelivery {
  node: CanvasNode;
  /** 0 for a step with no inputs; parallel steps share a number. */
  depth: number;
  output: NodeOutput | null;
  state: DeliveryState;
  kind: DeliveryKind | null;
  /** The first published HTML field, for a preview. */
  html?: string;
  /** The first published Markdown or text field, for an excerpt. */
  text?: string;
  /** An input form, not a working step. */
  input: boolean;
  /** An acceptance step (交付验收): it checks the result; it is not the result. */
  review: boolean;
}

export interface CanvasResult {
  /** Steps grouped by depth, in order. Feedback wires (a review sent back) do not count as order. */
  stages: StepDelivery[][];
  /** The canvas's result: the furthest product (page, media, file) delivered, otherwise the furthest working
   *  step delivered; complete deliveries are preferred over a failed run's capture. */
  final: StepDelivery | null;
  /** An acceptance step fed by the result that has reported on it. */
  review: StepDelivery | null;
  /** Working steps the canvas still owes: from the result's step on, nothing published yet, and after the
   *  result, a failed capture too. */
  pending: StepDelivery[];
  /** The result is what the canvas is for: complete, and nothing after it still owed. Otherwise it is only
   *  the furthest the canvas has got. */
  complete: boolean;
}

const KIND_RANK: Record<DeliveryKind, number> = { html: 4, media: 3, file: 2, markdown: 1, text: 0 };
/** What a canvas is usually for: something to open, watch or download, rather than notes on the way there. */
const PRODUCT_KINDS: ReadonlySet<DeliveryKind> = new Set(['html', 'media', 'file']);
/** An acceptance step by the name people give one (试玩验收, 体验与实现核对, 玩法回归, Code review). */
const ACCEPTANCE_TITLE = /验收|评审|审查|复核|核对|回归(?:测试|检查|验证)|(?:玩法|功能|界面|视觉|体验)回归|\b(?:review|qa|acceptance)\b/i;

export function stepDelivery(node: CanvasNode, depth: number, reviewer = false): StepDelivery {
  const input = node.kind === 'form';
  const review = node.kind === 'session' && (reviewer || getAgentTemplateForNode(node)?.id === 'review' || ACCEPTANCE_TITLE.test(node.title));
  const output = node.kind === 'session' ? node.lastOutput ?? null : null;
  const base = { node, depth, output, input, review };
  if (!output || !output.text.trim()) return { ...base, output: null, state: 'none', kind: null };
  const state: DeliveryState = output.partial ? 'partial' : output.source === 'manual' ? 'manual' : output.source === 'case' ? 'case' : 'run';
  const contract = (node.kind === 'session' && node.contract) || emptyContract();
  if (!contract.outputs.length && node.kind === 'session' && mediaKindOf(node.agentKind) && parseMediaOutput(output.text)) return { ...base, state, kind: 'media' };
  const parsed = deliveryPresentation(contract, output.text);
  const published = parsed.errors.length ? [] : contract.outputs.filter(field => {
    if (parsed.pendingFiles.has(field.id)) return true;
    const value = parsed.values[field.id];
    return value !== undefined && String(value).trim() !== '';
  });
  if (!published.length) return { ...base, state, kind: 'text', text: parsed.displaySource };
  const html = published.find(field => field.type === 'html');
  const prose = published.find(field => field.type === 'markdown' || field.type === 'text');
  const kind: DeliveryKind = html ? 'html' : published.some(field => field.type === 'file') ? 'file' : prose?.type === 'markdown' ? 'markdown' : 'text';
  return { ...base, state, kind,
    ...(html ? { html: String(parsed.values[html.id]) } : {}),
    ...(prose ? { text: String(parsed.values[prose.id]) } : {}) };
}

/** Among the candidates, the furthest step wins; at the same step, the richer kind, then the newer. */
const better = (a: StepDelivery, b: StepDelivery) => a.depth - b.depth
  || KIND_RANK[a.kind!] - KIND_RANK[b.kind!] || (a.output!.at - b.output!.at);
const best = (steps: StepDelivery[]) => steps.reduce<StepDelivery | null>((top, step) => !top || better(step, top) > 0 ? step : top, null);
const delivered = (step: StepDelivery) => step.state === 'run' || step.state === 'manual' || step.state === 'case';

/** Everything a step's output reaches over ordinary wires. */
function downstream(doc: Pick<CanvasDocument, 'edges'>, from: string): Set<string> {
  const reached = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of doc.edges) if (edge.kind !== 'feedback' && edge.fromNode === id && !reached.has(edge.toNode)) { reached.add(edge.toNode); queue.push(edge.toNode); }
  }
  return reached;
}

export function canvasResult(doc: Pick<CanvasDocument, 'nodes' | 'edges'> & Partial<Pick<CanvasDocument, 'execution'>>): CanvasResult {
  const depths = nodeDepths(doc.nodes, doc.edges.filter(edge => edge.kind !== 'feedback'));
  const reviewer = doc.execution?.reviewerNodeId;
  const steps = doc.nodes.map(node => stepDelivery(node, depths.get(node.id) ?? 0, node.id === reviewer));
  const byDepth = new Map<number, StepDelivery[]>();
  for (const step of steps) byDepth.set(step.depth, [...(byDepth.get(step.depth) ?? []), step]);
  const stages = [...byDepth.entries()].sort(([left], [right]) => left - right).map(([, items]) => items);
  const outputs = steps.filter(step => !step.input && step.output);
  const working = outputs.filter(step => !step.review);
  const products = working.filter(step => PRODUCT_KINDS.has(step.kind!));
  // A complete product, then any complete working step; a failed run's capture only when nothing complete
  // exists; an acceptance report only on a canvas that produced nothing else.
  const final = best(products.filter(delivered)) ?? best(working.filter(delivered)) ?? best(products) ?? best(working) ?? best(outputs);
  if (!final) return { stages, final: null, review: null, pending: [], complete: false };
  const after = downstream(doc, final.node.id);
  const reviews = outputs.filter(step => step.review && step !== final && after.has(step.node.id));
  const review = best(reviews.filter(delivered)) ?? best(reviews);
  const pending = steps.filter(step => step !== final && !step.input && !step.review
    && ((step.state === 'none' && step.depth >= final.depth) || (step.state === 'partial' && after.has(step.node.id))));
  return { stages, final, review, pending, complete: final.state !== 'partial' && !pending.length };
}
