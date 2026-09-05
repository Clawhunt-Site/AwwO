import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { emptyDocument, loadDocumentWithStatus, saveDocument, type SessionNode } from '../src/canvas/canvasDoc';
import type { CanvasPlan } from '../src/canvas/canvasPlan';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { resetAllSessions } from '../src/canvas/sessions';
import { presentationNodes } from '../src/canvas/nodePresentation';

function newProductPlan(): CanvasPlan {
  return { version: 1, summary: '已组织数据治理、业务服务和产品界面三个节点。', operations: [
    { type: 'add_node', ref: 'data', templateId: 'data', title: '数据治理', inputValues: { brief: '产品研发需求' } },
    { type: 'add_node', ref: 'service', templateId: 'backend', title: '业务服务' },
    { type: 'add_node', ref: 'interface', templateId: 'frontend', title: '产品界面' },
    { type: 'connect', fromNode: 'data', fromField: 'schema', toNode: 'service', toField: 'schema' },
    { type: 'connect', fromNode: 'service', fromField: 'api', toNode: 'interface', toField: 'api' },
  ] };
}

function seedExisting(): SessionNode {
  const node: SessionNode = {
    ...createAgentTemplate('general', { x: 173, y: 91 }), id: 'existing', title: '人工节点', w: 763, h: 517,
    runtime: 'claude_local', model: 'kept-model', effort: 'low', persona: '保留人工设定的职责。',
    binding: { companyId: 'company', agentId: 'bound-agent', agentName: 'Existing agent' },
    issueId: 'original-server-thread', preview: '先前会话摘要', activeThreadId: 'default',
    threads: [{ id: 'default', title: '需求澄清', issueId: 'original-server-thread', preview: '先前会话摘要', draft: '未发送的会话草稿', createdAt: 1 }],
  };
  node.contract!.inputs[0] = { ...node.contract!.inputs[0], label: '节点需求', value: '人工填写的原始需求' };
  node.contract!.outputs[0].value = '未发布的交付草稿';
  saveDocument({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } });
  return loadDocumentWithStatus().doc.nodes[0] as SessionNode;
}

function deferredPlan() {
  let resolve!: (plan: CanvasPlan) => void;
  const promise = new Promise<CanvasPlan>(complete => { resolve = complete; });
  const request = vi.fn<typeof requestCanvasPlan>().mockReturnValue(promise);
  return { request, resolve };
}

function submit(prompt: string, label: '生成画布' | '修改画布') {
  fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: prompt } });
  fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
}

function openAssistant() {
  if (!screen.queryByRole('textbox', { name: '画布需求' })) {
    fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
  }
}

beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.classList.contains('canvas-root')
      ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
      : originalRect.call(this);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});

describe('canvas planning integration', () => {
  it('applies a generated graph from the welcome prompt and reverses the whole plan with one undo', async () => {
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(newProductPlan());
    render(<CanvasSurface planRequest={planRequest} />);
    expect(screen.getByRole('heading', { name: '想一起搭建什么？' })).toBeTruthy();
    submit('搭建一个带用户权限的数据产品', '生成画布');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(3));
    const generated = loadDocumentWithStatus().doc;
    const byTitle = Object.fromEntries(generated.nodes.map(node => [node.title, node]));
    expect(generated.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNode: byTitle['数据治理'].id, fromPort: 'out:schema', toNode: byTitle['业务服务'].id, toPort: 'in:schema' }),
      expect.objectContaining({ fromNode: byTitle['业务服务'].id, fromPort: 'out:api', toNode: byTitle['产品界面'].id, toPort: 'in:api' }),
    ]));
    expect(generated.edges).toHaveLength(2);
    expect(generated.nodes.every(node => node.kind === 'session' && !node.binding && !node.issueId && !node.lastOutput)).toBe(true);
    expect(planRequest).toHaveBeenCalledOnce();
    expect(planRequest.mock.calls[0][0]).toBe('搭建一个带用户权限的数据产品');
    expect(planRequest.mock.calls[0][1].nodes).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '撤销本次更改', exact: true }));
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(0);
    expect(loadDocumentWithStatus().doc.edges).toHaveLength(0);
    expect(screen.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  });

  it('fits the generated graph to the narrower committed canvas when the assistant sidebar first opens', async () => {
    // The welcome viewport is measured at 1280px. Opening the sidebar leaves 950px,
    // but ResizeObserver has not delivered its next measurement yet. An in-app
    // browser may defer animation frames too, so the old cached width cannot own fit.
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      const isCanvas = this.classList.contains('canvas-root') || this.classList.contains('canvas-viewport');
      const width = isCanvas ? (document.querySelector('.awwo-planner-sidebar') ? 950 : 1280) : 0;
      const height = isCanvas ? 720 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
    });
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(newProductPlan());
    const { container } = render(<CanvasSurface planRequest={planRequest} />);
    expect(container.querySelector('.canvas-root')!.getBoundingClientRect().width).toBe(1280);

    submit('生成从数据到后端再到前端的完整流程', '生成画布');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(3));
    expect(container.querySelector('.awwo-planner-sidebar')).toBeTruthy();
    expect(container.querySelector('.canvas-root')!.getBoundingClientRect().width).toBe(950);
    const cards = presentationNodes(loadDocumentWithStatus().doc.nodes, null);
    await waitFor(() => {
      const transform = (container.querySelector('.canvas-world') as HTMLElement).style.transform;
      const match = transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/i);
      expect(match).not.toBeNull();
      const [x, y, scale] = match!.slice(1).map(Number);
      expect(scale).toBeGreaterThan(0);
      for (const card of cards) {
        expect(x + card.x * scale).toBeGreaterThanOrEqual(0);
        expect(x + (card.x + card.w) * scale).toBeLessThanOrEqual(950);
        expect(y + card.y * scale).toBeGreaterThanOrEqual(0);
        expect(y + (card.y + card.h) * scale).toBeLessThanOrEqual(720);
      }
    });
  });

  it('applies incremental rename and input changes without replacing an existing Session or manual geometry', async () => {
    const original = seedExisting();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue({ version: 1, summary: '已更新任务名称与输入要求。', operations: [
      { type: 'update_node', nodeId: original.id, title: '成员管理节点' },
      { type: 'set_input', nodeId: original.id, fieldId: 'brief', value: '改为移动端成员管理' },
    ] });
    render(<CanvasSurface planRequest={planRequest} />);
    openAssistant();
    submit('把这个节点改为移动端成员管理', '修改画布');
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes[0].title).toBe('成员管理节点'));
    const changed = loadDocumentWithStatus().doc.nodes[0] as SessionNode;
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1);
    expect(changed).toEqual({ ...original, title: '成员管理节点', contract: { ...original.contract!,
      inputs: original.contract!.inputs.map(field => field.id === 'brief' ? { ...field, value: '改为移动端成员管理' } : field),
    } });
    expect(planRequest.mock.calls[0][1].nodes[0]).toEqual(original);
  });

  it('keeps a manual input edit made during planning and refuses to apply the now-stale plan', async () => {
    const original = seedExisting();
    const pending = deferredPlan();
    render(<CanvasSurface planRequest={pending.request} />);
    openAssistant();
    submit('重命名这个节点', '修改画布');
    expect(pending.request).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: '打开 人工节点', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: '节点需求的值' }), { target: { value: '规划期间的人工需求修改' } });
    const manuallyChanged = loadDocumentWithStatus().doc;
    expect((manuallyChanged.nodes[0] as SessionNode).contract!.inputs[0].value).toBe('规划期间的人工需求修改');
    await act(async () => { pending.resolve({ version: 1, summary: '这份旧方案不应应用。', operations: [
      { type: 'update_node', nodeId: original.id, title: '不应应用的名称' },
    ] }); });
    await waitFor(() => expect(screen.getAllByRole('alert').some(element => element.textContent?.includes('画布已有新改动，请重新生成'))).toBe(true));
    expect(loadDocumentWithStatus().doc.nodes).toEqual(manuallyChanged.nodes);
    expect(loadDocumentWithStatus().doc.edges).toEqual(manuallyChanged.edges);
    expect(loadDocumentWithStatus().doc.nodes[0].title).toBe('人工节点');
  });

  it('aborts a cancelled request and ignores a late response even when the transport still resolves', async () => {
    const pending = deferredPlan();
    render(<CanvasSurface planRequest={pending.request} />);
    submit('生成一个产品研发流程', '生成画布');
    expect(pending.request).toHaveBeenCalledOnce();
    const signal = pending.request.mock.calls[0][3];
    expect(signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }));
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(newProductPlan()); });
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(0);
    expect(loadDocumentWithStatus().doc.edges).toHaveLength(0);
    expect(screen.queryByText('已更新画布')).toBeNull();
  });
});
