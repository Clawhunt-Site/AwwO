import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { InspectorPanel, type InspectorPanelProps } from '../src/canvas/InspectorPanel';
import { createSessionNode, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';

// 多人同屏: the Configure panel while its node changes elsewhere (inspectorMerge.ts): fields the person has not changed
// follow, a field both changed asks 「保留我的 / 用对方的」 before anything is saved, and a save writes only the person's own
// changes; a bind writes what it hired the Agent with.

const hire = vi.fn();
vi.mock('../src/canvasHire', async original => ({
  ...await original<typeof import('../src/canvasHire')>(),
  hireAgentIntoCompany: (...args: unknown[]) => hire(...args),
}));

const opened = (): SessionNode => ({ ...createSessionNode('coding', { x: 0, y: 0 }), id: 'frontend', title: '前端', runtime: 'claude_local', persona: '遵守项目约定' });
const props = (node: CanvasNode, onSave: InspectorPanelProps['onSave']): InspectorPanelProps => ({
  node, liveCompanies: [{ id: 'company', name: '项目团队' }], apiBase: '/paperclip-api', onSave, onBound: vi.fn(), onClose: vi.fn(),
});
const persona = () => screen.getByRole('textbox', { name: '人设 / 系统提示词' });
const name = () => screen.getByRole('textbox', { name: '名称' });
const conflicts = () => screen.queryByRole('group', { name: '这些设置在别处也被改了' });
const saveButton = () => screen.getByRole('button', { name: '保存', exact: true });

beforeEach(() => { hire.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the Configure panel with others on the canvas', () => {
  it('follows a field changed elsewhere while it is open, and saves only the person’s own change over it', () => {
    const onSave = vi.fn();
    const node = opened();
    const view = render(<InspectorPanel {...props(node, onSave)} />);
    fireEvent.change(persona(), { target: { value: '只改样式' } });
    view.rerender(<InspectorPanel {...props({ ...node, title: '前端（成员改名）', model: 'member-model' }, onSave)} />);
    expect(name()).toHaveValue('前端（成员改名）');
    expect(persona()).toHaveValue('只改样式');
    expect(conflicts()).toBeNull();
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: '前端（成员改名）', model: 'member-model', persona: '只改样式' });
  });

  it('keeps a change that came in under a keystroke made after it', () => {
    const onSave = vi.fn();
    const node = opened();
    const view = render(<InspectorPanel {...props(node, onSave)} />);
    // The panel's input still holds the render from before the member's rename when the person types in the persona.
    const stale = persona();
    view.rerender(<InspectorPanel {...props({ ...node, title: '前端（成员改名）' }, onSave)} />);
    fireEvent.change(stale, { target: { value: '只改样式' } });
    expect(name()).toHaveValue('前端（成员改名）');
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: '前端（成员改名）', persona: '只改样式' });
  });

  it('asks about a field both changed, saves nothing until answered, and takes the other value on 用对方的', () => {
    const onSave = vi.fn();
    const node = opened();
    const view = render(<InspectorPanel {...props(node, onSave)} />);
    fireEvent.change(persona(), { target: { value: '只改样式' } });
    view.rerender(<InspectorPanel {...props({ ...node, persona: '只改逻辑' }, onSave)} />);
    expect(persona()).toHaveValue('只改样式');
    expect(conflicts()).toHaveTextContent('人设在别处也被改了，与你的修改不同。');
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute('title', '请先在上方选择保留哪一个修改');
    expect(screen.getByRole('button', { name: '绑定并创建真实 Agent' })).toBeDisabled();
    fireEvent.click(within(conflicts()!).getByRole('button', { name: '用对方的人设' }));
    expect(persona()).toHaveValue('只改逻辑');
    expect(conflicts()).toBeNull();
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0]).toMatchObject({ persona: '只改逻辑' });
  });

  it('keeps the person’s value on 保留我的 and saves it over the other one', () => {
    const onSave = vi.fn();
    const node = opened();
    const view = render(<InspectorPanel {...props(node, onSave)} />);
    fireEvent.change(persona(), { target: { value: '只改样式' } });
    const theirs = { ...node, persona: '只改逻辑' };
    view.rerender(<InspectorPanel {...props(theirs, onSave)} />);
    fireEvent.click(within(conflicts()!).getByRole('button', { name: '保留我的人设' }));
    expect(conflicts()).toBeNull();
    // A later change elsewhere still comes in; the kept field stays the person's.
    view.rerender(<InspectorPanel {...props({ ...theirs, title: '前端 v2' }, onSave)} />);
    expect(name()).toHaveValue('前端 v2');
    expect(persona()).toHaveValue('只改样式');
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: '前端 v2', persona: '只改样式' });
  });

  it('saves a bound node with what its Agent was hired with, though the model changed elsewhere during the hire', async () => {
    let finish!: (outcome: unknown) => void;
    hire.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    const onSave = vi.fn();
    const node = { ...opened(), model: 'model-a', persona: '' };
    const view = render(<InspectorPanel {...props(node, onSave)} />);
    fireEvent.click(screen.getByRole('button', { name: '绑定并创建真实 Agent' }));
    expect(hire).toHaveBeenCalledWith('/paperclip-api', 'company', expect.objectContaining({ model: 'model-a' }));
    // While the hire is out, someone switches the node's model.
    view.rerender(<InspectorPanel {...props({ ...node, model: 'model-b' }, onSave)} />);
    finish({ outcome: 'created', agentId: 'agent-1', status: 'idle' });
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0]).toMatchObject({ model: 'model-a', binding: { companyId: 'company', agentId: 'agent-1' } });
  });
});
