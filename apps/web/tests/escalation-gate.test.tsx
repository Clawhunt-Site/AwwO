// Direction 4 D3: the escalation approval popup is a thin surface over the SAME kernel
// queue the CLI drives. It adds NO authority — it lists pending escalations, renders the
// canonical prompt + option buttons, and respond goes to the same /api/escalations
// endpoint. Dismissing is NOT a decision (the escalation stays pending; only choosing an
// option responds). Fail-closed: empty queue → no popup, no badge.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EscalationGate } from '../src/EscalationGate';

afterEach(() => {
  cleanup();
});

const PENDING = {
  request_id: 'esc_1',
  kind: 'permission',
  status: 'pending',
  prompt_text: 'Allow shell `ls`?',
  options: [
    { id: 'deny', label: 'Deny', style: 'default', grants: false },
    { id: 'approve', label: 'Approve once', style: 'danger', grants: true },
  ],
  default_option_id: 'deny',
  tool_name: 'run_shell',
  reserved_path: null,
  run_id: 'run-1',
};

function makeReadJson(initialPending: any[] = [PENDING]) {
  const calls: Array<{ path: string; init?: any }> = [];
  let pending = [...initialPending];
  const readJson = vi.fn(async (path: string, init?: any) => {
    calls.push({ path, init });
    if (path.startsWith('/api/escalations?status=pending')) {
      return { escalations: pending, pending_count: pending.length };
    }
    if (path.includes('/respond')) {
      const id = decodeURIComponent(path.split('/api/escalations/')[1].split('/respond')[0]);
      const decision = JSON.parse(init.body).decision;
      pending = pending.filter((e) => e.request_id !== id);
      return { request_id: id, status: decision === 'approve' ? 'approved' : 'denied' };
    }
    return {};
  });
  return { readJson, calls };
}

describe('EscalationGate', () => {
  it('surfaces a pending escalation as a popup with its option buttons', async () => {
    const { readJson } = makeReadJson();
    render(<EscalationGate readJson={readJson} pollMs={10_000} />);
    await waitFor(() => expect(screen.getByText('Allow shell `ls`?')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeInTheDocument();
    expect(screen.getByText(/run_shell/)).toBeInTheDocument();
  });

  it('responds via the SAME kernel endpoint with the chosen decision (no new authority)', async () => {
    const { readJson, calls } = makeReadJson();
    render(<EscalationGate readJson={readJson} pollMs={10_000} />);
    await waitFor(() => screen.getByText('Allow shell `ls`?'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve once' }));
    await waitFor(() => {
      const respond = calls.find((c) => c.path.includes('/respond'));
      expect(respond).toBeTruthy();
      expect(respond!.path).toBe('/api/escalations/esc_1/respond');
      expect(respond!.init.method).toBe('POST');
      expect(JSON.parse(respond!.init.body)).toEqual({ decision: 'approve' });
    });
  });

  it('renders nothing when the queue is empty (fail-closed: no popup, no badge)', async () => {
    const { readJson } = makeReadJson([]);
    const { container } = render(<EscalationGate readJson={readJson} pollMs={10_000} />);
    await waitFor(() => expect(readJson).toHaveBeenCalled());
    expect(container.querySelector('.escalation-gate__badge')).toBeNull();
    expect(screen.queryByText('Allow shell `ls`?')).toBeNull();
  });

  it('dismiss keeps the escalation pending and shows a badge (dismiss is not a decision)', async () => {
    const { readJson, calls } = makeReadJson();
    render(<EscalationGate readJson={readJson} pollMs={10_000} />);
    await waitFor(() => screen.getByText('Allow shell `ls`?'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss (stays pending)' }));
    await waitFor(() => expect(screen.queryByText('Allow shell `ls`?')).toBeNull());
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(calls.find((c) => c.path.includes('/respond'))).toBeUndefined();
  });

  it('does not re-poll on parent rerender (readJson identity is held in a ref)', async () => {
    const first = makeReadJson([]);
    const { rerender } = render(<EscalationGate readJson={first.readJson} pollMs={10_000} />);
    await waitFor(() => expect(first.readJson).toHaveBeenCalledTimes(1));
    // App rerenders hand a NEW readJson identity every time; the effect must NOT tear down
    // and immediately re-GET (that would be a fetch storm, not a 4s poll).
    const second = makeReadJson([]);
    rerender(<EscalationGate readJson={second.readJson} pollMs={10_000} />);
    rerender(<EscalationGate readJson={second.readJson} pollMs={10_000} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.readJson).toHaveBeenCalledTimes(1);
    expect(second.readJson).not.toHaveBeenCalled();
  });

  it('discards a stale out-of-order poll so it cannot resurrect a cleared queue', async () => {
    let resolveStale: (value: unknown) => void = () => {};
    const stale = new Promise((resolve) => {
      resolveStale = resolve;
    });
    let call = 0;
    const readJson = vi.fn(async (path: string) => {
      if (path.startsWith('/api/escalations?status=pending')) {
        call += 1;
        if (call === 1) return stale; // the first (mount) poll hangs
        return { escalations: [], pending_count: 0 }; // later polls: empty queue
      }
      return {};
    });
    render(<EscalationGate readJson={readJson} pollMs={20} />);
    // a later poll returns the empty (fresh) queue → no popup
    await waitFor(() => expect(call).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('Allow shell `ls`?')).toBeNull();
    // the stale first poll now resolves with a pending item — the seq guard must drop it
    resolveStale({ escalations: [PENDING], pending_count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText('Allow shell `ls`?')).toBeNull();
  });

  it('still applies a result when poll latency exceeds the interval (no starvation)', async () => {
    // Every poll is slower than the interval, so polls overlap. A "latest-issued-only"
    // guard would starve the UI (each response superseded before it returns → popup never
    // appears → run hangs). The applied-seq guard must let a newer-than-applied response
    // land, so the popup still shows.
    const readJson = vi.fn(async (path: string) => {
      if (path.startsWith('/api/escalations?status=pending')) {
        return await new Promise((resolve) =>
          setTimeout(() => resolve({ escalations: [PENDING], pending_count: 1 }), 30),
        );
      }
      return {};
    });
    render(<EscalationGate readJson={readJson} pollMs={10} />);
    await waitFor(() => expect(screen.getByText('Allow shell `ls`?')).toBeInTheDocument());
  });
});
