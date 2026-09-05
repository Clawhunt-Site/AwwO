// SessionTile: the per-node chat window. These pin the invariants that make a node USABLE at
// every level of detail. Configuration stays reachable from the compact header;
// infrequent actions live in the overflow menu.
//
//   - configuration once rode `lod === 'open'` only, so focusing a node — the one
//     state you are in when you want to configure it — removed the ONLY route to the inspector,
//     stranding an unbound node with no way to ever bind it;
//   - the focus class was emitted twice (once by the LOD class, once by a redundant `focused`
//     clause).
//
// Plus the honesty invariant the composer carries: an unbound tile says WHY it cannot send.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTile } from '../src/canvas/SessionTile';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

function node(over: Partial<SessionNode> = {}): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id: 's1', title: 'LLM 会话', ...over };
}

beforeEach(() => {
  cleanup();
  resetAllSessions();
});

describe('SessionTile compact header actions', () => {
  it('keeps 配置 reachable at the FOCUS level, so a focused unbound node can still be bound', () => {
    const onConfigure = vi.fn();
    render(
      <SessionTile node={node()} scale={1} focused onConfigure={onConfigure} onToggleFocus={vi.fn()} onDelete={vi.fn()} />,
    );
    const tile = screen.getByTestId('canvas-tile-s1');
    expect(tile.dataset.lod).toBe('focus');

    fireEvent.click(within(tile).getByRole('button', { name: '配置' }));
    expect(onConfigure).toHaveBeenCalledWith('s1');
  });

  it('also keeps it at the OPEN level (the pre-focus reading state)', () => {
    const onConfigure = vi.fn();
    render(<SessionTile node={node()} scale={1} focused={false} onConfigure={onConfigure} />);
    const tile = screen.getByTestId('canvas-tile-s1');
    expect(tile.dataset.lod).toBe('open');
    fireEvent.click(within(tile).getByRole('button', { name: '配置' }));
    expect(onConfigure).toHaveBeenCalledWith('s1');
  });

  it('emits the focus class exactly once', () => {
    render(<SessionTile node={node()} scale={1} focused />);
    const classes = screen.getByTestId('canvas-tile-s1').className.split(/\s+/);
    expect(classes.filter((c) => c === 'canvas-tile--focus')).toHaveLength(1);
  });

  it('keeps focus and delete in the overflow menu while configuration stays immediately reachable', () => {
    const onDelete = vi.fn();
    render(<SessionTile node={node()} scale={1} focused onConfigure={vi.fn()} onToggleFocus={vi.fn()} onDelete={onDelete} />);
    expect(screen.getByRole('button', { name: '配置' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除', exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
    expect(screen.getByRole('button', { name: '聚焦', exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }));
    expect(onDelete).toHaveBeenCalledWith('s1');
  });
});

describe('SessionTile composer', () => {
  it('an UNBOUND focused tile cannot send and says why', () => {
    const onSend = vi.fn();
    render(<SessionTile node={node({ binding: null })} scale={1} focused onSend={onSend} />);
    const tile = screen.getByTestId('canvas-tile-s1');

    const box = within(tile).getByRole('textbox', { name: /agent|消息/i }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(tile.textContent).toContain('尚未绑定');

    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('a BOUND focused tile sends the typed message', () => {
    const onSend = vi.fn();
    const bound = node({ binding: { companyId: 'c1', agentId: 'a1', agentName: '前端' } });
    render(<SessionTile node={bound} scale={1} focused onSend={onSend} />);
    const tile = screen.getByTestId('canvas-tile-s1');

    const box = within(tile).getByRole('textbox', { name: /agent|消息/i }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: '写个登录页' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][1]).toBe('写个登录页');
  });
});
