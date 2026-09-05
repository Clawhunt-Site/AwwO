import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, loadDocumentWithStatus, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { edgeBezierPath } from '../src/canvas/ports';
import { resetAllSessions } from '../src/canvas/sessions';

function seed(): CanvasDocument {
  const node = (id: string, title: string, x: number): SessionNode => ({
    ...createSessionNode('coding', { x, y: 80 }), id, title, w: 700, h: 460,
    activeThreadId: 'default',
    threads: [{ id: 'default', title: 'Session 1', issueId: null, preview: '', draft: `${title}的未发送草稿`, createdAt: 1 }],
  });
  return {
    version: 2, updatedAt: 1, nodes: [node('a', '甲', 100), node('b', '乙', 950)],
    edges: [{ id: 'a-b', fromNode: 'a', fromPort: 'result', toNode: 'b', toPort: 'context', dataType: 'text' }],
    waypoints: [], view: { x: 0, y: 0, scale: 1 },
  };
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
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});

describe('progressive node disclosure', () => {
  it('opens one workbench at a time and preserves saved geometry and Session drafts when collapsed', () => {
    const original = loadDocumentWithStatus().doc.nodes;
    render(<CanvasSurface />);
    expect(screen.queryAllByTestId('composer-input')).toHaveLength(0);
    expect(screen.queryAllByRole('navigation', { name: 'Session 管理' })).toHaveLength(0);
    expect(screen.queryByRole('region', { name: '交付物' })).toBeNull();
    for (const id of ['a', 'b']) expect(screen.getByTestId(`canvas-tile-${id}`)).toHaveStyle({ width: '260px', height: '128px' });

    fireEvent.click(screen.getByRole('button', { name: '打开 甲', exact: true }));
    expect(screen.getAllByTestId('composer-input')).toHaveLength(1);
    expect(within(screen.getByTestId('canvas-tile-a')).getByTestId('composer-input')).toHaveValue('甲的未发送草稿');
    expect(screen.getAllByRole('navigation', { name: 'Session 管理' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '打开 乙', exact: true }));
    expect(screen.getAllByTestId('composer-input')).toHaveLength(1);
    expect(within(screen.getByTestId('canvas-tile-b')).getByTestId('composer-input')).toHaveValue('乙的未发送草稿');
    expect(screen.getByTestId('canvas-tile-a')).toHaveStyle({ width: '260px', height: '128px' });
    fireEvent.click(screen.getByRole('button', { name: '收起节点', exact: true }));
    expect(screen.queryAllByTestId('composer-input')).toHaveLength(0);
    expect(loadDocumentWithStatus().doc.nodes).toEqual(original);
  });

  it('keeps wire endpoints on the visible compact or opened node borders without rewriting stored sizes', () => {
    render(<CanvasSurface />);
    const compactPath = edgeBezierPath({ x: 360, y: 144 }, { x: 950, y: 144 });
    expect(screen.getByTestId('canvas-wire-a-b')).toHaveAttribute('d', compactPath);
    const outputPort = within(screen.getByTestId('canvas-tile-a')).getByRole('button', { name: /输出端口 result/ });
    expect(outputPort).toHaveStyle({ left: '260px', top: '64px' });

    fireEvent.click(screen.getByRole('button', { name: '打开 甲', exact: true }));
    expect(screen.getByTestId('canvas-wire-a-b')).toHaveAttribute('d', edgeBezierPath({ x: 800, y: 310 }, { x: 950, y: 144 }));
    expect(outputPort).toHaveStyle({ left: '700px', top: '230px' });
    fireEvent.click(screen.getByRole('button', { name: '收起节点', exact: true }));
    expect(screen.getByTestId('canvas-wire-a-b')).toHaveAttribute('d', compactPath);
    expect(loadDocumentWithStatus().doc.nodes.map(node => ({ w: node.w, h: node.h }))).toEqual([{ w: 700, h: 460 }, { w: 700, h: 460 }]);
  });

  it('arranges only positions and restores them with a single undo while retaining contracts, deliveries and Sessions', () => {
    const document = seed();
    document.nodes = document.nodes.map(node => ({
      ...node,
      contract: {
        version: 1, inputs: [{ id: 'context', label: '需求', type: 'text', required: true, value: '保留输入' }],
        outputs: [{ id: 'result', label: '交付', type: 'markdown', required: true, value: '## 保留输出草稿' }],
      },
      lastOutput: { text: '{"result":"## 已发布交付"}', source: 'manual', at: 2 },
    }));
    document.edges = document.edges.map(edge => ({ ...edge, fromPort: 'out:result', toPort: 'in:context' }));
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(document));
    const original = loadDocumentWithStatus().doc;
    const positions = (nodes: typeof original.nodes) => nodes.map(({ id, x, y }) => ({ id, x, y }));
    const contents = (nodes: typeof original.nodes) => nodes.map(({ x: _x, y: _y, ...content }) => content);
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: '整理布局', exact: true }));
    const arranged = loadDocumentWithStatus().doc;
    expect(positions(arranged.nodes)).not.toEqual(positions(original.nodes));
    expect(contents(arranged.nodes)).toEqual(contents(original.nodes));
    expect(arranged.edges).toEqual(original.edges);

    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    const restored = loadDocumentWithStatus().doc;
    expect(positions(restored.nodes)).toEqual(positions(original.nodes));
    expect(restored.edges).toEqual(original.edges);
    expect(screen.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  });
});
