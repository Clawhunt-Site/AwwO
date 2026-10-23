// AwwO 本地版 in the hosted web app (edition.ts): 本机 in the place of 用量与计费, no administration link, no plan offers,
// a tutorial that is offered but never required, a sign-in page that takes no new accounts, and the import of the file
// the hosted site's 导出我的数据 saved.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PersonalEngineGate } from '../src/saas/PersonalAccount';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider, emptyAccountPreferences } from '../src/saas/accountPreferences';
import { LocalEdition } from '../src/saas/edition';
import { PlanUpsell } from '../src/saas/PlanUpsell';
import { TUTORIAL_REQUIRED_SINCE, tutorialRequired } from '../src/saas/SaaSOnboarding';
import { editionSection } from '../src/saas/SettingsCenter';
import { SaaSApp } from '../src/saas/SaaSApp';
import { detachDocument, fitName, importAccountExport, readAccountExport, type AccountExport } from '../src/saas/settings/accountImport';
import type { Identity } from '../src/saas/api';

const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const hosted = { user: { id: 'ada', name: 'Ada', email: 'ada@example.test', platformRole: 'admin' }, authentication: 'local', personalCredentialsRequired: false,
  tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner', createdAt: '2026-10-20T00:00:00Z' }] } as unknown as Identity;
const local = { ...hosted, edition: 'local', personalCredentialsRequired: true } as unknown as Identity;
const computer = { dataFolder: 'C:\\Users\\Ada\\AwwO 本地版', providersFile: 'C:\\Users\\Ada\\AwwO 本地版\\providers.env', media: false,
  managedExecution: true, render: false, webReader: false, skillRegistry: true, revision: '410b99fd1234567890abcdef', webReaderProxy: 'http://127.0.0.1:7897' };

/** The local API: the 本机 status, the settings, and workspaces and canvases made by an import. */
function server({ local: status = computer as unknown, refuseCanvas = '' } = {}) {
  const made = { tenants: [] as string[], canvases: [] as Array<{ tenant: string; name: string; document: unknown }> };
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const path = new URL(url, 'http://localhost').pathname;
    if (path.endsWith('/local')) return status instanceof Response ? status : json(status);
    if (path.endsWith('/auth/preferences')) return json({ preferences: emptyAccountPreferences(), version: 1 });
    if (path.endsWith('/auth/connections')) return json({ items: [], providers: [] });
    if (path.endsWith('/auth/deletion-request')) return json({ request: null });
    if (path.endsWith('/tenants') && method === 'POST') {
      const id = `new-${made.tenants.length + 1}`;
      made.tenants.push(JSON.parse(String(init.body)).name);
      return json({ id, name: made.tenants.at(-1), status: 'active', role: 'owner' }, 201);
    }
    const canvas = /\/tenants\/([^/]+)\/canvases$/.exec(path);
    if (canvas && method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.name === refuseCanvas) return json({ error: { code: 'invalid_input', message: 'Name and JSON document object required' } }, 400);
      made.canvases.push({ tenant: canvas[1], name: body.name, document: body.document });
      return json({ id: `canvas-${made.canvases.length}`, tenantId: canvas[1], name: body.name, document: body.document, version: 1 }, 201);
    }
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, made };
}

function open(section: string, who: Identity) {
  history.replaceState(null, '', `/?account=${section}`);
  return render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={who.user.id}><LocalEdition.Provider value={who.edition === 'local'}>
    <PersonalEngineGate identity={who}><p>workspace</p></PersonalEngineGate>
  </LocalEdition.Provider></AccountPreferencesProvider></SaaSPreferencesProvider>);
}

const exportFile = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  kind: 'awwo.account-export', schemaVersion: 1, exportedAt: '2026-10-21T08:00:00Z', user: { id: 'ada' },
  workspaces: [{ id: 'w1', name: 'Studio', status: 'active', role: 'owner' }, { id: 'w2', name: 'Paused', status: 'suspended', role: 'owner' }, { id: 'w3', name: 'Team', status: 'active', role: 'member' }],
  canvases: [
    { id: 'c1', tenantId: 'w1', name: 'Trailer', document: { nodes: [{ id: 'n1' }], edges: [] }, version: 4 },
    { id: 'c2', tenantId: 'w3', name: 'Plan', document: { nodes: [], edges: [] }, version: 1 },
    { id: 'c3', tenantId: 'w1', name: 'Poster', document: { nodes: [], edges: [] }, version: 2 },
    { id: 'c4', tenantId: 'gone', name: 'Orphan', document: { nodes: [] }, version: 1 },
    { id: 'c5', tenantId: 'w1', name: 'Broken', document: [], version: 1 },
  ],
  complete: true, ...overrides,
});

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); });

it('opens the links to 用量与计费 and 邀请好友 as 本机 in the local edition, and 本机 as 账号安全 on the hosted site', () => {
  for (const section of ['plans', 'invites', 'local'] as const) expect(editionSection(local, section)).toBe('local');
  expect(editionSection(local, 'security')).toBe('security');
  expect(editionSection(hosted, 'local')).toBe('security');
  expect(editionSection(hosted, 'plans')).toBe('plans');
});

it('shows this computer in place of usage and billing, without the administration link', async () => {
  server();
  open('plans', local);
  expect(await screen.findByRole('heading', { level: 1, name: '本机' })).toBeVisible();
  const nav = screen.getByRole('navigation', { name: '设置' });
  expect(within(nav).getByRole('link', { name: '本机' })).toHaveAttribute('aria-current', 'page');
  expect(within(nav).queryByRole('link', { name: '用量与计费' })).toBeNull();
  expect(within(nav).queryByRole('link', { name: '平台管理' })).toBeNull();
  expect(await screen.findByText(computer.dataFolder)).toBeVisible();
  expect(screen.getByText(computer.providersFile)).toBeVisible();
  expect(screen.getByText('未开启：providers.env 中还没有媒体服务密钥。')).toBeVisible();
  const services = document.querySelector('.saas-local-services')!;
  const row = (name: string) => within(services as HTMLElement).getByText(name).closest('li')!;
  expect(row('直接执行')).toHaveTextContent('已开启');
  expect(row('渲染视频与剪辑')).toHaveTextContent('未开启');
  expect(row('渲染视频与剪辑')).toHaveTextContent('ffmpeg');
  expect(row('技能库（skills.sh）')).toHaveTextContent('已开启');
  expect(row('技能库（skills.sh）')).toHaveTextContent('经本机代理 http://127.0.0.1:7897 访问网站。');
  expect(row('从网址读取')).toHaveTextContent('这次启动没有开启。');
  expect(screen.getByText('410b99fd1234')).toBeVisible();
  // Nothing of the hosted plans page: its heading, its plans, its upgrade.
  expect(screen.queryByRole('heading', { name: '用量与计费' })).toBeNull();
  expect(screen.queryByText(/Pro|Max|升级/)).toBeNull();
});

it('names the window’s menu, not npm commands, in AwwO Local’s window', async () => {
  server({ local: { ...computer, managedExecution: false, shell: 'windows' } });
  open('local', local);
  expect(await screen.findByText(computer.dataFolder)).toBeVisible();
  const services = document.querySelector('.saas-local-services')!;
  const row = (name: string) => within(services as HTMLElement).getByText(name).closest('li')!;
  expect(row('直接执行')).toHaveTextContent('安装版暂不提供');
  expect(row('渲染视频与剪辑')).toHaveTextContent('退出 AwwO 本地版（菜单「AwwO → 退出」）再重新打开');
  expect(screen.getByText(/填写或修改后用菜单「AwwO → 重新启动」即可生效/)).toBeVisible();
  expect(screen.getByText(/AWWO_WEB_READER_PROXY.*然后用菜单「AwwO → 重新启动」/)).toBeVisible();
  // From a checkout the same page names the commands.
  cleanup();
  server({ local: { ...computer, managedExecution: false } });
  open('local', local);
  expect(await screen.findByText(computer.dataFolder)).toBeVisible();
  expect(within(document.querySelector('.saas-local-services') as HTMLElement).getByText('直接执行').closest('li')).toHaveTextContent('npm run setup:local');
  expect(screen.queryByText(/菜单「AwwO/)).toBeNull();
});

it('names the Mac app’s menu and Homebrew in its local workspace', async () => {
  server({ local: { ...computer, managedExecution: false, render: false, shell: 'macos' } });
  open('local', local);
  expect(await screen.findByText(computer.dataFolder)).toBeVisible();
  const services = document.querySelector('.saas-local-services')!;
  const row = (name: string) => within(services as HTMLElement).getByText(name).closest('li')!;
  expect(row('直接执行')).toHaveTextContent('安装版暂不提供');
  expect(row('渲染视频与剪辑')).toHaveTextContent('brew install ffmpeg');
  expect(row('渲染视频与剪辑')).toHaveTextContent('退出 AwwO（菜单「AwwO → 退出 AwwO」）再重新打开');
  expect(row('渲染视频与剪辑')).not.toHaveTextContent('PATH');
  expect(screen.getByText(/填写或修改后用菜单「AwwO → 重新启动」即可生效/)).toBeVisible();
});

it('tells the sign-in page’s person where AwwO Local’s window keeps the password and how its menu resets it', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/auth/options')
    ? json({ clawhuntSSO: false, localAuth: true, passwordRecovery: false, edition: 'local', registration: false, shell: 'windows' })
    : json({ error: { code: 'unauthenticated' } }, 401)));
  render(<SaaSApp />);
  expect(await screen.findByText(/admin-credentials\.txt 中（菜单「AwwO → 打开数据目录」）.*菜单「AwwO → 重置登录密码」/)).toBeVisible();
  expect(screen.queryByText(/npm run/)).toBeNull();
});

it('names the menu on the sign-in page of the Mac app’s local workspace too', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/auth/options')
    ? json({ clawhuntSSO: false, localAuth: true, passwordRecovery: false, edition: 'local', registration: false, shell: 'macos' })
    : json({ error: { code: 'unauthenticated' } }, 401)));
  render(<SaaSApp />);
  expect(await screen.findByText(/菜单「AwwO → 重置登录密码」/)).toBeVisible();
  expect(screen.queryByText(/npm run/)).toBeNull();
});

it('says why 本机 could not be read', async () => {
  server({ local: json({ error: { code: 'not_found', message: 'Not found' } }, 404) });
  open('local', local);
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByText(computer.dataFolder)).toBeNull();
});

it('keeps the hosted site’s 用量与计费 and administration link, and opens ?account=local as 账号安全 there', async () => {
  server();
  open('local', hosted);
  expect(await screen.findByRole('heading', { level: 1, name: '账号安全' })).toBeVisible();
  const nav = screen.getByRole('navigation', { name: '设置' });
  expect(within(nav).getByRole('link', { name: '用量与计费' })).toBeVisible();
  expect(within(nav).queryByRole('link', { name: '本机' })).toBeNull();
  expect(within(nav).getByRole('link', { name: '平台管理' })).toHaveAttribute('href', '/admin');
});

it('replaces the deletion request with the local note and offers the import, in the local edition only', async () => {
  const { fetch } = server();
  open('data', local);
  expect(await screen.findByRole('heading', { name: '从 AwwO 在线版导入' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '删除本机数据' })).toBeVisible();
  expect(screen.getByRole('link', { name: '在「本机」查看数据目录' })).toHaveAttribute('href', '/?account=local');
  expect(screen.queryByRole('button', { name: '申请删除账号' })).toBeNull();
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/auth/deletion-request'))).toBe(false);
  cleanup();
  open('data', hosted);
  expect(await screen.findByRole('button', { name: '申请删除账号' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '从 AwwO 在线版导入' })).toBeNull();
});

it('reads an export: its active workspaces in order, each with its own canvases', () => {
  const plan = readAccountExport(exportFile()) as AccountExport;
  expect(plan.exportedAt).toBe('2026-10-21T08:00:00Z');
  expect(plan.workspaces).toEqual([
    { name: 'Studio', canvases: [{ name: 'Trailer', document: { nodes: [{ id: 'n1' }], edges: [] } }, { name: 'Poster', document: { nodes: [], edges: [] } }] },
    { name: 'Team', canvases: [{ name: 'Plan', document: { nodes: [], edges: [] } }] },
  ]);
  expect(plan.canvasCount).toBe(3);
});

it('refuses a file that is not an export, one cut short, one from a newer AwwO, and one with nothing active', () => {
  expect(readAccountExport('not json')).toBe('not_export');
  expect(readAccountExport(JSON.stringify({ kind: 'something-else', workspaces: [], canvases: [] }))).toBe('not_export');
  expect(readAccountExport(exportFile({ canvases: undefined }))).toBe('not_export');
  expect(readAccountExport(exportFile({ complete: false }))).toBe('incomplete');
  expect(readAccountExport(exportFile({ complete: undefined }))).toBe('incomplete');
  expect(readAccountExport(exportFile({ schemaVersion: 2 }))).toBe('newer');
  expect(readAccountExport(exportFile({ workspaces: [{ id: 'w2', name: 'Paused', status: 'suspended' }] }))).toBe('empty');
});

it('imports each workspace and its canvases in order, lists what the API refused, and goes on', async () => {
  const { made } = server({ refuseCanvas: 'Poster' });
  const reports: number[] = [];
  const done = await importAccountExport(readAccountExport(exportFile()) as AccountExport, progress => reports.push(progress.done));
  expect(made.tenants).toEqual(['Studio', 'Team']);
  expect(made.canvases.map(item => [item.tenant, item.name])).toEqual([['new-1', 'Trailer'], ['new-2', 'Plan']]);
  expect(made.canvases[0].document).toEqual({ nodes: [{ id: 'n1' }], edges: [] });
  expect(done).toMatchObject({ done: 3, total: 3, workspaces: 2, imported: 2 });
  expect(done.failed.map(item => [item.workspace, item.canvas])).toEqual([['Studio', 'Poster']]);
  expect(reports.at(-1)).toBe(3);
});

// A session node as the API's initialization leaves it (node_setup.go), bound to the hosted workspace's agent and session.
const bound = { companyId: 'hosted-workspace', agentId: 'hosted-agent', agentName: 'Writer' };
const media = JSON.stringify({ type: 'awwo.media', version: 1, kind: 'image', model: 'hosted.image', items: [{ artifactId: 'aHostedArtifact1', name: 'still.png', contentType: 'image/png', size: 10 }] });
const hostedCanvas = () => ({ version: 2, updatedAt: 1, view: null, waypoints: [], edges: [{ id: 'e1', from: 'writer', to: 'page' }], nodes: [
  { id: 'writer', kind: 'session', agentKind: 'llm', runtime: 'pi', model: 'qwen3.8-27b-p6', effort: 'high', persona: 'Write the plan.', title: 'Writer', x: 0, y: 0, w: 320, h: 240,
    binding: bound, bindAttempt: null, issueId: 'hosted-session', agentRef: { source: 'workspace', agentId: 'hosted-agent' }, activeThreadId: 't2', preview: 'Here is the plan',
    threads: [
      { id: 't1', title: 'Earlier', issueId: 'hosted-session-0', preview: '', draft: 'an old draft', createdAt: 1, binding: bound },
      { id: 't2', title: 'Plan', issueId: 'hosted-session', preview: 'Here is the plan', draft: 'Next: shorten it.\n\n[附件] notes.pdf · awwo-file:aHostedUpload1', createdAt: 2, binding: bound, agentRef: { source: 'workspace', agentId: 'hosted-agent' }, outputValues: { plan: 'x' } },
    ],
    skills: ['builtin:remotion-video', 'workspace:aHostedSkill1'], taskFrame: { version: 1, requirements: [] },
    lastOutput: { text: 'The plan, in words.', at: 5, source: 'run', supersedesGraphCanvasId: 'hosted-canvas', supersedesThroughGraphVersion: 7 },
    contract: { version: 1, inputs: [
      { id: 'brief', label: 'Brief', type: 'markdown', required: true, value: 'Write it warm, for families.\n\n[附件] brief.pdf · awwo-file:aHostedUpload2' },
      { id: 'reference', label: 'Reference', type: 'file', required: false, value: '[附件] ref.png · awwo-file:aHostedUpload3' },
      { id: 'tone', label: 'Tone', type: 'text', required: false, value: 'warm' }],
    outputs: [{ id: 'plan', label: 'Plan', type: 'text', required: true, value: 'The plan, in words.' }, { id: 'sheet', label: 'Sheet', type: 'file', required: false, value: '[附件] sheet.csv · awwo-file:aHostedArtifact3' }] } },
  { id: 'still', kind: 'session', agentKind: 'image', runtime: 'pi', model: 'hosted.image', effort: '', persona: '', title: 'Still', x: 400, y: 0, w: 320, h: 240,
    binding: bound, bindAttempt: null, issueId: 'hosted-session-2', preview: '', activeThreadId: 's1',
    threads: [{ id: 's1', title: '', issueId: 'hosted-session-2', preview: '', draft: 'A neon city at dusk\n\n[Attachment] ref.png · awwo-file:aHostedUpload4', createdAt: 3, binding: bound }],
    lastOutput: { text: media, at: 5, source: 'run' }, mediaParams: { size: '1024x1024' } },
  { id: 'cut', kind: 'edit', title: 'Cut', x: 0, y: 400, w: 320, h: 240, timeline: '{"version":"awwo.timeline/1"}', lastOutput: { text: '{"film":"named by artifact"}', at: 5, source: 'run' } },
  { id: 'page', kind: 'assemble', title: 'Page', x: 400, y: 400, w: 320, h: 240, template: '{{in:plan}}',
    contract: { version: 1, inputs: [], outputs: [{ id: 'file', label: 'File', type: 'file', required: true, value: 'index.html · awwo-file:aHostedArtifact2' }] },
    lastOutput: { text: 'index.html · awwo-file:aHostedArtifact2', at: 5, source: 'run' } },
] });

it('detaches a canvas from the hosted workspace, so each node is set up afresh on its first run here', () => {
  const original = hostedCanvas();
  const detached = detachDocument(original) as { nodes: Array<Record<string, unknown>>; edges: unknown };
  const [writer, still, cut, page] = detached.nodes;
  expect(writer).toMatchObject({ binding: null, bindAttempt: null, issueId: null, preview: '', skills: ['builtin:remotion-video'],
    runtime: 'pi', model: 'qwen3.8-27b-p6', effort: 'high', persona: 'Write the plan.', taskFrame: { version: 1, requirements: [] },
    lastOutput: { text: 'The plan, in words.', at: 5, source: 'run' } });
  expect(writer).not.toHaveProperty('agentRef');
  expect(writer.lastOutput).not.toHaveProperty('supersedesGraphCanvasId');
  expect(writer.lastOutput).not.toHaveProperty('supersedesThroughGraphVersion');
  // The open conversation's unsent draft comes along, as a new conversation, without its file.
  expect(writer.threads).toEqual([{ id: 't2', title: 'Plan', issueId: null, preview: '', draft: 'Next: shorten it.', createdAt: 2 }]);
  expect(writer.activeThreadId).toBe('t2');
  // An input keeps what was written in it without the old files; an output that named a file is made again.
  const contract = writer.contract as { inputs: Array<{ value: string }>; outputs: Array<{ value: string }> };
  expect(contract.inputs.map(field => field.value)).toEqual(['Write it warm, for families.', '', 'warm']);
  expect(contract.outputs.map(field => field.value)).toEqual(['The plan, in words.', '']);
  // A picture node keeps its prompt (its draft) and its settings, and loses the picture the old run made.
  expect(still).toMatchObject({ binding: null, issueId: null, lastOutput: null, mediaParams: { size: '1024x1024' }, activeThreadId: 's1',
    threads: [{ id: 's1', title: '', issueId: null, preview: '', draft: 'A neon city at dusk', createdAt: 3 }] });
  expect(cut).toMatchObject({ lastOutput: null, timeline: '{"version":"awwo.timeline/1"}' });
  expect(page).toMatchObject({ lastOutput: null, template: '{{in:plan}}' });
  expect((page.contract as { outputs: Array<{ value: string }> }).outputs[0].value).toBe('');
  expect(detached.edges).toEqual(original.edges);
  // Nothing of the old workspace is left anywhere in it, and the file's own copy is not changed.
  expect(JSON.stringify(detached)).not.toMatch(/hosted-workspace|hosted-agent|hosted-session|hosted-canvas|aHostedSkill1|aHostedUpload|aHostedArtifact|awwo-file:/);
  expect(original.nodes[0]).toMatchObject({ binding: bound, issueId: 'hosted-session' });
});

it('takes the default conversation’s draft when no open one is named, as the client and the server read it', () => {
  const node = (threads: unknown[], activeThreadId?: string) => (detachDocument({ nodes: [{ id: 'n', kind: 'session', binding: bound, issueId: 'hosted-session',
    threads, ...(activeThreadId ? { activeThreadId } : {}) }] }) as { nodes: Array<Record<string, unknown>> }).nodes[0];
  const threads = [{ id: 't1', title: 'Other', issueId: 'hosted-session-1', draft: 'not this one', createdAt: 1 }, { id: 'default', title: '', issueId: 'hosted-session', draft: 'this one', createdAt: 2 }];
  expect(node(threads)).toMatchObject({ activeThreadId: 'default', threads: [{ id: 'default', draft: 'this one', issueId: null }] });
  expect(node(threads, 'gone')).toMatchObject({ activeThreadId: 'default', threads: [{ id: 'default', draft: 'this one' }] });
  // Nothing written: no conversation comes along.
  expect(node([{ id: 'default', draft: '  \n[附件] a.png · awwo-file:aHostedUpload9' }])).toMatchObject({ threads: [] });
  expect(node([{ id: 'default', draft: '' }])).not.toHaveProperty('activeThreadId');
});

it('imports the detached canvas and fits a name the API would refuse as too long', async () => {
  const { made } = server();
  const long = `${'工'.repeat(66)}作区 · AwwO`;
  const plan: AccountExport = { exportedAt: '', canvasCount: 1, workspaces: [{ name: long, canvases: [{ name: long, document: hostedCanvas() }] }] };
  await importAccountExport(plan, () => {});
  expect(new TextEncoder().encode(made.tenants[0]).length).toBeLessThanOrEqual(200);
  expect(long.startsWith(made.tenants[0])).toBe(true);
  expect(made.canvases[0].document).toMatchObject({ nodes: [{ id: 'writer', binding: null, issueId: null, threads: [{ id: 't2', issueId: null }] }, {}, {}, {}] });
  expect(fitName('a'.repeat(198) + '中文')).toBe('a'.repeat(198));
  expect(fitName('Studio')).toBe('Studio');
});

it('ends the import when the API stops answering instead of refusing every canvas left', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => { calls++; if (calls === 1) return json({ id: 'new-1' }, 201); throw new TypeError('Failed to fetch'); }));
  const plan: AccountExport = { exportedAt: '', canvasCount: 3, workspaces: [{ name: 'Studio', canvases: [{ name: 'A', document: {} }, { name: 'B', document: {} }, { name: 'C', document: {} }] }] };
  await expect(importAccountExport(plan, () => {})).rejects.toBeInstanceOf(TypeError);
  expect(calls).toBe(2);
});

it('waits and tries a canvas again while the API’s canvas saves are busy', async () => {
  let busy = 2;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/tenants')) return json({ id: 'new-1' }, 201);
    if (busy-- > 0) return json({ error: { code: 'canvas_save_busy', message: 'Canvas saves are busy; try again shortly' } }, 503);
    return json({ id: 'c', name: JSON.parse(String(init.body)).name }, 201);
  }));
  const plan: AccountExport = { exportedAt: '', canvasCount: 1, workspaces: [{ name: 'Studio', canvases: [{ name: 'Trailer', document: { nodes: [] } }] }] };
  const done = await importAccountExport(plan, () => {}, { retryMs: 1 });
  expect(done).toMatchObject({ imported: 1, failed: [] });
});

it('stops when asked, and a refused workspace leaves its canvases out', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'invalid_input', message: 'Workspace name required' } }, 400)));
  const plan: AccountExport = { exportedAt: '', canvasCount: 2, workspaces: [{ name: '', canvases: [{ name: 'A', document: {} }, { name: 'B', document: {} }] }] };
  const done = await importAccountExport(plan, () => {});
  expect(done).toMatchObject({ done: 2, workspaces: 0, imported: 0 });
  expect(done.failed).toHaveLength(1);
  const stop = new AbortController();
  stop.abort();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => { init.signal?.throwIfAborted(); return json({ id: 'new-1' }, 201); }));
  await expect(importAccountExport(plan, () => {}, { signal: stop.signal })).rejects.toBeDefined();
});

it('ends the import when the session has ended instead of refusing every canvas left', async () => {
  const fetch = vi.fn(async (url: string) => String(url).endsWith('/tenants') ? json({ id: 'new-1' }, 201)
    : json({ error: { code: 'unauthorized', message: 'Session expired' } }, 401));
  vi.stubGlobal('fetch', fetch);
  const plan: AccountExport = { exportedAt: '', canvasCount: 3, workspaces: [{ name: 'Studio', canvases: [{ name: 'A', document: {} }, { name: 'B', document: {} }, { name: 'C', document: {} }] }] };
  const reports: number[] = [];
  await expect(importAccountExport(plan, progress => reports.push(progress.done))).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(reports).toEqual([0]);
});

it('imports a chosen export from 数据管理 and says what it made', async () => {
  const { made } = server();
  open('data', local);
  const input = (await screen.findByRole('button', { name: '选择导出文件' })).parentElement!.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File([exportFile()], 'awwo-account-export.json', { type: 'application/json' })] } });
  expect(await screen.findByText(/2 个工作区，3 张画布/)).toBeVisible();
  expect(screen.getByText('将新建：Studio、Team')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '开始导入' }));
  expect(await screen.findByText('已导入 3 张画布，新建 2 个工作区。')).toBeVisible();
  expect(made.canvases).toHaveLength(3);
  expect(screen.getByRole('link', { name: '返回工作区查看' })).toHaveAttribute('href', '/');
  // The same file again warns that it makes a second copy.
  fireEvent.change(input, { target: { files: [new File([exportFile()], 'awwo-account-export.json', { type: 'application/json' })] } });
  expect(await screen.findByText(/再导入会多出一份同样的工作区/)).toBeVisible();
});

it('keeps the file chosen last when an earlier choice is read more slowly', async () => {
  server();
  open('data', local);
  const input = (await screen.findByRole('button', { name: '选择导出文件' })).parentElement!.querySelector('input[type="file"]')!;
  const named = (name: string) => exportFile({ workspaces: [{ id: 'w1', name, status: 'active', role: 'owner' }] });
  let finishSlow: (text: string) => void = () => {};
  fireEvent.change(input, { target: { files: [{ text: () => new Promise<string>(resolve => { finishSlow = resolve; }) }] } });
  fireEvent.change(input, { target: { files: [{ text: async () => named('Chosen last') }] } });
  expect(await screen.findByText('将新建：Chosen last')).toBeVisible();
  finishSlow(named('Chosen first'));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.getByText('将新建：Chosen last')).toBeVisible();
  expect(screen.queryByText('将新建：Chosen first')).toBeNull();
});

it('says why a chosen file cannot be imported', async () => {
  server();
  open('data', local);
  const input = (await screen.findByRole('button', { name: '选择导出文件' })).parentElement!.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File([exportFile({ complete: false })], 'awwo-account-export.json')] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('这个导出文件不完整');
  expect(screen.queryByRole('button', { name: '开始导入' })).toBeNull();
});

it('offers no plan in the local edition', () => {
  render(<SaaSPreferencesProvider><LocalEdition.Provider value={true}><PlanUpsell tenantId="team-a" /></LocalEdition.Provider></SaaSPreferencesProvider>);
  expect(screen.queryByRole('note')).toBeNull();
  cleanup();
  render(<SaaSPreferencesProvider><PlanUpsell tenantId="team-a" /></SaaSPreferencesProvider>);
  expect(screen.getByRole('note')).toHaveTextContent('Pro / Max');
});

it('never requires the tutorial in the local edition', () => {
  const since = Date.parse(TUTORIAL_REQUIRED_SINCE) + 86_400_000;
  const fresh = (edition?: string) => ({ ...hosted, edition, tenants: [{ ...hosted.tenants[0], createdAt: new Date(since).toISOString() }] }) as unknown as Identity;
  expect(tutorialRequired(fresh(), since + 86_400_000)).toBe(true);
  expect(tutorialRequired(fresh('local'), since + 86_400_000)).toBe(false);
});

it('takes no new accounts on a sign-in page whose API says registration is closed', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/auth/options')
    ? json({ clawhuntSSO: false, localAuth: true, passwordRecovery: false, edition: 'local', registration: false })
    : json({ error: { code: 'unauthenticated' } }, 401)));
  render(<SaaSApp />);
  expect(await screen.findByText(/初始账号和密码在数据目录的 admin-credentials\.txt 中.*--reset-password/)).toBeVisible();
  expect(screen.getByRole('button', { name: '登录' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '创建账号和工作区' })).toBeNull();
  // No mail recovery here: the reset is the runtime's.
  expect(screen.queryByRole('button', { name: '忘记密码？' })).toBeNull();
});

it('leaves the usage meter and the administration links out of the local edition’s workspace', async () => {
  const me = { ...local, tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner', maxConcurrentRuns: 100, maxRunsPerDay: 100000 }] };
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    if (path.endsWith('/auth/me')) return json(me);
    if (path.endsWith('/route-usage')) return json({ limited: true, plan: null, daily: { used: 1, limit: 100 }, routes: {} });
    if (path.endsWith('/auth/connections')) return json({ items: [], providers: [] });
    return json({ items: [] });
  });
  vi.stubGlobal('fetch', fetch);
  localStorage.setItem('awwo.workmode.v1:ada', 'completed');
  render(<SaaSApp />);
  fireEvent.click(await screen.findByRole('button', { name: '更多选项' }));
  expect(await screen.findByRole('link', { name: '设置' })).toBeVisible();
  expect(screen.queryByRole('link', { name: '平台管理' })).toBeNull();
  expect(document.querySelector('.saas-route-usage-trigger')).toBeNull();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/route-usage'))).toBe(false);
});

it('keeps registration where the API does not say it is closed', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/auth/options')
    ? json({ clawhuntSSO: false, localAuth: true, passwordRecovery: false })
    : json({ error: { code: 'unauthenticated' } }, 401)));
  render(<SaaSApp />);
  expect(await screen.findByRole('button', { name: '创建账号和工作区' })).toBeVisible();
  expect(screen.queryByText(/admin-credentials\.txt/)).toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: '登录' })).toBeVisible());
});
