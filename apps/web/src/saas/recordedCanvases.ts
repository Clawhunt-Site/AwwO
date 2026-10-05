import type { AgentTemplateId } from '../canvas/agentTemplates';
import type { Localized, OfficialWorkflow, OfficialWorkflowNode } from './examples/officialWorkflows';
import KNOWLEDGE_BASE_CANVAS from './production-canvases/knowledge-base';

/** Production cases whose canvas is kept as it ran instead of compiled from tasks the way
 * productionWorkflows.ts compiles the others. A copy reproduces the recorded canvas (production-canvases/)
 * in the language it ran in. The node titles, personas and field labels below are read from it; the
 * English translations and the workflow's own descriptions are written here. */
const l = (zh: string, en: string): Localized => ({ zh, en });
const canvas = KNOWLEDGE_BASE_CANVAS;

// The template each node was made from on 2026-09-04, where it sits, and how its texts read in English.
const NODES: ReadonlyArray<readonly [id: string, role: AgentTemplateId, column: number, row: number, title: string, task: string, output: string]> = [
  ['product', 'general', 0, 0, 'Product scope & architecture', 'Sets down the smallest extensible product scope of the team knowledge-base SaaS, its module breakdown, acceptance criteria and open technology choices; implements nothing.', 'Delivered result'],
  ['users', 'users', 1, 0, 'Login & workspace permissions', 'Designs the accounts, login, workspace members, roles, resource permissions, audit boundaries and identity acceptance checks of the team knowledge-base SaaS.', 'User system contract'],
  ['data', 'data', 1, 1, 'Document data governance', 'Defines the knowledge base’s documents, metadata, versions, tags, sources, quality rules, permission-linked fields and governance boundaries.', 'Data dictionary'],
  ['materials', 'materials', 1, 2, 'Knowledge-base launch assets', 'Plans and makes the launch assets of the team knowledge-base SaaS: homepage copy, a product guide, empty-state and onboarding copy, a brand asset list, and copy and assets the front end can consume. Generates no designs, writes no files and publishes nothing.', 'Copy and asset list'],
  ['backend', 'backend', 2, 0, 'Backend API & business rules', 'Designs the backend business model, API contract, permission checks, search and dashboard APIs and service checks from the data dictionary and the user permission contract.', 'API contract'],
  ['frontend', 'frontend', 3, 0, 'Knowledge-base web workspace', 'Designs and builds the front end of the team knowledge-base SaaS: workspace entry, signed-in state, document search, document management, permission-based visibility and the dashboard.', 'Interface and delivery notes'],
  ['review', 'review', 4, 0, 'Delivery review', 'Sets acceptance criteria from the product goals, the API contract and the front-end delivery, and checks permissions, data governance, search, dashboards and the end-to-end flow.', 'Acceptance report'],
];
// Each wire is named for the input it fills.
const INPUTS: Readonly<Record<string, string>> = {
  'users.brief': 'User and permission requirements', 'data.brief': 'Business requirements', 'materials.brief': 'Product and brand requirements',
  'backend.rules': 'Business rules', 'backend.identityContract': 'User system contract', 'backend.schema': 'Data dictionary',
  'frontend.accessContract': 'User and permission contract', 'frontend.documentSchema': 'Document data dictionary', 'frontend.api': 'API contract',
  'frontend.assets': 'Copy and asset list', 'review.api': 'API contract', 'review.delivery': 'Deliverable to review',
};

const recorded = (id: string) => {
  const node = canvas.nodes.find(value => value.id === id);
  if (!node) throw new Error(`The knowledge-base canvas has no node ${id}`);
  return node;
};
const nodes = NODES.map(([id, role, column, row, title, task, output]): OfficialWorkflowNode => {
  const node = recorded(id);
  const primary = node.outputs.find(field => field.required) ?? node.outputs[0];
  return { id, role, column, row, title: l(node.title, title), task: l(node.persona, task), output: l(primary.label, output), acceptance: [] };
});
const edges = canvas.wires.map(wire => {
  const input = recorded(wire.to).inputs.find(field => field.id === wire.input);
  const en = INPUTS[`${wire.to}.${wire.input}`];
  if (!input || !en) throw new Error(`The knowledge-base canvas has no input ${wire.to}.${wire.input}`);
  return { from: wire.from, to: wire.to, label: l(input.label, en) };
});

export const KNOWLEDGE_BASE_WORKFLOW: OfficialWorkflow = {
  id: 'knowledge-base', category: 'knowledge', categoryLabel: l('知识库', 'Knowledge base'), accent: '#34d399',
  title: l('团队知识库 SaaS', 'Team knowledge-base SaaS'),
  summary: l('七个 Agent 分五个阶段：先定产品边界，再并行设计权限、数据治理与上线物料，然后是后端接口、Web 工作台和验收。',
    'Seven agents in five stages: product scope first, then permissions, data governance and launch assets in parallel, then the backend API, the web workspace and the review.'),
  description: l('2026-09-04 在 AwwO 本地开发预览里真实运行过的画布：七个 Codex Agent 按契约交接，交付了一个以演示模式（模拟数据）运行的知识库 Web 工作台；交付验收先判定部分通过、整体未通过并退回两处缺陷，前端修复后复验通过。',
    'The canvas that ran in AwwO’s local development preview on 2026-09-04: seven Codex agents handed over by contract and delivered a knowledge-base web workspace that runs in demo mode with simulated data; the delivery review first found it partly passed and not accepted overall and sent back two defects, which passed re-verification after the front end fixed them.'),
  pattern: l('产品边界 → 用户与权限 / 数据治理 / 上线物料并行 → 后端接口 → Web 工作台 → 交付验收',
    'Product scope → users and permissions / data governance / launch assets in parallel → backend API → web workspace → delivery review'),
  brief: l(recorded('product').inputs[0].value.split('\n')[0],
    'Build the agent canvas of a team knowledge-base SaaS covering login, workspace roles and permissions, document data governance, the backend API, front-end search and dashboards, and delivery review.'),
  nodes, edges,
  artifacts: [l('能跑起来的知识库 Web 工作台（演示模式）', 'A runnable knowledge-base web workspace (demo mode)'),
    l('身份、数据、接口与物料契约', 'Identity, data, API and launch-asset contracts'), l('验收报告与返工清单', 'An acceptance report and a rework list')],
  // Shown before copying: what the recordings refer to that a copy does not bring along.
  limitations: l('这张画布 2026-09-04 在 AwwO 的本地开发预览里运行，每个 Agent 是一个在那台电脑上有独立工作目录的 Codex 会话。实录里的本机目录和内部 ID 已隐去；实录提到的 artifacts/ 文件和前端原型留在那台电脑上，没有随画布复制。画布里的任务是按当时的 Codex 本地执行器写的，在你的工作区重新运行时由你选择的模型执行，结果可能不同。',
    'This canvas ran on 2026-09-04 in AwwO’s local development preview, where every agent was a Codex session with its own working directory on that computer. The recordings hide local directories and internal IDs; the artifacts/ files and the front-end prototype they mention stayed on that computer and are not copied. The canvas’s tasks were written for that local Codex runtime; a rerun in your workspace uses the model you choose and may turn out differently.'),
  canvas,
};

/** Keyed by production case id, like PRODUCTION_WORKFLOWS. */
export const RECORDED_CASE_WORKFLOWS: Readonly<Record<string, OfficialWorkflow>> = { [KNOWLEDGE_BASE_WORKFLOW.id]: KNOWLEDGE_BASE_WORKFLOW };
