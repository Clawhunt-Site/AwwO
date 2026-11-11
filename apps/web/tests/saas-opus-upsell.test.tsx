import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionHost } from '../src/saas/AssistantExecution';
import { OPUS_MODEL_ID } from '../src/saas/OpusUpsell';
import { accountURL } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { executionModelKey, useManagedExecution } from '../src/saas/useManagedExecution';

// In the canvas, where the canvas assistant's model is chosen, a workspace without a paid plan is invited to Claude Opus
// 5.5 (owner requests 2026-10-13). It is Pro, Max and Ultra only: the server marks it requiresUpgrade for such a workspace
// (plan_only_models.go), so the option is locked and the card leads to the plans. Where the server still offers it on
// the free allowance (no requiresUpgrade), the card counts today's free calls and switches to it.
const qwen = { id: 'qwen3.8-27b-p6', label: 'qwen3.8-27b-p6', runtime: 'pi', route: 'free' };
const opusFree = { id: OPUS_MODEL_ID, label: 'Claude Opus 5.5', runtime: 'pi', route: 'bedrock' };
const opusLocked = { ...opusFree, requiresUpgrade: true };
const catalogue = (models: unknown[]) => ({ ready: true, capabilities: { workspace: true, approvals: true }, models });
const free = (used = 5) => ({ limited: true, interested: false, daily: { limit: 300, used: 10 },
  routes: { gate: { limit: 30, used: 2 }, bedrock: { limit: 20, used }, media: { limit: 5, used: 0 } } });
const legacy = { limited: false, interested: false, daily: { limit: 300, used: 0 } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function server(usage: unknown, models: unknown[] = [qwen, opusLocked]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url}`);
    if (url.endsWith('/computer-runtime')) return json(catalogue(models));
    if (url.endsWith('/route-usage')) return json(usage);
    if (url.endsWith('/upgrade-interest')) return json({ recorded: true, clicks: 1 });
    return json({ items: [] });
  }));
  return calls;
}

function Settings() {
  const execution = useManagedExecution('tenant-a', 'canvas-a', { userId: 'user-a' });
  useEffect(() => { execution.activate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <>{executionHost(execution).settings}<output data-testid="choice">{execution.choice.key}</output>
    <output data-testid="components">{execution.componentModel ? execution.componentModel.model : ''}</output></>;
}
const view = () => render(<SaaSPreferencesProvider><Settings /></SaaSPreferencesProvider>);
const chip = () => document.querySelector<HTMLElement>('.awwo-execution-settings > summary')!;
const invitation = () => screen.queryByText('Claude Opus 5.5 · 这里最强的模型')?.closest<HTMLElement>('[role="note"]') ?? null;
const option = (model: string) => [...document.querySelectorAll<HTMLOptionElement>('option')].find(item => item.value === executionModelKey('pi', model))!;

describe('the Opus 5.5 invitation in the canvas assistant’s model menu', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([['a route-limited free workspace', free()], ['a free workspace without route limits', legacy]])(
    'shows %s that Opus 5.5 is Pro, Max and Ultra only, locks it, and opens the plans', async (_name, usage) => {
      const calls = server(usage);
      view();
      await waitFor(() => expect(invitation()).not.toBeNull());
      // The chip carries a spark, and its tooltip says why.
      expect(chip().querySelector('.awwo-execution-spark')).not.toBeNull();
      expect(chip()).toHaveAttribute('title', expect.stringContaining('升级 Pro / Max / Ultra 使用 Claude Opus 5.5'));
      const note = within(invitation()!);
      expect(note.getByText('Pro / Max / Ultra 专享：升级后按点数使用，不受次数限制。')).toBeInTheDocument();
      expect(note.queryByRole('button', { name: '换成 Opus 5.5' })).toBeNull();
      // Tagged and locked in the picker; the default model stays chosen.
      expect(option(OPUS_MODEL_ID)).toBeDisabled();
      expect(option(OPUS_MODEL_ID)).toHaveTextContent('Claude Opus 5.5 · Pro');
      expect(option(qwen.id)).toBeEnabled();
      expect(screen.getByTestId('choice')).toHaveTextContent(executionModelKey('pi', qwen.id));
      const upgrade = note.getByRole('link', { name: '升级套餐' });
      expect(upgrade).toHaveAttribute('href', accountURL('plans'));
      expect(upgrade).toHaveAttribute('target', '_blank');
      upgrade.addEventListener('click', event => event.preventDefault());
      fireEvent.click(upgrade);
      await waitFor(() => expect(calls).toContain('POST /api/v1/tenants/tenant-a/upgrade-interest'));
    });

  it('keeps a stored choice of Opus 5.5 shown, but never puts it on the components a plan adds', async () => {
    localStorage.setItem('awwo.saas:user-a:tenant-a:awwo.assistant.model.v1', executionModelKey('pi', OPUS_MODEL_ID));
    server(free());
    view();
    await waitFor(() => expect(invitation()).not.toBeNull());
    expect(screen.getByTestId('choice')).toHaveTextContent(executionModelKey('pi', OPUS_MODEL_ID));
    // The chosen option stays selectable so the box shows it (the composer's notice, covered elsewhere, says a task on it
    // is refused); nothing a plan adds is put on it.
    expect(option(OPUS_MODEL_ID)).toBeEnabled();
    expect(chip()).toHaveAttribute('title', expect.stringContaining('Claude Opus 5.5 · Pro'));
    expect(screen.getByTestId('components')).toHaveTextContent('');
  });

  it('where the server still offers it free, counts today’s calls and switches to it in one click', async () => {
    server(free(), [qwen, opusFree]);
    view();
    await waitFor(() => expect(invitation()).not.toBeNull());
    const note = within(invitation()!);
    expect(note.getByText('今天还能免费用 15 次；升级 Pro / Max / Ultra 用点数畅用，不受次数限制。')).toBeInTheDocument();
    expect(option(OPUS_MODEL_ID)).toBeEnabled();
    fireEvent.click(note.getByRole('button', { name: '换成 Opus 5.5' }));
    expect(screen.getByTestId('choice')).toHaveTextContent(executionModelKey('pi', OPUS_MODEL_ID));
    expect(screen.getByTestId('components')).toHaveTextContent(OPUS_MODEL_ID);
    // Chosen: the invitation stays, without a switch to make.
    expect(within(invitation()!).queryByRole('button', { name: '换成 Opus 5.5' })).toBeNull();
  });

  it('says when today’s free calls are used up, and then offers only the plans', async () => {
    server(free(20), [qwen, opusFree]);
    view();
    await waitFor(() => expect(invitation()).not.toBeNull());
    expect(within(invitation()!).getByText('今天的免费次数已用完；升级 Pro / Max / Ultra 用点数接着用。')).toBeInTheDocument();
    expect(within(invitation()!).queryByRole('button', { name: '换成 Opus 5.5' })).toBeNull();
    expect(within(invitation()!).getByRole('link', { name: '升级套餐' })).toBeInTheDocument();
  });

  it('never offers free calls left once the workspace’s free trial is over, only the plans', async () => {
    // The numbers may still show calls left: past the free plan's end the server runs nothing until the owner subscribes.
    server({ ...free(), freePlan: { until: '2026-11-12T16:00:00Z', ended: true } }, [qwen, opusFree]);
    view();
    await waitFor(() => expect(invitation()).not.toBeNull());
    const note = within(invitation()!);
    expect(note.getByText('免费试用已结束：工作区所有者订阅 Pro / Max / Ultra 后，就能按点数使用 Opus 5.5。')).toBeInTheDocument();
    expect(invitation()).not.toHaveTextContent(/今天还能免费用|今天的免费次数/);
    expect(note.queryByRole('button', { name: '换成 Opus 5.5' })).toBeNull();
    expect(note.getByRole('link', { name: '升级套餐' })).toHaveAttribute('href', accountURL('plans'));
  });

  it('counts today’s free calls as before while the free trial runs', async () => {
    server({ ...free(), freePlan: { until: '2026-11-12T16:00:00Z', ended: false } }, [qwen, opusFree]);
    view();
    await waitFor(() => expect(invitation()).not.toBeNull());
    expect(within(invitation()!).getByText('今天还能免费用 15 次；升级 Pro / Max / Ultra 用点数畅用，不受次数限制。')).toBeInTheDocument();
    expect(within(invitation()!).getByRole('button', { name: '换成 Opus 5.5' })).toBeInTheDocument();
  });

  it('says the free trial is over in English too', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    server({ ...free(), freePlan: { until: '2026-11-12T16:00:00Z', ended: true } }, [qwen, opusFree]);
    view();
    const note = await screen.findByText('The free trial has ended: once the workspace owner subscribes to Pro, Max or Ultra, Opus 5.5 runs on credits.');
    expect(note.closest('[role="note"]')).not.toHaveTextContent(/free calls? left|used up/);
    expect(screen.queryByRole('button', { name: 'Switch to Opus 5.5' })).toBeNull();
  });

  it('reads the allowance again when the menu opens', async () => {
    const calls = server(free());
    view();
    await waitFor(() => expect(invitation()).not.toBeNull());
    const reads = () => calls.filter(call => call.endsWith('/route-usage')).length;
    const before = reads();
    const details = chip().closest('details')!;
    act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it.each([
    ['on a paid plan', { ...free(), plan: { id: 'pro', owner: true, credits: { granted: 2000, spent: 10, remaining: 1990 } } }, [qwen, opusFree]],
    ['of the operator’s own (unlimited, Opus 5.5 offered)', { limited: false, interested: false, daily: { limit: 100000, used: 0 } }, [qwen, opusFree]],
  ])('never shows to a workspace %s', async (_name, usage, models) => {
    const calls = server(usage, models);
    view();
    await waitFor(() => expect(calls).toContain('GET /api/v1/tenants/tenant-a/route-usage'));
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(invitation()).toBeNull();
    expect(chip().querySelector('.awwo-execution-spark')).toBeNull();
    expect(option(OPUS_MODEL_ID)).toBeEnabled();
  });

  it('reads nothing where Opus 5.5 is not on offer', async () => {
    const calls = server(free(), [qwen]);
    view();
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(invitation()).toBeNull();
    expect(calls.some(call => call.endsWith('/route-usage'))).toBe(false);
  });
});
