import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { AgentTemplateDetails } from '../src/canvas/AgentTemplateDetails';
import { CanvasResults } from '../src/canvas/CanvasResults';
import { createAgentTemplate, getAgentTemplate } from '../src/canvas/agentTemplates';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { deliveredItems } from '../src/canvas/canvasResultModel';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearSaaSCanvas(); });

const cloud = () => configureSaaSCanvas({ tenant: { id: 'tenant-a', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 }, canvasId: 'canvas-a' });

/** A frontend node as the 3D game canvas had it: a description, an entry file and checks. */
function gameClient(preview: string, id = 'game'): SessionNode {
  const node = createAgentTemplate('frontend', { x: 0, y: 0 });
  return { ...node, id, title: '游戏客户端（3D）', lastOutput: { text: JSON.stringify({
    delivery: '实现页面：主菜单\n启动方式：直接在浏览器中打开 index.html', preview, checks: '已验证：主菜单可进入',
  }), at: 1_700_000_000_000, source: 'run' } };
}

describe('where a node’s files are', () => {
  it('names a delivered file above the tabs and opens its tab from there', () => {
    cloud();
    render(<NodeDeliverables node={gameClient('awwo-file:aAbCdEfGhIjKlMnOp')} readOnly presentation="result" />);
    const strip = screen.getByRole('group', { name: '交付文件' });
    expect(strip).toHaveTextContent('交付了 1 个文件');
    fireEvent.click(within(strip).getByRole('button', { name: /预览入口/ }));
    // The entry file is the one shown now: a stored file offers its download.
    expect(screen.getByRole('button', { name: '预览入口', pressed: true })).toBeInTheDocument();
  });

  it('says plainly when a file field came back as a name with no file, and offers to run again', () => {
    cloud();
    const rerun = vi.fn();
    render(<NodeDeliverables node={gameClient('index.html')} readOnly={false} onUpdateNode={vi.fn()} onRerun={rerun} />);
    expect(screen.getByRole('group', { name: '交付文件' })).toHaveTextContent('没有交出文件');
    fireEvent.click(screen.getByRole('button', { name: /预览入口.*只有文件名/ }));
    expect(screen.getByRole('note')).toHaveTextContent('Agent 只写了「index.html」，没有交出文件本身');
    fireEvent.click(screen.getByRole('button', { name: '重新执行，交出真实文件' }));
    expect(rerun).toHaveBeenCalledOnce();
  });

  it('keeps a local workspace’s plain file reference as it was', () => {
    render(<NodeDeliverables node={gameClient('index.html')} readOnly presentation="result" />);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByRole('group', { name: '交付文件' })).toBeNull();
  });

  it('can open with the deliverable form editor expanded', () => {
    const { container } = render(<NodeDeliverables node={gameClient('awwo-file:aAbCdEfGhIjKlMnOp')} readOnly={false} onUpdateNode={vi.fn()} editorOpen />);
    expect(container.querySelector('details.awwo-deliverables-editor[open]')).not.toBeNull();
  });
});

describe('everything a canvas made', () => {
  it('lists pages, stored files, documents and name-only files of every step in canvas order', () => {
    const art = { ...createAgentTemplate('materials', { x: 0, y: 0 }), id: 'art', title: '美术资源与角色设计',
      lastOutput: { text: JSON.stringify({ assets: '5 位英雄的 3D 角色概念', copy: '主标题：星环突围' }), at: 1, source: 'run' as const } };
    const page = { ...createSessionNode('llm', { x: 400, y: 0 }), id: 'page', title: '可玩页面',
      contract: { version: 1 as const, inputs: [], outputs: [{ id: 'game', label: '游戏页面', type: 'html' as const, required: true, value: '' }] },
      lastOutput: { text: JSON.stringify({ game: '<!doctype html><html><head></head><body>play</body></html>' }), at: 2, source: 'run' as const } };
    const items = deliveredItems({ nodes: [art, gameClient('index.html'), page], edges: [] });
    expect(items.map(item => [item.nodeId, item.fieldId, item.kind])).toEqual([
      ['art', 'assets', 'document'], ['art', 'copy', 'document'],
      ['game', 'delivery', 'document'], ['game', 'preview', 'missing'], ['game', 'checks', 'document'],
      ['page', 'game', 'page'],
    ]);
    expect(items.find(item => item.kind === 'missing')?.claimed).toBe('index.html');
  });

  it('shows the index first in the 成果 view and opens the item picked from it', () => {
    cloud();
    const nodes = [gameClient('awwo-file:aAbCdEfGhIjKlMnOp')];
    render(<CanvasResults nodes={nodes} edges={[]} runs={{}} running={false} readOnly onOpenNode={vi.fn()} onBack={vi.fn()} />);
    const index = screen.getByRole('region', { name: '这张画布做出的全部成果' });
    expect(within(index).getAllByRole('listitem')).toHaveLength(3);
    expect(within(index).getByRole('link', { name: '下载「预览入口」' })).toHaveAttribute('href', expect.stringContaining('/tenants/tenant-a/artifacts/aAbCdEfGhIjKlMnOp'));
    fireEvent.click(within(index).getByRole('button', { name: /打开「游戏客户端（3D）」的「交互验证」/ }));
    expect(screen.getByRole('button', { name: '交互验证', pressed: true })).toBeInTheDocument();
  });
});

describe('editing a node’s inputs and deliverables from its template guide', () => {
  it('offers an edit action for each side and says the assistant can change them too', () => {
    const editInputs = vi.fn(); const editOutputs = vi.fn();
    render(<AgentTemplateDetails template={getAgentTemplate('materials')} onEditInputs={editInputs} onEditOutputs={editOutputs} />);
    fireEvent.click(screen.getByRole('button', { name: /编辑这个 Agent 需要准备的内容/ }));
    fireEvent.click(screen.getByRole('button', { name: /编辑这个 Agent 的交付/ }));
    expect(editInputs).toHaveBeenCalledOnce();
    expect(editOutputs).toHaveBeenCalledOnce();
    expect(screen.getByText(/这些是这个节点自己的输入和交付/)).toBeInTheDocument();
  });

  it('stays a read-only reference where nothing may change', () => {
    render(<AgentTemplateDetails template={getAgentTemplate('materials')} />);
    expect(screen.queryByRole('button', { name: /编辑/ })).toBeNull();
  });
});
