import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAutomationControl } from '../src/ChatAutomationControl';
import * as bridge from '../src/chatAutomations';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SESSION = '11111111-1111-4111-8111-111111111111';

function automation(over: Partial<bridge.ChatAutomationView> = {}): bridge.ChatAutomationView {
  return {
    id: 'a1',
    sessionIssueId: SESSION,
    prompt: 'morning digest',
    cadence: { kind: 'interval', intervalSec: 86400 },
    timezone: 'UTC',
    enabled: true,
    approvalState: 'pending_approval',
    nextRunAt: Date.now() + 86_400_000,
    lastFiredAt: null,
    lastOutcomeOk: null,
    lastError: null,
    ...over,
  };
}

describe('ChatAutomationControl', () => {
  it('prompts to open a conversation when there is no session', () => {
    render(<ChatAutomationControl sessionIssueId={null} locale="en" />);
    expect(screen.getByText(/Open a conversation/i)).toBeInTheDocument();
  });

  it('lists the session automations and shows the pending-approval chip', async () => {
    vi.spyOn(bridge, 'listSessionAutomations').mockResolvedValue([automation()]);
    render(<ChatAutomationControl sessionIssueId={SESSION} locale="en" />);
    await waitFor(() => expect(screen.getByText('morning digest')).toBeInTheDocument());
    // Fail-closed: a new automation shows as Pending approval, not Active.
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('creates an automation (pre-filled prompt) and surfaces the fail-closed pending note', async () => {
    vi.spyOn(bridge, 'listSessionAutomations').mockResolvedValue([]);
    const create = vi.spyOn(bridge, 'createSessionAutomation').mockResolvedValue({ ok: true, data: automation() });
    render(<ChatAutomationControl sessionIssueId={SESSION} locale="en" initialPrompt="summarize my notes" />);
    await waitFor(() => expect(screen.getByText(/No scheduled tasks/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Create scheduled task/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ sessionIssueId: SESSION, prompt: 'summarize my notes', intervalSec: 86400 });
    expect(await screen.findByText(/will NOT run until you approve/i)).toBeInTheDocument();
  });

  it('notifies the host (onChanged) after creating so the sidebar badge can refresh', async () => {
    vi.spyOn(bridge, 'listSessionAutomations').mockResolvedValue([]);
    vi.spyOn(bridge, 'createSessionAutomation').mockResolvedValue({ ok: true, data: automation() });
    const onChanged = vi.fn();
    render(<ChatAutomationControl sessionIssueId={SESSION} locale="en" initialPrompt="x" onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText(/No scheduled tasks/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Create scheduled task/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('approves a pending automation through the human gate', async () => {
    vi.spyOn(bridge, 'listSessionAutomations').mockResolvedValue([automation()]);
    const approve = vi.spyOn(bridge, 'approveAutomation').mockResolvedValue({ ok: true, data: automation({ approvalState: 'approved' }) });
    render(<ChatAutomationControl sessionIssueId={SESSION} locale="en" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith('a1'));
  });

  it('shows a fail-soft notice when the gateway is unreachable', async () => {
    vi.spyOn(bridge, 'listSessionAutomations').mockResolvedValue(null);
    render(<ChatAutomationControl sessionIssueId={SESSION} locale="en" />);
    expect(await screen.findByText(/Could not reach the automation service/i)).toBeInTheDocument();
  });
});
