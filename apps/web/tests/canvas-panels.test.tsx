// Canvas panels (session-canvas rebuild): the four chrome surfaces plus the command bar.
//
// These tests pin the HONESTY invariants, not the pixels:
//   - a FAILED runtime-inventory fetch is said out loud, never rendered as an empty dropdown;
//   - no host inventory reader → runtime selection is hidden fail-closed;
//   - an UNKNOWN bind outcome persists on the NODE and keeps warning across a remount;
//   - inputs freeze while a bind is in flight (no stale-closure clobber window);
//   - a preflight problem NAMES the offending node and the run does not start;
//   - a blocked timeline row shows its REASON and elapsed comes from REAL stamps;
//   - search never implies it read a transcript it never loaded.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InspectorPanel } from '../src/canvas/InspectorPanel';
import { RunControls } from '../src/canvas/RunControls';
import { RunTimeline, type RunView } from '../src/canvas/RunTimeline';
import { CommandBar } from '../src/canvas/CommandBar';
import { createFormNode, createSessionNode, type FormNode, type SessionNode } from '../src/canvas/canvasDoc';
import type { NodeSession } from '../src/canvas/sessions';

const hireMock = vi.fn();
vi.mock('../src/canvasHire', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/canvasHire')>();
  return { ...orig, hireAgentIntoCompany: (...args: unknown[]) => hireMock(...args) };
});

function sessionNode(over: Partial<SessionNode> = {}): SessionNode {
  return {
    ...createSessionNode('coding', { x: 0, y: 0 }),
    id: 's1',
    title: '前端实现',
    runtime: 'claude_local',
    ...over,
  };
}

function formNode(over: Partial<FormNode> = {}): FormNode {
  return { ...createFormNode({ x: 0, y: 0 }), id: 'f1', ...over };
}

const COMPANIES = [{ id: 'c1', name: '测试公司' }];

function session(over: Partial<NodeSession> = {}): NodeSession {
  return { turns: [], streaming: false, status: null, history: 'unloaded', ...over };
}

beforeEach(() => {
  cleanup();
  hireMock.mockReset();
});

describe('InspectorPanel', () => {
  it('says out loud when the runtime inventory fetch fails (never a silent empty dropdown)', async () => {
    const readJson = vi.fn().mockRejectedValue(new Error('kernel down'));
    render(
      <InspectorPanel
        node={sessionNode()}
        liveCompanies={COMPANIES}
        apiBase="/paperclip-api"
        readJson={readJson}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/运行时清单加载失败/)).toBeTruthy();
  });

  it('hides runtime selection fail-closed when the host provides no inventory reader', () => {
    render(
      <InspectorPanel
        node={sessionNode()}
        liveCompanies={COMPANIES}
        apiBase="/paperclip-api"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/运行时清单不可用/)).toBeTruthy();
    expect(screen.queryByLabelText('Runtime')).toBeNull();
  });

  it('an UNKNOWN bind outcome persists bindAttempt on the node and warns durably', async () => {
    hireMock.mockResolvedValue({ outcome: 'unknown', detail: 'response lost' });
    const onSave = vi.fn();
    render(
      <InspectorPanel
        node={sessionNode()}
        liveCompanies={COMPANIES}
        apiBase="/paperclip-api"
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('绑定并创建真实 Agent'));
    await waitFor(() => expect(screen.getByText(/可能已创建，请刷新画布确认/)).toBeTruthy());
    const last = onSave.mock.calls.at(-1)![0] as SessionNode;
    expect(last.bindAttempt).toBe('unknown');
    expect(last.binding).toBeNull();
    expect(screen.getByText(/上次绑定结果未知/)).toBeTruthy();
    expect(screen.getByText(/重试绑定/)).toBeTruthy();
  });

  it('a node carrying bindAttempt=unknown warns on a FRESH mount (survives close/reopen/reload)', () => {
    render(
      <InspectorPanel
        node={sessionNode({ bindAttempt: 'unknown' })}
        liveCompanies={COMPANIES}
        apiBase="/paperclip-api"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/上次绑定结果未知/)).toBeTruthy();
    expect(screen.getByText(/重试绑定/)).toBeTruthy();
  });

  it('freezes every input while a bind is in flight (no stale-closure clobber window)', async () => {
    let resolveHire: (v: unknown) => void = () => {};
    hireMock.mockReturnValue(new Promise((r) => (resolveHire = r)));
    const onSave = vi.fn();
    render(
      <InspectorPanel
        node={sessionNode()}
        liveCompanies={COMPANIES}
        apiBase="/paperclip-api"
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('绑定并创建真实 Agent'));
    await waitFor(() => expect(screen.getByText('绑定中…')).toBeTruthy());
    expect((screen.getByLabelText('名称') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('人设 / 系统提示词') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText('绑定到公司') as HTMLSelectElement).disabled).toBe(true);
    resolveHire({ outcome: 'created', agentId: 'agent-1', status: 'idle' });
    await waitFor(() => expect(screen.getByText(/已绑定真实 Agent/)).toBeTruthy());
    const last = onSave.mock.calls.at(-1)![0] as SessionNode;
    expect(last.binding).toMatchObject({ companyId: 'c1', agentId: 'agent-1' });
    expect(last.bindAttempt).toBeNull();
  });

  it('binding is unavailable with an honest hint when no live company exists', () => {
    render(
      <InspectorPanel
        node={sessionNode()}
        liveCompanies={[]}
        apiBase="/paperclip-api"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/没有可用的 LIVE 公司/)).toBeTruthy();
    expect(screen.queryByText('绑定并创建真实 Agent')).toBeNull();
    // No host hand-off wired → the hint still explains, it just cannot navigate.
    expect(screen.queryByRole('button', { name: '去创建公司' })).toBeNull();
  });

  // The canvas creates no companies, so an empty world would dead-end on "go make a company"
  // with nowhere to go — the panel hands the user off to the surface that does.
  it('offers a hand-off to company creation when the host wires one', () => {
    const onCreateCompany = vi.fn();
    render(
      <InspectorPanel
        node={sessionNode()}
        liveCompanies={[]}
        apiBase="/paperclip-api"
        onSave={vi.fn()}
        onCreateCompany={onCreateCompany}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '去创建公司' }));
    expect(onCreateCompany).toHaveBeenCalledTimes(1);
  });

  it('never hires into a company that is no longer in the live list', async () => {
    hireMock.mockResolvedValue({ outcome: 'created', agentId: 'agent-9', status: 'idle' });
    const two = [
      { id: 'c1', name: '一号公司' },
      { id: 'c2', name: '二号公司' },
    ];
    const node = sessionNode();
    const { rerender } = render(
      <InspectorPanel
        node={node}
        liveCompanies={two}
        apiBase="/paperclip-api"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('绑定到公司'), { target: { value: 'c2' } });
    // c2 disappears (deleted / no longer LIVE) while the panel is open.
    rerender(
      <InspectorPanel
        node={node}
        liveCompanies={[two[0]]}
        apiBase="/paperclip-api"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('绑定并创建真实 Agent'));
    await waitFor(() => expect(hireMock).toHaveBeenCalled());
    expect(hireMock.mock.calls[0][1]).toBe('c1');
  });

  it('the form editor adds/edits fields and 保存 carries them through onSave', () => {
    const form = formNode();
    const onSave = vi.fn();
    render(
      <InspectorPanel
        node={form}
        liveCompanies={[]}
        apiBase="/paperclip-api"
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('＋ 添加字段'));
    const labelInputs = screen.getAllByLabelText(/字段 \d+ 名称/);
    expect(labelInputs.length).toBe(form.fields.length + 1);
    fireEvent.change(labelInputs.at(-1)!, { target: { value: '交付物' } });
    fireEvent.click(screen.getByText('保存'));
    const saved = onSave.mock.calls.at(-1)![0] as FormNode;
    expect(saved.fields.at(-1)!.label).toBe('交付物');
  });
});

describe('RunControls', () => {
  it('reports a preflight problem NAMING the unbound node and does not start the run', () => {
    const onStart = vi.fn();
    render(
      <RunControls
        nodes={[sessionNode({ title: '前端实现' })]}
        edges={[]}
        running={false}
        runs={{}}
        onStart={onStart}
        onStop={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('▶ 运行图'));
    expect(onStart).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('前端实现');
    expect(alert.textContent).toContain('未绑定');
  });

  it('starts the run when preflight is clean', () => {
    const onStart = vi.fn();
    const bound = sessionNode({ binding: { companyId: 'c1', agentId: 'a1', agentName: 'a' } });
    render(
      <RunControls nodes={[bound]} edges={[]} running={false} runs={{}} onStart={onStart} onStop={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('▶ 运行图'));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refusal never outlives the problem it named (the graph gets fixed → the message goes)', () => {
    const unbound = sessionNode({ id: 's1', title: '前端实现' });
    const bound = sessionNode({ id: 's1', title: '前端实现', binding: { companyId: 'c1', agentId: 'a1', agentName: 'a' } });
    const { rerender } = render(
      <RunControls nodes={[unbound]} edges={[]} running={false} runs={{}} onStart={vi.fn()} onStop={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('▶ 运行图'));
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(
      <RunControls nodes={[bound]} edges={[]} running={false} runs={{}} onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('counts live progress from real node states and summarises 成功/失败/被阻断 honestly', () => {
    const nodes = [sessionNode({ id: 's1' }), sessionNode({ id: 's2' }), sessionNode({ id: 's3' })];
    const { rerender } = render(
      <RunControls
        nodes={nodes}
        edges={[]}
        running
        runs={{ s1: { state: 'done' }, s2: { state: 'running' }, s3: { state: 'waiting' } }}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByText('运行中 · 1/3')).toBeTruthy();
    rerender(
      <RunControls
        nodes={nodes}
        edges={[]}
        running={false}
        runs={{ s1: { state: 'done' }, s2: { state: 'failed' }, s3: { state: 'blocked' } }}
        summary={{ ok: false, done: 1, failed: 1, blocked: 1, total: 3 }}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByText(/成功 1 · 失败 1 · 被阻断 1（共 3）/)).toBeTruthy();
  });
});

describe('RunTimeline', () => {
  it("shows a blocked row's REASON and computes elapsed from the recorded stamps", () => {
    const a = sessionNode({ id: 'a', title: '实现', runtime: 'claude_local', model: 'opus' });
    const b = sessionNode({ id: 'b', title: '审阅' });
    const absent = sessionNode({ id: 'not-in-run', title: '未参与本次运行' });
    const runStartedAt = 1_000;
    const runs: Record<string, RunView> = {
      a: { state: 'done', startedAt: runStartedAt, endedAt: runStartedAt + 65_000 },
      b: { state: 'blocked', detail: '上游未完成' },
    };
    render(
      <RunTimeline
        nodes={[a, b, absent]}
        runs={runs}
        runStartedAt={runStartedAt}
        now={runStartedAt + 70_000}
        onClose={vi.fn()}
      />,
    );
    const rowA = within(screen.getByTestId('runline-a'));
    expect(rowA.getByText('1:05')).toBeTruthy();
    expect(rowA.getByText('claude_local · opus')).toBeTruthy();
    const rowB = within(screen.getByTestId('runline-b'));
    // The reason replaces the generic chip — "被阻断" alone would hide WHY.
    expect(rowB.getByText('上游未完成')).toBeTruthy();
    // A node that never started draws no bar and reports no elapsed time.
    expect(rowB.getByText('—')).toBeTruthy();
    expect(rowB.getByText('上游未完成').getAttribute('title')).toBe('上游未完成');
    // The graph may contain scratch or out-of-scope nodes. Missing run state is absence of
    // participation, not evidence that the node was queued.
    expect(screen.queryByTestId('runline-not-in-run')).toBeNull();
  });

  it('localizes persisted recovery codes in the state detail', () => {
    const recovered = sessionNode({ id: 'recovered', title: '恢复节点' });
    render(
      <RunTimeline
        nodes={[recovered]}
        runs={{ recovered: { state: 'blocked', detail: 'recovery_not_dispatched' } }}
        runStartedAt={1_000}
        now={2_000}
        onClose={vi.fn()}
      />,
    );
    const badge = within(screen.getByTestId('runline-recovered')).getByText('页面中断前尚未下发。');
    expect(badge.getAttribute('title')).toBe('页面中断前尚未下发。');
  });
});

describe('CommandBar', () => {
  const noop = () => {};

  it('filters commands and Enter invokes the highlighted action', () => {
    const addForm = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandBar
        mode="commands"
        nodes={[formNode({ title: '需求表单' })]}
        actions={{ addForm, run: vi.fn(), fitAll: vi.fn() }}
        onFocusNode={noop}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '添加表单' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('添加表单节点');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(addForm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move the highlight and Enter runs THAT row', () => {
    const addForm = vi.fn();
    const fitAll = vi.fn();
    render(
      <CommandBar
        mode="commands"
        nodes={[]}
        actions={{ addForm, fitAll }}
        onFocusNode={noop}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(fitAll).toHaveBeenCalledTimes(1);
    expect(addForm).not.toHaveBeenCalled();
  });

  it('Escape closes, and the key listener is removed on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <CommandBar mode="commands" nodes={[]} actions={{ addForm: vi.fn() }} onFocusNode={noop} onClose={onClose} />,
    );
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers 停止 instead of 运行 while a run is in flight', () => {
    render(
      <CommandBar
        mode="commands"
        nodes={[]}
        actions={{ run: vi.fn(), stop: vi.fn() }}
        running
        onFocusNode={noop}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('停止运行')).toBeTruthy();
    expect(screen.queryByText('运行图')).toBeNull();
  });

  it('a row with nothing to act on is offered but inert — Enter and click both refuse it', () => {
    const deleteSelection = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandBar
        mode="commands"
        nodes={[]}
        actions={{ deleteSelection }}
        selectionCount={0}
        onFocusNode={noop}
        onClose={onClose}
      />,
    );
    const row = screen.getByTestId('cmdbar-row-delete');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain('没有选中的节点');
    // It is also never the drawn highlight, so Enter cannot fire it.
    expect(row.getAttribute('aria-selected')).toBe('false');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(row);
    expect(deleteSelection).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('search matches loaded transcript text and Enter focuses that tile', () => {
    const withHistory = sessionNode({ id: 's1', title: '实现' });
    const reader = (id: string): NodeSession =>
      id === 's1'
        ? session({ history: 'loaded', turns: [{ id: 1, role: 'agent', text: '已经完成了登录页的骨架' }] })
        : session();
    const onFocusNode = vi.fn();
    render(
      <CommandBar
        mode="search"
        nodes={[withHistory]}
        actions={{}}
        readSession={reader}
        onFocusNode={onFocusNode}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '登录页' } });
    expect(screen.getByText(/对话：.*登录页/)).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onFocusNode).toHaveBeenCalledWith('s1');
  });

  it('never implies it searched a transcript it did not load — it says so instead', () => {
    const loaded = sessionNode({ id: 's1', title: '实现', persona: '前端专家' });
    const notLoaded = sessionNode({ id: 's2', title: '实现二' });
    const broken = sessionNode({ id: 's3', title: '实现三' });
    const reader = (id: string): NodeSession => {
      if (id === 's1') return session({ history: 'loaded' });
      if (id === 's3') return session({ history: 'unreadable' });
      return session({ history: 'unloaded' });
    };
    render(
      <CommandBar
        mode="search"
        nodes={[loaded, notLoaded, broken]}
        actions={{}}
        readSession={reader}
        onFocusNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '实现' } });
    // 'not loaded yet' and 'could not be read' are reported as DIFFERENT facts.
    expect(screen.getByText(/1 个节点的对话尚未载入/)).toBeTruthy();
    expect(screen.getByText(/1 个节点的对话读取失败/)).toBeTruthy();
    // The row for the unread tile carries the note too, so a title match cannot read as
    // "searched everything about this tile".
    const row = screen.getByTestId('cmdbar-row-hit-s2');
    expect(row.textContent).toContain('对话尚未载入');
  });
});
