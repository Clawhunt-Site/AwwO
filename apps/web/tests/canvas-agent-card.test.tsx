import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTile } from '../src/canvas/SessionTile';
import { createSessionNode, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { resetAllSessions, setStreaming } from '../src/canvas/sessions';

function node(over: Partial<SessionNode> = {}): SessionNode {
  return { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'frontend', title: '前端 Agent', w: 400, h: 420, ...over };
}

beforeEach(() => { cleanup(); resetAllSessions(); });

describe('AwwO conversational cards', () => {
  it('offers a composer on a normal open card and sends without requiring focus', () => {
    const onSend = vi.fn();
    render(<SessionTile node={node({ binding: { companyId: 'c', agentId: 'a', agentName: '前端' } })} scale={1} focused={false} onSend={onSend} />);
    expect(screen.getByTestId('canvas-tile-frontend').dataset.lod).toBe('open');
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '实现登录页' } });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'frontend' }), '实现登录页');
  });

  it('explains the next step for a draft without verbose runtime metadata', () => {
    render(<SessionTile node={node()} scale={1} focused={false} onConfigure={vi.fn()} />);
    expect(screen.getByTestId('canvas-tile-bind-frontend').textContent).toContain('草稿');
    expect(screen.getByText('连接 Agent 后开始对话')).toBeTruthy();
    expect(screen.queryAllByText('未选择')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '配置' })).toBeTruthy();
  });

  it('keeps the conversation and its unsent message visible while inspecting inputs and deliverables', () => {
    render(<SessionTile node={node({ binding: { companyId: 'c', agentId: 'a', agentName: '前端' } })} scale={1} focused={false} onSend={vi.fn()} />);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '请先检查现有接口' } });
    expect(screen.getByRole('navigation', { name: 'Session 管理' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    expect(screen.getByRole('region', { name: '输入表单' })).toBeTruthy();
    expect(screen.getByTestId('composer-input')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '展开交付物' }));
    expect(screen.getByRole('region', { name: '交付物' })).toBeTruthy();
    expect(screen.getByTestId('composer-input')).toBeVisible();
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('请先检查现有接口');
    fireEvent.click(screen.getByRole('button', { name: '关闭交付物' }));
    fireEvent.click(screen.getByRole('button', { name: '收起输入' }));
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('请先检查现有接口');
  });

  it('edits an input inside its own card without publishing an output', () => {
    const updates = vi.fn();
    function Harness() {
      const [current, setCurrent] = useState<CanvasNode>(node());
      return <SessionTile node={current} scale={1} focused={false} onUpdateNode={(next) => { updates(next); setCurrent(next); }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '添加字段' }));
    fireEvent.change(screen.getByLabelText('字段 1 名称'), { target: { value: '需求' } });
    fireEvent.change(screen.getByLabelText('需求的值'), { target: { value: '可访问的登录页' } });
    expect(updates.mock.lastCall?.[0].contract.inputs[0].value).toBe('可访问的登录页');
    expect(updates.mock.lastCall?.[0].lastOutput).toBeUndefined();
  });

  it('keeps contract edits read-only during a stream and when no edit callback is supplied', () => {
    setStreaming('frontend', true);
    render(<SessionTile node={node()} scale={1} focused onUpdateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    expect((screen.getByRole('button', { name: '添加字段' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup(); resetAllSessions();
    render(<SessionTile node={node()} scale={1} focused />);
    fireEvent.click(screen.getByRole('button', { name: '展开交付物' }));
    fireEvent.click(screen.getByText('编辑输出表单'));
    expect((screen.getByRole('button', { name: '添加字段' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('publishes only valid declared outputs and preserves field edits separately', () => {
    const updates = vi.fn();
    function Harness() {
      const [current, setCurrent] = useState<CanvasNode>(node());
      return <SessionTile node={current} scale={1} focused onUpdateNode={(next) => { updates(next); setCurrent(next); }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '展开交付物' }));
    fireEvent.click(screen.getByText('编辑输出表单'));
    fireEvent.click(screen.getByRole('button', { name: '添加字段' }));
    fireEvent.change(screen.getByLabelText('字段 1 名称'), { target: { value: '数量' } });
    fireEvent.change(screen.getByLabelText('数量的类型'), { target: { value: 'number' } });
    fireEvent.click(screen.getByLabelText('数量必填'));
    fireEvent.click(screen.getByRole('button', { name: '发布输出' }));
    expect(updates.mock.lastCall?.[0].lastOutput).toBeUndefined();
    fireEvent.change(screen.getByLabelText('数量的值'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '发布输出' }));
    const published = updates.mock.lastCall?.[0];
    expect(JSON.parse(published.lastOutput.text)).toEqual({ [published.contract.outputs[0].id]: 3 });
    expect(published.lastOutput.source).toBe('manual');
  });

  it('routes a node run to its own id and displays an actual blocked reason', () => {
    const onRunNode = vi.fn();
    render(<SessionTile node={node({ binding: { companyId: 'c', agentId: 'a', agentName: '前端' } })} scale={1} focused run={{ state: 'blocked', detail: '等待后端接口' }} onRunNode={onRunNode} />);
    expect(screen.getByTestId('canvas-tile-run-frontend').textContent).toBe('等待后端接口');
    fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(within(screen.getByTestId('canvas-tile-frontend')).getByRole('button', { name: '运行节点' }));
    expect(onRunNode).toHaveBeenCalledWith('frontend');
  });
});
