// The end of the free trial (owner 2026-11-07: after 2026-11-12 24:00 Beijing time a workspace whose owner has no paid
// plan runs nothing until it subscribes). The service refuses with 402 free_plan_ended; every place that turns a plan or
// allowance refusal into an upgrade offers the plans for it the same way, in the service's own words, and never the
// default model, which runs no more than any other then.
import { Fragment, useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionHost } from '../src/saas/AssistantExecution';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
import { canvasErrorMessage, isFreePlanEnded, planErrorMessage, runErrorText, runFailureText } from '../src/saas/canvasErrors';
import { accountURL } from '../src/saas/PersonalAccount';
import { PlanUpsell, planUpsellCode, upsellReason } from '../src/saas/PlanUpsell';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { TeamRunDetails } from '../src/saas/TeamRunDetails';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { useManagedExecution } from '../src/saas/useManagedExecution';

const COPY = {
  zh: '免费试用已结束：工作区所有者订阅 Pro 或 Max 后，就能继续规划和运行。画布和成果都还在。',
  en: 'The free trial has ended: once the workspace owner subscribes to Pro or Max, planning and runs work again. Your canvases and results are all still here.',
};
// The voucher's way to the plans, true for whoever reads it: the workspace runs again once its owner subscribes.
const OFFER = { zh: '查看 Pro / Max 套餐', en: 'See the Pro and Max plans' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const refusal = () => new SaaSApiError(402, 'free_plan_ended', 'The free trial has ended: subscribe to Pro or Max to keep running AwwO.');

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.documentElement.lang = ''; });

describe('the refusal’s words', () => {
  it('are the service’s copy in both languages, wherever a refusal or a recorded failure is read', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(saasErrorMessage(refusal(), locale)).toBe(COPY[locale]);
      expect(runErrorText('free_plan_ended', locale)).toBe(COPY[locale]);
      expect(runFailureText('free_plan_ended', locale)).toBe(COPY[locale]);
      document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
      // A node's own Send, and a plan the assistant was refused.
      expect(canvasErrorMessage(refusal())).toBe(COPY[locale]);
      expect(planErrorMessage(refusal())).toBe(COPY[locale]);
    }
  });

  it('are known as the end of the free trial by the code, or the copy in either language, and nothing else', () => {
    expect(isFreePlanEnded('free_plan_ended')).toBe(true);
    expect(isFreePlanEnded(' free_plan_ended ')).toBe(true);
    expect(isFreePlanEnded(COPY.zh)).toBe(true);
    expect(isFreePlanEnded(`${COPY.en} (2nd try)`)).toBe(true);
    for (const other of ['quota_exceeded', 'premium_quota_exceeded', 'free_plan_ended_soon', runErrorText('quota_exceeded', 'zh')!, '', undefined]) {
      expect(isFreePlanEnded(other), String(other)).toBe(false);
    }
  });
});

describe('the upgrade offered for it', () => {
  it('takes the refusal as one only a plan lifts', () => {
    expect(planUpsellCode([null, 'runtime_failed', 'free_plan_ended'])).toBe('free_plan_ended');
    expect(upsellReason('free_plan_ended')).toBe('ended');
    expect(upsellReason('quota_exceeded')).toBe('daily');
    expect(upsellReason('premium_quota_exceeded')).toBe('premium');
  });

  it.each(['zh', 'en'] as const)('says what the plans give and opens them, recording the interest (%s)', async locale => {
    localStorage.setItem('superclaw_locale', locale);
    const fetcher = vi.fn(async () => json({ recorded: true, clicks: 1 }));
    vi.stubGlobal('fetch', fetcher);
    render(<SaaSPreferencesProvider><PlanUpsell tenantId="tenant-a" reason="ended" /></SaaSPreferencesProvider>);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(locale === 'zh' ? 'Pro / Max 按月订阅' : 'Pro and Max are monthly plans');
    // The default model is no way on once the trial is over.
    expect(note).not.toHaveTextContent(locale === 'zh' ? '默认模型照常免费' : 'the default model stays free');
    const link = within(note).getByRole('link', { name: OFFER[locale] });
    expect(link).toHaveAttribute('href', accountURL('plans'));
    expect(link).toHaveAttribute('target', '_blank');
    link.addEventListener('click', event => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/v1/tenants/tenant-a/upgrade-interest', expect.objectContaining({ method: 'POST' })));
  });
});

// A node's run details (TeamRunDetails.tsx), which offer the plans for the codes PlanUpsell names.
describe('a node’s run refused at the end of the free trial', () => {
  it.each(['zh', 'en'] as const)('says so in the service’s words and offers the plans (%s)', async locale => {
    localStorage.setItem('superclaw_locale', locale);
    configureSaaSCanvas({ tenant: { id: 'team', name: 'Team', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 }, canvasId: 'canvas' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/runs/run-1')
      ? json({ id: 'run-1', tenantId: 'team', status: 'failed', executionKind: 'text', error: 'free_plan_ended' })
      : url.endsWith('/turns') ? json({ items: [] }) : json({ error: { code: 'not_found', message: 'missing' } }, 404)));
    render(<SaaSPreferencesProvider><TeamRunDetails tenantId="team" runId="run-1" defaultOpen /></SaaSPreferencesProvider>);
    expect(await screen.findByText(COPY[locale])).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('link', { name: OFFER[locale] })).toHaveAttribute('href', accountURL('plans'));
  });
});

// The canvas assistant's direct tasks (AssistantExecution.tsx), as the canvas shows them.
const time = '2026-11-13T01:00:00Z';
const summary = { id: 'run-a', status: 'failed', prompt: '整理项目文件', createdAt: time, updatedAt: time };
const refused = { ...summary, output: '', error: 'free_plan_ended', canRespond: false, canCancel: false, truncated: false, messages: [], approvals: [], artifacts: [] };
const models = (list: unknown[]) => ({ ready: true, capabilities: { workspace: true, approvals: true }, models: list });
const qwen = { id: 'qwen3.8-27b-p6', label: 'qwen3.8-27b-p6', runtime: 'pi', efforts: [], route: 'free' };
const opus = { id: 'claude-opus-5', label: 'Claude Opus 5', runtime: 'pi', efforts: [], route: 'gate' };
function Conversation() {
  const execution = useManagedExecution('tenant-a', 'canvas-a');
  const host = executionHost(execution);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { execution.activate(); execution.setVisible(true); }, []);
  return <div className="awwo-assistant-messages" role="log" aria-label="执行记录">
    {host.renderEarlier(new Set(), true)}<Fragment>{host.renderNotices(true)}</Fragment>{host.settings}
  </div>;
}
const view = () => render(<SaaSPreferencesProvider><Conversation /></SaaSPreferencesProvider>);

describe('a direct task', () => {
  it.each(['zh', 'en'] as const)('refused at the end of the free trial offers only the plans (%s)', async locale => {
    localStorage.setItem('superclaw_locale', locale);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.endsWith('/computer-runtime') ? models([qwen, opus])
      : url.endsWith('/computer-runs') ? { items: [summary] } : url.endsWith('/upgrade-interest') ? { recorded: true, clicks: 1 } : refused)));
    view();
    expect(await screen.findByText(COPY[locale])).toBeInTheDocument();
    expect(screen.getByRole('link', { name: OFFER[locale] })).toHaveAttribute('href', expect.stringContaining('account=plans'));
    // The default model runs no more than any other then.
    expect(screen.queryByRole('button', { name: locale === 'zh' ? /改用默认模型/ : /Use the default model/ })).toBeNull();
  });
});

describe('a model the plan does not include, chosen for direct tasks', () => {
  const locked = { ...opus, requiresUpgrade: true };
  // Listed first, the model is the one direct tasks start on (as a workspace's catalogue may list it).
  const serve = (usage: unknown) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return json(url.endsWith('/computer-runtime') ? models([locked, qwen]) : url.endsWith('/computer-runs') ? { items: [] }
        : url.endsWith('/route-usage') ? usage : { items: [] });
    }));
    return calls;
  };
  const trial = (ended: boolean) => ({ limited: true, interested: false, daily: { limit: 100, used: 4 }, freePlan: { until: '2026-11-12T16:00:00Z', ended } });

  it.each(['zh', 'en'] as const)('says the free trial is over instead of offering the default model, once it is (%s)', async locale => {
    localStorage.setItem('superclaw_locale', locale);
    serve(trial(true));
    view();
    const note = await waitFor(() => { const found = document.querySelector<HTMLElement>('.awwo-execution-plan-needed'); expect(found).not.toBeNull(); return found!; });
    await waitFor(() => expect(note).toHaveTextContent(COPY[locale]));
    expect(note).not.toHaveTextContent(locale === 'zh' ? '可以先换成默认模型免费执行' : 'Choose the default model to run it free');
    expect(within(note).getByRole('link', { name: OFFER[locale] })).toHaveAttribute('href', expect.stringContaining('account=plans'));
  });

  it('keeps offering the default model while the free trial runs', async () => {
    const calls = serve(trial(false));
    view();
    const note = await waitFor(() => { const found = document.querySelector<HTMLElement>('.awwo-execution-plan-needed'); expect(found).not.toBeNull(); return found!; });
    await waitFor(() => expect(calls.some(url => url.endsWith('/route-usage'))).toBe(true));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(note).toHaveTextContent('这个模型不在当前工作区的免费额度里，需要 Pro / Max，直接执行会被拒绝。可以先换成默认模型免费执行。');
    expect(within(note).getByRole('link', { name: '升级 Pro / Max，继续使用高级模型' })).toBeInTheDocument();
  });
});
