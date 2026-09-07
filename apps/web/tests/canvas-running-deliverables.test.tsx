import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTile, type SessionTileProps } from '../src/canvas/SessionTile';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { createNodeThread, getNodeThreads, selectNodeThread } from '../src/canvas/nodeThreads';
import { resetAllSessions, setStreaming } from '../src/canvas/sessions';

function deliveryNode(): SessionNode {
  const node: SessionNode = { ...createSessionNode('coding', { x: 45, y: 80 }), id: 'reading-agent',
    title: 'Frontend Agent', runtime: 'codex_local', issueId: 'stable-issue',
    binding: { companyId: 'company', agentId: 'agent', agentName: 'Agent' },
    contract: { version: 1, inputs: [], outputs: [{ id: 'summary', label: '实现说明', type: 'markdown',
      required: true, value: '待采用的输出草稿' }] },
    lastOutput: { text: JSON.stringify({ summary: '## 已验收的页面\n\n会员详情支持侧栏展开。' }), at: 1, source: 'run' },
  };
  // Changing Session removes the active publication but retains the original delivery as
  // history. A running retry must still let the operator read that prior evidence.
  return selectNodeThread(createNodeThread(node), 'default');
}

beforeEach(() => { resetAllSessions(); localStorage.clear(); });
afterEach(() => { cleanup(); resetAllSessions(); vi.restoreAllMocks(); });

describe('read-only delivery disclosure during execution', () => {
  it.each(['running', 'waiting', 'streaming', 'locked'] as const)('opens and closes existing results locally while %s without unlocking changes', mode => {
    const node = deliveryNode();
    const original = structuredClone(node);
    const onUpdateNode = vi.fn();
    const onToggleDeliverables = vi.fn();
    const onConfigure = vi.fn();
    const onDelete = vi.fn();
    if (mode === 'streaming') setStreaming(node.id, true);
    const props: SessionTileProps = { node, scale: 1, focused: true, onUpdateNode, onToggleDeliverables,
      onConfigure, onDelete, onSend: vi.fn(),
      run: mode === 'running' || mode === 'waiting' ? { state: mode } : null,
      interactionLocked: mode === 'locked' };
    render(<SessionTile {...props} />);
    const tile = screen.getByTestId('canvas-tile-reading-agent');
    const geometry = tile.getAttribute('style');
    const open = screen.getByRole('button', { name: '展开交付物', exact: true });
    expect(open).toBeEnabled();
    fireEvent.click(open);
    const delivery = screen.getByRole('region', { name: '交付物', exact: true });
    expect(within(delivery).getByRole('heading', { name: '已验收的页面', exact: true })).toBeInTheDocument();
    expect(within(delivery).getByText('历史交付 · 未传递给下游')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开 Session 1', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '打开 Session 2', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新建 Session', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: '配置', exact: true })).toBeDisabled();
    expect(screen.getByTestId('composer-input')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '打开 Session 2', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '更多节点操作', exact: true }));
    expect(screen.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }));
    fireEvent.click(within(delivery).getByText('编辑输出表单'));
    expect(within(delivery).getByLabelText('实现说明的值')).toBeDisabled();
    expect(within(delivery).getByRole('button', { name: '发布输出', exact: true })).toBeDisabled();
    fireEvent.change(within(delivery).getByLabelText('实现说明的值'), { target: { value: '不可采用的中间结果' } });
    fireEvent.click(within(delivery).getByRole('button', { name: '发布输出', exact: true }));
    const close = within(delivery).getByRole('button', { name: '关闭交付物', exact: true });
    expect(close).toBeEnabled();
    fireEvent.click(close);
    expect(screen.queryByRole('region', { name: '交付物', exact: true })).toBeNull();
    expect(tile.getAttribute('style')).toBe(geometry);
    expect(node).toEqual(original);
    expect(node.activeThreadId).toBe('default');
    expect(getNodeThreads(node)).toHaveLength(2);
    expect(onToggleDeliverables).not.toHaveBeenCalled();
    expect(onUpdateNode).not.toHaveBeenCalled();
    expect(onConfigure).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('resumes the normal persistence callback once execution is idle', () => {
    const node = deliveryNode();
    const onToggleDeliverables = vi.fn();
    const onUpdateNode = vi.fn();
    const { rerender } = render(<SessionTile node={node} scale={1} focused interactionLocked
      onToggleDeliverables={onToggleDeliverables} onUpdateNode={onUpdateNode} />);
    fireEvent.click(screen.getByRole('button', { name: '展开交付物', exact: true }));
    expect(onToggleDeliverables).not.toHaveBeenCalled();
    rerender(<SessionTile node={node} scale={1} focused interactionLocked={false}
      onToggleDeliverables={onToggleDeliverables} onUpdateNode={onUpdateNode} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭交付物', exact: true }));
    expect(onToggleDeliverables).toHaveBeenLastCalledWith(node.id, false);
    fireEvent.click(screen.getByRole('button', { name: '展开交付物', exact: true }));
    expect(onToggleDeliverables).toHaveBeenLastCalledWith(node.id, true);
    expect(onUpdateNode).not.toHaveBeenCalled();
  });

  it('keeps the standalone idle update path while avoiding that write during a run', () => {
    const node = deliveryNode();
    const onUpdateNode = vi.fn();
    const { rerender } = render(<SessionTile node={node} scale={1} focused run={{ state: 'running' }} onUpdateNode={onUpdateNode} />);
    fireEvent.click(screen.getByRole('button', { name: '展开交付物', exact: true }));
    expect(onUpdateNode).not.toHaveBeenCalled();
    rerender(<SessionTile node={node} scale={1} focused run={{ state: 'done' }} onUpdateNode={onUpdateNode} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭交付物', exact: true }));
    expect(onUpdateNode).toHaveBeenLastCalledWith({ ...node, deliverablesOpen: false });
  });
});
