import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    clearPending: vi.fn(), cancelWiring: vi.fn(), onPortPointerDown: vi.fn(), onPortClick: vi.fn() };
}

describe('contract port labels', () => {
  it('names contract ports with their field labels, while retaining stable wiring ids', () => {
    render(<TilePorts node={node()} wiring={wiring()} />);
    const input = screen.getByRole('button', { name: '输入端口 用户需求与交互说明（文本），未连接' });
    const output = screen.getByRole('button', { name: '输出端口 前端页面（文件），未连接' });
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
    expect(label.style.maxWidth).toBe('96px');
    expect(input.style.left).toBe('0px');
    expect(input.style.top).toBe('210px');
    fireEvent.focus(input);
    expect(label.style.maxWidth).toBe('220px');
    fireEvent.blur(input);
    expect(label.style.maxWidth).toBe('96px');
  });

  it('moves a label inside the tile while the stage has no room for it beside its port at the tile\'s zoom, and back once it has', () => {
    const observers: { callback: IntersectionObserverCallback; init: IntersectionObserverInit; targets: Element[] }[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      readonly root: Element | null;
      private readonly entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback, init: IntersectionObserverInit) {
        this.root = (init.root as Element) ?? null;
        this.entry = { callback, init, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve(target: Element) { this.entry.targets = this.entry.targets.filter(item => item !== target); }
      disconnect() { this.entry.targets = []; }
    });
    try {
      const stage = document.createElement('div');
      stage.className = 'canvas-root';
      document.body.appendChild(stage);
      const { rerender } = render(<TilePorts node={node()} wiring={wiring()} />, { container: stage });
      const input = screen.getByRole('button', { name: /输入端口 用户需求/ });
      const output = screen.getByRole('button', { name: /输出端口 前端页面/ });
      const inputLabel = screen.getByText('用户需求与交互说明');
      const outputLabel = screen.getByText('前端页面');
      const watching = (port: Element) => observers.find(item => item.targets.includes(port))!;
      const left = watching(input);
      expect(left.init.root).toBe(stage);
      expect(left.init.rootMargin).toBe('0px 0px 0px -120px');
      expect(watching(output).init.rootMargin).toBe('0px -120px 0px 0px');
      expect(inputLabel.style.right).toBe('18px');
      const report = (observer: (typeof observers)[number], ratio: number) => act(() => observer.callback(
        [{ target: input, intersectionRatio: ratio } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
      report(left, 0.4);
      expect(inputLabel.style.left).toBe('18px');
      expect(inputLabel.style.right).toBe('');
      expect(outputLabel.style.left).toBe('18px');
      report(left, 1);
      expect(inputLabel.style.right).toBe('18px');
      // The label is drawn in the tile's own pixels, so at a zoom of 1.25 it takes 1.25 times its room on screen: the
      // handles move to new observers with that margin, and a render at the same zoom keeps them.
      rerender(<TilePorts node={node()} wiring={wiring()} scale={1.25} />);
      const zoomed = watching(input);
      expect(zoomed).not.toBe(left);
      expect(left.targets).toEqual([]);
      expect(zoomed.init.rootMargin).toBe('0px 0px 0px -150px');
      expect(watching(output).init.rootMargin).toBe('0px -150px 0px 0px');
      const made = observers.length;
      rerender(<TilePorts node={node()} wiring={wiring()} scale={1.25} />);
      expect(observers.length).toBe(made);
      expect(watching(input)).toBe(zoomed);
      expect(inputLabel.style.right).toBe('18px');
      report(zoomed, 0.4);
      expect(inputLabel.style.left).toBe('18px');
      stage.remove();
    } finally {
      vi.unstubAllGlobals();
    }
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
