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
const expandBots = () => fireEvent.click(within(bots()).getByRole('button', { name: '展开 Bot 清单' }));

it('separates models on the left, the canvas in the middle and Bots/personas on the right', () => {
  const p = props();
  render(<AgentWorkspace {...p}><div>Canvas fixture</div></AgentWorkspace>);
  const models = screen.getByRole('complementary', { name: '模型库' });
  const main = screen.getByRole('main');
  expect(within(models).getByText('Execution model fixture')).toBeVisible();
  // The desktop Bot rail starts collapsed: only the expand control and the add-Bot action remain.
  expect(bots()).toHaveClass('is-collapsed');
  expect(within(bots()).getByRole('button', { name: '添加 Bot', exact: true })).toBeEnabled();
  expect(within(bots()).queryByRole('button', { name: /定位/ })).toBeNull();
  expandBots();
  expect(bots()).not.toHaveClass('is-collapsed');
  fireEvent.click(within(bots()).getByText('人设预设'));
  expect(within(bots()).getByText('Persona fixture')).toBeVisible();
  expect(within(bots()).getByRole('button', { name: /定位/ })).toBeVisible();
  expect(models.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(main.compareDocumentPosition(bots()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('remembers the Bot rail state per browser, reports rail changes and survives blocked storage', () => {
  const onRailsChange = vi.fn();
  const view = render(<AgentWorkspace {...props()} onRailsChange={onRailsChange}><div /></AgentWorkspace>);
  expandBots();
  expect(onRailsChange).toHaveBeenCalledOnce();
  expect(localStorage.getItem(RAIL_BOT_KEY)).toBe('0');
  view.unmount();
  render(<AgentWorkspace {...props()}><div /></AgentWorkspace>);
  expect(bots()).not.toHaveClass('is-collapsed');
  const collapse = within(bots()).getByRole('button', { name: '收起 Bot 清单' });
  expect(collapse).toHaveAttribute('aria-expanded', 'true');
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
  fireEvent.click(collapse);
  expect(bots()).toHaveClass('is-collapsed');
  expect(within(bots()).getByRole('button', { name: '展开 Bot 清单' })).toHaveAttribute('aria-expanded', 'false');
});

it('keeps keyboard focus on the Bot rail toggle while it collapses and expands the rail', () => {
  render(<AgentWorkspace {...props()}><div /></AgentWorkspace>);
  const toggle = within(bots()).getByRole('button', { name: '展开 Bot 清单' });
  toggle.focus();
  fireEvent.click(toggle);
  expect(bots()).not.toHaveClass('is-collapsed');
  expect(document.activeElement).toBe(toggle);
  expect(toggle).toHaveAttribute('aria-label', '收起 Bot 清单');
  fireEvent.click(toggle);
  expect(bots()).toHaveClass('is-collapsed');
  expect(document.activeElement).toBe(toggle);
});

it('turns the empty-canvas hint into the controls that reveal a collapsed rail', () => {
  const onExpandModelRail = vi.fn();
  const view = render(<AgentWorkspace {...props()} nodes={[]} modelRailCollapsed onExpandModelRail={onExpandModelRail}><div /></AgentWorkspace>);
  const note = () => document.querySelector('.awwo-empty-note') as HTMLElement;
  expect(note()).toHaveTextContent('先在右侧Bot 清单选择人设（可选），再从左侧模型栏添加模型；也可以直接选用已有 Bot。');
  fireEvent.click(within(note()).getByRole('button', { name: '模型栏' }));
  expect(onExpandModelRail).toHaveBeenCalledOnce();
  fireEvent.click(within(note()).getByRole('button', { name: 'Bot 清单' }));
  expect(bots()).not.toHaveClass('is-collapsed');
  // Both rails are open: the hint is plain text again, pointing at what is now on screen.
  view.rerender(<AgentWorkspace {...props()} nodes={[]} modelRailCollapsed={false} onExpandModelRail={onExpandModelRail}><div /></AgentWorkspace>);
  expect(within(note()).queryAllByRole('button')).toHaveLength(0);
  expect(note()).toHaveTextContent('先在右侧Bot 清单选择人设（可选），再从左侧模型栏添加模型；也可以直接选用已有 Bot。');
});

it('lets users select the complete product Bot catalogue from the right sidebar', () => {
  const p = props();
  render(<AgentWorkspace {...p}><div /></AgentWorkspace>);
  expandBots();
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
  expandBots();
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
