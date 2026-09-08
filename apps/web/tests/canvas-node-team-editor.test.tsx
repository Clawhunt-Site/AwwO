import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { NodeTeamEditor } from '../src/canvas/NodeTeamEditor';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { InspectorPanel } from '../src/canvas/InspectorPanel';
import { LocaleProvider as CanvasI18nProvider } from '../src/canvas/i18n';
import { SessionTile } from '../src/canvas/SessionTile';
const readJson = vi.fn(async (path: string) => path.endsWith('/models') ? { models: ['model-a', 'model-b'] } : { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] });
function session(): SessionNode { return { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title: '研究', persona: 'Check the source.', model: 'model-a', runtime: 'pi' }; }
function Harness({ initial = session(), disabled = false, available = true, read = readJson, onChange = vi.fn() }: {
  initial?: SessionNode; disabled?: boolean; available?: boolean; read?: typeof readJson; onChange?: ReturnType<typeof vi.fn>;
}) {
  const [node, setNode] = useState(initial);
  return <NodeTeamEditor node={node} available={available} readJson={read} disabled={disabled} onChange={team => { onChange(team); setNode({ ...node, team }); }} />;
}
function member(index: number) { return within(screen.getByRole('group', { name: `Agent ${index}` })); }
async function enable() { fireEvent.click(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })); await waitFor(() => expect(member(1).getByLabelText('模型')).not.toBeDisabled()); }
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('node team configuration', () => {
  it('seeds two members and preserves single-Agent settings on disable', async () => {
    const save = vi.fn(); const initial = session(); render(<Harness initial={initial} onChange={save} />); await enable();
    expect(member(1).getByLabelText('专属指令')).toHaveValue('Check the source.'); expect(member(1).getByLabelText('模型')).toHaveValue('model-a');
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
    expect(member(1).getByLabelText('模型')).toHaveValue('model-a');
    fireEvent.change(member(2).getByLabelText('执行框架'), { target: { value: 'pi' } }); expect(member(2).getByLabelText('模型')).toHaveValue('');
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
  it('does not enable teams when the host lacks Pi', () => {
    render(<Harness available={false} />); expect(screen.getByRole('checkbox')).toBeDisabled(); expect(screen.getByText(/当前运行环境未提供 Pi/)).toBeInTheDocument();
  });
  it('requires explicit team capability even when a legacy host lists Pi', async () => {
    const legacyRead = vi.fn(async () => ({ agents: [{ name: 'pi' }] }));
    render(<InspectorPanel node={session()} liveCompanies={[]} apiBase="/api" readJson={legacyRead} onSave={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(legacyRead).toHaveBeenCalled());
    expect(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })).toBeDisabled();
    expect(screen.getByText(/当前运行环境未提供 Pi/)).toBeInTheDocument();
  });
  it('reports catalog failure and retries without inventing model options', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ models: ['model-a'] }); render(<Harness read={read} />);
    fireEvent.click(screen.getByRole('checkbox')); await screen.findByText(/Pi 模型清单读取失败/); expect(member(1).getByLabelText('模型')).toBeDisabled();
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
    unmount(); render(<CanvasI18nProvider locale="en"><SessionTile node={initial} compact scale={1} focused={false} /></CanvasI18nProvider>);
    expect(screen.getByTestId('node-team-badge-node-a')).toHaveTextContent('2 Agent · Parallel and aggregate');
  });
});
