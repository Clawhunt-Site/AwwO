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

  it('lists what the canvas still needs, one row per node with its own step, and keeps what things cost in 用户须知', () => {
    const fillPlan = vi.fn(); const fillCover = vi.fn();
    render(panel({ nextSteps: { lead: '运行前还需要你来定 3 项：', actions: [], note: '本地检查，不用次数', footnote: '填好后就能运行整张画布（至少 4 次）。', items: [
      { id: 'plan', title: '「选题策划」', detail: '主题、目标读者', action: { id: 'fill-plan', label: '去填写', ariaLabel: '去补全「选题策划」', primary: true, onSelect: fillPlan } },
      { id: 'cover', title: '「封面设计」', detail: '画面风格', action: { id: 'fill-cover', label: '去填写', ariaLabel: '去补全「封面设计」', onSelect: fillCover } },
    ] }, costNote: '提问会用掉今天的次数：改画布约 1 次，直接执行任务最多 16 次。' }));
    const next = within(screen.getByRole('group', { name: '接下来' }));
    expect(next.getByText('运行前还需要你来定 3 项：')).toBeVisible();
    // That the advice cost nothing is said in 用户须知, not on the card.
    expect(next.queryByText('本地检查，不用次数')).toBeNull();
    const rows = next.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText('画面风格')).toBeVisible();
    expect(next.getByText('填好后就能运行整张画布（至少 4 次）。')).toBeVisible();
    fireEvent.click(next.getByRole('button', { name: '去补全「封面设计」' }));
    expect(fillCover).toHaveBeenCalledOnce(); expect(fillPlan).not.toHaveBeenCalled();
    expect(next.getByRole('button', { name: '去补全「选题策划」' })).toHaveClass('is-primary');
    // What a message costs, that the advice cost nothing and the data notice are in 用户须知: nothing is printed around the box.
    expect(screen.queryByText('提问会用掉今天的次数：改画布约 1 次，直接执行任务最多 16 次。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '用户须知' }));
    const notes = within(screen.getByRole('region', { name: '用户须知' }));
    expect(notes.getByText('提问会用掉今天的次数：改画布约 1 次，直接执行任务最多 16 次。')).toBeVisible();
    expect(notes.getByText('「接下来」里的建议是在本地检查出来的，不用次数。')).toBeVisible();
    expect(notes.getByText('请勿输入身份证号、银行卡、密码等个人敏感信息；AI 生成的内容可能有误，请核实后再使用。')).toBeVisible();
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
