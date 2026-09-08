import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RunControls, type RunControlsProps } from '../src/canvas/RunControls';
import { createSessionNode } from '../src/canvas/canvasDoc';
import { LocaleProvider } from '../src/canvas/i18n';

function node(id: string, bound = false) {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id, title: `任务 ${id}`,
    binding: bound ? { companyId: 'workspace', agentId: `agent-${id}`, agentName: id } : null };
}
function props(overrides: Partial<RunControlsProps> = {}): RunControlsProps {
  return { nodes: [node('a'), node('b')], edges: [], running: false, runs: {},
    onStart: vi.fn(), onStop: vi.fn(), ...overrides };
}
const completed = { ok: true, done: 1, failed: 0, blocked: 0, cancelled: 0, cached: 0, total: 1 };
afterEach(cleanup);

describe('run configuration notices', () => {
  it('shows a compact count with expandable, actionable nodes and a dismiss button', () => {
    const configure = vi.fn(); const p = props({ onConfigureNode: configure });
    render(<RunControls {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 运行图' }));
    expect(screen.getByRole('alert')).toHaveTextContent('2 个节点待配置');
    expect(screen.queryByText('任务 a')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开问题' }));
    fireEvent.click(screen.getByRole('button', { name: '配置 任务 b' }));
    expect(configure).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('button', { name: '收起问题' }));
    expect(screen.queryByRole('button', { name: '配置 任务 b' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭运行提示' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '▶ 运行图' }));
    expect(screen.getByRole('alert')).toHaveTextContent('2 个节点待配置');
    expect(p.onStart).not.toHaveBeenCalled();
  });

  it('lets scoped execution replace an old whole-graph refusal and previous summary total', () => {
    const p = props({ nodes: [node('a', true), node('b')], summary: { ...completed, total: 9, done: 9 } });
    const view = render(<RunControls {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 运行图' }));
    expect(screen.getByRole('alert')).toHaveTextContent('1 个节点待配置');
    view.rerender(<RunControls {...p} running runs={{}} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在准备运行…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(<RunControls {...p} running runs={{ a: { state: 'done' } }} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('运行中 · 1/1');
    view.rerender(<RunControls {...p} summary={completed} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('运行完成：1/1');
  });

  it('updates changed problems and does not revive an old refusal after the graph was fixed', () => {
    const p = props(); const view = render(<RunControls {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 运行图' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭运行提示' }));
    view.rerender(<RunControls {...p} nodes={[node('c')]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('1 个节点待配置');
    fireEvent.click(screen.getByRole('button', { name: '展开问题' }));
    expect(screen.getByRole('alert')).toHaveTextContent('任务 c');
    expect(screen.getByRole('alert')).not.toHaveTextContent('任务 a');
    view.rerender(<RunControls {...p} nodes={[node('c', true)]} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(<RunControls {...p} nodes={[node('d')]} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('dismisses completion and stopped summaries, showing fresh completion after another run', () => {
    const p = props({ nodes: [node('a', true)], summary: completed });
    const view = render(<RunControls {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭运行提示' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    view.rerender(<RunControls {...p} running runs={{ a: { state: 'running' } }} />);
    expect(screen.getByRole('status')).toHaveTextContent('运行中 · 0/1');
    view.rerender(<RunControls {...p} />);
    expect(screen.getByRole('status')).toHaveTextContent('运行完成');
    view.rerender(<RunControls {...p} stopped />);
    expect(screen.getByRole('status')).toHaveTextContent('已停止');
    fireEvent.click(screen.getByRole('button', { name: '关闭运行提示' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('hands unbound SaaS nodes to initialization while preserving legacy preflight and read-only guards', () => {
    const p = props(); const view = render(<RunControls {...p} initializeOnRun />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 运行图' }));
    expect(p.onStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(<RunControls {...p} initializeOnRun readOnly />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 运行图' }));
    expect(p.onStart).toHaveBeenCalledTimes(1);
    view.rerender(<RunControls {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 运行图' }));
    expect(p.onStart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('2 个节点待配置');
  });

  it('localizes the compact and expanded actions in English', () => {
    render(<LocaleProvider locale="en"><RunControls {...props({ onConfigureNode: vi.fn() })} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: '▶ Run graph' }));
    expect(screen.getByRole('alert')).toHaveTextContent('2 node(s) need configuration');
    fireEvent.click(screen.getByRole('button', { name: 'Show issues' }));
    expect(screen.getByRole('button', { name: 'Configure 任务 a' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss run notice' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
