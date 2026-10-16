import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { COMPACT_CHIP_MIN_SCALE, SessionTile } from '../src/canvas/SessionTile';
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
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'frontend' }), '实现登录页', expect.any(Function), '实现登录页');
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
    fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表' }));
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
    fireEvent.click(screen.getByRole('button', { name: '编辑字段结构' }));
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
    expect(screen.queryByRole('button', { name: '编辑字段结构' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加字段' })).toBeNull();
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
    const badge = screen.getByTestId('canvas-tile-run-frontend');
    expect(badge.textContent).toBe('等待后端接口');
    expect(badge.getAttribute('title')).toBe('等待后端接口');
    fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(within(screen.getByTestId('canvas-tile-frontend')).getByRole('button', { name: '运行节点' }));
    expect(onRunNode).toHaveBeenCalledWith('frontend');
  });

  it('marks a compact card zoomed out past a readable state chip, keeping the chip for assistive technology', () => {
    const blocked = { state: 'blocked' as const, detail: '上游节点未完成' };
    const { rerender } = render(<SessionTile node={node()} compact scale={1} focused={false} run={blocked} />);
    const tile = () => screen.getByTestId('canvas-tile-frontend');
    expect(tile()).not.toHaveAttribute('data-zoom');
    rerender(<SessionTile node={node()} compact scale={COMPACT_CHIP_MIN_SCALE} focused={false} run={blocked} />);
    expect(tile()).not.toHaveAttribute('data-zoom');
    rerender(<SessionTile node={node()} compact scale={COMPACT_CHIP_MIN_SCALE - 0.05} focused={false} run={blocked} />);
    expect(tile()).toHaveAttribute('data-zoom', 'far');
    expect(screen.getByTestId('canvas-tile-run-frontend')).toHaveTextContent('上游节点未完成');
    // An open card draws its own level of detail and is never marked.
    rerender(<SessionTile node={node()} scale={0.3} focused={false} run={blocked} />);
    expect(tile()).not.toHaveAttribute('data-zoom');
  });

  it('lets a closed card that runs keep its title on one line, its chip still read by assistive technology', () => {
    // jsdom has no layout. In a real browser (2026-10-16) 「运行中」 beside the stop button pushed a five-character title
    // onto a second line and clipped itself to 「运行…」; the rule that steps the chip aside visually is checked.
    const css = readFileSync(resolve(process.cwd(), 'src/saas/design/canvas.css'), 'utf8');
    const hidden = /([^{}]+)\{\s*position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset\(50%\);/.exec(css)?.[1] ?? '';
    const selectors = hidden.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map(selector => selector.trim());
    expect(selectors).toContain('.canvas-root .awwo-node.is-compact .canvas-tile-badge.canvas-tile-badge--running:not([data-detail])');
    expect(selectors).toContain('.canvas-root .awwo-node.is-compact .canvas-tile-head:has(.awwo-card-stop) .canvas-tile-badge.canvas-tile-badge--waiting:not([data-detail])');
    const bound = node({ binding: { companyId: 'c', agentId: 'a', agentName: '前端' } });
    for (const [state, label] of [['running', '运行中'], ['waiting', '排队']] as const) {
      cleanup();
      render(<SessionTile node={bound} compact scale={1} focused={false} run={{ state }} onStopNode={vi.fn()} />);
      const head = screen.getByTestId('canvas-tile-frontend').querySelector('.canvas-tile-head')!;
      expect(within(head as HTMLElement).getByRole('button', { name: '停下这个组件' })).toHaveClass('awwo-card-stop');
      const chip = screen.getByTestId('canvas-tile-run-frontend');
      expect(chip).toHaveClass(`canvas-tile-badge--${state}`);
      expect(chip).toHaveTextContent(label);
      expect(chip).not.toHaveAttribute('data-detail');
    }
    // A run that lost its stream before it ended still shows as running; its chip keeps the reason in view, as its title.
    cleanup();
    render(<SessionTile node={bound} compact scale={1} focused={false} run={{ state: 'running', unconfirmed: true, detail: 'recovery_settlement_unconfirmed' }} onStopNode={vi.fn()} />);
    const noted = screen.getByTestId('canvas-tile-run-frontend');
    expect(noted).toHaveAttribute('data-detail', 'true');
    expect(noted.getAttribute('title')).not.toBe(noted.textContent);
  });

  it('localizes a persisted recovery code in the run badge and title', () => {
    render(<SessionTile node={node()} scale={1} focused run={{ state: 'blocked', detail: 'recovery_not_dispatched' }} />);
    const badge = screen.getByTestId('canvas-tile-run-frontend');
    expect(badge.textContent).toBe('页面中断前尚未下发。');
    expect(badge.getAttribute('title')).toBe('页面中断前尚未下发。');
  });
});
