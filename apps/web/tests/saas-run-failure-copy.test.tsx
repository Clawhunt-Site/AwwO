// A cloud canvas run's failed node records its run's code (graph_runs.go), and the canvas showed it as it was: an opened
// node read 「上次运行失败：run_timeout」 and the timeline's row kept `run_timeout` in its tooltip (owner 2026-10-21: an error
// says what to do). The node's own Send already read the copy (canvasBridge.ts); a run of the canvas now reads the same.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { SessionTile, runBadgeText } from '../src/canvas/SessionTile';
import { RunTimeline } from '../src/canvas/RunTimeline';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { emptyDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { configureCanvasStorage } from '../src/canvas/canvasStorage';
import { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { LocaleProvider } from '../src/canvas/i18n';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';
import type { RunNodeStatus } from '../src/canvas/runGraph';
import { resetAllSessions } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { planErrorMessage, runErrorText } from '../src/saas/canvasErrors';

beforeEach(() => { cleanup(); resetAllSessions(); });

const node = (): SessionNode => ({ ...createAgentTemplate('general', { x: 0, y: 0 }, 'zh'), id: 'n', title: '关卡设计' });
const opened = (locale: 'zh' | 'en', run: RunNodeStatus) => render(<LocaleProvider locale={locale}><CanvasUiModeProvider mode="simple">
  <div className="canvas-root"><SessionTile node={node()} scale={1} focused onRunNode={vi.fn()} onAskAssistant={vi.fn()} onUpdateNode={vi.fn()}
    freeConversation initializeOnSend onSend={vi.fn()} run={run} /></div></CanvasUiModeProvider></LocaleProvider>);

describe('a cloud run’s failure code on the canvas', () => {
  it.each(['zh', 'en'] as const)('reads as its copy in an opened node’s failure note (%s), with the ways on beside it', locale => {
    opened(locale, { state: 'failed', detail: 'run_timeout' });
    const note = document.querySelector<HTMLElement>('.awwo-node-failure')!;
    expect(note.textContent).toContain(runErrorText('run_timeout', locale)!);
    expect(note.textContent).not.toContain('run_timeout');
    expect(within(note).getAllByRole('button').map(button => button.textContent))
      .toEqual(locale === 'zh' ? ['重新运行', '让助手调整'] : ['Run it again', 'Let the assistant fix it']);
  });

  it('keeps a detail it has no copy for as it is, and the copy a node’s own Send already gave', () => {
    opened('zh', { state: 'failed', detail: 'provider said no' });
    expect(document.querySelector('.awwo-node-failure')!.textContent).toContain('provider said no');
    cleanup();
    const copy = runErrorText('provider_unavailable', 'zh')!;
    opened('zh', { state: 'failed', detail: copy });
    expect(document.querySelector('.awwo-node-failure')!.textContent).toContain(copy);
  });

  it('reads as its copy in the timeline row’s tooltip, the row itself saying it failed', () => {
    render(<LocaleProvider locale="en"><RunTimeline nodes={[node()]} runs={{ n: { state: 'failed', detail: 'team_timeout' } }}
      runStartedAt={1_000} now={2_000} onClose={vi.fn()} /></LocaleProvider>);
    const state = within(screen.getByTestId('runline-n')).getByText('Failed');
    expect(state.getAttribute('title')).toBe(runErrorText('team_timeout', 'en'));
  });

  it('reads a blocked node’s code as its copy on the badge', () => {
    expect(runBadgeText({ state: 'blocked', detail: 'interrupted' }, 'zh')).toBe(runErrorText('interrupted', 'zh'));
    expect(runBadgeText({ state: 'failed', detail: 'run_timeout' }, 'en')).toBe('Failed');
  });
});

describe('a planning run that failed', () => {
  const tenant = { id: 'plan-tenant', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const events = (...values: unknown[]) => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  beforeEach(() => {
    localStorage.clear(); configureCanvasStorage('plan-user', tenant.id, 'plan-canvas');
    configureSaaSCanvas({ tenant, canvasId: 'plan-canvas' }); configureSaaSCanvasSave(async () => 1);
  });
  afterEach(() => { clearSaaSCanvas(); localStorage.clear(); vi.unstubAllGlobals(); document.documentElement.lang = ''; });

  it.each([['zh', 'zh-CN'], ['en', 'en']] as const)('says so as the canvas assistant’s (%s), keeping its code for the caller', async (locale, lang) => {
    document.documentElement.lang = lang;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan') ? json({ id: 'plan-run', status: 'running', terminal: false }, 202)
      : events({ type: 'running' }, { type: 'failed', code: 'run_timeout', message: 'Pi execution failed' })));
    const failure = await requestCanvasPlan('Build a report', emptyDocument(), [], new AbortController().signal, locale).catch(error => error);
    expect(failure).toMatchObject({ code: 'run_timeout', message: planErrorMessage('Pi execution failed', 'run_timeout') });
    expect(failure.message).toContain(locale === 'zh' ? '画布保持原样' : 'the canvas has not changed');
    expect(failure.message).not.toBe(runErrorText('run_timeout', locale));
  });
});
