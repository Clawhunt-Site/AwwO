import type { AgentTemplateId } from '../canvas/agentTemplates';
import type { OfficialWorkflow, OfficialWorkflowNode } from './examples/officialWorkflows';
import KNOWLEDGE_BASE_CANVAS from './production-canvases/knowledge-base';

/** Production cases whose canvas is kept as it ran instead of compiled from tasks the way
 * productionWorkflows.ts compiles the others. A copy reproduces the recorded canvas (production-canvases/)
 * in the language it ran in. The workflow's own texts below are English, as every case's are. */
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
  if (!primary) throw new Error(`The knowledge-base canvas's node ${id} has no output`);
  return { id, role, column, row, title, task, output, acceptance: [] };
});
const edges = canvas.wires.map(wire => {
  const input = recorded(wire.to).inputs.find(field => field.id === wire.input);
  const label = INPUTS[`${wire.to}.${wire.input}`];
  if (!input || !label) throw new Error(`The knowledge-base canvas has no input ${wire.to}.${wire.input}`);
  return { from: wire.from, to: wire.to, label };
});

export const KNOWLEDGE_BASE_WORKFLOW: OfficialWorkflow = {
  id: 'knowledge-base',
  title: 'Team knowledge-base SaaS',
  brief: 'Build the agent canvas of a team knowledge-base SaaS covering login, workspace roles and permissions, document data governance, the backend API, front-end search and dashboards, and delivery review.',
  nodes, edges,
  // Shown before copying: what the recordings refer to that a copy does not bring along.
  limitations: 'This canvas ran on 2026-09-04 in AwwO’s local development preview, where every agent was a Codex session with its own working directory on that computer. The recordings hide local directories and internal IDs; the artifacts/ files and the front-end prototype they mention stayed on that computer and are not copied. The canvas’s tasks were written for that local Codex runtime; a rerun in your workspace uses the model you choose and may turn out differently.',
  canvas,
};

/** Keyed by production case id, like PRODUCTION_WORKFLOWS. */
export const RECORDED_CASE_WORKFLOWS: Readonly<Record<string, OfficialWorkflow>> = { [KNOWLEDGE_BASE_WORKFLOW.id]: KNOWLEDGE_BASE_WORKFLOW };
