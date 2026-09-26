import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { CanvasList } from '../src/saas/CanvasList';
import { AgentWorkspace } from '../src/canvas/AgentWorkspace';
import type { Tenant } from '../src/saas/api';
const tenant = { id: 'ux', name: 'UX', role: 'owner', status: 'active' } as Tenant;
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('does not block existing shorter login passwords and resets visibility when registering', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ error: { code: 'unauthenticated' } }, { status: 401 }));
  vi.stubGlobal('fetch', fetch); render(<SaaSApp />);
  const password = await screen.findByLabelText('密码');
  expect(password).not.toHaveAttribute('minlength');
  fireEvent.change(password, { target: { value: 'short' } });
  fireEvent.click(screen.getByRole('button', { name: '显示密码' }));
  expect(password).toHaveAttribute('type', 'text');
  expect(password).toHaveAttribute('spellcheck', 'false');
  expect(password).toHaveAttribute('autocapitalize', 'none');
  expect(password).toHaveAttribute('autocorrect', 'off');
  fireEvent.click(screen.getByRole('button', { name: '创建账号和工作区' }));
  expect(screen.getByLabelText('密码')).toHaveAttribute('minlength', '12');
  expect(screen.getByLabelText('密码')).toHaveAttribute('type', 'password');
  expect(screen.getByText(/注册后进入工作区，按提示选择模型服务/)).toBeVisible();
});
it('gives an actionable first-canvas state without irrelevant pagination', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [] })));
  render(<SaaSPreferencesProvider><CanvasList tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  await screen.findByRole('heading', { name: '从第一张画布开始' });
  expect(screen.queryByRole('navigation', { name: '画布分页' })).toBeNull();
  expect(screen.getByRole('button', { name: '刷新列表' })).toBeEnabled();
  expect(screen.getByText(/右侧 Bot 清单/)).toBeVisible();
});
it('offers readers an honest empty-state instruction without creation controls', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [] })));
  render(<SaaSPreferencesProvider><CanvasList tenant={{ ...tenant, role: 'reader' }} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  await screen.findByText('请工作区成员创建画布后，刷新列表查看。');
  expect(screen.queryByRole('button', { name: '新建画布' })).toBeNull();
});
it('takes an empty Bot library back to model selection without creating a phantom Bot', async () => {
  const add = vi.fn();
  render(<AgentWorkspace nodes={[]} edges={[]} selectedIds={[]} runs={{}} running={false}
    onFocusNode={vi.fn()} onSearch={vi.fn()} onAddAgent={add} onCreateTemplate={vi.fn()}
    modelShelf={<p>模型选择入口</p>} loadWorkspaceAgents={async () => ({ items: [] })} onAddWorkspaceAgent={add}><div /></AgentWorkspace>);
  const addBot = screen.getByRole('button', { name: '添加 Bot', exact: true });
  addBot.focus();
  fireEvent.click(addBot);
  fireEvent.click(await screen.findByRole('button', { name: '去选择模型' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.querySelector('.awwo-workspace')).toHaveClass('is-model-library-open');
  expect(addBot).toHaveFocus();
  expect(add).not.toHaveBeenCalled();
});
it('opens the correct mobile drawer from the empty-canvas guidance', () => {
  vi.stubGlobal('innerWidth', 390);
  render(<AgentWorkspace nodes={[]} edges={[]} selectedIds={[]} runs={{}} running={false}
    onFocusNode={vi.fn()} onSearch={vi.fn()} onAddAgent={vi.fn()} onCreateTemplate={vi.fn()}
    modelShelf={<p>模型选择入口</p>}><div /></AgentWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: '模型栏' }));
  expect(document.querySelector('.awwo-workspace')).toHaveClass('is-model-library-open');
  fireEvent.click(screen.getByRole('button', { name: '关闭模型库' }));
  fireEvent.click(screen.getByRole('button', { name: 'Bot 清单' }));
  expect(document.querySelector('.awwo-workspace')).toHaveClass('is-sidebar-open');
});
it('returns focus to the visible model opener after moving from an empty Bot dialog to the mobile drawer', async () => {
  vi.stubGlobal('innerWidth', 390);
  const add = vi.fn();
  render(<AgentWorkspace nodes={[]} edges={[]} selectedIds={[]} runs={{}} running={false}
    onFocusNode={vi.fn()} onSearch={vi.fn()} onAddAgent={add} onCreateTemplate={vi.fn()}
    modelShelf={<p>模型选择入口</p>} loadWorkspaceAgents={async () => ({ items: [] })} onAddWorkspaceAgent={add}><div /></AgentWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: '添加 Bot', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: '去选择模型' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '关闭模型库' }));
  expect(screen.getByRole('button', { name: '打开模型库' })).toHaveFocus();
  expect(add).not.toHaveBeenCalled();
});
it('expands an initially collapsed model rail before opening its mobile drawer', () => {
  vi.stubGlobal('innerWidth', 390);
  function MobileCanvas() {
    const [collapsed, setCollapsed] = useState(true);
    return <AgentWorkspace nodes={[]} edges={[]} selectedIds={[]} runs={{}} running={false}
      onFocusNode={vi.fn()} onSearch={vi.fn()} onAddAgent={vi.fn()} onCreateTemplate={vi.fn()}
      modelShelf={<div hidden={collapsed}><button type="button">测试模型</button></div>}
      onExpandModelRail={() => setCollapsed(false)}><div /></AgentWorkspace>;
  }
  render(<MobileCanvas />);
  expect(screen.queryByRole('button', { name: '测试模型' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开模型库' }));
  expect(screen.getByRole('button', { name: '测试模型' })).toBeVisible();
  expect(document.querySelector('.awwo-workspace')).toHaveClass('is-model-library-open');
});
