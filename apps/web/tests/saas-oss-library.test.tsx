// The workspace library added with the open-source intake: importing a knowledge source from a web address, the
// memory workbench, the skill library, their canvas-bar tools and the messages for their refusals.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeWorkbench } from '../src/saas/KnowledgeWorkbench';
import { MemoryWorkbench } from '../src/saas/MemoryWorkbench';
import { SkillLibrary } from '../src/saas/SkillLibrary';
import { CanvasLibraryTools } from '../src/saas/CanvasLibraryTools';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
import { importKnowledgeFromWeb } from '../src/saas/knowledgeApi';
import { forgetSkillCatalog } from '../src/saas/skillsApi';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const tenant = '/api/v1/tenants/tenant-a';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Call = { url: string; method: string; body: any };
function server(routes: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return routes(call) ?? json({ error: { code: 'not_found', message: 'missing' } }, 404);
  });
  vi.stubGlobal('fetch', fetcher);
  return calls;
}
const capabilities = (webReader = true) => ({
  skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: true, maxRunItems: 12, maxRunBytes: 4096, maxPerScope: 200 },
  webReader: { enabled: webReader, perDay: 30, usedToday: 2 },
  render: { enabled: false, perDay: 20, usedToday: 0, limits: { maxSeconds: 20, maxFps: 60, maxWidth: 1920, maxHeight: 1920, maxFrames: 1800, maxHtmlBytes: 6291456 } },
});
const knowledgeDocument = (patch: Record<string, unknown> = {}) => ({ id: 'source-a', kind: 'source', title: '访谈原文', content: '客户需要中文检索。', version: 1,
  currentRevisionId: 'revision-a', contentHash: 'hash-a', sourceUri: '', provenance: { origin: 'user' }, createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T01:00:00Z', ...patch });
const note = (patch: Record<string, unknown> = {}) => ({ id: 'm1', canvasId: null, scope: 'workspace', title: '对外文案用简体中文', body: '', kind: 'style', status: 'active', origin: 'user',
  pinned: true, source: {}, contentHash: 'h1', version: 3, useCount: 5, lastUsedAt: null, createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-02T01:00:00Z', ...patch });
const skill = (patch: Record<string, unknown> = {}) => ({ ref: 'builtin:motion-lab', name: 'motion-lab', title: 'Motion Lab', titleZh: '代码动效实验室', description: 'Animation drawn in code',
  descriptionZh: '用代码绘制的动画', category: 'video', applies: ['html', 'motion'], version: 1, source: 'builtin', bytes: 40, contentHash: 'sh1', ...patch });
const workspaceSkill = skill({ ref: `workspace:a${'b'.repeat(32)}`, id: `a${'b'.repeat(32)}`, name: 'house-style', title: 'House style', titleZh: undefined, description: 'Our house style',
  descriptionZh: undefined, category: 'writing', applies: ['writing'], source: 'workspace', version: 2 });
const limits = { maxNodeSkills: 4, maxNodeSkillBytes: 20480, maxSkillBodyBytes: 12288, maxWorkspaceSkills: 100 };
const preferences = (children: React.ReactNode) => <SaaSPreferencesProvider>{children}</SaaSPreferencesProvider>;

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); forgetSkillCatalog('tenant-a'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('knowledge from a web address', () => {
  it('posts one address to the server reader with a longer allowance', async () => {
    const calls = server(call => call.url.endsWith('/knowledge/sources/web') ? json(knowledgeDocument({ id: 'web-a', provenance: { origin: 'web' } }), 201) : undefined);
    const value = await importKnowledgeFromWeb('tenant-a', { url: 'https://example.com/a', operationId: 'knowledge-op-1' }, new AbortController().signal);
    expect(value.id).toBe('web-a');
    expect(calls).toEqual([{ url: `${tenant}/knowledge/sources/web`, method: 'POST', body: { url: 'https://example.com/a', operationId: 'knowledge-op-1' } }]);
  });

  it('offers the address field only when the server reads the web, and saves the page as a source', async () => {
    let documents = [knowledgeDocument()];
    const calls = server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities());
      if (call.url.endsWith('/knowledge/sources/web')) { const created = knowledgeDocument({ id: 'web-a', title: 'Example page', provenance: { origin: 'web' } }); documents = [...documents, created]; return json(created, 201); }
      if (call.url.startsWith(`${tenant}/knowledge`)) return json({ documents, links: [], proposals: [] });
    });
    render(preferences(<KnowledgeWorkbench tenantId="tenant-a" onTaskContext={() => {}} />));
    await screen.findByRole('button', { name: '查看 访谈原文' });
    fireEvent.click(screen.getByRole('button', { name: '导入资料' }));
    const box = await screen.findByRole('group', { name: '从网址读取' });
    expect(box).toHaveTextContent('今天已用 2 / 30 次');
    const read = within(box).getByRole('button', { name: '读取并保存' });
    expect(read).toBeDisabled();
    fireEvent.change(within(box).getByLabelText('网页地址'), { target: { value: 'https://example.com/a' } });
    fireEvent.click(read);
    await screen.findByText(/网页正文已作为原始资料入库/);
    const sent = calls.find(call => call.url.endsWith('/sources/web'))!;
    expect(sent.body).toEqual({ url: 'https://example.com/a', operationId: expect.stringMatching(/^knowledge-/) });
    expect(await screen.findByRole('button', { name: '查看 Example page' })).toBeVisible();
  });

  it('keeps the field away when the reader is off', async () => {
    server(call => call.url.endsWith('/capabilities') ? json(capabilities(false)) : call.url.startsWith(`${tenant}/knowledge`) ? json({ documents: [knowledgeDocument()], links: [], proposals: [] }) : undefined);
    render(preferences(<KnowledgeWorkbench tenantId="tenant-a" onTaskContext={() => {}} />));
    await screen.findByRole('button', { name: '查看 访谈原文' });
    fireEvent.click(screen.getByRole('button', { name: '导入资料' }));
    await waitFor(() => expect(screen.getByLabelText('资料标题')).toBeVisible());
    expect(screen.queryByRole('group', { name: '从网址读取' })).toBeNull();
  });
});

describe('memory workbench', () => {
  it('lists both scopes, confirms a proposal, pins, adds a canvas note and deletes in two steps', async () => {
    let items = [note(), note({ id: 'm2', canvasId: 'canvas-a', scope: 'canvas', title: '主色用 #E76F51', kind: 'decision', status: 'proposed', pinned: false, version: 1, useCount: 0 })];
    const calls = server(call => {
      if (call.method === 'GET' && call.url.startsWith(`${tenant}/memory?`)) return json({ items });
      if (call.method === 'PATCH') { const id = call.url.split('/').pop()!; items = items.map(item => item.id === id ? { ...item, ...call.body, version: Number(item.version) + 1 } : item); return json(items.find(item => item.id === id)); }
      if (call.method === 'POST') { const created = note({ id: 'm3', canvasId: call.body.canvasId ?? null, scope: call.body.canvasId ? 'canvas' : 'workspace', title: call.body.title, body: call.body.body, kind: call.body.kind, pinned: call.body.pinned, version: 1, useCount: 0 }); items = [...items, created]; return json(created, 201); }
      if (call.method === 'DELETE') { const id = call.url.split('/').pop()!; items = items.filter(item => item.id !== id); return new Response(null, { status: 204 }); }
    });
    render(preferences(<MemoryWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    const list = await screen.findByRole('list');
    expect(calls[0].url).toBe(`${tenant}/memory?canvasId=canvas-a&status=active%2Cproposed`);
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '本画布' }));
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '全部' }));

    const proposed = within(screen.getByRole('list')).getByText('主色用 #E76F51').closest('li')!;
    fireEvent.click(within(proposed).getByRole('button', { name: '确认' }));
    await screen.findByText('已确认。之后的运行会引用它。');
    expect(calls.find(call => call.method === 'PATCH')).toMatchObject({ url: `${tenant}/memory/m2`, body: { version: 1, status: 'active' } });

    const pinned = within(screen.getByRole('list')).getByText('对外文案用简体中文').closest('li')!;
    fireEvent.click(within(pinned).getByRole('button', { name: '取消置顶' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter(call => call.method === 'PATCH')[1].body).toEqual({ version: 3, pinned: false });

    fireEvent.click(screen.getByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '标题不超过 12 个字' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText(/记忆已保存/);
    expect(calls.find(call => call.method === 'POST')!.body).toEqual({ canvasId: 'canvas-a', title: '标题不超过 12 个字', body: '', kind: 'preference', pinned: false });

    const created = within(screen.getByRole('list')).getByText('标题不超过 12 个字').closest('li')!;
    fireEvent.click(within(created).getByRole('button', { name: '删除' }));
    expect(calls.some(call => call.method === 'DELETE')).toBe(false);
    fireEvent.click(within(created).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(calls.find(call => call.method === 'DELETE')?.url).toBe(`${tenant}/memory/m3`));
  });

  it('refuses an over-long note before sending it and offers no edits read-only', async () => {
    server(call => call.url.includes('/memory?') ? json({ items: [note()] }) : undefined);
    const { unmount } = render(preferences(<MemoryWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    await screen.findByText('对外文案用简体中文');
    fireEvent.click(screen.getByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '长' } });
    fireEvent.change(screen.getByLabelText('补充说明（可选）'), { target: { value: '字'.repeat(700) } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    unmount();
    render(preferences(<MemoryWorkbench tenantId="tenant-a" canvasId="canvas-a" readOnly onClose={() => {}} />));
    await screen.findByText('对外文案用简体中文');
    expect(screen.queryByRole('button', { name: '新建记忆' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });
});

describe('skill library', () => {
  it('reads a skill in full, writes one, imports a SKILL.md and archives a workspace skill', async () => {
    let items = [skill(), workspaceSkill];
    const calls = server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/skills`) return json({ items, limits });
      if (call.method === 'GET' && call.url.startsWith(`${tenant}/skills/`)) {
        const ref = decodeURIComponent(call.url.slice(`${tenant}/skills/`.length));
        const found = items.find(item => item.ref === ref);
        return found ? json({ ...found, body: found.source === 'builtin' ? '## Render contract\nDefine window.renderAt(t).\n' : 'Short lines.\n' }) : undefined;
      }
      if (call.method === 'POST') { const created = skill({ ref: `workspace:a${'c'.repeat(32)}`, id: `a${'c'.repeat(32)}`, name: call.body.name ?? 'imported', title: call.body.title ?? 'Imported', titleZh: undefined, descriptionZh: undefined, source: 'workspace', category: 'writing' }); items = [...items, created]; return json({ ...created, body: 'x' }, 201); }
      if (call.method === 'DELETE') { items = items.filter(item => `${tenant}/skills/${item.id}` !== call.url); return new Response(null, { status: 204 }); }
    });
    render(preferences(<SkillLibrary tenantId="tenant-a" onClose={() => {}} />));
    expect(await screen.findByRole('heading', { name: 'Render contract' })).toBeVisible();
    expect(screen.getByText('代码动效实验室', { selector: 'h3' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '视频' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '新建技能' }));
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: 'Brand-Voice' } });
    expect(screen.getByLabelText(/名称/)).toHaveValue('brand-voice');
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Brand voice' } });
    fireEvent.change(screen.getByLabelText(/一句话说明/), { target: { value: 'Use for copy in our voice' } });
    fireEvent.change(screen.getByLabelText('正文（Markdown）'), { target: { value: 'Short sentences.' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText(/技能已保存/);
    expect(calls.find(call => call.method === 'POST')!.body).toEqual({ name: 'brand-voice', title: 'Brand voice', description: 'Use for copy in our voice', category: 'writing', applies: [], body: 'Short sentences.' });

    const file = new File(['---\nname: imported\ndescription: Imported skill\n---\nBody\n'], 'SKILL.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('---\nname: imported\ndescription: Imported skill\n---\nBody\n').buffer });
    fireEvent.change(screen.getByLabelText('选择 SKILL.md 文件'), { target: { files: [file] } });
    expect(await screen.findByText(/将导入「SKILL.md」/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await screen.findByText(/已导入技能/);
    expect(calls.filter(call => call.method === 'POST')[1].body).toEqual({ markdown: '---\nname: imported\ndescription: Imported skill\n---\nBody\n' });

    fireEvent.click(screen.getByRole('button', { name: /House style/ }));
    fireEvent.click(await screen.findByRole('button', { name: '归档' }));
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }));
    await waitFor(() => expect(calls.find(call => call.method === 'DELETE')?.url).toBe(`${tenant}/skills/a${'b'.repeat(32)}`));
  });

  it('lets a viewer read built-in skills without any way to change them', async () => {
    server(call => call.url === `${tenant}/skills` ? json({ items: [skill()], limits }) : call.url.startsWith(`${tenant}/skills/`) ? json({ ...skill(), body: 'Body\n' }) : undefined);
    render(preferences(<SkillLibrary tenantId="tenant-a" readOnly onClose={() => {}} />));
    await screen.findByText('代码动效实验室', { selector: 'h3' });
    expect(screen.queryByRole('button', { name: '新建技能' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导入 SKILL.md' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });
});

describe('canvas bar tools and messages', () => {
  it('opens the memory and skill workbenches over the canvas', async () => {
    server(call => call.url.includes('/memory?') ? json({ items: [note()] }) : call.url === `${tenant}/skills` ? json({ items: [skill()], limits })
      : call.url.startsWith(`${tenant}/skills/`) ? json({ ...skill(), body: 'Body\n' }) : undefined);
    render(preferences(<div className="awwo-canvas-bar"><CanvasLibraryTools tenantId="tenant-a" canvasId="canvas-a" /></div>));
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    const memory = await screen.findByRole('dialog', { name: '记忆工作台' });
    expect(await within(memory).findByText('对外文案用简体中文')).toBeVisible();
    fireEvent.click(within(memory).getByRole('button', { name: '关闭记忆' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '技能库' }));
    const skills = await screen.findByRole('dialog', { name: '技能库' });
    expect(await within(skills).findByText('代码动效实验室', { selector: 'h3' })).toBeVisible();
  });

  it('names each new refusal in both languages', () => {
    for (const code of ['web_read_quota', 'web_reader_unavailable', 'web_robots_disallowed', 'web_blocked_address', 'web_blocked_by_site_protection', 'web_timeout',
      'skill_name_conflict', 'skill_limit', 'skill_unavailable', 'skill_context_limit', 'invalid_skill', 'invalid_memory', 'memory_limit',
      'invalid_render', 'render_busy', 'render_quota', 'render_unavailable', 'render_too_large']) {
      const error = new SaaSApiError(400, code, 'server text');
      expect(saasErrorMessage(error, 'zh')).not.toBe('server text');
      expect(saasErrorMessage(error, 'en')).not.toBe('server text');
    }
    expect(saasErrorMessage(new SaaSApiError(422, 'web_blocked_by_site_protection', 'x'), 'en')).toContain('does not get around site protection');
  });
});
