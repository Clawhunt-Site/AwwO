import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentWorkspace } from '../src/canvas/AgentWorkspace';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { getTeamMarketAgents } from '../src/canvas/teamMarketAgents';
import { RAIL_BOT_KEY } from '../src/canvas/railState';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const props = () => ({ nodes: [createAgentTemplate('general', { x: 0, y: 0 })], edges: [], selectedIds: [], runs: {}, running: false,
  onFocusNode: vi.fn(), onAddAgent: vi.fn(), onCreateTemplate: vi.fn(), onSearch: vi.fn(), onAddMarketAgent: vi.fn(),
  modelShelf: <div>Execution model fixture</div>, personaControls: <div>Persona fixture</div> });
const bots = () => screen.getByRole('complementary', { name: 'Bot 清单' });
const openBotTools = () => fireEvent.click(within(bots()).getByRole('button', { name: '搜索与筛选 Bot' }));

it('separates models on the left, the canvas in the middle and Bots/personas on the right', () => {
  const p = props();
  render(<AgentWorkspace {...p}><div>Canvas fixture</div></AgentWorkspace>);
  const models = screen.getByRole('complementary', { name: '模型库' });
  const main = screen.getByRole('main');
  expect(within(models).getByText('Execution model fixture')).toBeVisible();
  expect(bots()).not.toHaveClass('is-collapsed');
  expect(within(bots()).getByRole('button', { name: '添加 Bot', exact: true })).toBeEnabled();
  expect(within(bots()).getByRole('button', { name: /定位/ })).toBeVisible();
  expect(within(bots()).queryByRole('searchbox', { name: '查找 Agent' })).toBeNull();
  expect(within(bots()).queryByRole('button', { name: '产品 Bot' })).toBeNull();
  expect(within(bots()).queryByText('人设预设')).toBeNull();
  openBotTools();
  fireEvent.click(within(bots()).getByText('人设预设'));
  expect(within(bots()).getByText('Persona fixture')).toBeVisible();
  expect(models.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(main.compareDocumentPosition(bots()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('keeps the right Bot roster on a read-only cloud canvas without an editable model shelf', () => {
  const { container } = render(<AgentWorkspace {...props()} storageMode="cloud" readOnly modelShelf={undefined}><div /></AgentWorkspace>);
  expect(container.querySelector('.awwo-workspace')).toHaveClass('has-model-library');
  expect(screen.queryByRole('complementary', { name: '模型库' })).toBeNull();
  expect(within(bots()).getByRole('button', { name: /定位/ })).toBeVisible();
  expect(within(bots()).getByRole('button', { name: '添加 Bot' })).toBeDisabled();
  expect(screen.queryByRole('complementary', { name: '工作区导航' })).toBeNull();
});

it('distinguishes same-name Bots in the roster and accessible labels', () => {
  const p = props();
  const duplicate = { ...p.nodes[0], id: 'another-bot' };
  render(<AgentWorkspace {...p} nodes={[p.nodes[0], duplicate]}><div /></AgentWorkspace>);
  const rows = within(bots()).getAllByRole('button', { name: /定位/ });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveAttribute('aria-label', expect.stringContaining('· 1'));
  expect(rows[1]).toHaveAttribute('aria-label', expect.stringContaining('· 2'));
  expect(within(rows[0]).getByText('01')).toBeVisible();
  expect(within(rows[1]).getByText('02')).toBeVisible();
});

it('keeps the canvas bar focused and never leaves a hidden Bot search active', () => {
  render(<AgentWorkspace {...props()} headerTitle={<span>Current canvas</span>} toolbar={<button type="button">Run</button>}><div /></AgentWorkspace>);
  expect(screen.getByRole('button', { name: 'Run' })).toBeVisible();
  expect(screen.queryByText('Agent 节点：1')).toBeNull();
  expect(screen.queryByText('拖动画布平移')).toBeNull();
  expect(screen.queryByRole('contentinfo')).toBeNull();
  openBotTools();
  fireEvent.change(within(bots()).getByRole('searchbox', { name: '查找 Agent' }), { target: { value: 'missing' } });
  expect(within(bots()).getByText('没有找到匹配的 Agent')).toBeVisible();
  openBotTools();
  expect(within(bots()).queryByRole('searchbox', { name: '查找 Agent' })).toBeNull();
  expect(within(bots()).getByRole('button', { name: /定位/ })).toBeVisible();
});

it('returns to canvas Bots when source filters are closed', () => {
  render(<AgentWorkspace {...props()}><div /></AgentWorkspace>);
  openBotTools();
  fireEvent.click(within(bots()).getByRole('button', { name: '产品 Bot' }));
  expect(within(bots()).queryByRole('button', { name: /定位/ })).toBeNull();
  openBotTools();
  expect(within(bots()).queryByRole('button', { name: '产品 Bot' })).toBeNull();
  expect(within(bots()).getByRole('button', { name: /定位/ })).toBeVisible();
});

it('remembers the Bot rail state per browser, reports rail changes and survives blocked storage', () => {
  const onRailsChange = vi.fn();
  const view = render(<AgentWorkspace {...props()} onRailsChange={onRailsChange}><div /></AgentWorkspace>);
  fireEvent.click(within(bots()).getByRole('button', { name: '收起 Bot 清单' }));
  expect(onRailsChange).toHaveBeenCalledOnce();
  expect(localStorage.getItem(RAIL_BOT_KEY)).toBe('1');
  view.unmount();
  render(<AgentWorkspace {...props()}><div /></AgentWorkspace>);
  expect(bots()).toHaveClass('is-collapsed');
  const expand = within(bots()).getByRole('button', { name: '展开 Bot 清单' });
  expect(expand).toHaveAttribute('aria-expanded', 'false');
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
  fireEvent.click(expand);
  expect(bots()).not.toHaveClass('is-collapsed');
  expect(within(bots()).getByRole('button', { name: '收起 Bot 清单' })).toHaveAttribute('aria-expanded', 'true');
});

it('keeps keyboard focus on the Bot rail toggle while it collapses and expands the rail', () => {
  render(<AgentWorkspace {...props()}><div /></AgentWorkspace>);
  const toggle = within(bots()).getByRole('button', { name: '收起 Bot 清单' });
  toggle.focus();
  fireEvent.click(toggle);
  expect(bots()).toHaveClass('is-collapsed');
  expect(document.activeElement).toBe(toggle);
  expect(toggle).toHaveAttribute('aria-label', '展开 Bot 清单');
  fireEvent.click(toggle);
  expect(bots()).not.toHaveClass('is-collapsed');
  expect(document.activeElement).toBe(toggle);
});

it('turns the empty-canvas hint into the controls that reveal a collapsed rail', () => {
  localStorage.setItem(RAIL_BOT_KEY, '1');
  const onExpandModelRail = vi.fn();
  const view = render(<AgentWorkspace {...props()} nodes={[]} modelRailCollapsed onExpandModelRail={onExpandModelRail}><div /></AgentWorkspace>);
  const note = () => document.querySelector('.awwo-empty-note') as HTMLElement;
  expect(note()).toHaveTextContent('从左侧模型栏添加模型，或在右侧Bot 清单选择协作者。');
  fireEvent.click(within(note()).getByRole('button', { name: '模型栏' }));
  expect(onExpandModelRail).toHaveBeenCalledOnce();
  fireEvent.click(within(note()).getByRole('button', { name: 'Bot 清单' }));
  expect(bots()).not.toHaveClass('is-collapsed');
  // Both rails are open: the hint is plain text again, pointing at what is now on screen.
  view.rerender(<AgentWorkspace {...props()} nodes={[]} modelRailCollapsed={false} onExpandModelRail={onExpandModelRail}><div /></AgentWorkspace>);
  expect(within(note()).queryAllByRole('button')).toHaveLength(0);
  expect(note()).toHaveTextContent('从左侧模型栏添加模型，或在右侧Bot 清单选择协作者。');
});

it('lets users select the complete product Bot catalogue from the right sidebar', () => {
  const p = props();
  render(<AgentWorkspace {...p}><div /></AgentWorkspace>);
  openBotTools();
  fireEvent.click(within(bots()).getByRole('button', { name: '产品 Bot' }));
  const first = getTeamMarketAgents()[0];
  fireEvent.click(within(bots()).getByRole('button', { name: `选择 ${first.name} · ${first.source.teamName}` }));
  fireEvent.click(within(bots()).getByRole('button', { name: '添加所选角色' }));
  expect(p.onAddMarketAgent).toHaveBeenCalledExactlyOnceWith(first);
});

it('keeps Bot creation locked during execution', () => {
  const p = props();
  render(<AgentWorkspace {...p} running><div /></AgentWorkspace>);
  expect(within(bots()).getByRole('button', { name: '添加 Bot', exact: true })).toBeDisabled();
  openBotTools();
  fireEvent.click(within(bots()).getByRole('button', { name: '产品 Bot' }));
  const first = getTeamMarketAgents()[0];
  fireEvent.click(within(bots()).getByRole('button', { name: `选择 ${first.name} · ${first.source.teamName}` }));
  expect(within(bots()).getByRole('button', { name: '添加所选角色' })).toBeDisabled();
  expect(p.onAddMarketAgent).not.toHaveBeenCalled();
});

it('keeps mobile drawers mutually exclusive and dismisses them with Escape', () => {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  try {
    const { container } = render(<AgentWorkspace {...props()}><div /></AgentWorkspace>);
    fireEvent.click(screen.getByRole('button', { name: '打开模型库' }));
    expect(container.querySelector('.awwo-workspace')).toHaveClass('is-model-library-open');
    expect(container.querySelector('main')).toHaveAttribute('inert');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('main')).not.toHaveAttribute('inert');
    fireEvent.click(screen.getByRole('button', { name: '打开导航' }));
    expect(container.querySelector('.awwo-workspace')).toHaveClass('is-sidebar-open');
    expect(container.querySelector('.awwo-workspace')).not.toHaveClass('is-model-library-open');
    // The mobile drawer is never the collapsed desktop rail: the full Bot list is available.
    expect(bots()).not.toHaveClass('is-collapsed');
    expect(within(bots()).getByRole('button', { name: /定位/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('main')).not.toHaveAttribute('inert');
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
});

it('opens the drawers from the empty-canvas hint on a narrow stage', () => {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  try {
    const { container } = render(<AgentWorkspace {...props()} nodes={[]}><div /></AgentWorkspace>);
    const note = () => container.querySelector('.awwo-empty-note') as HTMLElement;
    fireEvent.click(within(note()).getByRole('button', { name: '模型栏' }));
    expect(container.querySelector('.awwo-workspace')).toHaveClass('is-model-library-open');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(note()).getByRole('button', { name: 'Bot 清单' }));
    expect(container.querySelector('.awwo-workspace')).toHaveClass('is-sidebar-open');
    expect(container.querySelector('.awwo-workspace')).not.toHaveClass('is-model-library-open');
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
});

it('reveals models when an empty mobile Bot library redirects to a previously collapsed rail', async () => {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  try {
    function Host() {
      const [collapsed, setCollapsed] = useState(true);
      return <AgentWorkspace {...props()} nodes={[]} modelRailCollapsed={collapsed}
        onExpandModelRail={() => setCollapsed(false)}
        modelShelf={<div hidden={collapsed}><button type="button">Test model</button></div>}
        loadWorkspaceAgents={async () => ({ items: [] })} onAddWorkspaceAgent={vi.fn()}><div /></AgentWorkspace>;
    }
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: '添加 Bot', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: '去选择模型' }));
    expect(container.querySelector('.awwo-workspace')).toHaveClass('is-model-library-open');
    expect(screen.getByRole('button', { name: 'Test model' })).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.awwo-workspace')).not.toHaveClass('is-model-library-open');
    expect(screen.getByRole('button', { name: '打开模型库' })).toHaveFocus();
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
});
