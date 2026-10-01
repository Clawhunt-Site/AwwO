import type { OfficialWorkflow, OfficialWorkflowCategory, OfficialWorkflowNode, Localized } from '../officialWorkflows';
import type { AdvancedCase } from './types';

const categories: Record<OfficialWorkflowCategory, Localized> = {
  design: { zh: '交互产品', en: 'Interactive products' },
  game: { zh: '游戏与模拟', en: 'Games and simulation' },
  '3d': { zh: '空间与数字孪生', en: 'Spatial and digital twins' },
  knowledge: { zh: '知识与决策', en: 'Knowledge and decisions' },
  training: { zh: '模型与实验', en: 'Models and experiments' },
  operations: { zh: '业务运营', en: 'Business operations' },
};
export const OFFICIAL_CATEGORY_LABELS = categories;

/** Compile domain steps into the same real CanvasDocument contract as starter cases.
 * Branches are concurrent dependency paths; a review/repair pass is finite, never a fake loop. */
export function industryWorkflow(source: AdvancedCase): OfficialWorkflow {
  const depth = new Map<string, number>();
  const rows = new Map<number, number>();
  const nodes: OfficialWorkflowNode[] = [];
  const edges: OfficialWorkflow['edges'][number][] = [];
  for (const step of source.steps) {
    if (depth.has(step.id)) throw new Error(`Duplicate step in ${source.id}: ${step.id}`);
    if (new Set(step.after).size !== step.after.length) throw new Error(`Duplicate handoff in ${source.id}: ${step.id}`);
    for (const parent of step.after) {
      if (!depth.has(parent)) throw new Error(`Unresolved or cyclic dependency in ${source.id}: ${parent} -> ${step.id}`);
      const parentStep = source.steps.find(value => value.id === parent)!;
      edges.push({ from: parent, to: step.id, label: parentStep.output });
    }
    const column = step.after.length ? Math.max(...step.after.map(parent => depth.get(parent)!)) + 1 : 0;
    const row = rows.get(column) || 0;
    rows.set(column, row + 1);
    depth.set(step.id, column);
    nodes.push({ id: step.id, title: step.title, role: step.role, task: step.task,
      output: step.output, outputType: step.outputType, acceptance: step.acceptance, column, row });
  }
  return { ...source, tier: 'flagship', categoryLabel: categories[source.category], nodes, edges };
}

export function workflowShape(item: OfficialWorkflow) {
  const columns = new Map<number, number>();
  item.nodes.forEach(node => columns.set(node.column, (columns.get(node.column) || 0) + 1));
  return { stages: columns.size, parallel: Math.max(0, ...columns.values()),
    reviews: item.nodes.filter(node => node.role === 'review').length,
    merges: item.nodes.filter(node => item.edges.filter(edge => edge.to === node.id).length > 1).length };
}
