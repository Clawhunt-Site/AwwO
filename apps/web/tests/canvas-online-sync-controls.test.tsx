import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RunControls, type RunControlsProps } from '../src/canvas/RunControls';
import { createSessionNode, type CanvasEdge, type ReviewGraphPolicy, type SessionNode } from '../src/canvas/canvasDoc';
import { LocaleProvider } from '../src/canvas/i18n';
import type { ContractField } from '../src/canvas/nodeContracts';

const field = (id: string, type: ContractField['type'] = 'markdown', value = '', required = true): ContractField => ({ id, label: id, type, value, required });
function fixture() {
  const author: SessionNode = { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'author', title: 'Author',
    binding: { companyId: 'workspace', agentId: 'author-agent', agentName: 'Author' },
    contract: { version: 1, inputs: [field('task', 'text', 'Build a page'), field('feedback', 'markdown', '', false)], outputs: [field('artifact')] } };
  const reviewer: SessionNode = { ...createSessionNode('coding', { x: 500, y: 0 }), id: 'reviewer', title: 'Reviewer',
    binding: { companyId: 'workspace', agentId: 'reviewer-agent', agentName: 'Reviewer' },
    contract: { version: 1, inputs: [field('candidate')], outputs: [field('approved', 'boolean'), field('notes')] } };
  const edges: CanvasEdge[] = [
    { id: 'candidate', fromNode: author.id, fromPort: 'out:artifact', toNode: reviewer.id, toPort: 'in:candidate', dataType: 'text' },
    { id: 'feedback', fromNode: reviewer.id, fromPort: 'out:notes', toNode: author.id, toPort: 'in:feedback', dataType: 'text', kind: 'feedback' },
  ];
  const execution: ReviewGraphPolicy = { mode: 'review', maxRounds: 3, reviewerNodeId: reviewer.id, verdictFieldId: 'approved' };
  const props: RunControlsProps = { nodes: [author, reviewer], edges, execution, running: false, runs: {}, onStart: vi.fn(), onStop: vi.fn() };
  return { props, author, reviewer };
}
afterEach(cleanup);

describe('online Review controls combined with SaaS controls', () => {
  it('starts a valid Review graph and retains dormant feedback when switched to workflow', () => {
    const { props } = fixture(); const view = render(<RunControls {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 开始互审' }));
    expect(props.onStart).toHaveBeenCalledTimes(1);
    view.rerender(<RunControls {...props} execution={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 运行图' }));
    expect(props.onStart).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(props.edges[1].kind).toBe('feedback');
  });

  it('keeps review validation dismissible and replaces old refusal/summary with live round scope', () => {
    const { props } = fixture();
    const invalid = { ...props.execution!, maxRounds: 6 };
    const view = render(<RunControls {...props} execution={invalid} />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 开始互审' }));
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '展开问题' }));
    expect(screen.getByRole('alert')).toHaveTextContent('1 到 5');
    fireEvent.click(screen.getByRole('button', { name: '关闭运行提示' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(<RunControls {...props} running round={2} runs={{ author: { state: 'done' }, reviewer: { state: 'running' }, upstream: { state: 'cached' } }}
      summary={{ ok: true, done: 9, total: 9, failed: 0, blocked: 0 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('第 2/3 轮 · 运行中 · 1/2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves host initialization and readonly guards when Review props are present', () => {
    const { props, author, reviewer } = fixture();
    const p = { ...props, nodes: [{ ...author, binding: null }, reviewer], initializeOnRun: true };
    const view = render(<RunControls {...p} readOnly />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 开始互审' }));
    expect(props.onStart).not.toHaveBeenCalled();
    view.rerender(<RunControls {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '▶ 开始互审' }));
    expect(props.onStart).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(<RunControls {...p} readOnly running />);
    fireEvent.click(screen.getByRole('button', { name: '■ 停止' }));
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it.each(['approved', 'exhausted', 'cancelled'] as const)('localizes and dismisses an honest %s Review outcome', outcome => {
    const { props } = fixture();
    const expected = { approved: 'Approved after 2 round(s)', exhausted: 'review has not passed', cancelled: 'Review stopped after 2 round(s)' };
    render(<LocaleProvider locale="en"><RunControls {...props}
      summary={{ ok: outcome === 'approved', done: 2, total: 2, failed: 0, blocked: 0, review: { rounds: 2, outcome } }} /></LocaleProvider>);
    expect(screen.getByRole('status')).toHaveTextContent(expected[outcome]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss run notice' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
