// The workspace library added with the open-source intake: importing a knowledge source from a web address, the
// memory workbench, the skill library, their canvas-bar tools and the messages for their refusals.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeWorkbench } from '../src/saas/KnowledgeWorkbench';
import { MemoryWorkbench, memoryArchivedReason, memoryDeletedNotice } from '../src/saas/MemoryWorkbench';
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
const skill = (patch: Record<string, unknown> = {}) => ({ ref: 'builtin:code-motion', name: 'code-motion', title: 'Motion in code', titleZh: '代码动效', description: 'Animation drawn in code',
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
      if (call.method === 'GET' && call.url.startsWith(`${tenant}/memory?`)) return json({ items: items.filter(item => (item.status === 'archived') === call.url.includes('status=archived')) });
      if (call.method === 'PATCH') { const id = call.url.split('/').pop()!; items = items.map(item => item.id === id ? { ...item, ...call.body, version: Number(item.version) + 1 } : item); return json(items.find(item => item.id === id)); }
      if (call.method === 'POST') { const created = note({ id: 'm3', canvasId: call.body.canvasId ?? null, scope: call.body.canvasId ? 'canvas' : 'workspace', title: call.body.title, body: call.body.body, kind: call.body.kind, pinned: call.body.pinned, version: 1, useCount: 0 }); items = [...items, created]; return json(created, 201); }
      if (call.method === 'DELETE') { const id = call.url.split('/').pop()!; items = items.filter(item => item.id !== id); return json({ setAside: 2 }); }
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
    // The notes of AwwO's the deletion set aside are said, for the person to delete them too.
    await screen.findByText(/AwwO 说同一件事的 2 条笔记也已归档/);

    // An edit of a note's text says that AwwO's notes of its old text are archived, or, of the whole workspace, no longer
    // given to the canvas of a canvas's note; one of its pin alone says neither.
    const edited = within(screen.getByRole('list')).getByText('主色用 #E76F51').closest('li')!;
    fireEvent.click(within(edited).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '主色用 #F4A261' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('记忆已更新；AwwO 若有说着它原来内容的笔记，已一并归档（在各自所在的「已归档」里），整个工作区里的这类笔记不再交给这张画布。');
    // The text it was opened with tells, though the list shown meanwhile no longer holds the note.
    const workspace = within(screen.getByRole('list')).getByText('对外文案用简体中文').closest('li')!;
    fireEvent.click(within(workspace).getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '已归档' }));
    await screen.findByText('没有匹配的记忆。');
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '对外文案用繁体中文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('记忆已更新；AwwO 若有说着它原来内容的笔记，已一并归档（在各自所在的「已归档」里）。');
    fireEvent.click(screen.getByRole('button', { name: '在用' }));
    // A save of the pin alone, or of the kind alone, says the note was updated, and nothing of AwwO's notes.
    const changes: Array<() => void> = [
      () => fireEvent.click(screen.getByLabelText('置顶：每次运行都优先引用，不论是否相关')),
      () => fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'fact' } }),
    ];
    for (const change of changes) {
      const again = (await within(await screen.findByRole('list')).findByText('对外文案用繁体中文')).closest('li')!;
      fireEvent.click(within(again).getByRole('button', { name: '编辑' }));
      change();
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await screen.findByText('记忆已更新。');
      expect(screen.queryByText(/已一并归档/)).toBeNull();
    }
    expect(calls.filter(call => call.method === 'PATCH').slice(-2).map(call => call.body)).toEqual([
      { version: 5, title: '对外文案用繁体中文', body: '', kind: 'style', pinned: true },
      { version: 6, title: '对外文案用繁体中文', body: '', kind: 'fact', pinned: true },
    ]);
  });

  it("names why AwwO archived a note that restated a person's", () => {
    expect(memoryArchivedReason('restated', (_zh: string, english: string) => english)).toBe('Restated a person’s note that was deleted or changed');
    expect(memoryArchivedReason('restated', (chinese: string) => chinese)).toBe('复述了一条被删掉或改掉的人写笔记');
  });

  it('says what a deletion archived apart from what it holds back from the canvas', () => {
    const en = (_zh: string, english: string) => english, zh = (chinese: string) => chinese;
    expect(memoryDeletedNotice({ setAside: 2, heldBack: 1 }, en)).toBe("Note deleted. 2 notes of AwwO's that said the same are archived (each under Archived where it was kept, to delete as well), and one of the whole workspace is no longer given to this canvas. Runs already admitted keep the copy they froze.");
    expect(memoryDeletedNotice({ setAside: 1, heldBack: 0 }, en)).toBe("Note deleted, and a note of AwwO's that said the same archived (each under Archived where it was kept, to delete as well). Runs already admitted keep the copy they froze.");
    expect(memoryDeletedNotice({ setAside: 0, heldBack: 3 }, en)).toBe("Note deleted, and 3 notes of AwwO's for the whole workspace that said the same no longer given to this canvas. Runs already admitted keep the copy they froze.");
    expect(memoryDeletedNotice({ setAside: 0, heldBack: 0 }, en)).toBe('Note deleted. Runs already admitted keep the copy they froze.');
    expect(memoryDeletedNotice({ setAside: 0, heldBack: 1 }, zh)).toBe('记忆已删除，整个工作区里 AwwO 说同一件事的 1 条笔记不再交给这张画布。已经开始的运行仍保留当时冻结的副本。');
  });

  it('marks the notes AwwO keeps, says which wait on probation, and why one was archived', async () => {
    let confirmed = false;
    const calls = server(call => {
      if (call.method === 'PATCH') { confirmed = true; return json(note({ id: 'p1', title: '标题用衬线字体', origin: 'run', status: 'active', locked: true })); }
      if (!call.url.includes('/memory?')) return undefined;
      if (call.url.includes('status=archived')) return json({ items: [note({ id: 'a1', title: '旧的笔记', origin: 'run', status: 'archived', archivedReason: 'unused', pinned: false, locked: false, evidence: 1 })] });
      // Once the replacement is confirmed, the note it takes the place of is archived, and listed in use no more.
      return json({ items: [
        note({ id: 'p1', title: '标题用衬线字体', origin: 'run', status: confirmed ? 'active' : 'proposed', pinned: false, locked: confirmed, evidence: 1, replacesId: 'b1' }),
        ...(confirmed ? [] : [note({ id: 'b1', title: '页面用深色', origin: 'evolution', pinned: false, locked: false, evidence: 3 })]),
        note({ id: 'o1', title: '我们自己写的', origin: 'user', pinned: false, locked: true, evidence: 1 }),
      ] });
    });
    render(preferences(<MemoryWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    const item = async (title: string) => (await screen.findByText(title)).closest('li')!;
    const probation = await item('标题用衬线字体');
    expect(within(probation).getByText('自动')).toBeVisible();
    expect(within(probation).getByText('试用中')).toBeVisible();
    expect(within(probation).queryByText('待确认')).toBeNull();
    const borne = await item('页面用深色');
    expect(within(borne).getByText('自动')).toBeVisible();
    expect(within(borne).queryByText('试用中')).toBeNull();
    expect(borne).toHaveTextContent('3 次运行印证');
    const own = await item('我们自己写的');
    expect(within(own).queryByText('自动')).toBeNull();
    expect(within(own).queryByText('试用中')).toBeNull();
    // The header says what is kept and for how long, names no cadence (the Lessons panel says it), and says a note moved
    // to the whole workspace goes with its last canvas; the Auto badge says AwwO no longer changes a note once it is theirs.
    const header = screen.getByRole('region', { name: '记忆' }).querySelector('header')!;
    expect(header).toHaveTextContent('一直留到那张画布或这个工作区删掉、或密钥更换');
    expect(header).toHaveTextContent('会在那张画布里记下那条 AwwO 笔记原文的哈希');
    expect(header).toHaveTextContent('除非你置顶或改过它的文字');
    expect(header).toHaveTextContent('运行会留着交给它们的笔记的副本');
    expect(header).not.toHaveTextContent('每 3 天');
    expect(header).not.toHaveTextContent('什么都不留');
    expect(within(probation).getByText('自动')).toHaveAttribute('title', expect.stringContaining('AwwO 不再改它'));
    // A note written to take another's place says which, and confirming it says that one is archived once it is.
    expect(within(probation).getByText('将取代「页面用深色」')).toBeVisible();
    fireEvent.click(within(probation).getByRole('button', { name: '确认' }));
    expect(await screen.findByText(/它取代的那条已归档/)).toBeVisible();
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ version: 3, status: 'active' });
    await waitFor(() => expect(screen.queryByText('页面用深色')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '已归档' }));
    const archived = await item('旧的笔记');
    expect(archived).toHaveTextContent('30 天没有用到');
    expect(within(archived).queryByText('试用中')).toBeNull();
  });

  it('says a confirmed replacement archived nothing when the note it was to replace stays in use', async () => {
    server(call => {
      if (call.method === 'PATCH') return json(note({ id: 'p1', title: '标题用衬线字体', origin: 'run', status: 'active', locked: true }));
      if (!call.url.includes('/memory?')) return undefined;
      // The note it was to replace became a person's meanwhile: the server archived nothing.
      return json({ items: [
        note({ id: 'p1', title: '标题用衬线字体', origin: 'run', status: 'proposed', pinned: false, locked: false, evidence: 1, replacesId: 'b1' }),
        note({ id: 'b1', title: '页面用深色', origin: 'evolution', pinned: true, locked: true, evidence: 3 }),
      ] });
    });
    render(preferences(<MemoryWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    const probation = (await screen.findByText('标题用衬线字体')).closest('li')!;
    fireEvent.click(within(probation).getByRole('button', { name: '确认' }));
    expect(await screen.findByText('已确认。之后的运行会引用它。')).toBeVisible();
    expect(screen.queryByText(/它取代的那条已归档/)).toBeNull();
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
    expect(screen.getByText('代码动效', { selector: 'h3' })).toBeVisible();
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
    await screen.findByText('代码动效', { selector: 'h3' });
    expect(screen.queryByRole('button', { name: '新建技能' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导入 SKILL.md' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });

  it('links the license texts beside an adapted built-in skill only', async () => {
    const adapted = skill({ attribution: 'From wshobson/agents@7257c27 (MIT, Copyright (c) 2024 Seth Hobson); trimmed for AwwO' });
    const plain = skill({ ref: 'builtin:copy-editor', name: 'copy-editor', title: 'Copy editor', titleZh: '文字编辑', category: 'writing' });
    const own = { ...workspaceSkill, attribution: 'Written by the team' };
    const items = [adapted, plain, own];
    server(call => {
      if (call.url === `${tenant}/skills`) return json({ items, limits });
      const found = items.find(item => call.url === `${tenant}/skills/${encodeURIComponent(item.ref)}` || call.url === `${tenant}/skills/${item.ref}`);
      return found ? json({ ...found, body: 'Body\n' }) : undefined;
    });
    render(preferences(<SkillLibrary tenantId="tenant-a" readOnly onClose={() => {}} />));
    await screen.findByText(/From wshobson\/agents@7257c27/);
    const link = screen.getByRole('link', { name: '许可证全文' });
    expect(link.getAttribute('href')).toMatch(/skillLicences/);
    expect(link).toHaveAttribute('target', '_blank');
    fireEvent.click(screen.getByRole('button', { name: /文字编辑/ }));
    await screen.findByText('文字编辑', { selector: 'h3' });
    expect(screen.queryByText(/来源：/)).toBeNull();
    expect(screen.queryByRole('link', { name: '许可证全文' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /House style/ }));
    await screen.findByText(/Written by the team/);
    expect(screen.queryByRole('link', { name: '许可证全文' })).toBeNull();
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
    expect(await within(skills).findByText('代码动效', { selector: 'h3' })).toBeVisible();
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
