import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CanvasAssistant, type CanvasAssistantProps, type UnifiedAssistant } from '../src/canvas/CanvasAssistant';
import { canvasText, LocaleProvider } from '../src/canvas/i18n';
import type { PlanProgress } from '../src/canvas/canvasPlanning';

const progress = (value: Partial<PlanProgress>): PlanProgress =>
  ({ stage: 'running', characters: 0, nodes: 0, edges: 0, reasoning: 0, attempt: 1, ...value });

afterEach(cleanup);

function Harness(props: Partial<CanvasAssistantProps> = {}) {
  const [draft, setDraft] = useState(props.draft ?? '');
  return <CanvasAssistant mode="welcome" messages={[]} busy={false} onSend={() => {}} onCancel={() => {}}
    {...props} draft={draft} onDraftChange={value => { setDraft(value); props.onDraftChange?.(value); }} />;
}

describe('canvas assistant UI', () => {
  it('keeps an unobserved accepted plan separate from a new draft and requires explicit recovery', () => {
    const send = vi.fn();
    const resume = vi.fn();
    const stop = vi.fn();
    render(<Harness draft="另一个还未发送的需求" onSend={send} recovery={{ prompt: '原来的销售周报任务', canResume: true,
      busy: false, onResume: resume, onStop: stop }} />);
    expect(screen.getByText('原来的销售周报任务')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveValue('另一个还未发送的需求');
    expect(screen.queryByRole('group', { name: '需求示例' })).toBeNull();
    expect(screen.getByRole('button', { name: '生成画布' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: '画布需求' }), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '继续接收这次规划' }));
    expect(resume).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '停止这次规划' }));
    expect(stop).toHaveBeenCalledOnce();
  });

  it('blocks recovery against a changed canvas while still allowing the original run to be stopped', () => {
    const resume = vi.fn();
    const stop = vi.fn();
    render(<Harness recovery={{ prompt: '原来的任务', canResume: false, busy: false, onResume: resume, onStop: stop }} />);
    expect(screen.getByRole('button', { name: '继续接收这次规划' })).toBeDisabled();
    expect(screen.getByText('画布已有改动。请先停止原规划，再根据当前画布重新生成。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '停止这次规划' }));
    expect(stop).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
  });

  it('announces the latest failure once beside the preserved input, keeping older history', () => {
    const message = '工作区运行额度已满';
    const messages = [{ id: 'old', role: 'assistant' as const, status: 'error' as const, content: '较早的错误' },
      { id: 'last', role: 'assistant' as const, status: 'error' as const, content: message }];
    const view = render(<Harness draft="保留需求" error={message} messages={messages} />);
    expect(screen.getAllByText(message)).toHaveLength(1);
    const input = screen.getByRole('textbox', { name: '画布需求' });
    expect(input).toHaveValue('保留需求');
    expect(input).toHaveAttribute('aria-describedby', screen.getByText(message).id);
    expect(screen.getByText('较早的错误')).toBeVisible();
    view.rerender(<Harness draft="保留需求" messages={messages} />);
    expect(screen.getByRole('log')).toHaveTextContent(message);
  });
  it('offers three requirement examples that only fill the welcome composer', () => {
    const send = vi.fn();
    render(<Harness onSend={send} />);
    expect(screen.getByRole('heading', { name: '想一起搭建什么？' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '生成画布' })).toBeDisabled();
    const examples = screen.getByRole('group', { name: '需求示例' }).querySelectorAll('button');
    expect(examples).toHaveLength(3);
    const example = canvasText('zh', 'assistant.exampleSaas');
    fireEvent.click(screen.getByRole('button', { name: example }));
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveValue(example);
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '生成画布' }));
    expect(send).toHaveBeenCalledOnce();
    expect(screen.queryByText('已更新画布')).toBeNull();
  });

  it('preserves the controlled draft and blocks empty or whitespace-only submissions', () => {
    const send = vi.fn();
    const change = vi.fn();
    render(<Harness onSend={send} onDraftChange={change} />);
    const input = screen.getByRole('textbox', { name: '画布需求' });
    fireEvent.change(input, { target: { value: '  \n ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '生成画布' }));
    expect(send).not.toHaveBeenCalled();
    expect(change).toHaveBeenLastCalledWith('  \n ');
    fireEvent.change(input, { target: { value: '第一行\n第二行' } });
    fireEvent.click(screen.getByRole('button', { name: '生成画布' }));
    expect(send).toHaveBeenCalledOnce();
    expect(input).toHaveValue('第一行\n第二行');
  });

  it('sends Enter only after composition, and leaves Shift+Enter for a newline', () => {
    const send = vi.fn();
    render(<Harness draft="做一个用户中心" onSend={send} />);
    const input = screen.getByRole('textbox', { name: '画布需求' });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps cancellation available while a request is busy and prevents resubmission', () => {
    const send = vi.fn();
    const cancel = vi.fn();
    render(<Harness draft="做一个看板" busy onSend={send} onCancel={cancel} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在提交需求');
    expect(screen.getByRole('button', { name: '生成画布' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: '画布需求' }), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('renders only supplied panel messages and their actual applied, stale or error states', () => {
    render(<Harness mode="panel" error="当前网关未连接" messages={[
      { id: 'u1', role: 'user', content: '增加用户系统' },
      { id: 'a1', role: 'assistant', content: '已加入用户系统节点及其连接。', status: 'applied' },
      { id: 'a2', role: 'assistant', content: '已有方案等待重新生成。', status: 'stale' },
      { id: 'a3', role: 'assistant', content: '请求返回了无法解析的字段。', status: 'error' },
    ]} />);
    expect(screen.getByRole('heading', { name: '画布助手' })).toBeTruthy();
    expect(screen.getByRole('log', { name: '画布对话' })).toHaveTextContent('增加用户系统');
    expect(screen.getByRole('status')).toHaveTextContent('已更新画布');
    expect(screen.getAllByRole('alert').map(item => item.textContent)).toEqual(expect.arrayContaining([
      '画布已有新改动，请重新生成', '请求返回了无法解析的字段。', '当前网关未连接',
    ]));
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveAttribute('placeholder', '描述你想调整的结构…');
    expect(screen.getByRole('button', { name: '修改画布' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: '需求示例' })).toBeNull();
  });

  it('shows one live status line that follows the stage the run reports, never a ratio', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Harness draft="做一个看板" busy />);
      const status = () => screen.getByRole('status');
      // Before the host reports anything, elapsed time alone proves the request is alive.
      expect(status()).toHaveTextContent('正在提交需求');
      expect(status()).toHaveTextContent('0 秒');
      act(() => { vi.advanceTimersByTime(5_000); });
      // Still unreported: the request is known only to be in flight, and the line says so.
      expect(status()).toHaveTextContent('正在等待规划服务响应');
      expect(status()).toHaveTextContent('5 秒');

      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'running' })} />);
      expect(status()).toHaveTextContent('模型正在构思整体结构');
      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'thinking', reasoning: 1200 })} />);
      expect(status()).toHaveTextContent('模型正在深度思考');
      expect(status()).toHaveTextContent('已思考 1200 字');
      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'streaming', characters: 820, reasoning: 1200 })} />);
      expect(status()).toHaveTextContent('正在写出方案');
      expect(status()).toHaveTextContent('820 字');
      // Reasoning is a thinking-stage fact; once writing starts the line is about the plan.
      expect(status()).not.toHaveTextContent('已思考');
      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'streaming', characters: 2345, nodes: 3, template: 'backend' })} />);
      expect(status()).toHaveTextContent('正在规划第 3 个节点：后端服务');
      expect(status()).toHaveTextContent('3 个节点');
      expect(status()).toHaveTextContent('2345 字');
      // An identifier the catalogue does not know is never shown as text.
      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'streaming', nodes: 4, template: 'unknown' })} />);
      expect(status()).toHaveTextContent('正在规划第 4 个节点');
      expect(status()).not.toHaveTextContent('unknown');
      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'streaming', characters: 3000, nodes: 4, edges: 2 })} />);
      expect(status()).toHaveTextContent('正在连接节点');
      expect(status()).toHaveTextContent('2 条连线');
      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'validating', characters: 3000, nodes: 4, edges: 2 })} />);
      expect(status()).toHaveTextContent('正在校验并应用方案');
      expect(status().textContent).not.toMatch(/%/);

      // A finished request must not leave a progress readout or a running clock behind.
      rerender(<Harness draft="做一个看板" busy={false} />);
      expect(screen.queryByRole('status')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('marks the four observed steps and exposes them as an accessible step count', () => {
    const { rerender } = render(<Harness draft="做一个看板" busy progress={progress({ stage: 'queued' })} />);
    const bar = () => screen.getByRole('progressbar');
    const states = () => [...bar().querySelectorAll('.awwo-assistant-step')].map(step =>
      step.classList.contains('is-done') ? 'done' : step.classList.contains('is-active') ? 'active' : 'pending');
    expect(bar()).toHaveAttribute('aria-valuemax', '4');
    expect(bar()).toHaveAttribute('aria-valuenow', '0');
    expect(bar()).toHaveAttribute('aria-valuetext', '第 1/4 步：提交');
    expect(states()).toEqual(['active', 'pending', 'pending', 'pending']);
    rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'thinking' })} />);
    expect(bar()).toHaveAttribute('aria-valuetext', '第 2/4 步：构思');
    rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'streaming', nodes: 1 })} />);
    expect(bar()).toHaveAttribute('aria-valuetext', '第 3/4 步：生成');
    expect(states()).toEqual(['done', 'done', 'active', 'pending']);
    rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'validating' })} />);
    expect(bar()).toHaveAttribute('aria-valuenow', '3');
    expect(states()).toEqual(['done', 'done', 'done', 'active']);
    // A retried plan starts its steps over, and says which attempt this is.
    rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'retrying', attempt: 2 })} />);
    expect(states()).toEqual(['active', 'pending', 'pending', 'pending']);
    expect(screen.getByRole('status')).toHaveTextContent('方案结构无效，正在自动重试一次');
  });

  it('keeps the retry visible for the whole second attempt', () => {
    render(<Harness draft="做一个看板" busy progress={progress({ stage: 'streaming', nodes: 1, characters: 90, attempt: 2 })} />);
    expect(screen.getByRole('status')).toHaveTextContent('第 2 次尝试');
  });

  it('says what a long stage usually means instead of repeating the same line', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Harness draft="做一个看板" busy progress={progress({ stage: 'running' })} />);
      const status = () => screen.getByRole('status');
      act(() => { vi.advanceTimersByTime(14_000); });
      expect(status()).not.toHaveTextContent('部分模型会先想清楚');
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(status()).toHaveTextContent('部分模型会先想清楚，再开始写出方案');
      // A new stage starts its own clock, so it never inherits the previous stage's hint.
      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'thinking' })} />);
      expect(status()).not.toHaveTextContent('部分模型会先想清楚');
      expect(status()).not.toHaveTextContent('思考结束后');
      act(() => { vi.advanceTimersByTime(21_000); });
      expect(status()).toHaveTextContent('思考结束后会立即开始写出方案');
      // Only a run that has reported nothing new for a while is told the wait may not end on its
      // own, and the line says for how long.
      act(() => { vi.advanceTimersByTime(8_000); });
      expect(status()).not.toHaveTextContent('没有新进展');
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(status()).toHaveTextContent('已 30 秒没有新进展，可继续等待，或取消后把需求拆小');
      // Any new report is progress: the stall hint goes, and the stage's own hint returns.
      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'thinking', reasoning: 40 })} />);
      expect(status()).not.toHaveTextContent('没有新进展');
      expect(status()).toHaveTextContent('思考结束后会立即开始写出方案');
    } finally { vi.useRealTimers(); }
  });

  it('never calls a run that keeps reporting, or a queue wait, a stall', () => {
    vi.useFakeTimers();
    try {
      // A plan that takes minutes but reports every second is progressing the whole time.
      const { rerender } = render(<Harness draft="做一个看板" busy progress={progress({ stage: 'streaming', characters: 1 })} />);
      const status = () => screen.getByRole('status');
      for (let second = 2; second <= 150; second++) {
        act(() => { vi.advanceTimersByTime(1_000); });
        rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'streaming', characters: second * 30, nodes: 5 })} />);
        expect(status()).not.toHaveTextContent('没有新进展');
      }
      expect(status()).toHaveTextContent('2 分 29 秒');
      expect(status()).not.toHaveTextContent('耗时较长');
      // Waiting for a runtime slot has its own explanation however long it lasts.
      rerender(<Harness draft="做一个看板" busy progress={progress({ stage: 'queued' })} />);
      act(() => { vi.advanceTimersByTime(90_000); });
      expect(status()).toHaveTextContent('正在等待空闲的执行资源');
      expect(status()).not.toHaveTextContent('没有新进展');
    } finally { vi.useRealTimers(); }
  });

  it('names the operation the plan is writing and the node it concerns', () => {
    const writing = (value: Partial<PlanProgress>) => progress({ stage: 'streaming', characters: 900, nodes: 5, template: 'review', ...value });
    const { rerender } = render(<Harness draft="做一个看板" busy progress={writing({ operation: 'add_node', nodes: 2, template: 'data', target: 'data' })} />);
    const status = () => screen.getByRole('status');
    expect(status()).toHaveTextContent('正在规划第 2 个节点：数据治理');
    // After the last node the model writes each node's input: the line follows it node by node
    // instead of staying on the last node it declared.
    rerender(<Harness draft="做一个看板" busy progress={writing({ operation: 'set_input', target: 'backend' })} />);
    expect(status()).toHaveTextContent('正在填写节点需求：后端服务');
    expect(status()).not.toHaveTextContent('正在规划第 5 个节点');
    expect(status()).toHaveTextContent('5 个节点');
    rerender(<Harness draft="做一个看板" busy progress={writing({ operation: 'set_input' })} />);
    expect(status()).toHaveTextContent('正在填写节点需求');
    expect(status()).not.toHaveTextContent('交付验收');
    for (const [operation, target, text] of [
      ['update_node', 'users', '正在调整节点：用户系统'], ['add_field', 'frontend', '正在调整节点字段：前端开发'],
      ['update_field', undefined, '正在调整节点字段'], ['remove_field', 'data', '正在调整节点字段：数据治理'],
      ['remove_node', undefined, '正在移除节点'], ['remove_node', 'materials', '正在移除节点：物料制作'],
      ['connect', undefined, '正在连接节点'], ['disconnect', undefined, '正在调整连线'],
      ['set_edge_kind', undefined, '正在调整连线'], ['set_execution', undefined, '正在设置执行方式'],
    ] as const) {
      rerender(<Harness draft="做一个看板" busy progress={writing({ operation, ...(target ? { target } : {}) })} />);
      expect(status()).toHaveTextContent(text);
    }
    // A host that reports no operation still gets the node-then-connection reading.
    rerender(<Harness draft="做一个看板" busy progress={writing({ nodes: 3, template: 'backend' })} />);
    expect(status()).toHaveTextContent('正在规划第 3 个节点：后端服务');
    rerender(<Harness draft="做一个看板" busy progress={writing({ edges: 2 })} />);
    expect(status()).toHaveTextContent('正在连接节点');
  });

  it('shows the last measured duration as an expectation', () => {
    render(<Harness draft="做一个看板" busy expectedSeconds={72} progress={progress({ stage: 'running' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('上次用时 1 分 12 秒');
  });

  it('reads the status in the document language', () => {
    render(<LocaleProvider locale="en"><Harness draft="Build a dashboard" busy expectedSeconds={45}
      progress={progress({ stage: 'streaming', nodes: 2, characters: 1500, template: 'data' })} /></LocaleProvider>);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Planning node 2: Data governance');
    expect(status).toHaveTextContent('2 nodes');
    expect(status).toHaveTextContent('1.5K characters');
    expect(status).toHaveTextContent('last took 45s');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Step 3 of 4: Write');
    cleanup();
    render(<LocaleProvider locale="en"><Harness draft="Build a dashboard" busy
      progress={progress({ stage: 'streaming', nodes: 5, characters: 2400, operation: 'set_input', target: 'backend' })} /></LocaleProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('Filling in inputs: ');
  });

  it('exposes close, undo and runtime controls only through the supplied callbacks and slot', () => {
    const close = vi.fn();
    const undo = vi.fn();
    const { rerender } = render(<Harness mode="panel" onClose={close} onUndo={undo} canUndo={false}
      runtimeControls={<label>运行方式<select aria-label="运行方式" defaultValue="runtime"><option value="runtime">本地 Agent</option></select></label>} />);
    expect(screen.getByRole('combobox', { name: '运行方式' })).toHaveValue('runtime');
    expect(screen.getByRole('button', { name: '撤销本次更改' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '关闭画布助手' }));
    expect(close).toHaveBeenCalledOnce();
    rerender(<Harness mode="panel" onUndo={undo} canUndo />);
    fireEvent.click(screen.getByRole('button', { name: '撤销本次更改' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '关闭画布助手' })).toBeNull();
  });
});

describe('one conversation where the host also does tasks', () => {
  const unified = (overrides: Partial<UnifiedAssistant> = {}): UnifiedAssistant =>
    ({ renderTask: id => <p>任务卡片 {id}</p>, ...overrides });

  it('has no mode to pick: one composer that sends, whatever the message turns out to be', () => {
    const send = vi.fn();
    const { rerender } = render(<Harness mode="panel" draft="做一个落地页" onSend={send} unified={unified()} />);
    expect(screen.queryByRole('group', { name: /模式/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '编排画布' })).toBeNull();
    expect(screen.queryByRole('button', { name: '直接执行' })).toBeNull();
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveAttribute('placeholder', '说出接下来想要的结果，或交给助手一件事…');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(send).toHaveBeenCalledOnce();
    rerender(<Harness key="welcome" draft="" unified={unified()} />);
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveAttribute('placeholder', '说出你想要的结果，助手会搭好画布，或直接替你完成…');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('says on each reply how it was handled, and draws a task where the server made one', () => {
    render(<Harness mode="panel" unified={unified()} messages={[
      { id: 'u1', role: 'user', content: '加一个审核节点', route: 'plan' },
      { id: 'a1', role: 'assistant', content: '已加入审核节点', status: 'applied', route: 'plan' },
      { id: 'u2', role: 'user', content: '写一封给客户的邮件', route: 'execute' },
      { id: 'a2', role: 'assistant', content: '', route: 'execute', taskId: 'task-1' },
    ]} />);
    const replies = [...document.querySelectorAll('.awwo-assistant-message--assistant')];
    expect(replies).toHaveLength(2);
    expect(replies[0]).toHaveTextContent('调整画布');
    expect(replies[0]).toHaveTextContent('已加入审核节点');
    expect(replies[1]).toHaveTextContent('直接执行');
    expect(replies[1]).toHaveTextContent('任务卡片 task-1');
    // The user's own messages carry no label.
    expect(screen.getByText('加一个审核节点').closest('li')).not.toHaveTextContent('调整画布');
  });

  // A customer's report (2026-10-16): a plan reply that only answered, with the canvas still empty, was labelled 调整画布.
  it('says a plan reply that left the canvas as it was is a reply, and keeps 调整画布 for one that changed or tried to', () => {
    render(<Harness mode="panel" unified={unified()} messages={[
      { id: 'u1', role: 'user', content: '做一个游戏', route: 'plan' },
      { id: 'a1', role: 'assistant', content: '想做什么类型的游戏？', route: 'plan' },
      { id: 'u2', role: 'user', content: '加一个审核节点', route: 'plan' },
      { id: 'a2', role: 'assistant', content: '已加入审核节点', status: 'applied', route: 'plan' },
      { id: 'a3', role: 'assistant', content: '画布已有新改动', status: 'stale', route: 'plan' },
    ]} />);
    const routes = [...document.querySelectorAll('.awwo-assistant-message--assistant .awwo-assistant-route')].map(chip => chip.textContent);
    expect(routes).toEqual(['回复 · 画布没有改动', '调整画布', '调整画布']);
  });

  it('shows a message being routed as pending, says so, and lets that be stopped', () => {
    const cancel = vi.fn();
    render(<Harness mode="panel" draft="" onCancel={cancel} unified={unified({ pending: { id: 'p', prompt: '做一个落地页', phase: 'routing' } })} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在判断怎么处理');
    expect(document.querySelector('.awwo-assistant-message--user.is-pending')).toHaveTextContent('做一个落地页');
    expect(screen.getByRole('textbox', { name: '画布需求' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([['starting', '正在创建任务'], ['stopping', '正在停止任务']] as const)('says a message is %s, with nothing to cancel meanwhile', (phase, headline) => {
    // Even in the welcome, which otherwise shows no conversation until there is one.
    render(<Harness draft="" unified={unified({ pending: { id: 'p', prompt: '写一封邮件', phase } })} />);
    expect(screen.getByRole('status')).toHaveTextContent(headline);
    expect(document.querySelector('.is-pending')).toHaveTextContent('写一封邮件');
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(screen.getByRole('textbox', { name: '画布需求' })).toBeDisabled();
  });

  it('gives the focus back to the box once a message has been handled, and takes it from nothing else', () => {
    const pending = unified({ pending: { id: 'p', prompt: '写一封邮件', phase: 'starting' } });
    const { rerender } = render(<Harness mode="panel" onClose={() => {}} draft="" unified={pending} />);
    (document.activeElement as HTMLElement | null)?.blur();
    rerender(<Harness mode="panel" onClose={() => {}} draft="" unified={unified()} />);
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveFocus();
    rerender(<Harness mode="panel" onClose={() => {}} draft="" unified={pending} />);
    screen.getByRole('button', { name: '关闭画布助手' }).focus();
    rerender(<Harness mode="panel" onClose={() => {}} draft="" unified={unified()} />);
    expect(screen.getByRole('button', { name: '关闭画布助手' })).toHaveFocus();
  });

  it('draws the host’s notices above the composer and the model in its toolbar, with nothing under the box', () => {
    render(<Harness mode="panel" unified={unified({ notices: <p>任务服务提示</p>, settings: <p>直接执行用的模型</p> })} />);
    const form = screen.getByRole('form', { name: '画布需求表单' });
    const before = (node: Node, other: Node) => Boolean(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByText('任务服务提示'), form)).toBe(true);
    // In the toolbar, after the box and beside the attach button, like a chat app's model switch.
    const model = screen.getByText('直接执行用的模型');
    expect(form.contains(model)).toBe(true);
    expect(before(screen.getByRole('textbox', { name: '画布需求' }), model)).toBe(true);
    expect(model.closest('.awwo-assistant-composer-tools')).not.toBeNull();
    // The data notice is no longer printed under the box: it is the box's description and a line in 用户须知.
    expect(screen.queryByText('AI 内容仅供参考 · 勿输入敏感信息')).toBeNull();
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveAccessibleDescription(/请勿输入身份证号/);
    fireEvent.click(screen.getByRole('button', { name: '用户须知' }));
    expect(within(screen.getByRole('region', { name: '用户须知' })).getByText(/请勿输入身份证号/)).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: '用户须知' })).toBeNull();
    expect(screen.getByRole('button', { name: '用户须知' })).toHaveFocus();
  });

  it('keeps an earlier plan’s recovery waiting while a message is handled', () => {
    render(<Harness mode="panel" recovery={{ prompt: '原来的需求', canResume: true, busy: false, onResume: () => {}, onStop: () => {} }}
      unified={unified({ pending: { id: 'p', prompt: '写一封邮件', phase: 'routing' } })} />);
    expect(screen.getByRole('button', { name: '继续接收这次规划' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '停止这次规划' })).toBeDisabled();
  });

  it('says how messages are handled while one way is closed', () => {
    render(<Harness mode="panel" unified={unified({ notice: '暂时不能调整画布，消息会作为任务直接执行。' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('暂时不能调整画布，消息会作为任务直接执行。');
  });

  it('says how a reply was handled without offering a way to pick by hand', () => {
    const messages = [{ id: 'u', role: 'user' as const, content: '写一封给客户的邮件', route: 'plan' as const },
      { id: 'a', role: 'assistant' as const, content: '画布不需要改动', route: 'plan' as const }];
    render(<Harness mode="panel" messages={messages} unified={unified()} />);
    expect(screen.getByText('回复 · 画布没有改动')).toBeVisible();
    expect(screen.queryByRole('button', { name: /改为/ })).toBeNull();
  });

  it('draws the host’s earlier tasks and notices, and only the conversation where it is read-only', () => {
    const { rerender } = render(<Harness mode="panel" unified={unified({ earlier: <p>之前的任务</p>, notices: <p>任务服务提示</p>, settings: <p>直接执行用的模型</p> })} />);
    expect(screen.getByText('之前的任务')).toBeVisible();
    expect(screen.getByText('直接执行用的模型')).toBeVisible();
    expect(screen.getByText('说出画布上想调整的地方，或交给助手一件事。')).toBeVisible();
    rerender(<Harness mode="panel" unified={unified({ earlier: <p>之前的任务</p>, notices: <p>任务服务提示</p>, settings: <p>直接执行用的模型</p>, readOnly: true })} />);
    expect(screen.getByText('之前的任务')).toBeVisible();
    expect(screen.queryByText('直接执行用的模型')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '画布需求' })).toBeNull();
    expect(screen.getByText('只读访问：可以查看这张画布的任务。')).toBeVisible();
    // A viewer sends nothing, so nothing invites a message.
    expect(screen.queryByText('说出画布上想调整的地方，或交给助手一件事。')).toBeNull();
  });

  it('stays a planning assistant where the host cannot do tasks', () => {
    const { rerender } = render(<Harness mode="panel" draft="x" messages={[{ id: 'a', role: 'assistant', content: '好的', route: 'plan' }]} />);
    expect(screen.getByRole('button', { name: '修改画布' })).toBeEnabled();
    expect(document.querySelector('.awwo-assistant-route')).toBeNull();
    rerender(<Harness draft="x" />);
    expect(screen.getByRole('button', { name: '生成画布' })).toBeEnabled();
  });
});
