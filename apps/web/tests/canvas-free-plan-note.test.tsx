import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { canvasText, LocaleProvider } from '../src/canvas/i18n';
import { resetAllSessions } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

// A hosted canvas whose free trial has ended (route-usage freePlan.ended) says so on the board, with the plans for the
// workspace's owner only: its plan alone opens the workspace, so anyone else is told the owner subscribes. Before the end,
// or on a paid workspace, nothing is said.
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
let usage: unknown = {};

function open(role: string, locale: 'zh' | 'en' = 'zh') {
  const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role, maxConcurrentRuns: 2, maxRunsPerDay: 100 };
  configureSaaSCanvas({ tenant, canvasId: 'canvas' });
  const node = { ...createSessionNode('llm', { x: 40, y: 40 }), id: 'brief', title: 'brief', runtime: 'pi', model: 'profile-main',
    binding: { companyId: tenant.id, agentId: 'agent-brief', agentName: 'brief' }, issueId: 'session-brief' };
  const doc: CanvasDocument = { ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [node], edges: [] };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  render(<LocaleProvider locale={locale}><CanvasSurface storageMode="cloud" runtimeReadJson={reader} /></LocaleProvider>);
}

beforeEach(() => {
  cleanup(); localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvasSave(async () => 9);
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/route-usage')) return new Response(JSON.stringify(usage));
    if (url.endsWith('/runtime')) return new Response(JSON.stringify({ available: true, plannerAvailable: true, plannerRuntime: 'pi' }));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); });

const ended = { limited: true, interested: false, daily: { limit: 30, used: 0 }, freePlan: { until: '2026-11-12T16:00:00Z', ended: true } };

describe('the board after the free trial', () => {
  it('tells the owner it has ended, with the way to the plans', async () => {
    usage = ended;
    open('owner');
    const note = await screen.findByText(canvasText('zh', 'canvas.freePlanEndedOwner'));
    const box = note.closest('.awwo-plan-ended-note') as HTMLElement;
    expect(box).toHaveAttribute('role', 'status');
    expect(box.querySelector('a')).toHaveAttribute('href', expect.stringContaining('account=plans'));
  });

  it('tells anyone else the owner subscribes, with nothing to buy for the workspace', async () => {
    usage = ended;
    open('member', 'en');
    const note = await screen.findByText(canvasText('en', 'canvas.freePlanEndedOther'));
    expect(note.closest('.awwo-plan-ended-note')?.querySelector('a')).toBeNull();
  });

  it('says nothing during the trial or on a paid plan', async () => {
    for (const value of [{ ...ended, freePlan: { until: '2026-11-12T16:00:00Z', ended: false } },
      { limited: true, interested: false, daily: { limit: 300, used: 0 }, plan: { id: 'pro', credits: { granted: 2000, gift: 0, spent: 0, carried: 0, remaining: 2000 } } }]) {
      usage = value;
      open('owner');
      await screen.findByRole('button', { name: canvasText('zh', 'workspace.assistant'), exact: true });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(document.querySelector('.awwo-plan-ended-note')).toBeNull();
      cleanup();
    }
  });
});
