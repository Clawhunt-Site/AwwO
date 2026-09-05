import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { resetAllSessions } from '../src/canvas/sessions';

const hire = vi.fn();
vi.mock('../src/canvas/runTransport', () => ({
  createGatewayExecutor: (options: { onIssueId: (nodeId: string, issueId: string) => void }) =>
    async (node: SessionNode) => {
      options.onIssueId(node.id, 'server-owned-thread');
      const values = Object.fromEntries((node.contract?.outputs ?? []).map(field => [
        field.id, field.type === 'number' ? 1 : field.type === 'boolean' ? false : `Validated ${field.id}`,
      ]));
      return { ok: true, output: node.contract ? JSON.stringify(values) : 'Validated result' };
    },
}));
vi.mock('../src/canvasHire', async (original) => ({
  ...await original<typeof import('../src/canvasHire')>(),
  hireAgentIntoCompany: (...args: unknown[]) => hire(...args),
}));

beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks();
  hire.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.classList.contains('canvas-root')
      ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
      : originalRect.call(this);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});

it('keeps an in-flight binding mounted across parent Escape, configuration switch and delete', async () => {
  const a = { ...createAgentTemplate('data', { x: 0, y: 0 }), runtime: 'claude_local', persona: '' };
  const b = createAgentTemplate('frontend', { x: 600, y: 0 });
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [a, b], view: { x: 0, y: 0, scale: 1 } }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ id: 'company', name: 'Local test company' }] })));
  let resolveHire!: (value: unknown) => void;
  hire.mockReturnValue(new Promise(resolve => { resolveHire = resolve; }));
  render(<CanvasSurface />);
  fireEvent.click(screen.getByRole('button', { name: '打开 数据治理', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  const bind = await screen.findByRole('button', { name: '绑定并创建真实 Agent' });
  fireEvent.click(bind);
  expect(hire).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { key: 'Escape' });
  const otherTile = within(screen.getByTestId(`canvas-tile-${b.id}`));
  fireEvent.click(otherTile.getByRole('button', { name: '更多节点操作' }));
  expect(otherTile.getByRole('button', { name: '配置', exact: true })).toBeDisabled();
  fireEvent.click(otherTile.getByRole('button', { name: '配置', exact: true }));
  const bindingTile = within(screen.getByTestId(`canvas-tile-${a.id}`));
  fireEvent.click(bindingTile.getByRole('button', { name: '更多节点操作' }));
  expect(bindingTile.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  fireEvent.click(bindingTile.getByRole('button', { name: '删除', exact: true }));
  expect(screen.getByText('节点配置 — 数据治理')).toBeTruthy();
  expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2);
  resolveHire({ outcome: 'created', agentId: 'actual-agent', status: 'idle' });
  await waitFor(() => {
    const saved = loadDocumentWithStatus().doc.nodes[0];
    expect(saved.kind === 'session' && saved.binding?.agentId).toBe('actual-agent');
  });
  fireEvent.click(screen.getByRole('button', { name: '关闭配置' }));
  expect(screen.queryByText('节点配置 — 数据治理')).toBeNull();
});

it('preserves card input when an older inspector draft is saved', () => {
  const node = createAgentTemplate('data', { x: 0, y: 0 });
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
  render(<CanvasSurface />);
  fireEvent.click(screen.getByRole('button', { name: '打开 数据治理', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
  fireEvent.change(screen.getByRole('textbox', { name: '业务需求的值' }), { target: { value: '**保留本次输入**' } });
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  const saved = loadDocumentWithStatus().doc.nodes[0];
  expect(saved.kind === 'session' && saved.contract?.inputs[0].value).toBe('**保留本次输入**');
});

it('preserves the server thread while undoing a user edit made before graph execution', async () => {
  const node = createAgentTemplate('data', { x: 0, y: 0 });
  node.runtime = 'claude_local';
  node.binding = { companyId: 'company', agentId: 'agent', agentName: 'Data agent' };
  node.contract!.inputs[0].value = 'A ready brief';
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
  render(<CanvasSurface />);
  fireEvent.click(screen.getByRole('button', { name: '打开 数据治理', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '数据 Agent' } });
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
  await screen.findByText(/运行完成：1\/1/);
  fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
  const restored = loadDocumentWithStatus().doc.nodes[0];
  expect(restored.title).toBe('数据治理');
  expect(restored.kind === 'session' && restored.issueId).toBe('server-owned-thread');
  expect(screen.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});

it('explains missing input when the operator runs one configured node', () => {
  const node = createAgentTemplate('data', { x: 0, y: 0 });
  node.runtime = 'claude_local';
  node.binding = { companyId: 'company', agentId: 'agent', agentName: 'Data agent' };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } }));
  render(<CanvasSurface />);
  fireEvent.click(screen.getByRole('button', { name: '更多节点操作' }));
  fireEvent.click(screen.getByRole('button', { name: '运行节点', exact: true }));
  expect(screen.getByRole('alert')).toHaveTextContent('业务需求');
  expect(screen.queryByRole('button', { name: /停止/ })).toBeNull();
});
