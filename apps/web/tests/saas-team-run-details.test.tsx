import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamRunDetails, type TeamRunDetailsProps } from '../src/saas/TeamRunDetails';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { TeamTurn } from '../src/saas/graphRuns';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const path = '/api/v1/tenants/tenant-a/runs/run-a';
const record = (status = 'completed', id = 'run-a', tenantId = 'tenant-a') => ({ id, tenantId, status, error: '' });
const turn = (patch: Partial<TeamTurn> = {}): TeamTurn => ({
  id: 'turn-a', memberId: 'writer', memberName: 'Writer Ada', role: 'Researcher', round: 1, ordinal: 1,
  status: 'completed', output: 'Complete member output', model: 'catalog-writer', runtime: 'pi',
  createdAt: '2026-09-08T03:04:05Z', updatedAt: '2026-09-08T03:04:09Z',
  config: { instructions: 'Write with your own identity.' }, prompt: 'The exact submitted task and source text',
  systemPrompt: 'Exact composed node and member system instructions',
  messages: [{ role: 'user', content: 'Previous user task' }, { role: 'assistant', content: 'Earlier team final reply, not this member identity' }],
  context: { version: 1, mode: 'shared', purpose: 'work', historyMessages: 2, historyAvailable: 4, historyTruncated: true,
    upstreamMembers: [{ memberId: 'analyst', memberName: 'Analyst Lin', round: 1, ordinal: 1 }], upstreamAvailable: 2, upstreamTruncated: true },
  ...patch,
});
const view = (props: Partial<TeamRunDetailsProps> = {}) => <SaaSPreferencesProvider><TeamRunDetails tenantId="tenant-a" runId="run-a" {...props}/></SaaSPreferencesProvider>;
const flushTimers = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'en'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('durable team run details', () => {
  it('loads only when expanded and renders complete persisted output and collapsed actual input evidence', async () => {
    const output = `First sentence ${'Long evidence. '.repeat(400)}FINAL SENTENCE`;
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url === path ? record() : { items: [turn({ output })] }));
    vi.stubGlobal('fetch', fetcher); render(view());
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run process' }));
    const article = within(await screen.findByRole('article'));
    expect(article.getByText(/Call #1 · Writer Ada/)).toBeVisible();
    expect(article.getByText('Researcher · Round 1 · Completed')).toBeVisible();
    expect(article.getByText(/catalog-writer/)).toHaveTextContent('Runtime: pi');
    expect(article.getByText(/FINAL SENTENCE/).textContent).toBe(output);
    expect(article.getByText(/Created:/).querySelector('time')).toHaveAttribute('dateTime', '2026-09-08T03:04:05Z');
    const audit = article.getByText('Inspect actual input, instructions and context sources').closest('details')!;
    expect(audit).not.toHaveAttribute('open');
    fireEvent.click(within(audit).getByText('Inspect actual input, instructions and context sources'));
    expect(article.getByText('The exact submitted task and source text')).toBeVisible();
    expect(article.getByText('Write with your own identity.')).toBeVisible();
    expect(article.getByText('Exact composed node and member system instructions')).toBeVisible();
    expect(article.getByText('Earlier team final reply, not this member identity')).toBeVisible();
    expect(article.getByText('Session history messages: 2/4 (truncated)')).toBeVisible();
    expect(article.getByText('Earlier member sources: 1/2 (truncated)')).toBeVisible();
    expect(article.getByText('Analyst Lin · Round 1 · Call #1')).toBeVisible();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([path, `${path}/turns`]);
    expect(fetcher.mock.calls.every(([, init]) => !init.method && init.credentials === 'include')).toBe(true);
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted'])('polls active calls, keeps actual output, and stops polling after %s', async terminal => {
    vi.useFakeTimers(); let phase = 0;
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url === path ? record(phase ? terminal : 'running') : {
      items: [turn({ status: phase ? terminal : 'running', output: phase ? 'Durable final or partial evidence' : 'Current partial evidence', error: terminal === 'failed' && phase ? 'team_timeout' : '' })],
    }));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true })); await flushTimers();
    expect(screen.getByText('Current partial evidence')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Running · Updating automatically');
    phase = 1; await flushTimers(2000);
    expect(screen.getByText('Durable final or partial evidence')).toBeVisible();
    expect(screen.getByRole('status')).not.toHaveTextContent('Updating automatically');
    // A team's own time limit says which setting lifts it, not its code.
    if (terminal === 'failed') expect(screen.getByRole('alert')).toHaveTextContent('The node team ran past its time limit before it finished. Raise “Node timeout (seconds)”');
    expect(fetcher).toHaveBeenCalledTimes(4); await flushTimers(10000); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('explains named run and member failures in the reader\'s language and keeps unknown ones verbatim', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url === path
      ? { ...record('failed'), error: 'provider_auth_failed' }
      : { items: [turn({ status: 'failed', error: 'model_refused' }), turn({ id: 'turn-b', ordinal: 2, status: 'failed', error: 'provider_diagnostic_42' })] }));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true }));
    expect(await screen.findByText('The model provider rejected the configured credentials. Check the API key of this model connection.')).toBeInTheDocument();
    expect(screen.getByText('The model declined this request. Adjust the task and try again.')).toBeInTheDocument();
    expect(screen.getByText('provider_diagnostic_42')).toBeInTheDocument();
    expect(screen.queryByText('model_refused')).toBeNull();
  });

  it.each(['premium_quota_exceeded', 'premium_capacity_exceeded'])('offers the paid plans once when a run fails with %s and records the interest on click', async code => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => url === path
      ? json({ ...record('failed'), error: code })
      : url.endsWith('/upgrade-interest') ? json({ recorded: true, clicks: 1 })
        : json({ items: [turn({ status: 'failed', output: '', model: 'claude-opus-5', error: code })] }));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true }));
    const upgrade = await screen.findByRole('link', { name: 'Upgrade to Pro or Max to keep using premium models' });
    // A team run fails with its member's code; the offer still appears once.
    expect(screen.getAllByRole('link', { name: /Upgrade to Pro or Max/ })).toHaveLength(1);
    expect(screen.getAllByText(/Upgrade to the Pro and Max plans|The Pro and Max plans are not limited/).length).toBeGreaterThan(0);
    expect(upgrade.getAttribute('href')).toContain('account=plans');
    expect(upgrade).toHaveAttribute('target', '_blank');
    expect(upgrade).toHaveAttribute('rel', 'noopener noreferrer');
    const stay = (event: Event) => event.preventDefault(); document.addEventListener('click', stay);
    try { fireEvent.click(upgrade); } finally { document.removeEventListener('click', stay); }
    await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url === '/api/v1/tenants/tenant-a/upgrade-interest' && init?.method === 'POST')).toBe(true));
  });

  it('offers the plans for a full daily allowance too, worded for more calls, and names the refusal instead of its code', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url === path ? { ...record('failed'), error: 'quota_exceeded' } : { items: [] }));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true }));
    const upgrade = await screen.findByRole('link', { name: 'Upgrade to Pro or Max to continue today' });
    expect(upgrade.getAttribute('href')).toContain('account=plans');
    expect(screen.getByText(/The workspace run quota has been reached: today’s calls are used up/)).toBeInTheDocument();
    expect(screen.getByText(/Pro and Max have many more calls a day and more runs at once, and run premium models such as Claude and GPT on credits/)).toBeInTheDocument();
    expect(screen.queryByText('quota_exceeded')).toBeNull();
  });

  it('offers no upgrade while a run is active or when a plan would not lift its failure', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url === path
      ? { ...record('failed'), error: 'provider_auth_failed' } : { items: [turn({ status: 'failed', error: 'model_refused' })] }));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true }));
    await screen.findByText('The model declined this request. Adjust the task and try again.');
    expect(screen.queryByRole('link', { name: /Upgrade to Pro or Max/ })).toBeNull();
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === path ? record('running')
      : { items: [turn({ status: 'failed', error: 'premium_quota_exceeded' })] })));
    render(view({ defaultOpen: true }));
    await screen.findByText(/This workspace’s free premium-model calls \(Claude, GPT, Bedrock\) are used up/);
    expect(screen.queryByRole('link', { name: /Upgrade to Pro or Max/ })).toBeNull();
  });

  it('words the upgrade offer in Chinese for Chinese readers', async () => {
    localStorage.setItem('superclaw_locale', 'zh');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === path ? { ...record('failed'), error: 'premium_quota_exceeded' } : { items: [] })));
    render(view({ defaultOpen: true }));
    expect(await screen.findByRole('link', { name: '升级 Pro / Max，继续使用高级模型' })).toBeVisible();
    expect(screen.getByText(/升级 Pro \/ Max 付费套餐，就能用点数继续使用这些模型/)).toBeInTheDocument();
    expect(screen.getByText(/单独指定了模型的团队成员都换成默认模型/)).toBeInTheDocument();
  });

  it.each(['run', 'tenant'])('clears previous records immediately on %s switch and rejects a late old response', async change => {
    let delayed = false; let resolveOld!: (value: Response) => void; let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === path) return json(record());
      if (url === `${path}/turns`) {
        if (delayed) { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { resolveOld = resolve; }); }
        return json({ items: [turn({ output: 'Previous workspace evidence' })] });
      }
      if (url.endsWith('/turns')) return json({ items: [turn({ id: 'turn-b', memberName: 'New agent', output: 'Current workspace evidence' })] });
      return json(record('completed', change === 'run' ? 'run-b' : 'run-a', change === 'tenant' ? 'tenant-b' : 'tenant-a'));
    });
    vi.stubGlobal('fetch', fetcher); const rendered = render(view({ defaultOpen: true })); await screen.findByText('Previous workspace evidence');
    delayed = true; rendered.rerender(view({ defaultOpen: true, runStatus: 'refresh' }));
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    rendered.rerender(view({ defaultOpen: true, ...(change === 'run' ? { runId: 'run-b' } : { tenantId: 'tenant-b' }) }));
    expect(screen.queryByText('Previous workspace evidence')).toBeNull(); expect(oldSignal!.aborted).toBe(true);
    await screen.findByText('Current workspace evidence');
    await act(async () => { resolveOld(json({ items: [turn({ output: 'Late stale evidence' })] })); });
    expect(screen.queryByText('Late stale evidence')).toBeNull();
    expect(screen.getByText('Current workspace evidence')).toBeVisible();
  });

  it.each(['server-error', 'malformed'])('adopts an authoritative terminal run even when member refresh returns %s', async failure => {
    vi.useFakeTimers(); let phase = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url === path) return json(record(phase ? 'completed' : 'running'));
      if (phase === 1) return failure === 'server-error' ? json({ error: { message: 'Member read failed' } }, 500) : json({ items: [{ id: 'broken' }] });
      return json({ items: [turn({ status: phase ? 'completed' : 'running', output: phase ? 'Final durable evidence' : 'Earlier partial evidence' })] });
    });
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true })); await flushTimers();
    phase = 1; await flushTimers(2000);
    expect(screen.getByRole('status')).toHaveTextContent('Run status: Completed');
    expect(screen.getByRole('status')).not.toHaveTextContent('Updating automatically');
    expect(screen.getByText('Earlier partial evidence')).toBeVisible();
    expect(screen.getByText('Member records could not be refreshed. The records below are from the last successful read.')).toBeVisible();
    expect(screen.getByRole('alert')).toBeVisible();
    const calls = fetcher.mock.calls.length; await flushTimers(6000); expect(fetcher).toHaveBeenCalledTimes(calls);
    phase = 2; fireEvent.click(screen.getByRole('button', { name: 'Retry reading records' })); await flushTimers();
    expect(screen.getByText('Final durable evidence')).toBeVisible();
    expect(screen.queryByText(/records below are from the last successful read/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['run', 'turns'])('marks a failed %s read as paused until a successful manual retry', async failure => {
    vi.useFakeTimers(); let fail = false;
    const fetcher = vi.fn(async (url: string) => fail && url === (failure === 'run' ? path : `${path}/turns`)
      ? json({ error: { message: 'Observation unavailable' } }, 500)
      : json(url === path ? record('running') : { items: [turn()] }));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true })); await flushTimers();
    fail = true; await flushTimers(2000);
    expect(screen.getByRole('status')).toHaveTextContent('Reading paused; retry to resume');
    expect(screen.getByRole('status')).not.toHaveTextContent('Updating automatically');
    if (failure === 'run') expect(screen.getByRole('status')).toHaveTextContent('Last confirmed run status: Running');
    const calls = fetcher.mock.calls.length; await flushTimers(6000); expect(fetcher).toHaveBeenCalledTimes(calls);
    fail = false; fireEvent.click(screen.getByRole('button', { name: 'Retry reading records' })); await flushTimers();
    expect(screen.getByRole('status')).toHaveTextContent('Updating automatically');
    await flushTimers(2000); expect(fetcher).toHaveBeenCalledTimes(calls + 4);
  });

  it('clears sensitive cached turns when the run read succeeds but its member endpoint returns 403', async () => {
    vi.useFakeTimers(); let denied = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === path ? json(record(denied ? 'completed' : 'running'))
      : denied ? json({ error: { code: 'forbidden' } }, 403) : json({ items: [turn()] })));
    render(view({ defaultOpen: true })); await flushTimers();
    expect(screen.getByText('Complete member output')).toBeVisible();
    denied = true; await flushTimers(2000);
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText(/Run status:/)).toBeNull();
    expect(screen.queryByText(/No member records yet/)).toBeNull();
  });

  it('shows missing historical audit fields as unavailable without inventing instructions, numbering or history', async () => {
    const legacy = turn({ ordinal: undefined, createdAt: undefined, updatedAt: undefined, model: undefined, runtime: undefined,
      config: null, prompt: 'Actually stored old prompt', systemPrompt: null, messages: null, context: null });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === path ? record() : { items: [legacy] })));
    render(view({ defaultOpen: true })); await screen.findByRole('article');
    expect(screen.getByText('Number unavailable · Writer Ada')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable: this was not saved in this record.').length).toBeGreaterThan(3);
    expect(screen.getByText('Actually stored old prompt')).toBeInTheDocument();
    expect(screen.queryByText('No session history was supplied.')).toBeNull();
    expect(screen.queryByText(/Session history messages:/)).toBeNull();
  });

  it('localizes task-only audit and distinguishes an empty history from missing records', async () => {
    localStorage.setItem('superclaw_locale', 'zh');
    const item = turn({ messages: [], context: { version: 1, mode: 'task', purpose: 'review', historyMessages: 0, historyAvailable: 0, historyTruncated: false,
      upstreamMembers: [{ memberId: 'worker', memberName: '李白', round: 1, ordinal: 1 }], upstreamAvailable: 1, upstreamTruncated: false } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === path ? record() : { items: [item] })));
    render(view({ defaultOpen: true })); await screen.findByText('团队协作过程');
    fireEvent.click(screen.getByText('查看实际输入、指令与上下文来源'));
    expect(screen.getByText('未提供会话历史。')).toBeVisible();
    expect(screen.getByText(/仅当前任务；汇总、审核和返工仍接收必要操作数/)).toHaveTextContent('审核');
    expect(screen.getByText('李白 · 第1轮 · 调用 #1')).toBeVisible();
    expect(screen.queryByText('此记录未保存，无法提供。')).toBeNull();
  });

  it.each([401, 403, 404])('removes cached records after HTTP %s and lets the user retry read-only observation', async status => {
    vi.useFakeTimers(); let denied = false;
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => denied
      ? json({ error: { code: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : 'not_found' } }, status)
      : json(url === path ? record('running') : { items: [turn()] }));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true })); await flushTimers();
    expect(screen.getByText('Complete member output')).toBeVisible();
    denied = true; await flushTimers(2000); expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByText('Complete member output')).toBeNull();
    const calls = fetcher.mock.calls.length; await flushTimers(6000); expect(fetcher).toHaveBeenCalledTimes(calls);
    denied = false; fireEvent.click(screen.getByRole('button', { name: 'Retry reading records' })); await flushTimers();
    expect(screen.getByText('Complete member output')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull(); expect(fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true);
  });

  it('restores durable records on remount, and collapse or unmount only stops observing', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url === path ? record() : { items: [turn()] }));
    vi.stubGlobal('fetch', fetcher); const first = render(view({ defaultOpen: true })); await screen.findByText('Complete member output');
    fireEvent.click(screen.getByRole('button', { name: /Team collaboration/ }));
    expect(fetcher.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
    first.unmount(); render(view({ defaultOpen: true })); await screen.findByText('Complete member output');
    expect(fetcher).toHaveBeenCalledTimes(4); expect(fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true);
  });

  it('uses a general run label for single-agent records and rejects malformed or foreign responses', async () => {
    let phase = 'single';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === path ? record('completed', phase === 'foreign' ? 'foreign-run' : 'run-a') : phase === 'malformed' ? { items: [{ id: 'broken' }] } : { items: [] })));
    const rendered = render(view({ defaultOpen: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Run process/ })).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByText('This run has no additional operation records.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Run process/ }));
    await screen.findByText('This run has no additional operation records.');
    expect(screen.getByRole('button', { name: /Run process/ })).toBeVisible(); expect(screen.queryByText('Team collaboration')).toBeNull();
    phase = 'malformed'; rendered.rerender(view({ defaultOpen: true, runStatus: 'new' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid member turn response.');
    phase = 'foreign'; fireEvent.click(screen.getByRole('button', { name: 'Retry reading records' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid run record response.'));
  });

  it('observes active single-Agent calls, then folds empty completed details while preserving manual inspection', async () => {
    vi.useFakeTimers(); let completed = false;
    const fetcher = vi.fn(async (url: string) => json(url === path ? record(completed ? 'completed' : 'running') : { items: [] }));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true })); await flushTimers();
    expect(screen.getByText('Execution is active; waiting for output.')).toBeVisible();
    completed = true; await flushTimers(2000);
    const toggle = screen.getByRole('button', { name: /Run process/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Completed');
    expect(screen.queryByText('This run has no additional operation records.')).toBeNull();
    fireEvent.click(toggle); await flushTimers();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Run status: Completed');
    expect(screen.getByText('This run has no additional operation records.')).toBeVisible();
    const calls = fetcher.mock.calls.length; await flushTimers(6000); expect(fetcher).toHaveBeenCalledTimes(calls);
  });
});

describe('project operation observations', () => {
  const project = (status = 'running', items: unknown[] = [], truncated = false) => ({ ...record(status), executionKind: 'workspace', workspaceActivity: { items, truncated } });
  it('polls actual operation starts without querying team turns or inventing success', async () => {
    vi.useFakeTimers(); let phase = 0;
    const fetcher = vi.fn(async () => json(project(phase === 2 ? 'completed' : 'running', phase ? [
      { step: 1, tool: 'workspace_list' }, { step: 2, tool: 'workspace_exec', command: 'PRIVATE COMMAND', args: { key: 'PRIVATE KEY' } },
    ] : [])));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true })); await flushTimers();
    expect(screen.getByText('Execution is active; waiting for the first project operation.')).toBeVisible();
    expect(screen.queryByText(/member records/i)).toBeNull();
    phase = 1; await flushTimers(2000);
    expect(screen.getByText('Last started:', { exact: false })).toHaveTextContent('Run a terminal command · Step 2');
    const history = screen.getByText('Operation history · 2').closest('details')!;
    expect(history).not.toHaveAttribute('open');
    fireEvent.click(within(history).getByText('Operation history · 2'));
    expect(within(history).getByText('Started: Inspect project files')).toBeVisible();
    expect(within(history).getByText('Started: Run a terminal command')).toBeVisible();
    expect(within(history).getByText(/not success/)).toBeVisible();
    expect(screen.queryByText(/PRIVATE|checks passed|published successfully/i)).toBeNull();
    expect(fetcher.mock.calls.every(([url]) => url === path)).toBe(true);
    phase = 2; await flushTimers(2000);
    fireEvent.click(screen.getByRole('button', { name: /Project execution/ })); await flushTimers();
    expect(screen.getByRole('status')).toHaveTextContent('Run status: Completed');
    expect(screen.queryByText(/Updating automatically/)).toBeNull();
    const count = fetcher.mock.calls.length; await flushTimers(6000); expect(fetcher).toHaveBeenCalledTimes(count);
  });

  it.each(['failed', 'cancelled', 'interrupted'])('keeps operation-start semantics after the run is %s', async terminal => {
    vi.stubGlobal('fetch', vi.fn(async () => json(project(terminal, [{ step: 3, tool: 'workspace_publish' }], true))));
    render(view({ defaultOpen: true }));
    const disclosure = await screen.findByText('Operation history · 1'); fireEvent.click(disclosure);
    expect(screen.getByText('Started: Publish a deliverable')).toBeVisible();
    expect(screen.getByText('Only the latest 64 operations are shown.')).toBeVisible();
    expect(screen.queryByText(/Publish succeeded|Successfully published|Running/)).toBeNull();
  });

  it('uses Chinese labels and clears recorded operations when access is lost', async () => {
    localStorage.setItem('superclaw_locale', 'zh'); vi.useFakeTimers(); let denied = false;
    vi.stubGlobal('fetch', vi.fn(async () => denied ? json({ error: { code: 'forbidden' } }, 403) : json(project('running', [{ step: 1, tool: 'workspace_read' }]))));
    render(view({ defaultOpen: true })); await flushTimers();
    expect(screen.getByText('读取文件')).toBeVisible();
    denied = true; await flushTimers(2000);
    expect(screen.getByRole('alert')).toBeVisible(); expect(screen.queryByText('读取文件')).toBeNull();
    expect(screen.queryByText(/操作记录/)).toBeNull();
  });

  it.each([
    [{ step: 0, tool: 'workspace_exec' }], [{ step: 17, tool: 'workspace_exec' }], [{ step: 1, tool: 'PRIVATE COMMAND' }],
    [{ step: 2, tool: 'workspace_read' }, { step: 1, tool: 'workspace_write' }],
    Array.from({ length: 65 }, () => ({ step: 1, tool: 'workspace_read' })),
  ])('rejects malformed operation records without rendering their payload', async items => {
    vi.stubGlobal('fetch', vi.fn(async () => json(project('running', items))));
    render(view({ defaultOpen: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid run record response.');
    expect(screen.queryByText(/PRIVATE COMMAND|Operation history|Last started/)).toBeNull();
  });

  it('does not fetch member records for explicitly identified text runs', async () => {
    const fetcher = vi.fn(async () => json({ ...record('running'), executionKind: 'text' }));
    vi.stubGlobal('fetch', fetcher); render(view({ defaultOpen: true }));
    await screen.findByText('Execution is active; waiting for output.');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(screen.queryByText(/member record/i)).toBeNull();
  });
});
