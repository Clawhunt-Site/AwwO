import { tenantPath, type SaaSAgent } from './api';
import { listPage } from './listPage';
import type { WorkspaceAgentLoader } from '../canvas/workspaceAgents';

/** Capture the workspace once; a pending catalogue request cannot follow a workspace switch. */
export function workspaceAgentCatalog(tenantId: string): WorkspaceAgentLoader {
  return async (cursor, signal) => {
    const page = await listPage<SaaSAgent>(tenantPath(tenantId, '/agents'), cursor, signal);
    return { nextCursor: page.nextCursor, items: page.items.filter(agent => agent.tenantId === tenantId).map(agent => ({
      id: agent.id, name: agent.name, instructions: agent.instructions ?? '',
      runtime: agent.runtime || 'pi', model: agent.model, effort: agent.effort ?? '', status: agent.status ?? 'active',
    })) };
  };
}
