import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CanvasAssistant, type CanvasAssistantProps } from '../src/canvas/CanvasAssistant';
import { canvasText } from '../src/canvas/i18n';

afterEach(cleanup);

function Harness(props: Partial<CanvasAssistantProps> = {}) {
  const [draft, setDraft] = useState(props.draft ?? '');
  return <CanvasAssistant mode="welcome" messages={[]} busy={false} onSend={() => {}} onCancel={() => {}}
    {...props} draft={draft} onDraftChange={value => { setDraft(value); props.onDraftChange?.(value); }} />;
}

describe('canvas assistant UI', () => {
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
    expect(screen.getByRole('status')).toHaveTextContent('正在生成画布');
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
