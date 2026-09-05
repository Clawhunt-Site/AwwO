import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InspectorPanel, type InspectorPanelProps } from '../src/canvas/InspectorPanel';
import { createFormNode, createSessionNode } from '../src/canvas/canvasDoc';

const hire = vi.fn();
vi.mock('../src/canvasHire', async (original) => ({
  ...await original<typeof import('../src/canvasHire')>(),
  hireAgentIntoCompany: (...args: unknown[]) => hire(...args),
}));
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function props(): InspectorPanelProps {
  return {
    node: { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'frontend', title: '前端', runtime: 'claude_local', persona: '遵守项目约定' },
    liveCompanies: [{ id: 'company', name: '项目团队' }], apiBase: '/paperclip-api',
    onSave: vi.fn(), onBound: vi.fn(), onClose: vi.fn(),
  };
}
beforeEach(() => { hire.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('inspector graph-run lock', () => {
  it('reports the close lock before dispatch and keeps it until a held result is saved', async () => {
    const pending = deferred<unknown>();
    let parentLocked = false;
    let lockedAtDispatch = false;
    hire.mockImplementation(() => {
      lockedAtDispatch = parentLocked;
      return pending.promise;
    });
    const p = { ...props(), onCloseLockChange: (locked: boolean) => { parentLocked = locked; } };
    const { rerender, unmount } = render(<InspectorPanel {...p} />);
    expect(parentLocked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '绑定并创建真实 Agent' }));
    expect(lockedAtDispatch).toBe(true);
    expect(parentLocked).toBe(true);
    rerender(<InspectorPanel {...p} readOnly />);
    pending.resolve({ outcome: 'unknown', detail: 'response lost' });
    await screen.findByText(/绑定结果已保留/);
    expect(parentLocked).toBe(true);
    rerender(<InspectorPanel {...p} readOnly={false} />);
    expect(parentLocked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存绑定结果' }));
    await waitFor(() => expect(parentLocked).toBe(false));
    unmount();
    expect(parentLocked).toBe(false);
  });

  it('releases a reported parent lock if the inspector is unmounted externally', async () => {
    const pending = deferred<unknown>(); hire.mockReturnValue(pending.promise);
    let parentLocked = false;
    const p = { ...props(), onCloseLockChange: (locked: boolean) => { parentLocked = locked; } };
    const { unmount } = render(<InspectorPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '绑定并创建真实 Agent' }));
    expect(parentLocked).toBe(true);
    unmount();
    expect(parentLocked).toBe(false);
    pending.resolve({ outcome: 'rejected', detail: 'not created' });
  });

  it('disables configuration, saving and binding with honest read-only copy', () => {
    const p = props();
    render(<InspectorPanel {...p} readOnly />);
    expect((screen.getByLabelText('名称') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('人设 / 系统提示词') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText('绑定到公司') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByText('绑定中…')).toBeNull();
    expect(screen.getByText(/图运行中，配置只读/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(screen.getByRole('button', { name: '绑定并创建真实 Agent' }));
    expect(p.onSave).not.toHaveBeenCalled();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(hire).not.toHaveBeenCalled();
  });

  it('guards legacy form edit handlers and retains the original draft after unlocking', () => {
    const p = { ...props(), node: { ...createFormNode({ x: 0, y: 0 }), fields: [{ id: 'f', label: '需求', value: '原始内容' }] } };
    const { rerender } = render(<InspectorPanel {...p} readOnly />);
    const field = screen.getByLabelText('字段 1 值') as HTMLInputElement;
    expect(field.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '不应保存' } });
    rerender(<InspectorPanel {...p} readOnly={false} />);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(p.onSave).toHaveBeenCalledWith(expect.objectContaining({ fields: [{ id: 'f', label: '需求', value: '原始内容' }] }));
  });

  it('retains a created hire after lock, then explicitly saves and syncs without rehiring', async () => {
    const pending = deferred<unknown>(); hire.mockReturnValue(pending.promise);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetchMock);
    const p = props();
    const { rerender } = render(<InspectorPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '绑定并创建真实 Agent' }));
    expect(p.onSave).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: '关闭配置' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<InspectorPanel {...p} readOnly />);
    pending.resolve({ outcome: 'created', agentId: 'actual-agent', status: 'idle' });
    await screen.findByText(/绑定结果已保留/);
    expect(p.onSave).toHaveBeenCalledTimes(1);
    expect(p.onBound).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '保存绑定结果' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(p.onClose).not.toHaveBeenCalled();
    rerender(<InspectorPanel {...p} readOnly={false} />);
    fireEvent.click(screen.getByRole('button', { name: '保存绑定结果' }));
    await waitFor(() => expect(p.onBound).toHaveBeenCalledTimes(1));
    expect(hire).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(p.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ binding: { companyId: 'company', agentId: 'actual-agent', agentName: '前端' } }));
    expect((screen.getByRole('button', { name: '关闭配置' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('retains an unknown hire response until its marker can be saved after unlocking', async () => {
    const pending = deferred<unknown>(); hire.mockReturnValue(pending.promise);
    const p = props();
    const { rerender } = render(<InspectorPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '绑定并创建真实 Agent' }));
    rerender(<InspectorPanel {...p} readOnly />);
    pending.resolve({ outcome: 'unknown', detail: 'response lost' });
    await screen.findByText(/绑定结果已保留/);
    expect(p.onSave).toHaveBeenCalledTimes(1);
    rerender(<InspectorPanel {...p} readOnly={false} />);
    fireEvent.click(screen.getByRole('button', { name: '保存绑定结果' }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalledTimes(2));
    expect(p.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ bindAttempt: 'unknown', binding: null }));
    expect(hire).toHaveBeenCalledTimes(1);
    expect(p.onBound).not.toHaveBeenCalled();
  });

  it('does not emit a binding callback during a run when an already-sent persona write resolves', async () => {
    hire.mockResolvedValue({ outcome: 'created', agentId: 'actual-agent', status: 'idle' });
    const pendingPersona = deferred<{ ok: boolean }>();
    const fetchMock = vi.fn().mockReturnValue(pendingPersona.promise); vi.stubGlobal('fetch', fetchMock);
    const p = props();
    const { rerender } = render(<InspectorPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '绑定并创建真实 Agent' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<InspectorPanel {...p} readOnly />);
    pendingPersona.resolve({ ok: true });
    await screen.findByText(/绑定结果已保留/);
    expect(p.onBound).not.toHaveBeenCalled();
    rerender(<InspectorPanel {...p} readOnly={false} />);
    fireEvent.click(screen.getByRole('button', { name: '保存绑定结果' }));
    await waitFor(() => expect(p.onBound).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hire).toHaveBeenCalledTimes(1);
  });
});
