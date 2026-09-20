import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentWorkspace } from '../src/canvas/AgentWorkspace';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { getTeamMarketAgents } from '../src/canvas/teamMarketAgents';

afterEach(cleanup);
const props = () => ({ nodes: [createAgentTemplate('general', { x: 0, y: 0 })], edges: [], selectedIds: [], runs: {}, running: false,
  onFocusNode: vi.fn(), onAddAgent: vi.fn(), onCreateTemplate: vi.fn(), onSearch: vi.fn(), onAddMarketAgent: vi.fn(),
  modelShelf: <div>Execution model fixture</div>, personaControls: <div>Persona fixture</div> });

it('separates models on the left, the canvas in the middle and Bots/personas on the right', () => {
  const p = props();
  render(<AgentWorkspace {...p}><div>Canvas fixture</div></AgentWorkspace>);
  const models = screen.getByRole('complementary', { name: '模型库' });
  const bots = screen.getByRole('complementary', { name: 'Bot 清单' });
  const main = screen.getByRole('main');
  expect(within(models).getByText('Execution model fixture')).toBeVisible();
  fireEvent.click(within(bots).getByText('人设预设'));
  expect(within(bots).getByText('Persona fixture')).toBeVisible();
  expect(within(bots).getByRole('button', { name: /定位/ })).toBeVisible();
  expect(models.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(main.compareDocumentPosition(bots) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('lets users select the complete product Bot catalogue from the right sidebar', () => {
  const p = props();
  render(<AgentWorkspace {...p}><div /></AgentWorkspace>);
  const bots = screen.getByRole('complementary', { name: 'Bot 清单' });
  fireEvent.click(within(bots).getByRole('button', { name: '产品 Bot' }));
  const first = getTeamMarketAgents()[0];
  fireEvent.click(within(bots).getByRole('button', { name: `选择 ${first.name} · ${first.source.teamName}` }));
  fireEvent.click(within(bots).getByRole('button', { name: '添加所选角色' }));
  expect(p.onAddMarketAgent).toHaveBeenCalledExactlyOnceWith(first);
});

it('keeps Bot creation locked during execution', () => {
  const p = props();
  render(<AgentWorkspace {...p} running><div /></AgentWorkspace>);
  const bots = screen.getByRole('complementary', { name: 'Bot 清单' });
  fireEvent.click(within(bots).getByRole('button', { name: '产品 Bot' }));
  const first = getTeamMarketAgents()[0];
  fireEvent.click(within(bots).getByRole('button', { name: `选择 ${first.name} · ${first.source.teamName}` }));
  expect(within(bots).getByRole('button', { name: '添加所选角色' })).toBeDisabled();
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
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('main')).not.toHaveAttribute('inert');
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
});
