// Which canvas-bar tool a cloud canvas offers in each mode: simple mode (the hosted default) gets 从网址读取, developer
// mode the knowledge map (which holds the same reader in its import panel); and 加入任务 from simple mode really sets
// the canvas's knowledge references and drafts the assistant's next request.
import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { canvasKnowledgeRevisionIds } from '../src/saas/canvasBridge';
import type { CanvasRecord, Tenant } from '../src/saas/api';
import { createSessionNode } from '../src/canvas/canvasDoc';
import { UI_MODE_STORAGE_KEY } from '../src/canvas/uiMode';

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity = { user: { id: 'user-a', name: 'Alice', email: 'alice@example.test', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const capabilities = {
  skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: true, maxRunItems: 12, maxRunBytes: 4096, maxPerScope: 200 },
  webReader: { enabled: true, perDay: 30, usedToday: 0 },
  render: { enabled: false, perDay: 20, usedToday: 0, limits: { maxSeconds: 20, maxFps: 60, maxWidth: 1920, maxHeight: 1920, maxFrames: 1800, maxHtmlBytes: 6291456 } },
};
const page = { id: 'web-a', kind: 'source', title: 'Example page', content: 'An example page.', version: 1, currentRevisionId: 'revision-web',
  contentHash: 'hash-web', sourceUri: 'https://example.com/a', provenance: { origin: 'web' }, createdAt: '2026-10-16T06:00:00Z', updatedAt: '2026-10-16T06:00:00Z' };

function open(mode: 'simple' | 'developer') {
  localStorage.setItem(UI_MODE_STORAGE_KEY, mode);
  const node = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: 'Step a', runtime: 'openai', model: 'qwen',
    binding: { companyId: tenant.id, agentId: 'agent-a', agentName: 'a' } };
  const cloud: CanvasRecord = { id: 'canvas-0', tenantId: tenant.id, name: 'Canvas 0', version: 1, document: { nodes: [node] } as CanvasRecord['document'],
    createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z' };
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/appearance')) return json(appearanceFixture);
    if (url.endsWith('/auth/me')) return json(identity);
    if (url.endsWith('/runtime')) return json({ available: false, configured: false, models: [] });
    if (url.endsWith('/graph-runs')) return json({ items: [] });
    if (url.endsWith('/capabilities')) return json(capabilities);
    if (url.endsWith('/knowledge/sources/web')) return json(page, 201);
    if (url.includes('/knowledge/context?revisionIds=revision-web')) return json({ text: 'Quoted knowledge evidence', truncated: false, items: [{ documentId: page.id,
      revisionId: page.currentRevisionId, title: page.title, kind: 'source', contentHash: page.contentHash, content: page.content, sourceUri: page.sourceUri, provenance: page.provenance }] });
    if (init.method === 'PUT') return json({ ...cloud, version: cloud.version + 1, document: JSON.parse(String(init.body)).document });
    return json(cloud);
  }));
  window.history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=${cloud.id}`);
  render(<SaaSApp />);
  return { posts };
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the canvas bar in each mode', () => {
  it('offers 从网址读取 in simple mode, and no knowledge map', async () => {
    open('simple');
    expect(await screen.findByRole('button', { name: '从网址读取' }, { timeout: 15000 })).toBeVisible();
    expect(screen.queryByRole('button', { name: '知识地图' })).toBeNull();
  });

  it('keeps the knowledge map in developer mode, without a second reader in the bar', async () => {
    open('developer');
    expect(await screen.findByRole('button', { name: '知识地图' }, { timeout: 15000 })).toBeVisible();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: '从网址读取' })).toBeNull();
  });

  it('cites the page in the next task from simple mode: the canvas references and the assistant draft', async () => {
    const { posts } = open('simple');
    fireEvent.click(await screen.findByRole('button', { name: '从网址读取' }, { timeout: 15000 }));
    const dialog = await screen.findByRole('dialog', { name: '从网址读取' });
    fireEvent.change(within(dialog).getByLabelText('网页地址'), { target: { value: 'https://example.com/a' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '读取并保存' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: '加入任务' }));
    expect(posts.filter(post => post.url.endsWith('/knowledge/sources/web'))).toHaveLength(1);
    await waitFor(() => expect(canvasKnowledgeRevisionIds()).toEqual(['revision-web']));
    expect(await screen.findByTitle('已引用 1 份知识')).toBeVisible();
    await waitFor(() => expect(screen.getAllByRole('textbox').some(box => (box as HTMLTextAreaElement).value.includes('请结合网页「Example page」完成任务：'))).toBe(true));
    // The references stay when the canvas switches to developer mode, and its knowledge map shows (and clears) them.
    fireEvent.click(screen.getByRole('button', { name: '普通模式' }));
    expect(await screen.findByRole('button', { name: '知识地图' })).toBeVisible();
    const chip = await screen.findByTitle('已引用 1 份知识');
    fireEvent.click(within(chip).getByRole('button', { name: '清除任务知识引用' }));
    await waitFor(() => expect(canvasKnowledgeRevisionIds()).toEqual([]));
    await waitFor(() => expect(screen.queryByTitle('已引用 1 份知识')).toBeNull());
  });
});
