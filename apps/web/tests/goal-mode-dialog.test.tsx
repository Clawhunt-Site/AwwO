import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoalModeDialog, type GoalRecord } from '../src/GoalModeDialog';

// PR6 + PR4 — the 选兵台 dialog: plan preview + a LEAD runtime plus optional
// per-slot agent overrides. Confirm submits the lead entry plus one entry per
// overridden role; that roster is the execution source of truth.

afterEach(cleanup);

const record: GoalRecord = {
  spec: { goal_id: 'goal_1', title: 'Add /health' },
  status: 'awaiting_confirmation',
  revision: 1,
  plan_hash: 'sha256:abc',
  plan: {
    topology: 'linear',
    slots: [
      { role: 'explore', title: 'explore: Add /health' },
      { role: 'implement', title: 'implement: Add /health' },
    ],
  },
};

function mockReadJson(overrides: Record<string, any> = {}) {
  return vi.fn(async (path: string, _init?: any) => {
    if (path === '/api/agents') {
      return {
        agents: [
          { name: 'claude', supports_model_selection: true, supports_effort_selection: true, effort_levels: ['low', 'high'], effort_input_mode: 'select' },
          { name: 'codex', supports_model_selection: true, supports_effort_selection: false },
        ],
      };
    }
    if (path === '/api/agents/claude/models') return { models: ['claude-opus-4-8'] };
    if (path === '/api/agents/codex/models') return { models: ['gpt-5.5'] };
    if (path in overrides) return overrides[path];
    return {};
  });
}

function props(extra: Partial<Parameters<typeof GoalModeDialog>[0]> = {}) {
  return {
    open: true as const,
    record,
    lang: 'en' as const,
    onClose: vi.fn(),
    onConfirmed: vi.fn(),
    onReplanned: vi.fn(),
    readJson: mockReadJson(),
    ...extra,
  };
}

describe('GoalModeDialog', () => {
  it('renders the plan slots from the kernel record', async () => {
    render(<GoalModeDialog {...props()} />);
    expect(await screen.findByText('explore: Add /health')).toBeInTheDocument();
    expect(screen.getByText('implement: Add /health')).toBeInTheDocument();
  });

  it('confirms with a single lead entry when no per-slot override is set', async () => {
    const readJson = mockReadJson({ '/api/goals/goal_1/confirm': { goal: { ...record, status: 'active' } } });
    const onConfirmed = vi.fn();
    render(<GoalModeDialog {...props({ readJson, onConfirmed })} />);
    await screen.findByText('explore: Add /health');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & run' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & run' }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    const call = readJson.mock.calls.find((c) => c[0] === '/api/goals/goal_1/confirm');
    const roster = JSON.parse(call![1].body).roster;
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ role: null, backend: 'claude' });
  });

  it('adds a role entry when a per-slot agent is assigned (multi-agent)', async () => {
    const readJson = mockReadJson({ '/api/goals/goal_1/confirm': { goal: { ...record, status: 'active' } } });
    render(<GoalModeDialog {...props({ readJson })} />);
    await screen.findByText('explore: Add /health');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & run' })).not.toBeDisabled());
    // Runtime dropdowns: [0]=lead, [1]=explore role, [2]=implement role
    const runtimeDropdowns = screen.getAllByLabelText('Runtime');
    fireEvent.click(runtimeDropdowns[2]); // implement role picker
    fireEvent.click(await screen.findByRole('option', { name: 'codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & run' }));
    await waitFor(() => {
      const call = readJson.mock.calls.find((c) => c[0] === '/api/goals/goal_1/confirm');
      return call !== undefined;
    });
    const call = readJson.mock.calls.find((c) => c[0] === '/api/goals/goal_1/confirm');
    const roster = JSON.parse(call![1].body).roster;
    const impl = roster.find((e: any) => e.role === 'implement');
    expect(impl).toMatchObject({ backend: 'codex' });
    expect(roster.find((e: any) => e.role === null)).toBeTruthy(); // lead still present
  });

  it('keeps confirm disabled until the inventory resolves', async () => {
    let resolveAgents: (v: any) => void = () => {};
    const agentsPromise = new Promise((res) => {
      resolveAgents = res;
    });
    const readJson = vi.fn((path: string) => (path === '/api/agents' ? agentsPromise : Promise.resolve({})));
    render(<GoalModeDialog {...props({ readJson: readJson as any })} />);
    expect(screen.getByRole('button', { name: 'Confirm & run' })).toBeDisabled();
    await act(async () => {
      resolveAgents({ agents: [{ name: 'claude', supports_model_selection: true }] });
      await agentsPromise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & run' })).not.toBeDisabled());
  });

  it('disables confirm when the runtime inventory cannot be loaded (fail-closed)', async () => {
    const readJson = vi.fn(async (path: string) => {
      if (path === '/api/agents') throw new Error('offline');
      return {};
    });
    render(<GoalModeDialog {...props({ readJson })} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & run' })).toBeDisabled());
  });

  it('re-plans via the kernel and refreshes the record', async () => {
    const replanned = { ...record, revision: 2, plan_hash: 'sha256:new' };
    const readJson = mockReadJson({ '/api/goals/goal_1/replan': replanned });
    const onReplanned = vi.fn();
    render(<GoalModeDialog {...props({ readJson, onReplanned })} />);
    await screen.findByText('explore: Add /health');
    fireEvent.click(screen.getByRole('button', { name: 'Re-plan' }));
    await waitFor(() => expect(onReplanned).toHaveBeenCalledWith(replanned));
  });
});

const consensusRecord: GoalRecord = {
  spec: { goal_id: 'goal_1', title: 'Add /health' },
  status: 'awaiting_confirmation',
  revision: 2,
  plan_hash: 'sha256:rc',
  plan: {
    topology: 'review_consensus',
    slots: [
      { role: 'implement', title: 'implement: Add /health' },
      { role: 'review', title: 'review: Add /health' },
    ],
  },
};

describe('GoalModeDialog fan-out strategy (PR-followup)', () => {
  it('has no budget input for a linear plan', async () => {
    render(<GoalModeDialog {...props()} />);
    await screen.findByText('explore: Add /health');
    expect(screen.queryByLabelText('Token budget')).not.toBeInTheDocument();
  });

  it('re-plans through /replan when the strategy changes', async () => {
    const readJson = mockReadJson({ '/api/goals/goal_1/replan': consensusRecord });
    const onReplanned = vi.fn();
    render(<GoalModeDialog {...props({ readJson, onReplanned })} />);
    await screen.findByText('explore: Add /health');
    const strategy = await screen.findByLabelText('Execution strategy');
    fireEvent.click(strategy);
    fireEvent.click(await screen.findByRole('option', { name: /Review consensus/ }));
    await waitFor(() => expect(onReplanned).toHaveBeenCalledWith(consensusRecord));
    const call = readJson.mock.calls.find((c) => c[0] === '/api/goals/goal_1/replan');
    expect(JSON.parse(call![1].body)).toMatchObject({ topology: 'review_consensus' });
  });

  it('requires a token budget before confirming a concurrent plan', async () => {
    const readJson = mockReadJson({ '/api/goals/goal_1/confirm': { goal: { ...consensusRecord, status: 'active' } } });
    render(<GoalModeDialog {...props({ record: consensusRecord, readJson })} />);
    await screen.findByText('implement: Add /health');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & run' })).toBeDisabled());
    fireEvent.change(screen.getByLabelText('Token budget'), { target: { value: '6000' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & run' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & run' }));
    await waitFor(() => {
      const call = readJson.mock.calls.find((c) => c[0] === '/api/goals/goal_1/confirm');
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1].body).token_budget).toBe(6000);
    });
  });
});

describe('GoalModeDialog fan-out budget correctness', () => {
  it('resets the budget when the dialog switches to a different goal', async () => {
    const { rerender } = render(<GoalModeDialog {...props({ record: consensusRecord })} />);
    await screen.findByText('implement: Add /health');
    fireEvent.change(screen.getByLabelText('Token budget'), { target: { value: '6000' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & run' })).not.toBeDisabled());
    // a different concurrent goal opens in the same (not-unmounted) dialog
    const otherGoal = { ...consensusRecord, spec: { goal_id: 'goal_2', title: 'Other' } };
    rerender(<GoalModeDialog {...props({ record: otherGoal })} />);
    await waitFor(() => expect((screen.getByLabelText('Token budget') as HTMLInputElement).value).toBe(''));
    expect(screen.getByRole('button', { name: 'Confirm & run' })).toBeDisabled();  // no inherited budget
  });

  it('parses scientific notation correctly and rejects non-integers', async () => {
    const readJson = mockReadJson({ '/api/goals/goal_1/confirm': { goal: { ...consensusRecord, status: 'active' } } });
    render(<GoalModeDialog {...props({ record: consensusRecord, readJson })} />);
    await screen.findByText('implement: Add /health');
    const input = screen.getByLabelText('Token budget');
    // a non-integer is rejected -> confirm stays gated
    fireEvent.change(input, { target: { value: '1.5' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & run' })).toBeDisabled());
    // "1e6" is 1,000,000 (Number), not 1 (parseInt)
    fireEvent.change(input, { target: { value: '1e6' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & run' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & run' }));
    await waitFor(() => {
      const call = readJson.mock.calls.find((c) => c[0] === '/api/goals/goal_1/confirm');
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1].body).token_budget).toBe(1000000);
    });
  });
});
