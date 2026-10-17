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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { runBadgeText, SessionTile } from '../src/canvas/SessionTile';
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
  it('leads with the published delivery instead of a later chat line, without Session chrome', () => {
    const delivered = node({
      preview: 'A newer chat reply',
      contract: { version: 1, inputs: [], outputs: [{ id: 'result', label: '交付结果', type: 'text', required: true, value: '' }] },
      lastOutput: { text: '{"result":"两步验收建议\\n核对输出与上下游"}', source: 'run', at: 1 },
      binding: { companyId: 'c1', agentId: 'a1', agentName: 'Agent' },
    });
    render(<SessionTile node={delivered} compact scale={1} focused={false} onToggleFocus={vi.fn()} />);
    const card = screen.getByRole('button', { name: '打开 LLM 会话' });
    expect(card).toHaveTextContent('两步验收建议');
    expect(card).not.toHaveTextContent('A newer chat reply');
    expect(card).not.toHaveTextContent('Session');
    expect(screen.getByTestId('canvas-tile-s1')).not.toHaveTextContent('已连接');
  });

  it('marks an incomplete published result as partial in the compact card', () => {
    render(<SessionTile node={node({ lastOutput: { text: '仅有部分内容', source: 'run', at: 1, partial: true } })}
      compact scale={1} focused={false} onToggleFocus={vi.fn()} />);
    expect(screen.getByRole('button', { name: '打开 LLM 会话' })).toHaveTextContent('产出（未完成，仅部分）');
  });

  it.each([
    ['# 一句定位\nAwwO 让**多个 Agent**按图协作。', 'AwwO 让多个 Agent按图协作。'],
    ['**短版文案**\n**AwwO**，让工作可编排。', 'AwwO，让工作可编排。'],
    ['# 产品介绍\n## 一句定位\n**价值**\n把目标拆成看得见的执行步骤。', '把目标拆成看得见的执行步骤。'],
    ['### 只有标题 ###', '只有标题'],
    ['**只有标题**', '只有标题'],
    ['**AwwO** 把协作过程放在画布上。', 'AwwO 把协作过程放在画布上。'],
  ])('uses readable delivery content in the compact card: %s', (markdown, expected) => {
    const raw = JSON.stringify({ result: markdown });
    const output = Object.freeze({ text: raw, source: 'run' as const, at: 1 });
    const delivered = node({ lastOutput: output });
    render(<SessionTile node={delivered} compact scale={1} focused={false} onToggleFocus={vi.fn()} />);
    expect(screen.getByRole('button', { name: '打开 LLM 会话' })).toHaveTextContent(expected);
    expect(screen.getByRole('button', { name: '打开 LLM 会话' })).not.toHaveTextContent('**');
    expect(delivered.lastOutput).toBe(output);
    expect(output.text).toBe(raw);
  });

  it('summarizes a saved JSON preview when no published output field is present', () => {
    render(<SessionTile node={node({ preview: '{"result":"完成内容：\\n核对任务顺序"}' })}
      compact scale={1} focused={false} onToggleFocus={vi.fn()} />);
    const card = screen.getByRole('button', { name: '打开 LLM 会话' });
    expect(card).toHaveTextContent('核对任务顺序');
    expect(card).not.toHaveTextContent('{"result"');
  });

  it('keeps malformed historical JSON-shaped output legible in the compact card', () => {
    render(<SessionTile node={node({ preview: '{"result":"完成内容：\\n回答"任务顺序"。"}' })}
      compact scale={1} focused={false} onToggleFocus={vi.fn()} />);
    const card = screen.getByRole('button', { name: '打开 LLM 会话' });
    expect(card).toHaveTextContent('回答"任务顺序"。');
    expect(card).not.toHaveTextContent('{"result"');
  });

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

  it('marks a card that finishes or fails while mounted, briefly, and never one that loads finished', () => {
    vi.useFakeTimers();
    try {
      const tile = (state: 'running' | 'done' | 'failed' | 'waiting') => <StrictMode><SessionTile node={node()} scale={1} run={{ state }} /></StrictMode>;
      const classes = () => screen.getByTestId('canvas-tile-s1').className.split(/\s+/);
      const loaded = render(tile('done'));
      expect(classes()).toContain('is-done');
      expect(classes()).not.toContain('is-just-done');
      loaded.unmount();

      const view = render(tile('running'));
      // Every class value the card ever commits, so a mark that outlives its state for a frame shows up.
      const committed: string[] = [];
      const observer = new MutationObserver(records => { for (const record of records) committed.push(record.oldValue ?? ''); });
      const element = screen.getByTestId('canvas-tile-s1');
      observer.observe(element, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
      view.rerender(tile('done'));
      expect(classes()).toContain('is-just-done');
      act(() => { vi.advanceTimersByTime(999); });
      expect(classes()).toContain('is-just-done');
      act(() => { vi.advanceTimersByTime(1); });
      expect(classes()).not.toContain('is-just-done');
      view.rerender(tile('running'));
      view.rerender(tile('failed'));
      expect(classes()).toContain('is-just-failed');
      // A new run taking over clears the mark in the same commit.
      view.rerender(tile('waiting'));
      expect(classes()).not.toContain('is-just-failed');
      view.rerender(tile('running'));
      view.rerender(tile('done'));
      view.rerender(tile('running'));
      observer.takeRecords().forEach(record => committed.push(record.oldValue ?? ''));
      committed.push(element.className);
      observer.disconnect();
      const both = committed.filter(value => /\bis-just-(done|failed)\b/.test(value) && !/\bis-(done|failed)\b/.test(value));
      expect(both).toEqual([]);
      // Unmounting with a mark pending leaves no timer behind.
      view.rerender(tile('done'));
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says which automatic retry a cloud node is waiting for', () => {
    render(<SessionTile node={node()} scale={1} run={{ state: 'waiting', detail: 'retrying', attempts: 1, retryLimit: 2 }} />);
    expect(screen.getByTestId('canvas-tile-run-s1')).toHaveTextContent('自动重试中（第 1 次，共 2 次）');
    expect(runBadgeText({ state: 'waiting', detail: 'retrying', attempts: 2, retryLimit: 2 }, 'en')).toBe('Retrying automatically (2 of 2)');
    // Without the counts it still says it is retrying, and a node merely queued says so.
    expect(runBadgeText({ state: 'waiting', detail: 'retrying' }, 'en')).toBe('Retrying automatically');
    expect(runBadgeText({ state: 'waiting', attempts: 1, retryLimit: 2 }, 'en')).toBe('Queued');
    expect(runBadgeText({ state: 'running', attempts: 1, retryLimit: 2 }, 'zh')).toBe('运行中');
  });

  it('closes the overflow menu on a press outside the card and keeps it for presses on the card', () => {
    const { rerender } = render(<SessionTile node={node()} scale={1} focused onConfigure={vi.fn()} onToggleFocus={vi.fn()} onDelete={vi.fn()} />);
    const tile = screen.getByTestId('canvas-tile-s1');
    fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
    fireEvent.pointerDown(tile);
    expect(screen.getByRole('button', { name: '删除', exact: true })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('button', { name: '删除', exact: true })).toBeNull();
    // The compact card's menu follows the same rule.
    rerender(<SessionTile node={node()} scale={1} compact onConfigure={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
    expect(screen.getByRole('button', { name: '删除', exact: true })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('button', { name: '删除', exact: true })).toBeNull();
  });

  it('closes one card\'s menu when another card is pressed, and when the card changes layout', () => {
    const second = { ...node(), id: 's2', title: '第二个会话' };
    render(<>
      <SessionTile node={node()} scale={1} compact onConfigure={vi.fn()} onDelete={vi.fn()} />
      <SessionTile node={second} scale={1} compact onConfigure={vi.fn()} onDelete={vi.fn()} />
    </>);
    const first = within(screen.getByTestId('canvas-tile-s1'));
    fireEvent.click(first.getByRole('button', { name: '更多节点操作' }));
    expect(first.getByRole('button', { name: '删除', exact: true })).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-s2'));
    expect(first.queryByRole('button', { name: '删除', exact: true })).toBeNull();
    cleanup();

    // Opening the node from its compact card does not carry the compact card's menu along.
    const { rerender } = render(<SessionTile node={node()} scale={1} compact onConfigure={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
    expect(screen.getByRole('button', { name: '删除', exact: true })).toBeTruthy();
    rerender(<SessionTile node={node()} scale={1} focused onConfigure={vi.fn()} onToggleFocus={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '删除', exact: true })).toBeNull();
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

  it('keeps a cloud draft editable when execution is unavailable and sends it after reconnection', () => {
    const onSend = vi.fn();
    const bound = node({ binding: { companyId: 'c1', agentId: 'a1', agentName: '前端' } });
    const reason = '请先连接个人执行引擎';
    const view = render(<SessionTile node={bound} scale={1} focused onSend={onSend} sendUnavailableReason={reason} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    const button = screen.getByTestId('composer-send');

    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: '继续旧画布中的任务' } });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', reason);
    expect(button).toHaveAttribute('aria-describedby', screen.getByRole('status').id);
    expect(screen.getByRole('status')).toHaveTextContent(reason);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('继续旧画布中的任务');

    view.rerender(<SessionTile node={bound} scale={1} focused onSend={onSend} />);
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onSend).toHaveBeenCalledWith(bound, '继续旧画布中的任务', expect.any(Function), '继续旧画布中的任务');
  });
});

it('keeps an open node’s conversation in its own box, so a squeezed transcript never paints over the composer', () => {
  // jsdom has no layout; the rule found in a real browser (a run status drawn over the composer) is checked.
  const css = readFileSync(resolve(process.cwd(), 'src/canvas/awwo-node.css'), 'utf8');
  expect(css).toMatch(/\.canvas-root \.awwo-node \.canvas-transcript \{[^}]*overflow: hidden;/);
});
