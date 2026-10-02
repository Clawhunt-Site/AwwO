import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createSessionNode, emptyDocument, type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import { addReviewPartner } from '../src/canvas/reviewPartner';
import { RunControls } from '../src/canvas/RunControls';
import { RunTimeline } from '../src/canvas/RunTimeline';
import type { RunNodeStatus } from '../src/canvas/runGraph';
import { LocaleProvider } from '../src/canvas/i18n';

afterEach(cleanup);
const node = (id: string): SessionNode => ({ ...createSessionNode('coding', { x: 0, y: 0 }), id, title: id,
  lastOutput: { text: `Delivery ${id}`, at: 1, source: 'run' } });
const done = (id: string): RunNodeStatus => ({ state: 'done', output: `Delivery ${id}` });
const edge = (fromNode: string, toNode: string): CanvasEdge => ({ id: `${fromNode}-${toNode}`, fromNode, toNode, fromPort: 'output', toPort: 'input', dataType: 'text' });
const summary = { ok: true, total: 2, done: 2, failed: 0, blocked: 0, cancelled: 0, cached: 0 };

it('opens only the actual terminal delivery without rerunning the graph', () => {
  const open = vi.fn(), start = vi.fn();
  render(<RunControls nodes={[node('build'), node('review'), node('scratch')]} edges={[edge('build', 'review')]}
    runs={{ build: done('build'), review: done('review') }} running={false} summary={summary}
    onViewOutput={open} onStart={start} onStop={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '查看交付物', exact: true }));
  expect(open).toHaveBeenCalledWith('review'); expect(start).not.toHaveBeenCalled();
});

it('offers a choice for independent completed outputs and ignores feedback edges', () => {
  const open = vi.fn();
  render(<RunControls nodes={[node('site'), node('report')]} edges={[{ ...edge('report', 'site'), kind: 'feedback' }]}
    runs={{ site: done('site'), report: done('report') }} running={false} summary={summary}
    onViewOutput={open} onStart={vi.fn()} onStop={vi.fn()} />);
  const disclosure = screen.getByText('查看 2 份交付物').closest('details')!;
  fireEvent.click(screen.getByText('查看 2 份交付物'));
  expect(within(disclosure).getByRole('button', { name: '查看 report 的交付物' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看 report 的交付物' }));
  expect(open).toHaveBeenCalledWith('report');
});

it('opens the producer delivery instead of the approval verdict in a review loop', () => {
  const producer = node('producer');
  producer.contract = { version: 1, inputs: [], outputs: [{ id: 'result', label: '交付结果', type: 'markdown', required: true, value: '', help: '' }] };
  const { doc, reviewerId } = addReviewPartner({ ...emptyDocument(), nodes: [producer] }, producer.id, 'zh');
  const nodes = doc.nodes.map(item => item.id === reviewerId
    ? { ...item, lastOutput: { text: '{"approved":true,"feedback":"Checked"}', at: 1, source: 'run' as const } } : item);
  const open = vi.fn();
  render(<RunControls nodes={nodes} edges={doc.edges} execution={doc.execution} running={false}
    runs={{ producer: done('producer'), [reviewerId]: { state: 'done', output: '{"approved":true,"feedback":"Checked"}' } }}
    summary={{ ...summary, review: { rounds: 1, outcome: 'approved' } }} onViewOutput={open} onStart={vi.fn()} onStop={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '查看交付物', exact: true }));
  expect(open).toHaveBeenCalledWith('producer');
});

it.each(['failed', 'stopped', 'running', 'partial', 'old', 'cached', 'unconfirmed', 'empty', 'manual'] as const)(
  'does not label %s output as a new completed delivery', kind => {
    const output = node('task'); let run = done('task');
    if (kind === 'partial') output.lastOutput!.partial = true;
    if (kind === 'old') output.lastOutput!.text = 'Older delivery';
    if (kind === 'manual') output.lastOutput!.source = 'manual';
    if (kind === 'cached') run = { ...run, state: 'cached' };
    if (kind === 'unconfirmed') run = { ...run, unconfirmed: true };
    if (kind === 'empty') run = { ...run, output: '' };
    render(<RunControls nodes={[output]} edges={[]} runs={{ task: run }} running={kind === 'running'} stopped={kind === 'stopped'}
      summary={{ ...summary, ok: kind !== 'failed' }} onViewOutput={vi.fn()} onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '查看交付物', exact: true })).toBeNull();
  });

it('shows the failure reason without hovering and lets the user inspect its node', () => {
  const open = vi.fn();
  render(<RunTimeline nodes={[node('build')]} runs={{ build: { state: 'failed', detail: '模型额度不足，请检查连接。' } }}
    now={2000} runStartedAt={1000} onClose={vi.fn()} onOpenNode={open} />);
  expect(screen.getByText('模型额度不足，请检查连接。')).toBeVisible();
  const button = screen.getByRole('button', { name: '查看节点：build' });
  button.focus(); expect(button).toHaveFocus(); fireEvent.click(button);
  expect(open).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledWith('build');
});

it('localizes delivery actions', () => {
  render(<LocaleProvider locale="en"><RunControls nodes={[node('task')]} edges={[]} runs={{ task: done('task') }}
    running={false} summary={{ ...summary, total: 1, done: 1 }} onViewOutput={vi.fn()} onStart={vi.fn()} onStop={vi.fn()} /></LocaleProvider>);
  expect(screen.getByRole('button', { name: 'View delivery' })).toBeVisible();
});
