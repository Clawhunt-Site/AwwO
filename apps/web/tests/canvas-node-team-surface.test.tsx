import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { getNodeThreads } from '../src/canvas/nodeThreads';
import { resetAllSessions } from '../src/canvas/sessions';
import { canvasText, type CanvasTranslate } from '../src/canvas/i18n';
import { surfaceNotice } from '../src/canvas/surfaceMessages';

const runtimeReadJson = async (path: string) => path === '/api/agents'
  ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] }
  : { models: ['model-a', 'model-b'] };

beforeEach(() => {
  localStorage.clear(); resetAllSessions();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => new Response(JSON.stringify(
    String(input).endsWith('/companies') ? [{ id: 'company', name: 'Team workspace' }] : {},
  ), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { cleanup(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function seed(withTeam = false) {
  const node = (id: string, x: number): SessionNode => ({
    ...createSessionNode('llm', { x, y: 80 }), id, title: id, runtime: 'pi', model: 'model-a', persona: 'Existing node instructions',
    binding: { companyId: 'company', agentId: `agent-${id}`, agentName: id }, issueId: `session-${id}`,
    lastOutput: { text: `Previous ${id}`, source: 'run', at: 1 },
  });
  const first = node('Team task', 100);
  if (withTeam) first.team = createNodeTeam(first);
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [first, node('Downstream', 950), node('Unrelated', 1800)],
    edges: [{ id: 'team-downstream', fromNode: first.id, fromPort: 'result', toNode: 'Downstream', toPort: 'context', dataType: 'text' }],
    view: { x: 0, y: 0, scale: 1 },
  }));
  return first;
}

function stored() { return loadDocumentWithStatus().doc.nodes.find(node => node.id === 'Team task') as SessionNode; }
async function openInspector() {
  fireEvent.click(screen.getByRole('button', { name: '打开 Team task', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })).not.toBeDisabled());
}
async function save() {
  await waitFor(() => expect(screen.getByRole('button', { name: '保存', exact: true })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '保存', exact: true })).toBeNull());
}
function unchangedSession(initial: SessionNode) {
  expect(stored()).toMatchObject({ binding: initial.binding, issueId: initial.issueId, model: initial.model, persona: initial.persona, runtime: initial.runtime });
  expect(getNodeThreads(stored())).toHaveLength(1);
  expect(getNodeThreads(stored())[0].issueId).toBe(initial.issueId);
}
function invalidatedOnlyDependents() {
  expect(loadDocumentWithStatus().doc.nodes.map(node => node.lastOutput?.text ?? null)).toEqual([null, null, 'Previous Unrelated']);
}

describe('CanvasSurface team configuration persistence', () => {
  it('saves enabling a team through the real inspector and restores it after remount', async () => {
    const initial = seed(); const page = render(<CanvasSurface runtimeReadJson={runtimeReadJson} />);
    await openInspector(); fireEvent.click(screen.getByRole('checkbox', { name: '启用多 Agent 协作' }));
    await save();
    expect(stored().team).toMatchObject({ mode: 'sequential', runtime: 'pi', members: [expect.objectContaining({ model: 'model-a' }), expect.objectContaining({ model: '' })] });
    unchangedSession(initial); invalidatedOnlyDependents();
    page.unmount(); render(<CanvasSurface runtimeReadJson={runtimeReadJson} />); await openInspector();
    expect(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })).toBeChecked();
    expect(screen.getAllByRole('group', { name: /^Agent \d$/ })).toHaveLength(2);
    expect(within(screen.getByRole('group', { name: 'Agent 1' })).getByLabelText('专属指令')).toHaveValue(initial.persona);
  });

  it('persists member model and mode edits without losing the old binding or conversation and invalidates downstream results', async () => {
    const initial = seed(true); const originalIds = initial.team!.members.map(member => member.id);
    const page = render(<CanvasSurface runtimeReadJson={runtimeReadJson} />); await openInspector();
    const second = within(screen.getByRole('group', { name: 'Agent 2' }));
    await waitFor(() => expect(second.getByLabelText('模型')).not.toBeDisabled());
    fireEvent.change(second.getByLabelText('模型'), { target: { value: 'model-b' } });
    fireEvent.change(second.getByLabelText('职责'), { target: { value: 'Independent reviewer' } });
    fireEvent.change(screen.getByLabelText('协作方式'), { target: { value: 'review' } });
    fireEvent.change(screen.getByLabelText('最多轮数'), { target: { value: '3' } });
    await save();
    expect(stored().team).toMatchObject({ mode: 'review', maxRounds: 3, members: [expect.anything(), expect.objectContaining({ role: 'Independent reviewer', model: 'model-b' })] });
    expect(stored().team!.members.map(member => member.id)).toEqual(originalIds);
    unchangedSession(initial); invalidatedOnlyDependents();
    page.unmount(); render(<CanvasSurface runtimeReadJson={runtimeReadJson} />); await openInspector();
    expect(screen.getByLabelText('协作方式')).toHaveValue('review'); expect(screen.getByLabelText('最多轮数')).toHaveValue(3);
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Agent 2' })).getByLabelText('模型')).toHaveValue('model-b'));
  });

  it('persists disabling a team while keeping the original single-Agent configuration and conversation', async () => {
    const initial = seed(true); const page = render(<CanvasSurface runtimeReadJson={runtimeReadJson} />); await openInspector();
    fireEvent.click(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })); await save();
    expect(stored().team).toBeUndefined(); unchangedSession(initial); invalidatedOnlyDependents();
    page.unmount(); render(<CanvasSurface runtimeReadJson={runtimeReadJson} />); await openInspector();
    expect(screen.getByRole('checkbox', { name: '启用多 Agent 协作' })).not.toBeChecked();
    expect(screen.queryByRole('group', { name: 'Agent 1' })).toBeNull(); unchangedSession(initial);
  });

  it('uses a backend recovery completion notice without instructing a duplicate downstream run', () => {
    const translate = (locale: 'zh' | 'en'): CanvasTranslate => (key, values) => canvasText(locale, key, values);
    expect(surfaceNotice(translate('zh'), 'graph_recovery_complete')).toBe('已从后台恢复运行结果。');
    expect(surfaceNotice(translate('en'), 'graph_recovery_complete')).toBe('Run results restored from the background.');
    expect(surfaceNotice(translate('zh'), 'graph_recovery_pending')).toBe('任务正在后台执行，关闭页面后仍会继续。');
    expect(surfaceNotice(translate('en'), 'graph_recovery_pending')).toBe('The task is running in the background and will continue after you close this page.');
    expect(surfaceNotice(translate('en'), 'recovery_complete')).toContain('pending downstream');
  });
});
