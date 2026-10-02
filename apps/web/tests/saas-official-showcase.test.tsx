import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { OfficialShowcase } from '../src/saas/examples/OfficialShowcase';
import { OfficialExamples } from '../src/saas/examples/OfficialExamples';
import { KnowledgeDemo } from '../src/saas/examples/IntelligenceDemos';
import { getOfficialWorkflow } from '../src/saas/examples/officialWorkflows';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const item = getOfficialWorkflow('knowledge-desk')!;
const stages = [...new Set(item.nodes.map(node => node.column))].sort((a, b) => a - b);
const firstNode = item.nodes.find(node => node.column === stages[0])!;
const nodeAtStage = (stage: number) => item.nodes.find(node => node.column === stages[stage])!;
const left = () => screen.getByRole('region', { name: '编排过程', exact: true });
const right = () => screen.getByRole('region', { name: '交互成果', exact: true });
const choose = (title: string) => fireEvent.click(within(left()).getByRole('button', { name: `查看节点：${title}`, exact: true }));
const selectedTitle = () => within(left()).getAllByRole('heading', { level: 4 })
  .find(heading => item.nodes.some(node => node.title.zh === heading.textContent))?.textContent;

function StatefulResult() {
  const [value, setValue] = useState('initial result');
  return <label>Result state<input value={value} onChange={event => setValue(event.target.value)} /></label>;
}

function view(realDemo = false) {
  return render(<SaaSPreferencesProvider><OfficialShowcase item={item}>
    {realDemo ? <KnowledgeDemo locale="zh" /> : <StatefulResult />}
  </OfficialShowcase></SaaSPreferencesProvider>);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('superclaw_locale', 'zh');
  history.replaceState({}, '', '/?examples=1');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('official side-by-side showcase', () => {
  it('presents orchestration and a working result together with truthful non-execution provenance', () => {
    view(true);
    expect(left()).toBeVisible();
    expect(right()).toBeVisible();
    expect(within(left()).getByRole('heading', { name: firstNode.title.zh })).toBeVisible();
    expect(within(right()).getByLabelText('搜索你的知识库')).toBeVisible();
    expect(screen.getByText('编排导览 · 非执行记录')).toBeVisible();
    expect(within(left()).getAllByRole('button', { name: /^查看节点：/ })).toHaveLength(item.nodes.length);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the selected node contract and only its actual upstream handoffs', () => {
    view();
    const target = item.nodes.find(node => item.edges.filter(edge => edge.to === node.id).length > 1)!;
    choose(target.title.zh);
    expect(within(left()).getByRole('heading', { name: target.title.zh })).toBeVisible();
    expect(within(left()).getAllByText(target.output.zh).length).toBeGreaterThan(0);
    const disclosure = within(left()).getByText('完整任务与验收', { exact: true });
    fireEvent.click(disclosure);
    const details = disclosure.closest('details')!;
    expect(details).toHaveAttribute('open');
    expect(within(details).getByText(target.task.zh)).toBeVisible();
    for (const acceptance of target.acceptance) expect(within(details).getByText(acceptance.zh)).toBeVisible();
    const parentIds = item.edges.filter(edge => edge.to === target.id).map(edge => edge.from);
    const parent = item.nodes.find(node => node.id === parentIds[0])!;
    const upstream = within(left()).getByText('接收上游', { exact: true }).parentElement!;
    expect(within(upstream).getAllByRole('button').map(button => button.textContent))
      .toEqual(parentIds.map(id => item.nodes.find(node => node.id === id)!.title.zh));
    fireEvent.click(within(upstream).getByRole('button', { name: parent.title.zh, exact: true }));
    expect(within(left()).getByRole('heading', { name: parent.title.zh })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('navigates real stages rather than counting parallel nodes as separate stages', () => {
    view();
    expect(screen.getByRole('button', { name: '上一阶段', exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下一阶段', exact: true }));
    expect(selectedTitle()).toBe(nodeAtStage(1).title.zh);
    const parallel = item.nodes.filter(node => node.column === stages[1]);
    expect(parallel.length).toBeGreaterThan(1);
    choose(parallel.at(-1)!.title.zh);
    fireEvent.click(screen.getByRole('button', { name: '下一阶段', exact: true }));
    expect(selectedTitle()).toBe(nodeAtStage(2).title.zh);
    fireEvent.click(screen.getByRole('button', { name: '上一阶段', exact: true }));
    expect(selectedTitle()).toBe(nodeAtStage(1).title.zh);
    choose(nodeAtStage(stages.length - 1).title.zh);
    expect(screen.getByRole('button', { name: '下一阶段', exact: true })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('plays and pauses a local explanation without creating real execution activity', () => {
    vi.useFakeTimers();
    const mounted = view();
    const before = selectedTitle();
    fireEvent.click(screen.getByRole('button', { name: '播放编排讲解', exact: true }));
    expect(screen.getByRole('button', { name: '暂停讲解', exact: true })).toBeVisible();
    act(() => { vi.advanceTimersToNextTimer(); });
    expect(selectedTitle()).not.toBe(before);
    fireEvent.click(screen.getByRole('button', { name: '暂停讲解', exact: true }));
    const paused = selectedTitle();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(selectedTitle()).toBe(paused);
    expect(screen.getByRole('button', { name: '播放编排讲解', exact: true })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '播放编排讲解', exact: true }));
    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops explanation at the final stage and restarts from the first stage on explicit replay', () => {
    vi.useFakeTimers();
    view();
    choose(nodeAtStage(stages.length - 2).title.zh);
    fireEvent.click(screen.getByRole('button', { name: '播放编排讲解', exact: true }));
    act(() => { vi.advanceTimersToNextTimer(); });
    expect(selectedTitle()).toBe(nodeAtStage(stages.length - 1).title.zh);
    act(() => { vi.runAllTimers(); });
    expect(screen.getByRole('button', { name: '播放编排讲解', exact: true })).toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '播放编排讲解', exact: true }));
    expect(selectedTitle()).toBe(firstNode.title.zh);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('pauses the explanation when its parent tab hides it without discarding the result state', () => {
    vi.useFakeTimers();
    const mounted = view();
    const input = within(right()).getByLabelText('Result state');
    fireEvent.change(input, { target: { value: 'retained while hidden' } });
    fireEvent.click(screen.getByRole('button', { name: '播放编排讲解', exact: true }));
    mounted.rerender(<SaaSPreferencesProvider><OfficialShowcase item={item} visible={false}><StatefulResult /></OfficialShowcase></SaaSPreferencesProvider>);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(selectedTitle()).toBe(firstNode.title.zh);
    expect(vi.getTimerCount()).toBe(0);
    mounted.rerender(<SaaSPreferencesProvider><OfficialShowcase item={item}><StatefulResult /></OfficialShowcase></SaaSPreferencesProvider>);
    expect(within(right()).getByLabelText('Result state')).toBe(input);
    expect(input).toHaveValue('retained while hidden');
    expect(screen.getByRole('button', { name: '播放编排讲解', exact: true })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves child state while inspecting nodes or focusing the result, and resets only on request', () => {
    view();
    const input = within(right()).getByLabelText('Result state');
    fireEvent.change(input, { target: { value: 'edited interactive result' } });
    choose(item.nodes.at(-1)!.title.zh);
    expect(input).toHaveValue('edited interactive result');
    fireEvent.click(screen.getByRole('button', { name: '专注成果', exact: true }));
    expect(screen.getByRole('button', { name: '恢复左右对照', exact: true })).toBeVisible();
    expect(screen.queryByRole('region', { name: '编排过程', exact: true })).toBeNull();
    expect(within(right()).getByLabelText('Result state')).toBe(input);
    expect(input).toHaveValue('edited interactive result');
    fireEvent.click(screen.getByRole('button', { name: '恢复左右对照', exact: true }));
    expect(input).toHaveValue('edited interactive result');
    fireEvent.click(screen.getByRole('button', { name: '重置成果', exact: true }));
    expect(within(right()).getByLabelText('Result state')).not.toBe(input);
    expect(within(right()).getByLabelText('Result state')).toHaveValue('initial result');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps real knowledge edits and empty-result behavior working alongside workflow exploration', () => {
    view(true);
    const title = within(right()).getByLabelText('文档标题');
    const content = within(right()).getByLabelText('正文 · 可直接编辑');
    fireEvent.change(title, { target: { value: '测试来源记录' } });
    fireEvent.change(content, { target: { value: 'quasarprotocol unique evidence' } });
    fireEvent.click(within(right()).getByRole('button', { name: '保存并更新索引' }));
    const search = within(right()).getByLabelText('搜索你的知识库');
    fireEvent.change(search, { target: { value: 'quasarprotocol' } });
    fireEvent.click(within(right()).getByRole('button', { name: '检索', exact: true }));
    expect(within(right()).getByRole('button', { name: '[1] 测试来源记录', exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一阶段', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '专注成果', exact: true }));
    expect(search).toHaveValue('quasarprotocol');
    expect(content).toHaveValue('quasarprotocol unique evidence');
    fireEvent.change(search, { target: { value: 'no_matching_lexical_source_zzzz' } });
    fireEvent.click(within(right()).getByRole('button', { name: '检索', exact: true }));
    expect(within(right()).getByText('没有匹配来源')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重置成果', exact: true }));
    expect(within(right()).getByLabelText('文档标题')).toHaveValue('交付与验收指南');
    expect(within(right()).getByLabelText('搜索你的知识库')).toHaveValue('交付验收');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('localizes both panes and opens the full workflow only through its explicit callback', () => {
    localStorage.setItem('superclaw_locale', 'en');
    const onOpenWorkflow = vi.fn();
    render(<SaaSPreferencesProvider><OfficialShowcase item={item} onOpenWorkflow={onOpenWorkflow}><StatefulResult /></OfficialShowcase></SaaSPreferencesProvider>);
    expect(screen.getByRole('region', { name: 'Orchestration process' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Interactive result' })).toBeVisible();
    expect(screen.getByText('Workflow tour · not a run record')).toBeVisible();
    expect(onOpenWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Explore the full canvas' }));
    expect(onOpenWorkflow).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resets the selected contract, result focus and child state when switching to a different case', () => {
    const mounted = view();
    choose(item.nodes.at(-1)!.title.zh);
    const oldInput = within(right()).getByLabelText('Result state');
    fireEvent.change(oldInput, { target: { value: 'previous case only' } });
    fireEvent.click(screen.getByRole('button', { name: '专注成果', exact: true }));
    const nextItem = getOfficialWorkflow('research-atlas')!;
    mounted.rerender(<SaaSPreferencesProvider><OfficialShowcase item={nextItem}><StatefulResult /></OfficialShowcase></SaaSPreferencesProvider>);
    expect(left()).toBeVisible();
    expect(within(left()).getByRole('heading', { name: nextItem.nodes[0].title.zh })).toBeVisible();
    expect(screen.getByRole('button', { name: '专注成果', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(within(right()).getByLabelText('Result state')).not.toBe(oldInput);
    expect(within(right()).getByLabelText('Result state')).toHaveValue('initial result');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens the gallery directly in the split view and preserves the result across the existing tabs', async () => {
    render(<SaaSPreferencesProvider><OfficialExamples initialId={item.id} /></SaaSPreferencesProvider>);
    expect(screen.getByRole('tab', { name: '同屏体验' })).toHaveAttribute('aria-selected', 'true');
    expect(left()).toBeVisible();
    const search = await within(right()).findByLabelText('搜索你的知识库');
    fireEvent.change(search, { target: { value: 'preserve this query' } });
    fireEvent.click(screen.getByRole('button', { name: '展开完整连线画布' }));
    expect(screen.getByRole('tab', { name: '编排画布' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('navigation', { name: '节点目录' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('tab', { name: '编排画布' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '复用指南' })).toHaveFocus();
    expect(screen.getByRole('button', { name: '下载画布 JSON' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '同屏体验' }));
    expect(within(right()).getByLabelText('搜索你的知识库')).toBe(search);
    expect(search).toHaveValue('preserve this query');
    expect(fetch).not.toHaveBeenCalled();
  });
});
