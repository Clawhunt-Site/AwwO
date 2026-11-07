import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { PLANNING_STORAGE_KEY } from '../src/canvas/canvasPlanning';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { canvasText, LocaleProvider, type CanvasTextKey } from '../src/canvas/i18n';
import { resetAllSessions } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

// The Next card under a canvas whose newest request names live data (liveDataNeed): AwwO's own Agents have no live web,
// so its footnote says how the person's own Agent brings it, treg through 同屏 → 邀请 Agent. A request that names none
// gets no such line.
type Locale = 'zh' | 'en';
const text = (locale: Locale, key: CanvasTextKey) => canvasText(locale, key);
const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
const agent = (id: string, x: number): SessionNode => ({ ...createSessionNode('llm', { x, y: 40 }), id, title: id, runtime: 'pi', model: 'profile-main',
  binding: { companyId: tenant.id, agentId: `agent-${id}`, agentName: id }, issueId: `session-${id}` });

function seed(request: string) {
  const doc: CanvasDocument = { ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [agent('brief', 40), agent('draft', 640)], edges: [] };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  canvasStorage().setItem(PLANNING_STORAGE_KEY, JSON.stringify({ draft: '', messages: [
    { id: 'm-1', role: 'user', content: request, route: 'plan' },
    { id: 'm-2', role: 'assistant', content: 'Planned two nodes.', status: 'applied', route: 'plan' },
  ] }));
}

function nextCard(locale: Locale) {
  render(<LocaleProvider locale={locale}><CanvasSurface storageMode="cloud" runtimeReadJson={reader} /></LocaleProvider>);
  fireEvent.click(within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: text(locale, 'workspace.assistant'), exact: true }));
  const sidebar = within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
  return sidebar.getByRole('group', { name: text(locale, 'assistant.nextTitle') });
}

beforeEach(() => {
  cleanup(); localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/runtime')) return new Response(JSON.stringify({ available: true, plannerAvailable: true, plannerRuntime: 'pi' }));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); });

describe('the Next card and live data', () => {
  it('says how to bring live data when the newest request names it', () => {
    seed('做一份竞品调研，整理小红书上的热门话题和 SEO 关键词，再做成一页报告');
    const card = nextCard('zh');
    expect(within(card).getByText(text('zh', 'assistant.nextLiveData'))).toBeVisible();
    expect(text('zh', 'assistant.nextLiveData')).toContain('同屏 → 邀请 Agent');
    expect(text('zh', 'assistant.nextLiveData')).toContain('treg');
  });

  it('says nothing of it for a request that names no live data', () => {
    seed('做一个可以在浏览器里玩的贪吃蛇游戏');
    const card = nextCard('zh');
    expect(within(card).queryByText(text('zh', 'assistant.nextLiveData'))).toBeNull();
  });

  it('reads in English, naming the panel by its English name', () => {
    seed('Research our competitors and the latest news on them, then build a landing page');
    const card = nextCard('en');
    expect(within(card).getByText(text('en', 'assistant.nextLiveData'))).toBeVisible();
    expect(text('en', 'assistant.nextLiveData')).toContain('Multiplayer → Invite an Agent');
    expect(text('en', 'assistant.nextLiveData')).not.toMatch(/[㐀-鿿]/);
  });
});
