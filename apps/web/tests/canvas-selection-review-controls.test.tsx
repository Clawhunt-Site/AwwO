import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SelectionCollaboration, CollaborationFlow, CollaborationStatus } from '../src/canvas/SelectionCollaboration';
import { createSessionNode, createFormNode } from '../src/canvas/canvasDoc';
import { useMarquee, Marquee } from '../src/canvas/Marquee';
import type { GraphCollaborationSnapshot } from '../src/saas/graphRuns';

afterEach(cleanup);
const a = { ...createSessionNode('llm', { x: 20, y: 20 }), id: 'a', title: '方案作者', w: 100, h: 100 };
const b = { ...createSessionNode('llm', { x: 220, y: 20 }), id: 'b', title: '工程评审', w: 100, h: 100 };
it('one click submits exactly the selected components with visible bounded defaults', () => {
  const onStart = vi.fn();
  render(<SelectionCollaboration nodes={[b, a]} disabled={false} available onStart={onStart} />);
  expect(screen.getByText('1 轮 · 最多 5 次调用')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '互审优化' }));
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onStart.mock.calls[0][0]).toEqual(['b', 'a']);
  expect(onStart.mock.calls[0][1]).toMatchObject({ rounds: 1, synthesizerNodeId: 'b' });
  expect(onStart.mock.calls[0][1].goal).toContain('工程评审');
});
it('keeps custom goal, round limit and synthesizer explicit before dispatch', () => {
  const onStart = vi.fn();
  render(<SelectionCollaboration nodes={[a, b]} disabled={false} available onStart={onStart} />);
  fireEvent.click(screen.getByRole('button', { name: '互审设置' }));
  fireEvent.change(screen.getByLabelText('共同目标'), { target: { value: '生成更易读的服务契约' } });
  fireEvent.change(screen.getByLabelText('互审轮数'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('负责汇总'), { target: { value: 'b' } });
  expect(screen.getByText('2 轮 · 最多 9 次调用')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '互审优化' }));
  expect(onStart).toHaveBeenCalledWith(['a', 'b'], { goal: '生成更易读的服务契约', rounds: 2, synthesizerNodeId: 'b' });
});
it.each(['form', 'team', 'locked', 'unavailable', 'too-many'])('does not dispatch an invalid or locked %s selection', mode => {
  const onStart = vi.fn();
  const nodes = mode === 'form' ? [a, createFormNode({ x: 0, y: 0 })]
    : mode === 'team' ? [a, { ...b, team: { members: [] } as any }]
    : mode === 'too-many' ? Array.from({ length: 7 }, (_, i) => ({ ...a, id: String(i) })) : [a, b];
  render(<SelectionCollaboration nodes={nodes} disabled={mode === 'locked'} available={mode !== 'unavailable'} onStart={onStart} />);
  fireEvent.click(screen.getByRole('button', { name: '互审优化' }));
  expect(onStart).not.toHaveBeenCalled();
});
const review: GraphCollaborationSnapshot = { goal: 'Compare', rounds: 1, synthesizerNodeId: 'a', maxModelCalls: 5, phase: 'review', round: 1,
  turns: [{ ordinal: 1, nodeId: 'a', phase: 'proposal', round: 1, status: 'completed', runId: 'p-a' },
    { ordinal: 2, nodeId: 'b', phase: 'proposal', round: 1, status: 'completed', runId: 'p-b' },
    { ordinal: 3, nodeId: 'a', phase: 'review', round: 1, status: 'running', runId: 'r-a' }] };
it('draws only evidence-bearing incoming peer flow while a real review is active', () => {
  const view = render(<CollaborationFlow nodes={[a, b]} collaboration={review} running />);
  expect(view.container.querySelectorAll('g')).toHaveLength(1);
  expect(view.container.querySelector('path')?.getAttribute('d')).toContain('M 320 70');
  view.rerender(<CollaborationFlow nodes={[a, b]} collaboration={review} running={false} />);
  expect(view.container.querySelector('svg')).toBeNull();
});
it('reports actual completed calls and the actual reviewer', () => {
  render(<CollaborationStatus nodes={[a, b]} collaboration={review} />);
  expect(screen.getByText('方案作者 · 评议方案')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('2');
});
function BoxSelection({ enabled }: { enabled: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [selected, select] = useState<string[]>([]);
  const marquee = useMarquee({ nodes: [a, b], rootRef: root, view: { x: 0, y: 0, scale: 1 }, enabled, onSelect: select });
  return <div ref={root}><div className="canvas-viewport" data-testid="viewport" onPointerDown={marquee.onBackgroundPointerDown}><Marquee rect={marquee.rect} /></div><output>{selected.join(',')}</output></div>;
}
function pointer(target: Element | Window, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
}
it('explicit selection mode boxes components without Shift while pan mode does not', () => {
  const view = render(<BoxSelection enabled />);
  pointer(screen.getByTestId('viewport'), 'pointerdown', 0, 0);
  pointer(window, 'pointermove', 350, 150);
  pointer(window, 'pointerup', 350, 150);
  expect(screen.getByRole('status').textContent).toBe('a,b');
  view.unmount();
  render(<BoxSelection enabled={false} />);
  pointer(screen.getByTestId('viewport'), 'pointerdown', 0, 0);
  pointer(window, 'pointermove', 350, 150);
  pointer(window, 'pointerup', 350, 150);
  expect(screen.getByRole('status').textContent).toBe('');
});
