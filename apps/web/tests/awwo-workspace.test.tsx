import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentWorkspace } from '../src/canvas/AgentWorkspace';
import { AGENT_TEMPLATES, createAgentTemplate, createDevelopmentTemplate } from '../src/canvas/agentTemplates';
import { loadDocumentWithStatus, saveDocument } from '../src/canvas/canvasDoc';
import { reconcileEdges } from '../src/canvas/ports';

beforeEach(() => { cleanup(); localStorage.clear(); });

describe('AwwO draft workspace', () => {
  it('creates independent draft sessions with typed connections only after an explicit action', () => {
    const first = createDevelopmentTemplate({ x: 0, y: 0 });
    const second = createDevelopmentTemplate({ x: 0, y: 0 });
    expect(first.nodes).toHaveLength(5);
    expect(first.nodes.every(n => n.kind === 'session' && !n.binding && !n.issueId && !n.lastOutput)).toBe(true);
    expect(first.nodes.every(n => n.contract?.version === 1 && !n.runtime && !n.model)).toBe(true);
    expect(reconcileEdges(first.nodes, first.edges)).toEqual(first.edges);
    expect(first.edges.length).toBeGreaterThanOrEqual(4);
    expect(first.nodes.some(n => second.nodes.some(other => other.id === n.id))).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('round-trips a responsibility template and its input schema', () => {
    const node = createAgentTemplate('backend', { x: 12, y: 34 });
    node.contract!.inputs[0].value = '**需求**：管理用户权限';
    saveDocument({ version: 2, updatedAt: 1, nodes: [node], edges: [], waypoints: [], view: null });
    const restored = loadDocumentWithStatus().doc.nodes[0];
    expect(restored).toMatchObject({ kind: 'session', title: '后端服务', contract: node.contract });
    expect(restored.w).toBeGreaterThanOrEqual(400);
  });

  it('offers a usable empty workspace without inventing agents or run counts', () => {
    const onTemplate = vi.fn();
    render(<AgentWorkspace nodes={[]} edges={[]} selectedIds={[]} runs={{}} running={false}
      onFocusNode={vi.fn()} onAddAgent={vi.fn()} onCreateTemplate={onTemplate}
      onSearch={vi.fn()} onOpenSettings={vi.fn()}><div /></AgentWorkspace>);
    expect(within(screen.getByRole('complementary', { name: '工作区导航' })).getByText('AwwO')).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toHaveTextContent('本地画布');
    expect(onTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '创建产品研发画布' }));
    expect(onTemplate).toHaveBeenCalledOnce();
    expect(screen.queryByText('运行成功')).toBeNull();
  });

  it('filters the Agent list and focuses the chosen node', () => {
    const nodes = createDevelopmentTemplate({ x: 0, y: 0 }).nodes;
    const onFocusNode = vi.fn();
    render(<AgentWorkspace nodes={nodes} edges={[]} selectedIds={[]} runs={{}} running={false}
      onFocusNode={onFocusNode} onAddAgent={vi.fn()} onCreateTemplate={vi.fn()} onSearch={vi.fn()}><div /></AgentWorkspace>);
    fireEvent.change(screen.getByRole('searchbox', { name: '查找 Agent' }), { target: { value: '后端' } });
    const result = screen.getByRole('button', { name: /定位 后端/ });
    expect(screen.queryByRole('button', { name: /定位 物料/ })).toBeNull();
    fireEvent.click(result);
    expect(onFocusNode).toHaveBeenCalledWith(nodes.find(n => n.title.includes('后端'))!.id);
  });

  it('keeps keyboard focus inside the Agent library and restores it on Escape', () => {
    render(<AgentWorkspace nodes={[]} edges={[]} selectedIds={[]} runs={{}} running={false}
      onFocusNode={vi.fn()} onAddAgent={vi.fn()} onCreateTemplate={vi.fn()} onSearch={vi.fn()}><div /></AgentWorkspace>);
    const trigger = screen.getByRole('button', { name: '添加 Agent', exact: true });
    trigger.focus();
    fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: '关闭添加 Agent' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).not.toBe(close);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});


describe('personalized template library', () => {
  it('previews each complete role before creating exactly the selected template', () => {
    const onAddAgent = vi.fn();
    render(<AgentWorkspace nodes={[]} edges={[]} selectedIds={[]} runs={{}} running={false}
      onFocusNode={vi.fn()} onAddAgent={onAddAgent} onCreateTemplate={vi.fn()} onSearch={vi.fn()}><div /></AgentWorkspace>);
    fireEvent.click(screen.getByRole('button', { name: '添加 Agent', exact: true }));
    for (const template of AGENT_TEMPLATES) {
      fireEvent.click(screen.getByRole('button', { name: `预览${template.title}模板` }));
      const preview = screen.getByRole('region', { name: `${template.title}模板详情` });
      expect(within(preview).getByText(template.emptyDescription)).toBeTruthy();
      expect(within(preview).getByText(template.workflow[0])).toBeTruthy();
      expect(within(preview).getByRole('region', { name: '模板输入' })).toHaveTextContent(template.inputs[0].label);
      expect(within(preview).getByRole('region', { name: '模板输出' })).toHaveTextContent(template.outputs[0].label);
      expect(onAddAgent).not.toHaveBeenCalled();
    }
    fireEvent.click(screen.getByRole('button', { name: '添加交付验收' }));
    expect(onAddAgent).toHaveBeenCalledExactlyOnceWith('review');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
