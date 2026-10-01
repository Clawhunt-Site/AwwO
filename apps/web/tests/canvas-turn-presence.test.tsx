import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { formatElapsed } from '../src/canvas/WorkingIndicator';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import * as sessions from '../src/canvas/sessions';
import type { Turn } from '../src/canvas/sessions';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); sessions.resetAllSessions(); });

const user: Turn = { id: 1, role: 'user', text: '做一个登录页' };
const pendingReply: Turn = { id: 2, role: 'agent', text: '' };

describe('turn presence', () => {
  it('formats elapsed time compactly', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_400)).toBe('42s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('replaces the empty reply bubble with one live row carrying the status and an elapsed timer', () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const { container } = render(<TileTranscript turns={[user, pendingReply]} history="loaded" streaming status="运行中" streamingSince={58_000} limit={Infinity} />);
    const presence = screen.getByTestId('transcript-presence');
    expect(presence).toHaveTextContent('运行中');
    expect(presence).toHaveTextContent('42s');
    expect(presence.closest('.canvas-transcript-turn')).toHaveClass('is-pending');
    // The status is said once, in the row, not again as a footer.
    expect(container.querySelector('.canvas-transcript-status')).toBeNull();
    act(() => { vi.advanceTimersByTime(23_000); });
    expect(presence).toHaveTextContent('1m 05s');
  });

  it('falls back to the waiting copy when the gateway has not reported a phase yet', () => {
    render(<TileTranscript turns={[user, pendingReply]} history="loaded" streaming limit={Infinity} />);
    expect(screen.getByTestId('transcript-presence')).toHaveTextContent('已投递，等待 agent 启动…');
  });

  it('keeps the bubble and moves the status to a quiet footer once text is streaming', () => {
    const { container } = render(<TileTranscript turns={[user, { ...pendingReply, text: '正在搭建表单' }]} history="loaded" streaming status="运行中" limit={Infinity} />);
    expect(screen.queryByTestId('transcript-presence')).toBeNull();
    expect(screen.getByText('正在搭建表单')).toBeInTheDocument();
    expect(container.querySelector('.canvas-transcript-status')).toHaveTextContent('运行中');
  });

  it('shows the row after an accepted user message that has no reply placeholder yet', () => {
    render(<TileTranscript turns={[user]} history="loaded" streaming limit={Infinity} />);
    expect(screen.getByTestId('transcript-presence')).toBeInTheDocument();
  });

  it('never shows a working row once the stream has ended, even for an empty reply', () => {
    render(<TileTranscript turns={[user, pendingReply]} history="loaded" streaming={false} status="运行中" limit={Infinity} />);
    expect(screen.queryByTestId('transcript-presence')).toBeNull();
  });

  it('restarts the clock when a new stream supersedes one that is still live', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    sessions.beginStreaming('n');
    vi.setSystemTime(310_000);
    sessions.beginStreaming('n');
    expect(sessions.getSnapshot('n')).toMatchObject({ streaming: true, streamingSince: 310_000 });
  });

  it('records when a stream began and clears it when the stream ends', () => {
    vi.useFakeTimers(); vi.setSystemTime(5_000);
    sessions.setStreaming('n', true);
    expect(sessions.getSnapshot('n').streamingSince).toBe(5_000);
    const live = sessions.getSnapshot('n');
    sessions.setStreaming('n', true);
    expect(sessions.getSnapshot('n')).toBe(live);
    sessions.setStreaming('n', false);
    expect(sessions.getSnapshot('n')).not.toHaveProperty('streamingSince');
  });
});

const node = (over: Partial<SessionNode> = {}): SessionNode => ({
  ...createSessionNode('coding', { x: 0, y: 0 }), id: 'n1', title: '前端',
  contract: { version: 1, inputs: [], outputs: [
    { id: 'summary', label: '实现说明', type: 'text', required: true, value: '' },
    { id: 'route', label: '页面路由', type: 'text', required: true, value: '' },
  ] },
  ...over,
});

describe('delivery receipt', () => {
  it('states where a delivery came from, when, and how many declared fields it filled', () => {
    vi.useFakeTimers(); vi.setSystemTime(2_000_000_000_000);
    const optionalRoute = node();
    optionalRoute.contract!.outputs[1].required = false;
    render(<NodeDeliverables readOnly node={{ ...optionalRoute, lastOutput: { text: JSON.stringify({ summary: '已完成登录页' }), at: 2_000_000_000_000 - 3 * 60_000, source: 'run' } }} />);
    expect(screen.getByText('来自运行 · 3 分钟前交付 · 1/2 项')).toBeInTheDocument();
  });

  it('gives a failed-validation delivery no field count, since its fields were not accepted', () => {
    render(<NodeDeliverables readOnly node={node({ lastOutput: { text: JSON.stringify({ summary: '只有一项' }), at: 1, source: 'run' } })} />);
    expect(screen.getByText('来自运行')).toBeInTheDocument();
    expect(screen.getByText('输出未通过表单校验')).toHaveAttribute('role', 'alert');
  });

  it('does not count a field that was published blank as delivered', () => {
    const optionalRoute = node();
    optionalRoute.contract!.outputs[1].required = false;
    render(<NodeDeliverables readOnly node={{ ...optionalRoute, lastOutput: { text: JSON.stringify({ summary: '已完成', route: '   ' }), at: 1, source: 'run' } }} />);
    expect(screen.getByText('来自运行 · 1/2 项')).toBeInTheDocument();
  });

  it('keeps the delivery age true while the drawer stays open', () => {
    vi.useFakeTimers(); vi.setSystemTime(2_000_000_000_000);
    const optionalRoute = node();
    optionalRoute.contract!.outputs[1].required = false;
    render(<NodeDeliverables readOnly node={{ ...optionalRoute, lastOutput: { text: JSON.stringify({ summary: '已完成' }), at: 2_000_000_000_000 - 4 * 60_000, source: 'run' } }} />);
    expect(screen.getByText('来自运行 · 4 分钟前交付 · 1/2 项')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(screen.getByText('来自运行 · 14 分钟前交付 · 1/2 项')).toBeInTheDocument();
  });

  it('claims no time for a legacy output without a real timestamp', () => {
    render(<NodeDeliverables readOnly node={node({ lastOutput: { text: JSON.stringify({ summary: 'a', route: '/login' }), at: 1, source: 'manual' } })} />);
    expect(screen.getByText('手动发布 · 2/2 项')).toBeInTheDocument();
  });

  it('marks a partial delivery as a caveat', () => {
    const { container } = render(<NodeDeliverables readOnly node={node({ lastOutput: { text: JSON.stringify({ summary: 'a', route: '/x' }), at: 1, source: 'run', partial: true } })} />);
    expect(container.querySelector('.awwo-deliverables-receipt')).toHaveClass('is-caveat');
  });

  it('copies a plain field value exactly and confirms in place', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<NodeDeliverables readOnly node={node({ lastOutput: { text: JSON.stringify({ summary: '  已完成登录页\n第二行', route: '/login' }), at: 1, source: 'run' } })} />);
    fireEvent.click(screen.getByRole('button', { name: '复制实现说明' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('  已完成登录页\n第二行'));
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('does not carry a "Copied" confirmation over to a newer delivery of the same field', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const optionalRoute = node();
    optionalRoute.contract!.outputs[1].required = false;
    const delivery = (text: string, at: number): SessionNode => ({ ...optionalRoute, lastOutput: { text: JSON.stringify({ summary: text }), at, source: 'run' } });
    const { rerender } = render(<NodeDeliverables readOnly node={delivery('第一版', 1)} />);
    fireEvent.click(screen.getByRole('button', { name: '复制实现说明' }));
    expect(await screen.findByText('已复制')).toBeInTheDocument();
    rerender(<NodeDeliverables readOnly node={delivery('第二版', 2)} />);
    expect(screen.queryByText('已复制')).toBeNull();
  });

  it('reports a refused clipboard instead of claiming success', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<NodeDeliverables readOnly node={node({ lastOutput: { text: JSON.stringify({ summary: 'a', route: '/login' }), at: 1, source: 'run' } })} />);
    // A multi-file delivery shows one file at a time; open the second before copying it.
    fireEvent.click(within(screen.getByRole('group', { name: '交付物' })).getByRole('button', { name: '页面路由' }));
    fireEvent.click(screen.getByRole('button', { name: '复制页面路由' }));
    expect(await screen.findByText('复制失败，请选择路径手动复制')).toBeInTheDocument();
    expect(screen.queryByText('已复制')).toBeNull();
  });

  it('offers no copy control for previews and file references, which carry their own actions', () => {
    render(<NodeDeliverables readOnly node={node({
      contract: { version: 1, inputs: [], outputs: [
        { id: 'page', label: '页面', type: 'html', required: true, value: '' },
        { id: 'file', label: '文件', type: 'file', required: true, value: '' },
      ] },
      lastOutput: { text: JSON.stringify({ page: '<!doctype html><html><body>x</body></html>', file: '/workspace/a.md' }), at: 1, source: 'run' },
    })} />);
    expect(screen.queryByRole('button', { name: '复制页面' })).toBeNull();
    expect(screen.queryByRole('button', { name: '复制文件' })).toBeNull();
  });
});
