import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ModelPersonaShelf, type ModelPersonaShelfProps } from '../src/canvas/ModelPersonaShelf';
import { LocaleProvider } from '../src/canvas/i18n';
import { groupModels, type ModelPaletteGroup, type ModelPaletteSelection } from '../src/canvas/modelPalette';

const model: ModelPaletteSelection = { key: 'pi:qwen-fixture', runtime: 'pi', model: 'qwen-fixture', label: 'Qwen fixture', providerGroup: 'clawhunt', available: true };
const groups: ModelPaletteGroup[] = [
  ...(['codex', 'claude', 'grok', 'gemini'] as const).map(id => ({ id, label: id, available: false, models: [], reason: '未配置' })),
  { id: 'clawhunt', label: 'ClawHunt · 平台模型', available: true, models: [model] },
];
function props(overrides: Partial<ModelPersonaShelfProps> = {}): ModelPersonaShelfProps {
  return { groups, loading: false, personaId: null, collapsed: false, onCollapsedChange: vi.fn(), onPersonaChange: vi.fn(),
    onAddModel: vi.fn(), onModelDragStart: vi.fn(), onOpenWorkspaceAgents: vi.fn(), onRetry: vi.fn(), ...overrides };
}
afterEach(cleanup);

describe('model and persona shelf', () => {
  it('shows the real model in its supplied group and all unavailable groups honestly', () => {
    render(<ModelPersonaShelf {...props()} />);
    expect(screen.getAllByText('未配置')).toHaveLength(4);
    const platform = screen.getByRole('region', { name: 'ClawHunt · 平台模型' });
    expect(within(platform).getByRole('button', { name: /添加 Qwen fixture/ })).toBeEnabled();
    expect(within(screen.getByRole('region', { name: 'codex' })).queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(8);
    expect(screen.getByRole('radio', { name: '无预设' })).toBeChecked();
  });

  it('passes identical model and independent persona for click and drag; preserves the workspace entry', () => {
    const p = props({ personaId: 'frontend' });
    render(<ModelPersonaShelf {...p} />);
    const card = screen.getByRole('button', { name: /添加 Qwen fixture/ });
    fireEvent.click(card);
    expect(p.onAddModel).toHaveBeenCalledWith(model, 'frontend');
    fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn() } });
    expect(p.onModelDragStart).toHaveBeenCalledWith(expect.anything(), model, 'frontend');
    fireEvent.click(screen.getByRole('radio', { name: '后端服务' }));
    expect(p.onPersonaChange).toHaveBeenCalledWith('backend');
    fireEvent.click(screen.getByRole('radio', { name: '无预设' }));
    expect(p.onPersonaChange).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: '已有工作区 Agent' }));
    expect(p.onOpenWorkspaceAgents).toHaveBeenCalledOnce();
  });

  it.each([{ disabled: true }, { loading: true }, { error: '目录读取失败' }])('gates stale model interactions for %j', override => {
    const p = props(override);
    render(<ModelPersonaShelf {...p} />);
    const card = screen.getByRole('button', { name: /添加 Qwen fixture/ });
    expect(card).toBeDisabled();
    expect(card).toHaveAttribute('draggable', 'false');
    fireEvent.click(card); fireEvent.dragStart(card);
    expect(p.onAddModel).not.toHaveBeenCalled();
    expect(p.onModelDragStart).not.toHaveBeenCalled();
  });

  it('gates individual unavailable models even when another model in the group is available', () => {
    const p = props({ groups: [{ ...groups[4], models: [{ ...model, available: false, reason: '执行服务不可用' }] }] });
    render(<ModelPersonaShelf {...p} />);
    const card = screen.getByRole('button', { name: /添加 Qwen fixture/ });
    expect(card).toBeDisabled(); expect(screen.getByText('执行服务不可用')).toBeVisible();
    fireEvent.dragStart(card); expect(p.onModelDragStart).not.toHaveBeenCalled();
  });

  it('exposes error recovery and an accessible collapse control without hidden tab stops', () => {
    const p = props({ error: '目录读取失败' }); const view = render(<ModelPersonaShelf {...p} />);
    expect(screen.getByRole('alert')).toHaveTextContent('目录读取失败');
    fireEvent.click(screen.getByRole('button', { name: '重试' })); expect(p.onRetry).toHaveBeenCalledOnce();
    const toggle = screen.getByRole('button', { name: '收起模型与人设' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle); expect(p.onCollapsedChange).toHaveBeenCalledWith(true);
    view.rerender(<ModelPersonaShelf {...p} collapsed />);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('button', { name: '展开模型与人设' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses native keyboard controls and localizes persona labels', () => {
    render(<LocaleProvider locale="en"><ModelPersonaShelf {...props({ onModelDragStart: undefined })} /></LocaleProvider>);
    const card = screen.getByRole('button', { name: /Add Qwen fixture/ });
    expect(card.tagName).toBe('BUTTON'); expect(card).toHaveAttribute('draggable', 'false');
    const preset = screen.getByRole('radio', { name: 'No preset' });
    expect(preset.tagName).toBe('INPUT'); expect(preset).toHaveAttribute('type', 'radio');
    expect(screen.getByRole('button', { name: 'Existing workspace Agents' })).toBeEnabled();
  });

  it('hosts one orchestration control above models and preserves its callback', () => {
    const onChange = vi.fn();
    render(<ModelPersonaShelf {...props({ orchestrationControls: <label>编排模型<select onChange={onChange}><option>Pi</option><option>Jev</option></select></label> })} />);
    const selector = screen.getByRole('combobox', { name: '编排模型' });
    const modelsHeading = screen.getByRole('heading', { name: '执行模型' });
    expect(selector.compareDocumentPosition(modelsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(selector, { target: { value: 'Jev' } }); expect(onChange).toHaveBeenCalledOnce();
  });

  it('locks persona and workspace mutations in a read-only canvas while collapse stays available', () => {
    const p = props({ disabled: true }); render(<ModelPersonaShelf {...p} />);
    screen.getAllByRole('radio').forEach(radio => expect(radio).toBeDisabled());
    fireEvent.click(screen.getByRole('radio', { name: '前端开发' }));
    fireEvent.click(screen.getByRole('button', { name: '已有工作区 Agent' }));
    expect(p.onPersonaChange).not.toHaveBeenCalled(); expect(p.onOpenWorkspaceAgents).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '收起模型与人设' })).toBeEnabled();
  });
});

it('keeps same-model personal connections visibly distinct and selects the intended credential alias', () => {
  const onAddModel = vi.fn();
  const entries = [
    { id: 'personal-a', name: 'gpt-5', label: 'gpt-5 · Work · openai / conn-a', runtime: 'openai-agents', provider: 'openai' },
    { id: 'personal-b', name: 'gpt-5', label: 'gpt-5 · Personal · openai / conn-b', runtime: 'openai-agents', provider: 'openai' },
  ];
  const groups = groupModels({ configured: true, available: true, models: entries, runtimes: [{ id: 'openai-agents', name: 'Agents', configured: true, available: true, supportsEffortSelection: false, tools: [] }] }, 'en');
  render(<LocaleProvider locale="en"><ModelPersonaShelf {...props({ groups, onAddModel })} /></LocaleProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Add gpt-5 · Personal · openai / conn-b · Agents' }));
  expect(onAddModel.mock.calls[0][0]).toMatchObject({ model: 'personal-b', label: entries[1].label });
  expect(screen.getByRole('button', { name: 'Add gpt-5 · Work · openai / conn-a · Agents' })).toBeEnabled();
});

it('offers model configuration without enabling unavailable models', () => {
  render(<ModelPersonaShelf {...props({ groups: groups.slice(0, 4), modelsOnly: true, configureModelsHref: '/?tenant=t&canvas=c&account=engines' })} />);
  expect(screen.getByText('当前没有可用模型。请检查个人连接或联系工作区管理员。')).toBeVisible();
  expect(screen.getByRole('link', { name: '配置我的模型连接 ↗' })).toHaveAttribute('href', '/?tenant=t&canvas=c&account=engines');
  expect(screen.queryByRole('button', { name: /添加/ })).toBeNull();
});
