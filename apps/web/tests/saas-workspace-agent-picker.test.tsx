import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentWorkspace } from '../src/canvas/AgentWorkspace';
import { SaaSApiError } from '../src/saas/api';
import { TeamMarketAgentPicker } from '../src/canvas/TeamMarketAgentPicker';
import { WorkspaceAgentPicker } from '../src/canvas/WorkspaceAgentPicker';
import type { WorkspaceAgent } from '../src/canvas/workspaceAgents';
const agent = (id: string, name = id): WorkspaceAgent => ({ id, name, runtime: 'pi', model: 'qwen', effort: '', instructions: `Role ${id}`, status: 'active' });
beforeEach(() => { cleanup(); localStorage.clear(); });
describe('real Agent library', () => {
  it('selects a later page Agent once, without invoking template creation', async () => {
    const load = vi.fn().mockResolvedValueOnce({ items: [agent('first')], nextCursor: 'next' }).mockResolvedValueOnce({ items: [agent('last', 'Researcher')] });
    const select = vi.fn(), template = vi.fn();
    render(<AgentWorkspace nodes={[]} edges={[]} selectedIds={[]} runs={{}} running={false} onFocusNode={vi.fn()} onSearch={vi.fn()} onAddAgent={template} onCreateTemplate={vi.fn()} loadWorkspaceAgents={load} onAddWorkspaceAgent={select}><div /></AgentWorkspace>);
    fireEvent.click(screen.getByRole('button', { name: '添加 Agent', exact: true }));
    await screen.findByRole('button', { name: '选择 first' });
    fireEvent.click(screen.getByRole('button', { name: '加载更多 Agent' }));
    await screen.findByRole('button', { name: '选择 Researcher' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索已加载的 Agent' }), { target: { value: 'Researcher' } });
    expect(screen.queryByRole('button', { name: '选择 first' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择 Researcher' }));
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '添加所选 Agent' }));
    expect(select).toHaveBeenCalledExactlyOnceWith(agent('last', 'Researcher'));
    expect(template).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(load.mock.calls[1][0]).toBe('next');
  });
  it('retains existing rows on a page error and retries that page', async () => {
    const load = vi.fn().mockResolvedValueOnce({ items: [agent('first')], nextCursor: 'next' }).mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce({ items: [agent('last')] });
    render(<WorkspaceAgentPicker loadPage={load} onSelect={vi.fn()} disabled={false} />);
    await screen.findByRole('button', { name: '选择 first' });
    fireEvent.click(screen.getByRole('button', { name: '加载更多 Agent' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: '选择 first' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('button', { name: '选择 last' });
    expect(load.mock.calls.map(call => call[0])).toEqual([null, 'next', 'next']);
  });
  it('aborts a previous scope request and ignores its late response', async () => {
    let oldResolve!: (value: unknown) => void;
    const oldLoad = vi.fn().mockImplementation(() => new Promise(resolve => { oldResolve = resolve; }));
    const newLoad = vi.fn().mockResolvedValue({ items: [agent('new')] });
    const props = { onSelect: vi.fn(), disabled: false };
    const view = render(<WorkspaceAgentPicker {...props} loadPage={oldLoad} />);
    view.rerender(<WorkspaceAgentPicker {...props} loadPage={newLoad} />);
    await screen.findByRole('button', { name: '选择 new' });
    oldResolve({ items: [agent('old')] });
    await waitFor(() => expect(oldLoad.mock.calls[0][1].aborted).toBe(true));
    expect(screen.queryByRole('button', { name: '选择 old' })).toBeNull();
  });
  it('does not allow an unavailable Agent to be added', async () => {
    render(<WorkspaceAgentPicker loadPage={async () => ({ items: [{ ...agent('paused'), status: 'suspended' }] })} onSelect={vi.fn()} disabled={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '选择 paused' }));
    expect(screen.getByRole('button', { name: '添加所选 Agent' })).toBeDisabled();
  });
});


describe('catalogue recovery and market selection', () => {
  it.each([[401, 'unauthenticated'], [403, 'forbidden'], [400, 'invalid_cursor']] as const)('clears obsolete selections for %s and restarts pagination', async (status, code) => {
    const load = vi.fn().mockResolvedValueOnce({ items: [agent('old')], nextCursor: 'expired' }).mockRejectedValueOnce(new SaaSApiError(status, code, code)).mockResolvedValueOnce({ items: [agent('fresh')] });
    render(<WorkspaceAgentPicker loadPage={load} onSelect={vi.fn()} disabled={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '选择 old' }));
    fireEvent.click(screen.getByRole('button', { name: '加载更多 Agent' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: '选择 old' })).toBeNull();
    expect(screen.getByRole('button', { name: '添加所选 Agent' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('button', { name: '选择 fresh' });
    expect(load.mock.calls[2][0]).toBe(null);
  });
  it('offers all repository market roles, distinguishes duplicate names and imports only the chosen role', () => {
    const select = vi.fn();
    render(<TeamMarketAgentPicker onSelect={select} disabled={false} />);
    expect(screen.getAllByRole('button', { name: /^选择 / })).toHaveLength(8);
    expect(screen.getByRole('button', { name: '选择 CTO · Core Exec Team' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '选择 CTO · Product Engineering' }));
    expect(screen.getByRole('region', { name: '所选市场角色详情' })).toHaveTextContent('github-pr-workflow');
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '添加所选角色' }));
    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0][0]).toMatchObject({ name: 'CTO', source: { teamName: 'Product Engineering' }, skillsInstalled: false });
  });
});
