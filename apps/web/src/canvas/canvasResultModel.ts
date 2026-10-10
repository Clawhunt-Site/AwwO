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
  /** The canvas's result: an explicit final delivery at the end of the work, otherwise the furthest product
   *  (page, media, file) or working step; complete deliveries are preferred over a failed run's capture. */
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
/** Final authors can use review guidance too. Read their declared responsibility, never words inside the
 *  generated output: a final review/verdict alone is still an acceptance check. */
const FINAL_DELIVERY = /最终(?:化|方案|成果|交付|版本|正文|报告|文稿|文案|文件|页面)|定稿|终稿|\bfinali[sz](?:e|ed|ing|ation)\b|\bfinal[\s_-]+(?:result|deliverable|output|draft|plan|report|document|markdown|html|file|page)\b/i;
function finalDelivery(node: CanvasNode): boolean {
  if (node.kind !== 'session') return false;
  return FINAL_DELIVERY.test(node.title) || Boolean(node.contract?.outputs.some(field =>
    field.type !== 'boolean' && field.type !== 'number'
    && FINAL_DELIVERY.test(`${field.id.replace(/([a-z])([A-Z])/g, '$1 $2')} ${field.label}`)));
}

export function stepDelivery(node: CanvasNode, depth: number, reviewer = false): StepDelivery {
  const input = node.kind === 'form';
  const review = node.kind === 'session' && (reviewer || (!finalDelivery(node)
    && (getAgentTemplateForNode(node)?.id === 'review' || ACCEPTANCE_TITLE.test(node.title))));
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

/** Among the candidates, the furthest step wins; at the same step, the richer kind, then the newer.
 *  Equal deliveries use their stable ID so changing document order cannot change the result. */
const better = (a: StepDelivery, b: StepDelivery) => a.depth - b.depth
  || KIND_RANK[a.kind!] - KIND_RANK[b.kind!] || (a.output!.at - b.output!.at) || a.node.id.localeCompare(b.node.id);
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
  const finalizers = working.filter(step => {
    if (!finalDelivery(step.node)) return false;
    const after = downstream(doc, step.node.id);
    return !steps.some(next => next !== step && !next.input && !next.review && after.has(next.node.id));
  });
  // An explicit final delivery outranks a richer intermediate draft. Otherwise keep the product-first
  // fallback; a failed run's capture is used only when nothing complete exists, and a pure acceptance
  // report only on a canvas that produced nothing else.
  const final = best(finalizers.filter(delivered)) ?? best(products.filter(delivered)) ?? best(working.filter(delivered))
    ?? best(finalizers) ?? best(products) ?? best(working) ?? best(outputs);
  if (!final) return { stages, final: null, review: null, pending: [], complete: false };
  const after = downstream(doc, final.node.id);
  const reviews = outputs.filter(step => step.review && step !== final && after.has(step.node.id));
  const review = best(reviews.filter(delivered)) ?? best(reviews);
  const pending = steps.filter(step => step !== final && !step.input && !step.review
    && ((step.state === 'none' && step.depth >= final.depth) || (step.state === 'partial' && after.has(step.node.id))));
  return { stages, final, review, pending, complete: final.state !== 'partial' && !pending.length };
}


/** One thing a canvas made, as the 成果 view lists it: a page that runs, a stored file, a generated image, video
 *  or 3D model, a document, or a file field that came back as a name with no file behind it. */
export type DeliveredItemKind = 'page' | 'file' | 'image' | 'video' | 'model' | 'document' | 'missing';
export interface DeliveredItem {
  key: string;
  nodeId: string;
  nodeTitle: string;
  /** The field to open in the deliverable viewer; absent for a media node, which shows all its files at once. */
  fieldId?: string;
  label: string;
  kind: DeliveredItemKind;
  /** A stored file's reference (awwo-file:…) or a media item's artifact id, for its download. */
  reference?: string;
  artifactId?: string;
  name?: string;
  /** What a missing file field said instead of the file. */
  claimed?: string;
}

/**
 * Everything the canvas's steps have published, step by step in canvas order: what the 成果 view shows all at once
 * so nothing a run made has to be hunted for behind a step or a tab. Read from published outputs only, like the
 * rest of this model; an acceptance report and an input form are not things made, and are left to their steps.
 */
export function deliveredItems(doc: Pick<CanvasDocument, 'nodes' | 'edges'> & Partial<Pick<CanvasDocument, 'execution'>>): DeliveredItem[] {
  const result = canvasResult(doc);
  const items: DeliveredItem[] = [];
  for (const step of result.stages.flat()) {
    const node = step.node;
    if (step.input || !step.output || node.kind !== 'session') continue;
    const nodeTitle = node.title.trim() || node.id;
    const contract = node.contract || emptyContract();
    if (!contract.outputs.length && mediaKindOf(node.agentKind)) {
      const media = parseMediaOutput(step.output.text);
      for (const item of media?.items ?? []) {
        const kind: DeliveredItemKind = item.contentType.startsWith('video/') ? 'video' : item.contentType.startsWith('model/') ? 'model' : 'image';
        items.push({ key: `${node.id}:${item.artifactId}`, nodeId: node.id, nodeTitle, label: item.name, kind, artifactId: item.artifactId, name: item.name });
      }
      continue;
    }
    if (step.review) continue;
    const parsed = deliveryPresentation(contract, step.output.text);
    if (parsed.errors.length) continue;
    for (const field of contract.outputs) {
      const label = field.label.trim() || field.id;
      const base = { nodeId: node.id, nodeTitle, fieldId: field.id, label, key: `${node.id}:${field.id}` };
      if (parsed.pendingFiles.has(field.id)) { items.push({ ...base, kind: 'file', name: parsed.pendingFiles.get(field.id)!.name }); continue; }
      const value = parsed.values[field.id];
      if (value === undefined || String(value).trim() === '') continue;
      const text = String(value).trim();
      if (field.type === 'html') items.push({ ...base, kind: 'page' });
      else if (field.type === 'file') {
        if (text.startsWith('awwo-file:')) items.push({ ...base, kind: 'file', reference: text });
        else items.push({ ...base, kind: 'missing', claimed: text.slice(0, 200) });
      } else if (field.type === 'markdown' || field.type === 'text') items.push({ ...base, kind: 'document' });
    }
  }
  return items;
}
