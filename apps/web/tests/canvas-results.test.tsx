import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasResults, type CanvasResultsProps } from '../src/canvas/CanvasResults';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { createSessionNode, emptyDocument, loadDocumentWithStatus, saveDocument, type CanvasEdge, type CanvasNode, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { resetAllSessions } from '../src/canvas/sessions';

const now = Date.now();
const page = '<!doctype html><html><head><title>狐狸邮差</title></head><body><h1>Saved game page</h1></body></html>';
function step(id: string, title: string, type: 'markdown' | 'html', output?: string, extra: Partial<NodeOutput> = {}): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id, title,
    contract: { version: 1, inputs: [], outputs: [{ id: 'result', label: `${title}交付`, type, required: true, value: '' }] },
    lastOutput: output === undefined ? null : { text: JSON.stringify({ result: output }), at: now - 120_000, source: 'run', ...extra } };
}
const wire = (from: string, to: string): CanvasEdge => ({ id: `${from}-${to}`, fromNode: from, fromPort: 'out:result', toNode: to, toPort: 'in:brief', dataType: 'text' });
const pipeline = (final = page): { nodes: CanvasNode[]; edges: CanvasEdge[] } => ({
  nodes: [step('design', '玩法与数值', 'markdown', '规格：三封信'), step('build', '可玩试玩关', 'html', final), step('review', '试玩验收', 'markdown', '**结论**：通过，跳跃手感正常。')],
  edges: [wire('design', 'build'), wire('build', 'review')],
});
const view = (props: Partial<CanvasResultsProps> = {}) => render(<CanvasResults {...pipeline()} runs={{}} running={false} readOnly={false}
  onOpenNode={vi.fn()} onBack={vi.fn()} onRun={vi.fn()} {...props} />);

beforeEach(() => { cleanup(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the 成果 view', () => {
  it('shows the result large in the sandboxed viewer, with where it came from and the steps that made it', () => {
    const receipt = vi.fn(() => <p>回执内容</p>);
    view({ receipt });
    const result = screen.getByRole('article', { name: '可玩试玩关' });
    expect(within(result).getByText('这张画布的成果')).toBeVisible();
    expect(within(result).getByRole('heading', { name: '可玩试玩关' })).toBeVisible();
    expect(within(result).getByText(/运行交付 · 2 分钟前交付 · 第 2 步，共 3 步/)).toBeVisible();
    const frame = within(result).getByTitle('可玩试玩关交付 · HTML 预览');
    // Static until the reader chooses to run it: no scripts, an opaque origin.
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame.getAttribute('srcdoc')).toContain('Saved game page');
    expect(frame.getAttribute('srcdoc')).toContain("script-src 'none'");
    // Nothing that edits a deliverable is offered here.
    expect(screen.queryByText('编辑交付表单')).toBeNull();
    expect(screen.queryByText('添加交付要求')).toBeNull();
    const steps = within(screen.getByRole('complementary', { name: '怎么做出来的' }));
    expect(steps.getAllByRole('button').map(button => button.textContent)).toEqual(['玩法与数值运行交付', '可玩试玩关成果运行交付', '试玩验收运行交付']);
    expect(receipt).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'build' }));
    expect(screen.getByText('回执内容')).toBeVisible();
  });

  it('shows the acceptance step as an agent’s check, never as a person’s sign-off', () => {
    view();
    const review = screen.getByRole('region', { name: '验收意见' });
    expect(within(review).getByText('由「试玩验收」这一步的 Agent 给出，不是人工签收。')).toBeVisible();
    expect(within(review).getByText('结论').tagName).toBe('STRONG');
    fireEvent.click(within(review).getByRole('button', { name: '查看「试玩验收」的交付' }));
    expect(screen.getByRole('article', { name: '试玩验收' })).toBeVisible();
  });

  it('opens any step’s delivery, returns to the result, and sends a step to the canvas when asked', () => {
    const onOpenNode = vi.fn();
    view({ onOpenNode });
    // Each step's name carries what its row shows: which step, whether it is the result, how it stands.
    expect(screen.getByRole('button', { name: '查看「可玩试玩关」的交付（成果 · 运行交付）' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '查看「玩法与数值」的交付（运行交付）' }));
    const opened = screen.getByRole('article', { name: '玩法与数值' });
    expect(within(opened).getByText('第 1 步的交付')).toBeVisible();
    expect(within(opened).getByText('规格：三封信')).toBeVisible();
    expect(screen.getByRole('button', { name: '查看「玩法与数值」的交付（运行交付）' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(opened).getByRole('button', { name: '在画布中打开' }));
    expect(onOpenNode).toHaveBeenCalledWith('design');
    fireEvent.click(within(opened).getByRole('button', { name: '回到成果' }));
    expect(screen.getByRole('article', { name: '可玩试玩关' })).toBeVisible();
  });

  it('calls a partial or hand-published result what it is, and never the canvas’s result while partial', () => {
    const { nodes, edges } = pipeline();
    const partial = nodes.map(node => node.id === 'build' ? { ...node, lastOutput: { ...(node as SessionNode).lastOutput!, partial: true } } : node);
    const { rerender } = render(<CanvasResults nodes={partial} edges={edges} runs={{}} running={false} readOnly={false} onOpenNode={vi.fn()} onBack={vi.fn()} />);
    // The complete step before the failed page is the one shown; the failed page still owes its delivery.
    expect(screen.getByRole('article', { name: '玩法与数值' })).toBeVisible();
    expect(screen.getByText('目前交付到的最远一步')).toBeVisible();
    expect(screen.getByText('还有 1 步没有交付')).toBeVisible();
    const onlyPartial = partial.map(node => node.id === 'design' ? { ...node, lastOutput: null } : node);
    rerender(<CanvasResults nodes={onlyPartial} edges={edges} runs={{}} running={false} readOnly={false} onOpenNode={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('article', { name: '可玩试玩关' })).toBeVisible();
    expect(screen.getByText(/部分结果 · /)).toBeVisible();
    expect(screen.getByText('目前交付到的最远一步')).toBeVisible();
    expect(screen.queryByText('这张画布的成果')).toBeNull();
    const manual = nodes.map(node => node.id === 'build' ? { ...node, lastOutput: { ...(node as SessionNode).lastOutput!, source: 'manual' as const } } : node);
    rerender(<CanvasResults nodes={manual} edges={edges} runs={{}} running={false} readOnly={false} onOpenNode={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText(/手动发布 · /)).toBeVisible();
    expect(screen.getByText('这张画布的成果')).toBeVisible();
  });

  it('calls a copied case’s recording the case’s, with the model and day it ran, never this canvas’s run', () => {
    const { nodes, edges } = pipeline();
    const at = Date.UTC(2026, 9, 3, 6, 0, 0);
    const copied = nodes.map(node => ({ ...node, lastOutput: { ...(node as SessionNode).lastOutput!, source: 'case' as const, model: 'qwen3.8-27b-p6', at } }));
    render(<CanvasResults nodes={copied} edges={edges} runs={{}} running={false} readOnly={false} onOpenNode={vi.fn()} onBack={vi.fn()} />);
    const result = screen.getByRole('article', { name: '可玩试玩关' });
    expect(within(result).getByText('案例实录的成果')).toBeVisible();
    expect(within(result).getByText(/^案例实录 · qwen3.8-27b-p6 · 2026-10-03 真实运行 · 第 2 步，共 3 步$/)).toBeVisible();
    expect(within(result).getByText('没有在你的工作区运行；运行整张图会换成你自己的结果')).toBeVisible();
    expect(screen.queryByText('这张画布的成果')).toBeNull();
    expect(screen.queryByText(/运行交付/)).toBeNull();
    expect(within(screen.getByRole('region', { name: '验收意见' })).getByText('来自「试玩验收」这一步的案例实录：由 Agent 给出，不是人工签收。')).toBeVisible();
  });

  it('says the result is only the furthest step so far while later steps have delivered nothing', () => {
    const nodes = [step('design', '玩法与数值', 'markdown', '规格'), step('build', '可玩试玩关', 'html')];
    render(<CanvasResults nodes={nodes} edges={[wire('design', 'build')]} runs={{}} running={false} readOnly={false} onOpenNode={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText('目前交付到的最远一步')).toBeVisible();
    expect(screen.getByText('还有 1 步没有交付')).toBeVisible();
    expect(screen.queryByText('这张画布的成果')).toBeNull();
    expect(screen.getByRole('button', { name: '查看「玩法与数值」的交付（目前最远 · 运行交付）' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看「可玩试玩关」的交付（还没有交付）' }));
    // A step with nothing yet is named by its number, not as a delivery.
    expect(within(screen.getByRole('article', { name: '可玩试玩关' })).getByText('第 2 步')).toBeVisible();
    expect(screen.getByText('这一步还没有交付。')).toBeVisible();
  });

  it('says an unfinished or hand-published acceptance check for what it is', () => {
    const { nodes, edges } = pipeline();
    const partial = nodes.map(node => node.id === 'review' ? { ...node, lastOutput: { ...(node as SessionNode).lastOutput!, partial: true } } : node);
    const { rerender } = render(<CanvasResults nodes={partial} edges={edges} runs={{}} running={false} readOnly={false} onOpenNode={vi.fn()} onBack={vi.fn()} />);
    const review = () => screen.getByRole('region', { name: '验收意见' });
    expect(within(review()).getByText('「试玩验收」这一步没有完成，留下的内容不是验收结论。')).toBeVisible();
    expect(within(review()).queryByText('结论')).toBeNull();
    const manual = nodes.map(node => node.id === 'review' ? { ...node, lastOutput: { ...(node as SessionNode).lastOutput!, source: 'manual' as const } } : node);
    rerender(<CanvasResults nodes={manual} edges={edges} runs={{}} running={false} readOnly={false} onOpenNode={vi.fn()} onBack={vi.fn()} />);
    expect(within(review()).getByText('在「试玩验收」这一步手动发布。')).toBeVisible();
    expect(within(review()).queryByText(/Agent/)).toBeNull();
  });

  it('shows the board’s notices (why a run did not start, what it is preparing) where they can be seen', () => {
    const onDismiss = vi.fn();
    const { rerender } = view({ notice: { kind: 'alert', text: '还有 1 个节点待配置', onDismiss } });
    expect(screen.getByRole('alert')).toHaveTextContent('还有 1 个节点待配置');
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    rerender(<CanvasResults {...pipeline()} runs={{}} running={false} readOnly={false} onOpenNode={vi.fn()} onBack={vi.fn()} notice={{ kind: 'status', text: '正在准备节点…' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在准备节点…');
  });

  it('invites a run when nothing has been delivered, and explains why it cannot run', () => {
    const onRun = vi.fn(); const onBack = vi.fn();
    const nodes = [step('design', '玩法与数值', 'markdown'), step('build', '可玩试玩关', 'html')];
    const { rerender } = render(<CanvasResults nodes={nodes} edges={[wire('design', 'build')]} runs={{}} running={false} readOnly={false} onOpenNode={vi.fn()} onBack={onBack} onRun={onRun} />);
    expect(screen.getByRole('heading', { name: '还没有成果' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行画布' }));
    expect(onRun).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '回到编排' }));
    expect(onBack).toHaveBeenCalledOnce();
    rerender(<CanvasResults nodes={nodes} edges={[wire('design', 'build')]} runs={{}} running={false} readOnly={false} runUnavailableReason="尚未连接执行引擎"
      onOpenNode={vi.fn()} onBack={onBack} onRun={onRun} />);
    expect(screen.getByRole('button', { name: '运行画布' })).toBeDisabled();
    expect(screen.getByText('尚未连接执行引擎')).toBeVisible();
    rerender(<CanvasResults nodes={nodes} edges={[wire('design', 'build')]} runs={{}} running={false} readOnly onOpenNode={vi.fn()} onBack={onBack} />);
    expect(screen.queryByRole('button', { name: '运行画布' })).toBeNull();
    expect(screen.getByText('成员运行这张画布后，成果会显示在这里。')).toBeVisible();
  });

  it('shows a run’s progress live without claiming anything about the result shown', () => {
    view({ running: true, runs: { design: { state: 'done' }, build: { state: 'running' }, review: { state: 'waiting' } } });
    expect(screen.getByRole('status')).toHaveTextContent('正在运行：已完成 1/3 步');
    const steps = within(screen.getByRole('complementary', { name: '怎么做出来的' }));
    expect(steps.getByRole('button', { name: '查看「可玩试玩关」的交付（成果 · 运行中）' })).toHaveTextContent('运行中');
    expect(steps.getByRole('button', { name: '查看「试玩验收」的交付（等待中）' })).toHaveTextContent('等待中');
  });
});

describe('the canvas with a 成果 view', () => {
  beforeEach(() => {
    resetAllSessions();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    saveDocument({ ...emptyDocument(), ...pipeline(), view: { x: 0, y: 0, scale: 1 } });
  });
  const viewSwitch = () => screen.queryByRole('group', { name: '画布视图' });

  it('switches between building and the results, keeping the board as it was underneath', () => {
    const onViewChange = vi.fn();
    const { container } = render(<CanvasSurface results={{ onViewChange }} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(within(viewSwitch()!).getByRole('button', { name: '成果' }));
    expect(onViewChange).toHaveBeenLastCalledWith('results');
    expect(screen.getByRole('region', { name: '画布成果' })).toBeVisible();
    expect(container.querySelector('.canvas-root')).toHaveAttribute('inert');
    expect(within(viewSwitch()!).getByRole('button', { name: '成果' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(viewSwitch()!).getByRole('button', { name: '编排' }));
    expect(onViewChange).toHaveBeenLastCalledWith('canvas');
    expect(screen.queryByRole('region', { name: '画布成果' })).toBeNull();
    expect(container.querySelector('.canvas-root')).not.toHaveAttribute('inert');
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(3);
  });

  it('pauses the board’s shortcuts under the results, so Delete cannot remove a node no one can see', async () => {
    render(<CanvasSurface results={{ initialView: 'results' }} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(screen.getByRole('region', { name: '画布成果' })).toBeVisible();
    fireEvent.click(within(viewSwitch()!).getByRole('button', { name: '编排' }));
    fireEvent.click(screen.getByRole('button', { name: '打开 玩法与数值' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(within(viewSwitch()!).getByRole('button', { name: '成果' }));
    fireEvent.keyDown(window, { key: 'Delete' });
    fireEvent.keyDown(window, { key: 'Backspace' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(loadDocumentWithStatus().doc.nodes).toHaveLength(3);
    // The same key on the board does delete the selected node: the pause is what kept it.
    fireEvent.click(within(viewSwitch()!).getByRole('button', { name: '编排' }));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
  });

  it('opens a step on the board from the results', () => {
    const { container } = render(<CanvasSurface results={{ initialView: 'results' }} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    fireEvent.click(within(screen.getByRole('article', { name: '可玩试玩关' })).getByRole('button', { name: '在画布中打开' }));
    expect(screen.queryByRole('region', { name: '画布成果' })).toBeNull();
    expect(container.querySelector('.canvas-tile--focus')).not.toBeNull();
  });

  it('leaves the results for the board when the canvas has no steps, so its shortcuts work', () => {
    saveDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 } });
    const onViewChange = vi.fn();
    const { container } = render(<CanvasSurface results={{ initialView: 'results', onViewChange }} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(screen.queryByRole('region', { name: '画布成果' })).toBeNull();
    expect(onViewChange).toHaveBeenCalledWith('canvas');
    expect(container.querySelector('.canvas-root')).not.toHaveAttribute('inert');
  });

  it('offers no 成果 view where the host has none (the desktop app)', () => {
    render(<CanvasSurface planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    expect(viewSwitch()).toBeNull();
  });
});
