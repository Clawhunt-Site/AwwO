import { createAgentTemplate } from './agentTemplates';
import type { SessionNode } from './canvasDoc';
import type { UiLocale } from '../i18n';

/** Public, executable Agent metadata. Credentials and external service endpoints never belong here. */
export interface WorkspaceAgent {
  id: string;
  name: string;
  instructions: string;
  runtime: string;
  model: string;
  effort: string;
  status: string;
}
export interface WorkspaceAgentPage { items: WorkspaceAgent[]; nextCursor?: string | null }
export type WorkspaceAgentLoader = (cursor?: string | null, signal?: AbortSignal) => Promise<WorkspaceAgentPage>;

/** Binding is performed by the tenant-scoped setup endpoint, never synthesized in the browser. */
export function createWorkspaceAgentNode(agent: WorkspaceAgent, pos: { x: number; y: number }, locale: UiLocale): SessionNode {
  const node = createAgentTemplate('general', pos, locale);
  return { ...node, title: agent.name, persona: agent.instructions, runtime: agent.runtime,
    model: agent.model, effort: agent.effort, agentRef: { source: 'workspace', agentId: agent.id } };
}
