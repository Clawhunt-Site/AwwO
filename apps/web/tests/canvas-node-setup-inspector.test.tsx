import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InspectorPanel, type InspectorPanelProps } from '../src/canvas/InspectorPanel';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { LocaleProvider } from '../src/canvas/i18n';

const hire = vi.fn();
vi.mock('../src/canvasHire', async original => ({
  ...await original<typeof import('../src/canvasHire')>(),
  hireAgentIntoCompany: (...args: unknown[]) => hire(...args),
}));
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function props(overrides: Partial<InspectorPanelProps> = {}): InspectorPanelProps {
  return {
    node: { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'research', title: '研究', persona: '核对证据' },
    liveCompanies: [{ id: 'workspace', name: '当前项目' }], apiBase: '/api',
    onSave: vi.fn(), onBound: vi.fn(), onClose: vi.fn(), onCreateCompany: vi.fn(),
    onInitialize: vi.fn(async () => {}), ...overrides,
  };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SaaS node configuration save', () => {
  it('saves once with service defaults and no separate company selection or legacy hire', async () => {
    const pending = deferred();
    let locked = false;
    const initialize = vi.fn(() => { expect(locked).toBe(true); return pending.promise; });
    const close = vi.fn(() => { expect(locked).toBe(false); });
    const p = props({ onInitialize: initialize, onClose: close, onCloseLockChange: value => { locked = value; } });
    render(<InspectorPanel {...p} />);
    expect(screen.getByText('当前工作区：当前项目')).toBeInTheDocument();
    expect(screen.getByText('未指定执行框架时使用 Pi；未指定模型时使用所选执行框架的服务端默认模型。')).toBeInTheDocument();
    expect(screen.queryByText('绑定真实 Agent')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('绑定到公司')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '绑定并创建真实 Agent' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '独立研究' } });
    fireEvent.change(screen.getByLabelText('人设 / 系统提示词'), { target: { value: '保留引用' } });
    const save = screen.getByRole('button', { name: '保存并准备运行' });
    fireEvent.click(save); fireEvent.click(save);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize.mock.calls[0]?.[0]).toMatchObject({ id: 'research', title: '独立研究', persona: '保留引用', runtime: '', model: '', binding: null });
    expect(screen.getByLabelText('名称')).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭配置' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '关闭配置' }));
    expect(close).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(close).toHaveBeenCalledTimes(1);
    expect(p.onSave).not.toHaveBeenCalled();
    expect(p.onBound).not.toHaveBeenCalled();
    expect(hire).not.toHaveBeenCalled();
  });

  it('retains the edited draft on failure and retries the same node through the host', async () => {
    const initialize = vi.fn().mockRejectedValueOnce(new Error('服务暂不可用')).mockResolvedValue(undefined);
    const p = props({ onInitialize: initialize });
    render(<InspectorPanel {...p} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '保留这个名称' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，草稿仍保留：服务暂不可用');
    expect(screen.getByLabelText('名称')).toHaveValue('保留这个名称');
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '保存并准备运行' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    await waitFor(() => expect(p.onClose).toHaveBeenCalledTimes(1));
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(initialize.mock.calls[1][0]).toMatchObject({ id: 'research', title: '保留这个名称' });
    expect(hire).not.toHaveBeenCalled();
  });

  it('disables unsupported image tasks and explains that saved instructions take effect', async () => {
    const p = props({ node: { ...createSessionNode('image', { x: 0, y: 0 }), id: 'image-draft' } });
    render(<InspectorPanel {...p} />);
    expect(screen.getByRole('radio', { name: '图像 Agent' })).toBeDisabled();
    expect(screen.getByText('Pi 和 OpenAI Agents JS 支持文本与编程任务；图像任务及单独设置思考强度尚不可用。')).toBeInTheDocument();
    expect(screen.getByLabelText('人设 / 系统提示词')).toHaveAttribute('placeholder', '这个 Agent 是谁、偏好什么、必须遵守什么…（保存时生效）');
    expect(screen.getByRole('button', { name: '保存并准备运行' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    expect(p.onInitialize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: '编程 Agent' }));
    expect(screen.getByRole('button', { name: '保存并准备运行' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    await waitFor(() => expect(p.onInitialize).toHaveBeenCalledTimes(1));
    expect(p.onInitialize).toHaveBeenCalledWith(expect.objectContaining({ id: 'image-draft', agentKind: 'coding' }));
  });

  it('guards read-only dispatch and does not close or re-submit after a late successful save', async () => {
    const pending = deferred();
    const p = props({ onInitialize: vi.fn(() => pending.promise) });
    const view = render(<InspectorPanel {...p} readOnly />);
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    expect(p.onInitialize).not.toHaveBeenCalled();
    view.rerender(<InspectorPanel {...p} readOnly={false} />);
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    view.rerender(<InspectorPanel {...p} readOnly />);
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.getByText('配置已保存。')).toBeInTheDocument();
    view.rerender(<InspectorPanel {...p} readOnly={false} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭', exact: true }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onInitialize).toHaveBeenCalledTimes(1);
  });

  it('ignores late results after unmount and releases the parent close lock', async () => {
    const pending = deferred(); const lock = vi.fn();
    const p = props({ onInitialize: vi.fn(() => pending.promise), onCloseLockChange: lock });
    const view = render(<InspectorPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    expect(lock).toHaveBeenLastCalledWith(true);
    view.unmount(); expect(lock).toHaveBeenLastCalledWith(false);
    const callsAtUnmount = lock.mock.calls.length;
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledTimes(callsAtUnmount);
  });

  it('ignores a previous node result after switching configuration', async () => {
    const pending = deferred(); const p = props({ onInitialize: vi.fn(() => pending.promise) });
    const view = render(<InspectorPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    const next = { ...p.node, id: 'review', title: '复核' };
    view.rerender(<InspectorPanel {...p} node={next} />);
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('名称')).toHaveValue('复核');
    expect(screen.getByRole('button', { name: '保存并准备运行' })).not.toBeDisabled();
  });

  it('keeps team validation strict before initialization', async () => {
    const node = props().node as SessionNode;
    node.team = { ...createNodeTeam(node), maxTurns: 0 };
    const readJson = vi.fn(async (path: string) => path.endsWith('/models') ? { models: ['model-a'] }
      : { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] });
    const p = props({ node, readJson }); render(<InspectorPanel {...p} />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: '保存并准备运行' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    expect(p.onInitialize).not.toHaveBeenCalled();
  });

  it('explains the service defaults and failure in English', async () => {
    const p = props({ onInitialize: vi.fn().mockRejectedValue(null), liveCompanies: [] });
    render(<LocaleProvider locale="en"><InspectorPanel {...p} /></LocaleProvider>);
    expect(screen.queryByText('Create company')).not.toBeInTheDocument();
    expect(screen.getByText('An unspecified runtime uses Pi. An unspecified model uses the selected runtime’s server default.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save and prepare to run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Saving failed. Your draft is kept: Saving could not complete. Try again.');
  });
});
