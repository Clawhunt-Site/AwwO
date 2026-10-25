import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { NodeTeamEditor } from '../src/canvas/NodeTeamEditor';
import { createNodeTeam, validateNodeTeam, type NodeTeamRuntime, type NodeTeamTool } from '../src/canvas/nodeTeam';
import { nodeTeamTemplates } from '../src/canvas/nodeTeamTemplates';
import { InspectorPanel } from '../src/canvas/InspectorPanel';
import { LocaleProvider as CanvasI18nProvider } from '../src/canvas/i18n';
import { SessionTile } from '../src/canvas/SessionTile';
import type { ModelPaletteGroup } from '../src/canvas/modelPalette';
const readJson = vi.fn(async (path: string) => path.endsWith('/models') ? { models: ['model-a', 'model-b'] } : { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] });
function session(): SessionNode { return { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title: '研究', persona: 'Check the source.', model: 'model-a', runtime: 'pi' }; }
function Harness({ initial = session(), disabled = false, available = true, read = readJson, onChange = vi.fn(), runtimes, runtimeTools }: {
  initial?: SessionNode; disabled?: boolean; available?: boolean; read?: (path: string) => Promise<any>; onChange?: ReturnType<typeof vi.fn>;
  runtimes?: NodeTeamRuntime[]; runtimeTools?: Partial<Record<NodeTeamRuntime, NodeTeamTool[]>>;
}) {
  const [node, setNode] = useState(initial);
  return <NodeTeamEditor node={node} available={available} readJson={read} runtimes={runtimes} runtimeTools={runtimeTools} disabled={disabled} onChange={team => { onChange(team); setNode({ ...node, team }); }} />;
}
function member(index: number) { return within(screen.getByRole('group', { name: `Agent ${index}` })); }
async function enable() { fireEvent.click(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })); await waitFor(() => expect(member(1).getByLabelText('模型')).not.toBeDisabled()); }
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('node team configuration', () => {
  it('seeds two members and preserves single-Agent settings on disable', async () => {
    const save = vi.fn(); const initial = session(); render(<Harness initial={initial} onChange={save} />); await enable();
    expect(member(1).getByLabelText('专属指令')).toHaveValue('Check the source.');
    // The worker follows the node's model rather than a copy of it, so a later node switch reaches it.
    expect(member(1).getByLabelText('模型')).toHaveValue('');
    expect(member(1).getByRole('option', { name: '继承节点已绑定模型' })).toHaveValue('');
    expect(member(2).getByLabelText('模型')).toHaveValue('');
    expect(member(2).getByRole('option', { name: '继承节点已绑定模型' })).toHaveValue('');
    expect(screen.getByText(/工具、文件读写和 Shell 尚不可用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })); expect(save).toHaveBeenLastCalledWith(undefined);
    expect(initial.persona).toBe('Check the source.'); expect(initial.model).toBe('model-a');
  });
  it('edits independent roles/models/context from catalog selects and resets model on harness change', async () => {
    const save = vi.fn(); render(<Harness onChange={save} />); await enable();
    expect(member(1).getByLabelText('模型').tagName).toBe('SELECT');
    expect(within(member(1).getByLabelText('模型')).getAllByRole('option').map(item => item.getAttribute('value'))).toEqual(['', 'model-a', 'model-b']);
    fireEvent.change(member(2).getByLabelText('模型'), { target: { value: 'model-b' } });
    fireEvent.change(member(2).getByLabelText('职责'), { target: { value: '独立审稿' } });
    fireEvent.change(member(2).getByLabelText('可见上下文'), { target: { value: 'task' } });
    expect(save.mock.lastCall![0].members[1]).toMatchObject({ model: 'model-b', role: '独立审稿', context: 'task' });
    expect(member(1).getByLabelText('模型')).toHaveValue('');
    fireEvent.change(member(2).getByLabelText('执行框架'), { target: { value: 'pi' } }); expect(member(2).getByLabelText('模型')).toHaveValue('');
  });
  it('offers member reasoning effort only for an explicit model that advertises levels and resets it with the model or harness', async () => {
    const save = vi.fn();
    const read = vi.fn(async (path: string) => path.includes('/openai-agents/')
      ? { source: 'saas_runtime', models: ['deep', 'plain'], model_capabilities: { deep: { effort_levels: ['low', 'high'], default_effort: 'low' }, plain: { effort_levels: [], default_effort: '' } } }
      : { models: ['model-a', 'model-b'] });
    render(<Harness onChange={save} read={read} runtimes={['pi', 'openai-agents']} runtimeTools={{ 'openai-agents': [] }} />); await enable();
    expect(member(2).queryByLabelText('思考强度')).toBeNull();
    fireEvent.change(member(2).getByLabelText('执行框架'), { target: { value: 'openai-agents' } });
    await waitFor(() => expect(member(2).getByLabelText('模型')).not.toBeDisabled());
    expect(member(2).getByText('留空模型时继承节点模型及其思考强度；选择明确的模型后才可单独设置。')).toBeInTheDocument();
    expect(member(2).queryByLabelText('思考强度')).toBeNull();
    fireEvent.change(member(2).getByLabelText('模型'), { target: { value: 'deep' } });
    expect(within(member(2).getByLabelText('思考强度')).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['', 'low', 'high']);
    expect(save.mock.lastCall![0].members[1]).not.toHaveProperty('effort');
    fireEvent.change(member(2).getByLabelText('思考强度'), { target: { value: 'high' } });
    expect(save.mock.lastCall![0].members[1]).toMatchObject({ runtime: 'openai-agents', model: 'deep', effort: 'high' });
    fireEvent.change(member(2).getByLabelText('模型'), { target: { value: 'plain' } });
    expect(save.mock.lastCall![0].members[1]).not.toHaveProperty('effort');
    expect(member(2).queryByLabelText('思考强度')).toBeNull();
    fireEvent.change(member(2).getByLabelText('模型'), { target: { value: 'deep' } });
    fireEvent.change(member(2).getByLabelText('思考强度'), { target: { value: 'low' } });
    fireEvent.change(member(2).getByLabelText('执行框架'), { target: { value: 'pi' } });
    expect(save.mock.lastCall![0].members[1]).toMatchObject({ runtime: 'pi', model: '', tools: [] });
    expect(save.mock.lastCall![0].members[1]).not.toHaveProperty('effort');
    expect(member(1).queryByLabelText('思考强度')).toBeNull();
  });
  it('keeps an unadvertised saved member effort visible and blocks it instead of dropping it', async () => {
    const read = vi.fn(async (path: string) => path.includes('/openai-agents/')
      ? { source: 'saas_runtime', models: ['deep'], model_capabilities: { deep: { effort_levels: ['low'], default_effort: 'low' } } }
      : { models: ['model-a', 'model-b'] });
    const initial = session(); initial.team = createNodeTeam(initial);
    initial.team.members[1] = { ...initial.team.members[1], runtime: 'openai-agents', model: 'deep', effort: 'xhigh' };
    render(<Harness initial={initial} read={read} runtimes={['pi', 'openai-agents']} runtimeTools={{ 'openai-agents': [] }} />);
    await waitFor(() => expect(member(2).getByLabelText('思考强度')).not.toBeDisabled());
    expect(member(2).getByRole('option', { name: '当前模型不提供：xhigh' })).toHaveAttribute('value', 'xhigh');
    expect(screen.getByRole('alert')).toHaveTextContent('思考强度');
  });
  it('reorders stable member identities and removes only the chosen member', async () => {
    const save = vi.fn(); render(<Harness onChange={save} />); await enable();
    const original = save.mock.lastCall![0].members.map((item: { id: string }) => item.id);
    fireEvent.click(screen.getByRole('button', { name: '添加 Agent' })); expect(screen.getAllByRole('group')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '上移 Agent 2' }));
    expect(save.mock.lastCall![0].members.slice(0, 2).map((item: { id: string }) => item.id)).toEqual([original[1], original[0]]);
    fireEvent.click(screen.getByRole('button', { name: '删除 Agent 2' }));
    expect(save.mock.lastCall![0].members.map((item: { id: string }) => item.id)).not.toContain(original[0]);
  });
  it('shows mode-specific budget estimates and validates review member count', async () => {
    const save = vi.fn(); render(<Harness onChange={save} />); await enable();
    fireEvent.change(screen.getByLabelText('协作方式'), { target: { value: 'debate' } });
    fireEvent.change(screen.getByLabelText('最多轮数'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('最多模型调用次数'), { target: { value: '2' } });
    expect(screen.getByText(/计划最多 7 次调用/)).toBeInTheDocument(); expect(screen.getByText(/调用次数上限低于完整流程所需次数/)).toBeInTheDocument();
    expect(save.mock.lastCall![0].maxTurns).toBe(2);
    fireEvent.change(screen.getByLabelText('协作方式'), { target: { value: 'review' } }); expect(screen.getByText(/计划最多 6 次调用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除 Agent 2' })); expect(screen.getByRole('alert')).toHaveTextContent('审核模式至少需要一位执行者和一位审核者');
  });
  it('explains real chat history, independent task context and the final result for every collaboration mode', async () => {
    render(<Harness />); await enable();
    expect(member(1).getByRole('option', { name: '当前会话历史与本次运行前序成果' })).toHaveValue('shared');
    expect(member(1).getByRole('option', { name: '仅当前任务（含节点输入）' })).toHaveValue('task');
    expect(screen.getByText(/不包含此前所有成员的发言/)).toHaveTextContent('汇总、审核及返工仍接收必要的团队结果和审核意见');
    expect(screen.getByText(/全部成功后，最后一位的输出成为节点最终结果/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('协作方式'), { target: { value: 'parallel' } });
    expect(screen.getByText(/最后一位等待全部完成/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('协作方式'), { target: { value: 'debate' } });
    expect(screen.getByText(/最后一位额外汇总，作为节点最终结果/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('协作方式'), { target: { value: 'review' } });
    expect(screen.getByText(/其批准的交付成为最终结果/)).toBeVisible();
  });
  it('caps teams at eight members and preserves at least one member', async () => {
    render(<Harness />); await enable();
    for (let count = 2; count < 8; count += 1) fireEvent.click(screen.getByRole('button', { name: '添加 Agent' }));
    expect(screen.getAllByRole('group')).toHaveLength(8);
    expect(screen.getByRole('button', { name: '添加 Agent' })).toBeDisabled();
    for (let count = 8; count > 1; count -= 1) fireEvent.click(screen.getByRole('button', { name: `删除 Agent ${count}` }));
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '删除 Agent 1' })).toBeDisabled();
  });
  it('disables all controls and guards synthetic edits while read-only', async () => {
    const initial = session(); initial.team = createNodeTeam(initial); const save = vi.fn();
    const { rerender } = render(<Harness initial={initial} disabled onChange={save} />);
    await screen.findAllByRole('option', { name: 'model-a' });
    for (const control of [...screen.getAllByRole('textbox'), ...screen.getAllByRole('combobox'), ...screen.getAllByRole('spinbutton')]) expect(control).toBeDisabled();
    fireEvent.change(member(1).getByLabelText('职责'), { target: { value: 'Should not save' } });
    fireEvent.click(screen.getByRole('button', { name: '添加 Agent' })); expect(save).not.toHaveBeenCalled();
    rerender(<Harness initial={initial} disabled={false} onChange={save} />); expect(member(1).getByLabelText('职责')).toHaveValue('执行者');
  });
  it('shows team members the node model does not reach and makes them follow it in one click', async () => {
    // The reported canvas: the team was enabled while the node ran a premium model, and only the node was switched after.
    const initial = session(); initial.team = createNodeTeam(initial); initial.team.members[0].model = 'model-b'; const save = vi.fn();
    render(<InspectorPanel node={initial} liveCompanies={[]} apiBase="/api" readJson={readJson} onSave={save} onClose={vi.fn()} />);
    const warning = within(screen.getByRole('group', { name: '单独指定模型的团队成员' }));
    expect(warning.getByText(/1 位成员单独指定了模型/)).toBeInTheDocument();
    expect(warning.getByText('Agent 1 · 研究 · model-b')).toBeInTheDocument();
    fireEvent.click(warning.getByRole('button', { name: '改为跟随节点模型' }));
    expect(screen.queryByRole('group', { name: '单独指定模型的团队成员' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.lastCall![0]).toMatchObject({ model: 'model-a', team: { members: [expect.objectContaining({ model: '' }), expect.objectContaining({ model: '' })] } });
  });
  it('carries a node model switch to a member that held the previous node model', async () => {
    // Teams enabled before members inherited stored the node's model in their first member.
    const initial = session(); initial.team = createNodeTeam(initial); initial.team.members[0].model = 'model-a'; const save = vi.fn();
    render(<InspectorPanel node={initial} liveCompanies={[]} apiBase="/api" readJson={readJson} onSave={save} onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: '单独指定模型的团队成员' })).toBeNull();
    const nodeModel = await waitFor(() => {
      const input = screen.getAllByLabelText('模型').find(element => element.tagName === 'INPUT');
      expect(input).toBeDefined(); return input!;
    });
    fireEvent.change(nodeModel, { target: { value: 'model-b' } });
    expect(screen.queryByRole('group', { name: '单独指定模型的团队成员' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(save.mock.lastCall![0]).toMatchObject({ model: 'model-b', team: { members: [expect.objectContaining({ model: '' }), expect.anything()] } });
  });
  // Codex review 2026-10-25: choosing the node's model after enabling its team left the team on the runtime it began on.
  it('moves a team that runs where its node runs along with the model the node is switched to', async () => {
    const groups: ModelPaletteGroup[] = [{ id: 'models', label: 'Models', available: true, models: [
      { key: 'pi-a', label: 'Pi A', providerGroup: 'models', runtime: 'pi', model: 'model-a', available: true },
      { key: 'agents-b', label: 'Agents B', providerGroup: 'models', runtime: 'openai-agents', model: 'model-b', available: true },
    ] }];
    const both = vi.fn(async (path: string) => path.endsWith('/models') ? { models: ['model-a', 'model-b'] } : { agents: [
      { name: 'pi', supports_model_selection: true, supports_node_teams: true },
      { name: 'openai-agents', supports_model_selection: true, supports_node_teams: true }] });
    const save = vi.fn();
    render(<InspectorPanel node={{ ...session(), runtime: '', model: '' }} liveCompanies={[]} apiBase="/api" readJson={both} modelGroups={groups}
      onSave={save} onClose={vi.fn()} />);
    await enable();
    fireEvent.change(screen.getAllByRole('combobox', { name: '模型' })[0], { target: { value: 'model-a' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(save.mock.lastCall![0]).toMatchObject({ runtime: 'pi', model: 'model-a',
      team: { runtime: 'pi', members: [expect.objectContaining({ runtime: '', model: '' }), expect.objectContaining({ runtime: '', model: '' })] } });
  });
  // Sub-agent review 2026-10-25: the template picker could give a sandbox node a team the API then refuses, a question
  // about a replacement outlived the team it was asked for, and members of a node without a runtime were said not to
  // inherit its model.
  it('offers no team on a sandbox node, which runs one Agent', () => {
    render(<Harness initial={{ ...session(), runtime: 'sandbox', model: 'box' }} />);
    expect(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })).toBeDisabled();
    expect(screen.getByLabelText('协作模板')).toBeDisabled();
    expect(screen.getByText('沙箱电脑节点只运行一个 Agent，不能配协作团队。')).toBeInTheDocument();
  });
  it('forgets a replacement it asked about once the team it was for is turned off', async () => {
    render(<Harness />); await enable();
    fireEvent.change(screen.getByLabelText('协作模板'), { target: { value: 'draft-review' } });
    expect(screen.getByRole('button', { name: '替换为此模板' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '启用多 Agent 协作' }));
    await enable();
    expect(screen.queryByRole('button', { name: '替换为此模板' })).toBeNull();
  });
  it('says members of a node without a runtime inherit its model, as the API runs it on OpenAI Agents', async () => {
    render(<Harness initial={{ ...session(), runtime: '', model: '' }} runtimes={['pi', 'openai-agents']} runtimeTools={{ 'openai-agents': [] }} />);
    await enable();
    expect(member(1).getByRole('option', { name: '继承节点已绑定模型' })).toHaveValue('');
  });
  it('does not enable teams when the host lacks Pi', () => {
    render(<Harness available={false} />); expect(screen.getByRole('checkbox')).toBeDisabled(); expect(screen.getByText(/当前运行环境未提供团队/)).toBeInTheDocument();
  });
  it('requires explicit team capability even when a legacy host lists Pi', async () => {
    const legacyRead = vi.fn(async () => ({ agents: [{ name: 'pi' }] }));
    render(<InspectorPanel node={session()} liveCompanies={[]} apiBase="/api" readJson={legacyRead} onSave={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(legacyRead).toHaveBeenCalled());
    expect(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })).toBeDisabled();
    expect(screen.getByText(/当前运行环境未提供团队/)).toBeInTheDocument();
  });
  it('reports catalog failure and retries without inventing model options', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ models: ['model-a'] }); render(<Harness read={read} />);
    fireEvent.click(screen.getByRole('checkbox')); await screen.findByText(/模型清单读取失败/); expect(member(1).getByLabelText('模型')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试模型清单' })); await waitFor(() => expect(member(1).getByLabelText('模型')).not.toBeDisabled()); expect(read).toHaveBeenCalledTimes(2);
  });
  it('blocks inspector save for stale models/invalid limits and saves corrected team settings', async () => {
    const initial = session(); initial.team = createNodeTeam(initial); initial.team.members[0].model = 'retired-model'; const save = vi.fn(); const close = vi.fn();
    render(<InspectorPanel node={initial} liveCompanies={[]} apiBase="/api" readJson={readJson} onSave={save} onClose={close} />);
    await screen.findByText(/此模型不在当前 Pi 模型清单中/); expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.change(member(1).getByLabelText('模型'), { target: { value: 'model-b' } });
    fireEvent.change(screen.getByLabelText('节点超时（秒）'), { target: { value: '0' } }); expect(screen.getByRole('button', { name: '保存' })).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('10 至 1800');
    fireEvent.change(screen.getByLabelText('节点超时（秒）'), { target: { value: '90' } }); fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(save).toHaveBeenCalledOnce(); expect(save.mock.lastCall![0]).toMatchObject({ persona: initial.persona, model: initial.model, team: { timeoutSeconds: 90, members: [expect.objectContaining({ model: 'model-b' }), expect.anything()] } }); expect(close).toHaveBeenCalledOnce();
  });
  it('localizes team settings and summarizes members/mode on collapsed nodes', async () => {
    const initial = session(); initial.team = { ...createNodeTeam(initial), mode: 'parallel' };
    const { unmount } = render(<CanvasI18nProvider locale="en"><Harness initial={initial} /></CanvasI18nProvider>);
    expect(screen.getByRole('checkbox', { name: 'Enable multiple Agents' })).toBeInTheDocument(); expect(screen.getByLabelText('Maximum model calls')).toBeInTheDocument(); await screen.findAllByRole('option', { name: 'model-a' });
    expect(screen.getByText(/Shared session history includes completed user exchanges/)).toHaveTextContent('not every earlier member response');
    unmount(); render(<CanvasI18nProvider locale="en"><SessionTile node={initial} compact scale={1} focused={false} /></CanvasI18nProvider>);
    expect(screen.getByTestId('node-team-badge-node-a')).toHaveTextContent('2 Agent');
    expect(screen.getByTestId('node-team-badge-node-a')).toHaveAttribute('title', '2 Agent · Parallel and aggregate');
  });
});

const mixedRuntimes: NodeTeamRuntime[] = ['pi', 'openai-agents'];
const allowedTools: Partial<Record<NodeTeamRuntime, NodeTeamTool[]>> = { 'openai-agents': ['calculator', 'current_time'] };
const mixedRead = async (path: string) => ({ models: path.includes('/openai-agents/') ? ['agents-only', 'shared-id'] : ['model-a', 'pi-only', 'shared-id'] });
describe('OpenAI Agents team configuration', () => {
  it('loads each member runtime catalog, resets portable settings and allows only advertised tools', async () => {
    const save = vi.fn(); const read = vi.fn(mixedRead);
    render(<Harness read={read} onChange={save} runtimes={mixedRuntimes} runtimeTools={allowedTools} />); await enable();
    fireEvent.change(member(2).getByLabelText('执行框架'), { target: { value: 'openai-agents' } });
    await waitFor(() => expect(member(2).getByLabelText('模型')).not.toBeDisabled());
    expect(read).toHaveBeenCalledWith('/api/agents/openai-agents/models');
    expect(within(member(2).getByLabelText('模型')).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['', 'agents-only', 'shared-id']);
    expect(member(2).getByRole('option', { name: '使用此执行框架的服务默认模型' })).toHaveValue('');
    expect(member(1).queryByRole('checkbox', { name: /计算器/ })).toBeNull();
    fireEvent.change(member(2).getByLabelText('模型'), { target: { value: 'agents-only' } });
    fireEvent.click(member(2).getByRole('checkbox', { name: /计算器/ }));
    fireEvent.click(member(2).getByRole('checkbox', { name: /当前时间/ }));
    expect(save.mock.lastCall![0].members[1]).toMatchObject({ runtime: 'openai-agents', model: 'agents-only', tools: ['calculator', 'current_time'] });
    expect(screen.queryByLabelText('思考强度')).toBeNull();
    fireEvent.change(member(2).getByLabelText('执行框架'), { target: { value: 'pi' } });
    expect(save.mock.lastCall![0].members[1]).toMatchObject({ runtime: 'pi', model: '', tools: [] });
    expect(member(2).queryByRole('checkbox', { name: /计算器/ })).toBeNull();
    await waitFor(() => expect(member(2).getByLabelText('模型')).not.toBeDisabled());
  });
  it('changing the team default resets inherited members but retains explicit Pi members', async () => {
    const initial = session(); initial.team = createNodeTeam(initial); initial.team.members[1].runtime = 'pi'; initial.team.members[1].model = 'pi-only';
    const save = vi.fn(); render(<Harness initial={initial} read={mixedRead} runtimes={mixedRuntimes} runtimeTools={allowedTools} onChange={save} />);
    await waitFor(() => expect(member(1).getByLabelText('模型')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('团队默认执行框架'), { target: { value: 'openai-agents' } });
    expect(save.mock.lastCall![0]).toMatchObject({ runtime: 'openai-agents', members: [expect.objectContaining({ runtime: '', model: '', tools: [] }), expect.objectContaining({ runtime: 'pi', model: 'pi-only' })] });
    await waitFor(() => expect(member(1).getByLabelText('模型')).not.toBeDisabled());
    expect(member(1).getByRole('option', { name: 'agents-only' })).toBeInTheDocument();
    expect(member(2).queryByRole('option', { name: 'agents-only' })).toBeNull();
  });
  it('ignores late catalogs after runtime changes and preserves unknown saved models visibly', async () => {
    let resolveAgents!: (value: unknown) => void;
    const read = vi.fn((path: string): Promise<any> => path.includes('/openai-agents/') ? new Promise(resolve => { resolveAgents = resolve; }) : mixedRead(path));
    render(<Harness read={read} runtimes={mixedRuntimes} />); await enable();
    fireEvent.change(member(2).getByLabelText('执行框架'), { target: { value: 'openai-agents' } });
    expect(member(2).getByLabelText('模型')).toBeDisabled();
    fireEvent.change(member(2).getByLabelText('执行框架'), { target: { value: 'pi' } });
    await waitFor(() => expect(member(2).getByLabelText('模型')).not.toBeDisabled());
    resolveAgents({ models: ['late-agents-model'] });
    await waitFor(() => expect(member(2).getByRole('option', { name: 'pi-only' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'late-agents-model' })).toBeNull();
  });
  it('keeps saved models and tools visible when the catalog changes, blocking save until corrected', async () => {
    const node = session(); node.team = createNodeTeam(node); node.team.members[1] = { ...node.team.members[1], runtime: 'openai-agents', model: 'retired-agents', tools: ['calculator'] };
    const validity = vi.fn();
    render(<NodeTeamEditor node={node} available runtimes={mixedRuntimes} runtimeTools={{ 'openai-agents': [] }} readJson={mixedRead} onChange={vi.fn()} onValidityChange={validity} />);
    await screen.findByText(/此模型不在当前 OpenAI Agents 模型清单/);
    expect(member(2).getByLabelText('模型')).toHaveValue('retired-agents');
    expect(member(2).getByRole('checkbox', { name: /计算器/ })).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('当前服务目录未提供此工具');
    expect(validity).toHaveBeenLastCalledWith(false);
  });
  it('preserves tools during read-only viewing and guards synthetic changes', async () => {
    const node = { ...session(), runtime: 'openai-agents', model: 'agents-only' }; node.team = createNodeTeam(node); node.team.members[0].tools = ['calculator'];
    const save = vi.fn(); render(<Harness initial={node} read={mixedRead} disabled runtimes={mixedRuntimes} runtimeTools={allowedTools} onChange={save} />);
    await screen.findAllByRole('option', { name: 'agents-only' });
    const calculator = member(1).getByRole('checkbox', { name: /计算器/ }); expect(calculator).toBeChecked(); expect(calculator).toBeDisabled();
    fireEvent.click(calculator); fireEvent.change(member(1).getByLabelText('执行框架'), { target: { value: 'pi' } });
    expect(save).not.toHaveBeenCalled();
  });
});
describe('node team templates in the editor', () => {
  const template = () => screen.getByLabelText('协作模板');
  it('lists every template with its mode and planned calls, and starts a team from one', async () => {
    const save = vi.fn(); render(<Harness onChange={save} />);
    expect(within(template()).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['', ...nodeTeamTemplates().map(item => item.id)]);
    expect(within(template()).getByRole('option', { name: '正反辩论与裁决（多轮讨论 · 最多 7 次调用）' })).toBeInTheDocument();
    fireEvent.change(template(), { target: { value: 'debate-verdict' } });
    const team = save.mock.lastCall![0];
    expect(team).toMatchObject({ mode: 'debate', runtime: 'pi', maxRounds: 2, maxTurns: 7 });
    expect(team.members.map((item: { name: string }) => item.name)).toEqual(['正方', '反方', '裁决者']);
    expect(validateNodeTeam(team)).toEqual([]);
    await waitFor(() => expect(member(3).getByLabelText('模型')).not.toBeDisabled());
    expect(member(3).getByLabelText('模型')).toHaveValue('');
    expect(template()).toHaveValue('');
  });
  it('asks before replacing a team, keeps it on cancel and keeps a same-name member’s own model on replace', async () => {
    const node = session(); node.team = createNodeTeam(node);
    node.team.members[1] = { ...node.team.members[1], name: '审核者', model: 'model-b' };
    const save = vi.fn(); render(<Harness initial={node} onChange={save} />);
    fireEvent.change(template(), { target: { value: 'draft-review' } });
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText('用「撰写与审核」替换当前团队的 2 位成员？同名成员保留自己选的模型和设置。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保留当前团队' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText(/替换当前团队/)).toBeNull();
    fireEvent.change(template(), { target: { value: 'draft-review' } });
    fireEvent.click(screen.getByRole('button', { name: '替换为此模板' }));
    const team = save.mock.lastCall![0];
    expect(team.mode).toBe('review');
    expect(team.members.map((item: { name: string; model: string }) => [item.name, item.model])).toEqual([['撰写者', ''], ['审核者', 'model-b']]);
    expect(team.members[1].id).toBe(node.team.members[1].id);
    expect(screen.queryByText(/替换当前团队/)).toBeNull();
  });
  it('offers no template while the editor is read-only or teams are unavailable', () => {
    const { unmount } = render(<Harness disabled />);
    expect(template()).toBeDisabled();
    unmount();
    render(<Harness available={false} />);
    expect(template()).toBeDisabled();
  });
});
describe('a new team’s runtime', () => {
  it('is where its node runs, from the checkbox and from a template alike, whatever the catalogue answered just now', () => {
    const save = vi.fn();
    const read = vi.fn(async (path: string) => path.endsWith('/models') ? { models: ['agents-model'] } : { agents: [] });
    const { unmount } = render(<Harness initial={{ ...session(), runtime: '' }} read={read} runtimes={['openai-agents']} runtimeTools={{ 'openai-agents': [] }} onChange={save} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '启用多 Agent 协作' }));
    expect(save.mock.lastCall![0].runtime).toBe('openai-agents');
    unmount();
    const fromTemplate = vi.fn();
    render(<Harness initial={{ ...session(), runtime: '' }} read={read} runtimes={['openai-agents']} runtimeTools={{ 'openai-agents': [] }} onChange={fromTemplate} />);
    fireEvent.change(screen.getByLabelText('协作模板'), { target: { value: 'plan-build-check' } });
    expect(fromTemplate.mock.lastCall![0].runtime).toBe('openai-agents');
    cleanup();
    // A Pi node's team stays on Pi even while the catalogue lists only OpenAI Agents.
    const onPi = vi.fn();
    render(<Harness initial={{ ...session(), runtime: 'pi' }} read={read} runtimes={['openai-agents']} runtimeTools={{ 'openai-agents': [] }} onChange={onPi} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '启用多 Agent 协作' }));
    expect(onPi.mock.lastCall![0].runtime).toBe('pi');
  });
});
