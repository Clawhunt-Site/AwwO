// Finding a skill on skills.sh from the skill library and importing it (SkillRegistry.tsx, skill_registry.go): the
// button only where the server offers it to an editor, the search and preview the server answers, what the member
// is told before importing, and the import itself with the member's changes.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchOverlay } from '../src/saas/CanvasKnowledgeDock';
import { CanvasLibraryTools } from '../src/saas/CanvasLibraryTools';
import { SkillLibrary } from '../src/saas/SkillLibrary';
import { formatInstalls } from '../src/saas/SkillRegistry';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
import { forgetSkillCatalog, previewRegistrySkill } from '../src/saas/skillsApi';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const tenant = '/api/v1/tenants/tenant-a';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Call = { url: string; method: string; body: any };
const limits = { maxNodeSkills: 4, maxNodeSkillBytes: 20480, maxSkillBodyBytes: 12288, maxWorkspaceSkills: 100 };
const builtin = { ref: 'builtin:critic', name: 'critic', title: 'Critic', titleZh: '评审', description: 'Find defects', descriptionZh: '找出问题', category: 'engineering',
  applies: ['review'], version: 1, source: 'builtin', bytes: 40, contentHash: 'h1' };
const capabilities = (registry?: boolean) => ({
  skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: true, maxRunItems: 12, maxRunBytes: 4096, maxPerScope: 200 },
  webReader: { enabled: false, perDay: 30, usedToday: 0 },
  render: { enabled: false, perDay: 20, usedToday: 0, limits: { maxSeconds: 20, maxFps: 60, maxWidth: 1920, maxHeight: 1920, maxFrames: 1800, maxHtmlBytes: 6291456 } },
  ...(registry === undefined ? {} : { skillRegistry: { enabled: registry, source: 'skills.sh' } }),
});
const hit = { id: 'vercel-labs/skills/find-skills', source: 'vercel-labs/skills', slug: 'find-skills', name: 'find-skills', installs: 185000,
  url: 'https://skills.sh/vercel-labs/skills/find-skills', repoUrl: 'https://github.com/vercel-labs/skills' };
const markdown = '---\nname: find-skills\ndescription: Helps users discover skills\n---\n\n# Find Skills\n\nRun `npx skills find`.\n';
const preview = (patch: Record<string, unknown> = {}) => ({
  id: hit.id, source: hit.source, slug: hit.slug, url: hit.url, repoUrl: hit.repoUrl, hash: 'a'.repeat(64), markdown, truncated: false, bytes: markdown.length, maxBytes: 12288,
  files: [{ path: 'scripts/install.sh', bytes: 20 }], filesTotal: 1, declaredLicense: '', notes: ['extra_files', 'runs_commands'],
  license: { status: 'open', spdx: 'MIT', files: [] },
  repository: { checked: true, found: true, license: 'MIT', stars: 4321, archived: false },
  audits: [{ provider: 'Socket', status: 'pass', riskLevel: 'LOW', summary: 'No issues' }, { provider: 'Snyk', status: 'warn' }],
  problem: null, skill: { name: 'find-skills', title: 'Find Skills', description: 'Helps users discover skills', category: 'engineering', applies: [] }, ...patch,
});
function server(routes: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return routes(call) ?? json({ error: { code: 'not_found', message: 'missing' } }, 404);
  }));
  return calls;
}
const preferences = (children: React.ReactNode) => <SaaSPreferencesProvider>{children}</SaaSPreferencesProvider>;
const catalog = (items: unknown[]) => (call: Call) => {
  if (call.url === `${tenant}/skills`) return json({ items, limits });
  if (call.method === 'GET' && call.url.startsWith(`${tenant}/skills/`) && !call.url.includes('/registry/')) {
    const ref = decodeURIComponent(call.url.slice(`${tenant}/skills/`.length));
    const found = (items as { ref: string }[]).find(item => item.ref === ref);
    return found ? json({ ...found, body: 'Body\n' }) : undefined;
  }
};

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); forgetSkillCatalog('tenant-a'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('finding skills on skills.sh', () => {
  it('offers skills.sh only where the server has it on and the member can edit', async () => {
    const calls = server(call => call.url.endsWith('/capabilities') ? json(capabilities(true)) : catalog([builtin])(call));
    const { unmount } = render(preferences(<SkillLibrary tenantId="tenant-a" onClose={() => {}} />));
    expect(await screen.findByRole('button', { name: '从 skills.sh 查找' })).toBeVisible();
    unmount();
    // A server older than the registry, and one with it off: once their answer is in, no button.
    for (const registry of [undefined, false]) {
      const asked = server(call => call.url.endsWith('/capabilities') ? json(capabilities(registry)) : catalog([builtin])(call));
      const view = render(preferences(<SkillLibrary tenantId="tenant-a" onClose={() => {}} />));
      await screen.findByText('评审', { selector: 'h3' });
      await waitFor(() => expect(asked.some(call => call.url.endsWith('/capabilities'))).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(screen.getByRole('button', { name: '导入 SKILL.md' })).toBeVisible();
      expect(screen.queryByRole('button', { name: '从 skills.sh 查找' })).toBeNull();
      view.unmount();
    }
    const readerCalls = server(call => call.url.endsWith('/capabilities') ? json(capabilities(true)) : catalog([builtin])(call));
    render(preferences(<SkillLibrary tenantId="tenant-a" readOnly onClose={() => {}} />));
    await screen.findByText('评审', { selector: 'h3' });
    expect(screen.queryByRole('button', { name: '从 skills.sh 查找' })).toBeNull();
    expect(readerCalls.some(call => call.url.endsWith('/capabilities'))).toBe(false);
    expect(calls.filter(call => call.url.endsWith('/capabilities'))).toHaveLength(1);
  });

  it('searches, shows what to know before importing, and imports with the member’s changes', async () => {
    let items: unknown[] = [builtin];
    const imported = { ref: `workspace:a${'d'.repeat(32)}`, id: `a${'d'.repeat(32)}`, name: 'find-skills', title: 'Skill finder', description: 'Helps users discover skills',
      category: 'research', applies: ['research'], version: 1, source: 'workspace', bytes: 30, contentHash: 'h2',
      attribution: 'Imported from skills.sh (vercel-labs/skills/find-skills); source https://github.com/vercel-labs/skills; license MIT' };
    const calls = server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities(true));
      if (call.url.startsWith(`${tenant}/skills/registry/search?`)) return json({ query: 'find skills', items: [hit], source: 'skills.sh' });
      if (call.url.startsWith(`${tenant}/skills/registry/preview?`)) return json(preview());
      if (call.method === 'POST' && call.url === `${tenant}/skills/registry/import`) { items = [...items, imported]; return json({ ...imported, body: '# Find Skills\n' }, 201); }
      return catalog(items)(call);
    });
    render(preferences(<SkillLibrary tenantId="tenant-a" onClose={() => {}} />));
    fireEvent.click(await screen.findByRole('button', { name: '从 skills.sh 查找' }));
    const search = screen.getByRole('button', { name: '搜索' });
    expect(search).toBeDisabled();
    fireEvent.change(screen.getByLabelText('在 skills.sh 搜索技能'), { target: { value: '  find   skills ' } });
    fireEvent.click(search);
    const results = await screen.findByRole('list', { name: 'skills.sh 搜索结果' });
    expect(calls.find(call => call.url.includes('/registry/search'))!.url).toBe(`${tenant}/skills/registry/search?q=find%20skills`);
    const row = within(results).getByRole('button', { name: /find-skills/ });
    expect(row).toHaveTextContent('vercel-labs/skills');
    expect(row).toHaveTextContent('18.5 万次安装');

    fireEvent.click(row);
    expect(await screen.findByText('许可证：MIT（宽松的开源许可）')).toBeVisible();
    expect(screen.getByText('来源仓库的许可证：MIT')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /确认有权/ })).toBeNull();
    expect(calls.find(call => call.url.includes('/registry/preview'))!.url).toBe(`${tenant}/skills/registry/preview?id=vercel-labs%2Fskills%2Ffind-skills`);
    expect(screen.getByText('4321')).toBeVisible();
    expect(screen.getByText('安全审计 · Socket：通过（风险 LOW）')).toBeVisible();
    expect(screen.getByText('安全审计 · Snyk：有提醒')).toBeVisible();
    expect(screen.getByText(/它还带有 1 个附带文件（scripts\/install\.sh）/)).toBeVisible();
    expect(screen.getByText(/它是写给能运行命令的智能体的/)).toBeVisible();
    expect(screen.getByText(/Run `npx skills find`/, { selector: 'pre' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'skills.sh' })).toHaveAttribute('href', hit.url);
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', hit.repoUrl);

    expect(screen.getByLabelText(/名称/)).toHaveValue('find-skills');
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Skill finder' } });
    fireEvent.change(screen.getByLabelText('类别'), { target: { value: 'research' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'research' }));
    fireEvent.click(screen.getByRole('button', { name: '导入到本工作区' }));
    await screen.findByText(/已从 skills.sh 导入「Skill finder」/);
    expect(calls.find(call => call.method === 'POST')!.body).toEqual({ id: hit.id, hash: 'a'.repeat(64), name: 'find-skills', title: 'Skill finder',
      description: 'Helps users discover skills', category: 'research', applies: ['research'], licenseConfirmed: false });
    // Back in the library with the new skill open, its source beside it.
    expect(await screen.findByText(/来源：Imported from skills\.sh \(vercel-labs\/skills\/find-skills\)/)).toBeVisible();
    expect(screen.queryByRole('list', { name: 'skills.sh 搜索结果' })).toBeNull();
  });

  it('refuses a skill whose text cannot be imported and lets a member fix the fields of one that can', async () => {
    let next = preview({ problem: { code: 'skill_registry_too_large', message: 'too large', blocking: true }, bytes: 18842 });
    const calls = server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities(true));
      if (call.url.includes('/registry/search?')) return json({ query: 'x', items: [hit, { ...hit, id: 'o/r/other', slug: 'other', name: 'other', source: 'o/r', installs: 7 }], source: 'skills.sh' });
      if (call.url.includes('/registry/preview?')) return json(next);
      if (call.url.endsWith('/registry/import')) return json({ error: { code: 'skill_registry_changed', message: 'changed' } }, 409);
      return catalog([builtin])(call);
    });
    render(preferences(<SkillLibrary tenantId="tenant-a" onClose={() => {}} />));
    fireEvent.click(await screen.findByRole('button', { name: '从 skills.sh 查找' }));
    fireEvent.change(screen.getByLabelText('在 skills.sh 搜索技能'), { target: { value: 'pdf' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('button', { name: /find-skills/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('这个技能的正文约 18.4 KiB，超过了工作区技能 12 KiB 的上限，无法导入。');
    expect(screen.queryByRole('button', { name: '导入到本工作区' })).toBeNull();
    expect(screen.getByText('7 次安装')).toBeVisible();

    next = preview({ id: 'o/r/other', problem: { code: 'invalid_skill', message: 'description too long', blocking: false }, skill: { ...preview().skill, description: 'd'.repeat(1100) } });
    fireEvent.click(screen.getByRole('button', { name: /other/ }));
    const warning = await screen.findByText(/技能内容不符合要求/);
    expect(warning).toHaveTextContent('请修改下面的内容后再导入。');
    const importButton = screen.getByRole('button', { name: '导入到本工作区' });
    expect(importButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/一句话说明/), { target: { value: 'Short enough' } });
    expect(importButton).toBeEnabled();
    fireEvent.click(importButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('这个技能或它的许可在你打开之后变了，已重新读取。请看一下下面的最新内容，确认后再导入。');
    expect(calls.filter(call => call.url.endsWith('/registry/import'))).toHaveLength(1);
  });

  it('says plainly when nothing matches, and imports a skill without an open license only on the member’s word', async () => {
    let next = preview({ license: { status: 'unknown', files: [] }, repository: { checked: true, found: true, stars: 3, archived: true }, audits: [] });
    const calls = server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities(true));
      if (call.url.includes('q=nothing')) return json({ query: 'nothing', items: [], source: 'skills.sh' });
      if (call.url.includes('/registry/search?')) return json({ query: 'x', items: [hit], source: 'skills.sh' });
      if (call.url.includes('/registry/preview?')) return json(next);
      if (call.url.endsWith('/registry/import')) return json({ error: { code: 'skill_name_conflict', message: 'taken' } }, 409);
      return catalog([builtin])(call);
    });
    render(preferences(<SkillLibrary tenantId="tenant-a" onClose={() => {}} />));
    fireEvent.click(await screen.findByRole('button', { name: '从 skills.sh 查找' }));
    const field = screen.getByLabelText('在 skills.sh 搜索技能');
    fireEvent.change(field, { target: { value: 'nothing' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByRole('status')).toHaveTextContent('skills.sh 上没有找到与「nothing」相关的技能。');
    fireEvent.change(field, { target: { value: 'find' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('button', { name: /find-skills/ }));
    expect(await screen.findByText('来源仓库：没有许可证文件。')).toBeVisible();
    expect(screen.getByText('仓库已归档')).toBeVisible();
    expect(screen.getByText('skills.sh 还没有发布这个技能的安全审计。')).toBeVisible();
    expect(screen.getByText(/没能确认它用的是宽松的开源许可/)).toBeVisible();
    expect(screen.queryByText(/许可证：.*（宽松的开源许可）/)).toBeNull();
    const importButton = screen.getByRole('button', { name: '导入到本工作区' });
    expect(importButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /确认有权在本工作区使用这份技能的文字/ }));
    expect(importButton).toBeEnabled();
    fireEvent.click(importButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('这个工作区已经有同名技能');
    expect(calls.find(call => call.url.endsWith('/registry/import'))!.body.licenseConfirmed).toBe(true);

    // A restricted license, the skill's own license and notice files and nothing checked with GitHub.
    next = preview({ license: { status: 'restricted', files: [{ path: 'LICENSE.txt', notice: false, text: 'Proprietary terms of Example.', truncated: true },
      { path: 'NOTICE', notice: true, text: 'Copyright Example. All rights reserved.', truncated: false },
      { path: 'README.md', notice: true, readme: true, text: '## License: ask Example first', truncated: false }] },
      declaredLicense: 'Proprietary. LICENSE.txt has complete terms', repository: { checked: false, found: false, stars: 0, archived: false }, audits: null });
    fireEvent.click(screen.getByRole('button', { name: /find-skills/ }));
    expect(await screen.findByText('SKILL.md 声明的许可证：Proprietary. LICENSE.txt has complete terms')).toBeVisible();
    expect(screen.getByText('技能自带的许可与声明文件：LICENSE.txt、NOTICE、README.md（全文见下）')).toBeVisible();
    expect(screen.getByText('技能自带的许可证（LICENSE.txt）')).toBeVisible();
    expect(screen.getByText('技能自带的版权声明（NOTICE）')).toBeVisible();
    expect(screen.getByText('说明文件里的许可条款（README.md）')).toBeVisible();
    expect(screen.getByText('Proprietary terms of Example. …（只显示了前 16 KiB）', { selector: 'pre' })).toBeInTheDocument();
    expect(screen.getByText('Copyright Example. All rights reserved.', { selector: 'pre' })).toBeInTheDocument();
    expect(screen.getByText(/作者对这份技能的使用设了限制/)).toBeVisible();
    expect(screen.getByText('来源仓库：暂时无法向 GitHub 查询。')).toBeVisible();
    expect(screen.getByText('暂时读不到 skills.sh 的安全审计。')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /确认有权/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '导入到本工作区' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '返回技能库' }));
    expect(await screen.findByText('评审', { selector: 'h3' })).toBeVisible();
  });

  it('shows the newest pick only, even when an older preview answers later', async () => {
    const other = { ...hit, id: 'o/r/other', slug: 'other', name: 'other', source: 'o/r', installs: 7 };
    let releaseFirst = () => {};
    const firstAnswered = new Promise<void>(resolve => { releaseFirst = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.endsWith('/capabilities')) return json(capabilities(true));
      if (target.includes('/registry/search?')) return json({ query: 'x', items: [hit, other], source: 'skills.sh' });
      if (target.includes('/registry/preview?') && target.includes('find-skills')) { await firstAnswered; return json(preview()); }
      if (target.includes('/registry/preview?')) return json(preview({ id: other.id, source: other.source, slug: other.slug, skill: { ...preview().skill, name: 'other', title: 'Other' } }));
      return catalog([builtin])({ url: target, method: 'GET', body: null }) ?? json({ error: { code: 'not_found', message: 'missing' } }, 404);
    }));
    render(preferences(<SkillLibrary tenantId="tenant-a" onClose={() => {}} />));
    fireEvent.click(await screen.findByRole('button', { name: '从 skills.sh 查找' }));
    fireEvent.change(screen.getByLabelText('在 skills.sh 搜索技能'), { target: { value: 'find' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('button', { name: /find-skills/ }));
    expect(await screen.findByText('正在从 skills.sh 读取这个技能…')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /other/ }));
    const panel = await screen.findByRole('region', { name: '技能预览' });
    await waitFor(() => expect(within(panel).getByLabelText('标题')).toHaveValue('Other'));
    releaseFirst();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(within(panel).getByLabelText('标题')).toHaveValue('Other');
    expect(within(panel).getByText('other', { selector: 'h3' })).toBeVisible();
  });

  it('keeps every way out closed while an import runs', async () => {
    let finish = () => {};
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const imported = { ref: `workspace:a${'e'.repeat(32)}`, id: `a${'e'.repeat(32)}`, name: 'find-skills', title: 'Find Skills', description: 'x', category: 'engineering', applies: [],
      version: 1, source: 'workspace', bytes: 3, contentHash: 'h3' };
    let items: unknown[] = [builtin];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const target = String(url);
      if (target.endsWith('/capabilities')) return json(capabilities(true));
      if (target.includes('/registry/search?')) return json({ query: 'x', items: [hit], source: 'skills.sh' });
      if (target.includes('/registry/preview?')) return json(preview());
      if (init.method === 'POST') { await finished; items = [...items, imported]; return json({ ...imported, body: 'x' }, 201); }
      return catalog(items)({ url: target, method: 'GET', body: null }) ?? json({ error: { code: 'not_found', message: 'missing' } }, 404);
    }));
    render(preferences(<SkillLibrary tenantId="tenant-a" onClose={() => {}} />));
    fireEvent.click(await screen.findByRole('button', { name: '从 skills.sh 查找' }));
    fireEvent.change(screen.getByLabelText('在 skills.sh 搜索技能'), { target: { value: 'find' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('button', { name: /find-skills/ }));
    fireEvent.click(await screen.findByRole('button', { name: '导入到本工作区' }));
    expect(await screen.findByRole('button', { name: '导入中…' })).toBeDisabled();
    for (const name of ['返回技能库', '从 skills.sh 查找', '导入 SKILL.md', '新建技能', '关闭技能库', '刷新技能库']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    finish();
    await screen.findByText(/已从 skills.sh 导入「Find Skills」/);
    expect(screen.getByRole('button', { name: '关闭技能库' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '从 skills.sh 查找' })).toBeEnabled();
  });

  it('reads the skill again when the server judges its license differently from the preview', async () => {
    let previews = 0;
    const calls = server(call => {
      if (call.url.endsWith('/capabilities')) return json(capabilities(true));
      if (call.url.includes('/registry/search?')) return json({ query: 'x', items: [hit], source: 'skills.sh' });
      if (call.url.includes('/registry/preview?')) {
        previews++;
        return json(previews === 1 ? preview({ audits: [{ provider: 'Snyk', status: 'warn', riskLevel: 'MEDIUM', summary: 'Downloads and runs a script.' }] })
          : preview({ license: { status: 'unknown', files: [] }, repository: { checked: false, found: false, stars: 0, archived: false } }));
      }
      if (call.url.endsWith('/registry/import')) return json({ error: { code: 'skill_registry_license_unconfirmed', message: 'confirm' } }, 409);
      return catalog([builtin])(call);
    });
    render(preferences(<SkillLibrary tenantId="tenant-a" onClose={() => {}} />));
    fireEvent.click(await screen.findByRole('button', { name: '从 skills.sh 查找' }));
    fireEvent.change(screen.getByLabelText('在 skills.sh 搜索技能'), { target: { value: 'find' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('button', { name: /find-skills/ }));
    expect(await screen.findByText('Downloads and runs a script.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Kept title' } });
    fireEvent.click(screen.getByRole('button', { name: '导入到本工作区' }));
    expect(await screen.findByRole('checkbox', { name: /确认有权/ })).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('没能确认这个技能用的是宽松的开源许可');
    expect(screen.getByLabelText('标题')).toHaveValue('Kept title');
    expect(previews).toBe(2);
    expect(calls.filter(call => call.url.endsWith('/registry/import'))).toHaveLength(1);
  });

  it('keeps the library open on Escape while an import runs over the canvas', async () => {
    let finish = () => {};
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const imported = { ref: `workspace:a${'f'.repeat(32)}`, id: `a${'f'.repeat(32)}`, name: 'find-skills', title: 'Find Skills', description: 'x', category: 'engineering', applies: [],
      version: 1, source: 'workspace', bytes: 3, contentHash: 'h4' };
    let items: unknown[] = [builtin];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const target = String(url);
      if (target.endsWith('/capabilities')) return json(capabilities(true));
      if (target.includes('/registry/search?')) return json({ query: 'x', items: [hit], source: 'skills.sh' });
      if (target.includes('/registry/preview?')) return json(preview());
      if (init.method === 'POST') { await finished; items = [...items, imported]; return json({ ...imported, body: 'x' }, 201); }
      return catalog(items)({ url: target, method: 'GET', body: null }) ?? json({ error: { code: 'not_found', message: 'missing' } }, 404);
    }));
    render(preferences(<CanvasLibraryTools tenantId="tenant-a" canvasId="canvas-a" />));
    fireEvent.click(screen.getByRole('button', { name: '技能库' }));
    const dialog = await screen.findByRole('dialog', { name: '技能库' });
    fireEvent.click(await within(dialog).findByRole('button', { name: '从 skills.sh 查找' }));
    fireEvent.change(within(dialog).getByLabelText('在 skills.sh 搜索技能'), { target: { value: 'find' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '搜索' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /find-skills/ }));
    fireEvent.click(await within(dialog).findByRole('button', { name: '导入到本工作区' }));
    expect(await within(dialog).findByRole('button', { name: '导入中…' })).toBeDisabled();
    // The library tells the overlay through its effects, a commit after its own button changes.
    await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'true'));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.getByRole('dialog', { name: '技能库' })).toBe(dialog);
    // A browser that closes the dialog itself (a second Escape with no click between) sees it open again.
    dialog.removeAttribute('open');
    fireEvent(dialog, new Event('close'));
    expect(dialog).toHaveAttribute('open');
    finish();
    expect(await within(dialog).findByText(/已从 skills.sh 导入「Find Skills」/)).toBeVisible();
    await waitFor(() => expect(dialog).not.toHaveAttribute('aria-busy'));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes a workbench the browser closes, unless what runs in it is busy', () => {
    const closed = vi.fn();
    const { rerender } = render(<WorkbenchOverlay label="工作台" onClose={closed} busy><p>内容</p></WorkbenchOverlay>);
    const dialog = screen.getByRole('dialog', { name: '工作台' });
    expect(dialog).toHaveAttribute('tabindex', '-1');
    dialog.removeAttribute('open');
    fireEvent(dialog, new Event('close'));
    expect(dialog).toHaveAttribute('open');
    expect(closed).not.toHaveBeenCalled();
    rerender(<WorkbenchOverlay label="工作台" onClose={closed}><p>内容</p></WorkbenchOverlay>);
    dialog.removeAttribute('open');
    fireEvent(dialog, new Event('close'));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('refuses a preview whose license files it cannot show', async () => {
    for (const license of [{ status: 'open', spdx: 'MIT', file: null }, { status: 'unknown', files: [{ path: 'LICENSE', text: 'Terms.' }] }, { status: 'maybe', files: [] }]) {
      vi.stubGlobal('fetch', vi.fn(async () => json(preview({ license }))));
      await expect(previewRegistrySkill('tenant-a', hit.id)).rejects.toMatchObject({ code: 'invalid_skill_response' });
    }
    vi.stubGlobal('fetch', vi.fn(async () => json(preview({ license: { status: 'unknown', files: [{ path: 'NOTICE', notice: true, text: 'Credits.', truncated: false }] } }))));
    expect((await previewRegistrySkill('tenant-a', hit.id)).license.files[0].notice).toBe(true);
  });

  it('formats install counts and names every refusal in both languages', () => {
    expect([formatInstalls(7, 'zh'), formatInstalls(9999, 'zh'), formatInstalls(185000, 'zh'), formatInstalls(123456789, 'zh')]).toEqual(['7 次安装', '9999 次安装', '18.5 万次安装', '1.2 亿次安装']);
    expect([formatInstalls(1, 'en'), formatInstalls(999, 'en'), formatInstalls(185000, 'en'), formatInstalls(1500000, 'en')]).toEqual(['1 install', '999 installs', '185K installs', '1.5M installs']);
    for (const code of ['skill_registry_unavailable', 'skill_registry_busy', 'skill_registry_rate_limited', 'skill_registry_timeout', 'skill_registry_upstream', 'skill_registry_not_found',
      'skill_registry_too_large', 'skill_registry_unimportable', 'skill_registry_unreadable', 'skill_registry_empty', 'skill_registry_folder_too_large', 'skill_registry_answer_too_large', 'skill_registry_hidden_text', 'skill_registry_changed', 'skill_registry_license_unconfirmed', 'invalid_skill_registry_request']) {
      const error = new SaaSApiError(400, code, 'server text');
      expect(saasErrorMessage(error, 'zh')).not.toBe('server text');
      expect(saasErrorMessage(error, 'en')).not.toBe('server text');
    }
  });
});
