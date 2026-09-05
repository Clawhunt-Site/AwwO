import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TilePorts, type WiringApi } from '../src/canvas/TilePorts';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';

afterEach(cleanup);
function node(): SessionNode {
  return { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'frontend', w: 400, h: 420,
    contract: { version: 1,
      inputs: [{ id: 'private_input_id', label: '用户需求与交互说明', type: 'markdown', required: true, value: '' }],
      outputs: [{ id: 'private_output_id', label: '前端页面', type: 'file', required: true, value: '' }],
    },
  };
}
function wiring(): WiringApi {
  return { pendingPort: null, wireDrag: null, interactive: true, wireCount: () => 0,
    clearPending: vi.fn(), onPortPointerDown: vi.fn(), onPortClick: vi.fn() };
}

describe('contract port labels', () => {
  it('names contract ports with their field labels, while retaining stable wiring ids', () => {
    render(<TilePorts node={node()} wiring={wiring()} />);
    const input = screen.getByRole('button', { name: '输入端口 用户需求与交互说明（文本），未连接' });
    const output = screen.getByRole('button', { name: '输出端口 前端页面（文件引用），未连接' });
    expect(input.getAttribute('title')).toBe('用户需求与交互说明 · 文本');
    expect(input.dataset.portId).toBe('in:private_input_id');
    expect(output.dataset.portId).toBe('out:private_output_id');
    expect(screen.getByText('前端页面')).toBeTruthy();
    expect(input.getAttribute('aria-label')).not.toContain('private_input_id');
  });

  it('keeps labels outside the original handle and expands their readable text on focus', () => {
    render(<TilePorts node={node()} wiring={wiring()} />);
    const input = screen.getByRole('button', { name: /输入端口 用户需求/ });
    const label = screen.getByText('用户需求与交互说明');
    expect(label.style.position).toBe('absolute');
    expect(label.style.pointerEvents).toBe('none');
    expect(label.style.maxWidth).toBe('72px');
    expect(input.style.left).toBe('0px');
    expect(input.style.top).toBe('210px');
    fireEvent.focus(input);
    expect(label.style.maxWidth).toBe('220px');
    fireEvent.blur(input);
    expect(label.style.maxWidth).toBe('72px');
  });

  it('passes the original port spec through both gesture handlers', () => {
    const controls = wiring();
    render(<TilePorts node={node()} wiring={controls} />);
    const output = screen.getByRole('button', { name: /输出端口 前端页面/ });
    fireEvent.pointerDown(output, { button: 0, pointerId: 1 });
    fireEvent.click(output);
    expect(controls.onPortPointerDown).toHaveBeenCalledWith('frontend', expect.objectContaining({ id: 'out:private_output_id', dataType: 'file' }), expect.anything());
    expect(controls.onPortClick).toHaveBeenCalledWith('frontend', expect.objectContaining({ id: 'out:private_output_id', dataType: 'file' }), expect.anything());
  });
});
