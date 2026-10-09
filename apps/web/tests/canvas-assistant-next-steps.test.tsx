import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CanvasAssistant, type CanvasAssistantProps } from '../src/canvas/CanvasAssistant';
import { LocaleProvider } from '../src/canvas/i18n';

afterEach(cleanup);

const panel = (props: Partial<CanvasAssistantProps> = {}) => <LocaleProvider locale="zh"><CanvasAssistant mode="panel" messages={[]} draft="" busy={false}
  onDraftChange={() => {}} onSend={() => {}} onCancel={() => {}} {...props} /></LocaleProvider>;

describe('the assistant offers what to do next without being asked', () => {
  it('shows the situation and acts on a choice, the first one drawn as the main step', () => {
    const run = vi.fn(); const results = vi.fn();
    render(panel({ nextSteps: { lead: '画布已经搭好，还没有运行过。', actions: [
      { id: 'run-all', label: '运行整张画布', primary: true, onSelect: run },
      { id: 'results', label: '查看成果', onSelect: results },
    ] } }));
    const next = within(screen.getByRole('group', { name: '接下来' }));
    expect(next.getByText('画布已经搭好，还没有运行过。')).toBeVisible();
    expect(next.getByRole('button', { name: '运行整张画布' })).toHaveClass('is-primary');
    expect(next.getByRole('button', { name: '查看成果' })).not.toHaveClass('is-primary');
    fireEvent.click(next.getByRole('button', { name: '运行整张画布' }));
    expect(run).toHaveBeenCalledOnce(); expect(results).not.toHaveBeenCalled();
  });

  it('opens a link action in a new tab and still records the choice', () => {
    const recorded = vi.fn();
    render(panel({ nextSteps: { lead: '「规划」用的是免费版不含的高级模型，被拒绝了。', actions: [
      { id: 'upgrade', label: '升级 Pro / Max', primary: true, href: '/?account=plans', onSelect: recorded },
    ] } }));
    const link = screen.getByRole('link', { name: '升级 Pro / Max' });
    expect(link).toHaveAttribute('href', '/?account=plans'); expect(link).toHaveAttribute('target', '_blank');
    const stay = (event: Event) => event.preventDefault(); document.addEventListener('click', stay);
    try { fireEvent.click(link); } finally { document.removeEventListener('click', stay); }
    expect(recorded).toHaveBeenCalledOnce();
  });

  it('steps aside while a message is handled, on the welcome screen, and when there is nothing to offer', () => {
    const steps = { lead: 'x', actions: [{ id: 'run-all', label: '运行整张画布', onSelect: () => {} }] };
    const { rerender } = render(panel({ busy: true, nextSteps: steps }));
    expect(screen.queryByRole('group', { name: '接下来' })).toBeNull();
    rerender(<LocaleProvider locale="zh"><CanvasAssistant mode="welcome" messages={[]} draft="" busy={false} onDraftChange={() => {}} onSend={() => {}} onCancel={() => {}} nextSteps={steps} /></LocaleProvider>);
    expect(screen.queryByRole('group', { name: '接下来' })).toBeNull();
    rerender(panel({ nextSteps: { lead: 'x', actions: [] } }));
    expect(screen.queryByRole('group', { name: '接下来' })).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });
});
