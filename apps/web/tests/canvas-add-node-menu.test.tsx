import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AddNodeMenu, type AddNodeMenuProps } from '../src/canvas/AddNodeMenu';
import { LocaleProvider } from '../src/canvas/i18n';

afterEach(cleanup);
function props(overrides: Partial<AddNodeMenuProps> = {}): AddNodeMenuProps {
  return { at: { x: 40, y: 60 }, onPick: vi.fn(), onClose: vi.fn(), ...overrides };
}

describe('canvas add menu model shelf mode', () => {
  it('replaces role templates with a model/persona entry while retaining generic and workspace Agents', () => {
    const order: string[] = [];
    const p = props({ onClose: vi.fn(() => order.push('close')), onOpenModelShelf: vi.fn(() => order.push('shelf')), onOpenAgentLibrary: vi.fn() });
    render(<AddNodeMenu {...p} />);
    expect(screen.queryByRole('menuitem', { name: '前端开发' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '后端服务' })).toBeNull();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('menuitem', { name: '模型与人设…' }));
    expect(order).toEqual(['close', 'shelf']); expect(p.onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: '自定义 Agent' }));
    expect(p.onPick).toHaveBeenCalledWith('general');
    fireEvent.click(screen.getByRole('menuitem', { name: '选择工作区 Agent…' }));
    expect(p.onOpenAgentLibrary).toHaveBeenCalledOnce();
  });

  it('preserves all seven legacy template choices when the model shelf is not supplied', () => {
    const p = props(); render(<AddNodeMenu {...p} />);
    expect(screen.getAllByRole('menuitem')).toHaveLength(7);
    expect(screen.queryByRole('menuitem', { name: '模型与人设…' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '前端开发' }));
    expect(p.onPick).toHaveBeenCalledWith('frontend');
  });

  it('localizes the model shelf entry and cleans up Escape and outside-click listeners', () => {
    const p = props({ onOpenModelShelf: vi.fn() });
    const view = render(<LocaleProvider locale="en"><AddNodeMenu {...p} /></LocaleProvider>);
    expect(screen.getByRole('menuitem', { name: 'Models & personas…' })).toBeEnabled();
    fireEvent.keyDown(window, { key: 'Escape' }); expect(p.onClose).toHaveBeenCalledOnce();
    fireEvent.pointerDown(document.body); expect(p.onClose).toHaveBeenCalledTimes(2);
    view.unmount(); fireEvent.keyDown(window, { key: 'Escape' }); fireEvent.pointerDown(document.body);
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });
});
