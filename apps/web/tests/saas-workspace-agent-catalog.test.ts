import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceAgentCatalog } from '../src/saas/workspaceAgentCatalog';
import { createWorkspaceAgentNode } from '../src/canvas/workspaceAgents';

afterEach(() => vi.unstubAllGlobals());
describe('workspace Agent catalogue', () => {
  it('loads a tenant-scoped cursor page with a safe metadata projection and legacy runtime', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [
      { id: 'agent-a', tenantId: 'tenant/one', name: 'Writer', model: 'model-a', instructions: 'Write clearly', apiKey: 'never-copy' },
      { id: 'agent-other', tenantId: 'other', name: 'Other', model: 'x' },
    ], nextCursor: 'next+page' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const page = await workspaceAgentCatalog('tenant/one')('previous+page', controller.signal);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/tenants/tenant%2Fone/agents?limit=50&cursor=previous%2Bpage', expect.objectContaining({ credentials: 'include', signal: controller.signal }));
    expect(page).toEqual({ nextCursor: 'next+page', items: [{ id: 'agent-a', name: 'Writer', model: 'model-a', instructions: 'Write clearly', runtime: 'pi', effort: '', status: 'active' }] });
  });
  it('creates a selection intent with fresh conversation identity instead of a forged binding', () => {
    const agent = { id: 'real-agent', name: 'Existing Agent', instructions: 'Its actual role', runtime: 'pi', model: 'model-a', effort: '', status: 'active' };
    const node = createWorkspaceAgentNode(agent, { x: 10, y: 20 }, 'zh');
    const other = createWorkspaceAgentNode(agent, { x: 0, y: 0 }, 'zh');
    expect(node).toMatchObject({ title: agent.name, agentRef: { source: 'workspace', agentId: agent.id }, binding: null, issueId: null, runtime: 'pi', persona: agent.instructions });
    expect(node.id).not.toBe(other.id);
    expect(node.lastOutput).toBeFalsy();
  });
});
