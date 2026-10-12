import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { ContractFields } from '../src/canvas/ContractFields';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { parseContractOutput } from '../src/canvas/nodeContracts';
import { prepareNodeConversation } from '../src/canvas/nodeConversation';
import { prepareRunDocument } from '../src/canvas/runRecoveryDocument';
import { resetAllSessions } from '../src/canvas/sessions';
import { SessionTile } from '../src/canvas/SessionTile';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { canonicalCanvasText } from '../src/saas/productionCanvasText';
import { createProductionCopyDocument } from '../src/saas/productionCopy';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import { loadProductionRun, type ProductionRunRecord } from '../src/saas/productionRuns';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { RECORDED_CASE_WORKFLOWS } from '../src/saas/recordedCanvases';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import type { Identity, Tenant } from '../src/saas/api';

vi.mock('../src/saas/productionRuns', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/saas/productionRuns')>();
  return { ...actual, loadProductionRun: vi.fn(actual.loadProductionRun) };
});

// Every published case: the canvases compiled from tasks and the knowledge base's recorded one.
const WORKFLOWS = { ...PRODUCTION_WORKFLOWS, ...RECORDED_CASE_WORKFLOWS };
const CASES = Object.keys(WORKFLOWS);
// A media case's image and video nodes generate afresh in a copy, and the page they feed is made on its first run.
const RECORDED = CASES.filter(id => !WORKFLOWS[id].media?.length);
const records = new Map<string, ProductionRunRecord>();
const copyOf = (id: string, locale: 'zh' | 'en' = 'zh') => createProductionCopyDocument(WORKFLOWS[id], records.get(id)!, locale, null);
const tenant: Tenant = { id: 'copy-workspace', name: 'Copy workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const identity: Identity = { user: { id: 'copy-user', name: 'Copy user', email: 'copy@example.invalid', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeAll(async () => {
  for (const id of CASES) records.set(id, (await loadProductionRun(id))!);
  await import('../src/saas/ProductionShowcase');
}, 300_000);
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('carries every agent’s recorded delivery into its copy, as the case’s, on the very canvas that ran', () => {
  expect(CASES).toHaveLength(11);
  expect(RECORDED).toHaveLength(9);
  for (const id of RECORDED) {
    const workflow = WORKFLOWS[id], record = records.get(id)!, copy = copyOf(id);
    // Only results are added: the tasks, contracts and wires are the pinned canvas the case ran on.
    expect(canonicalCanvasText(copy)).toBe(canonicalCanvasText(createOfficialDocument(workflow, 'zh')));
    copy.nodes.forEach((node, index) => {
      const recorded = record.nodes.find(value => value.id === workflow.nodes[index].id)!;
      const session = node as SessionNode;
      expect(session.lastOutput, `${id}/${recorded.id}`).toEqual({ text: recorded.outputType === 'fields' ? expect.any(String) : recorded.output,
        at: Date.parse(`${record.capturedOn}T00:00:00Z`), source: 'case', model: record.model });
      expect(session.deliverablesOpen).toBe(true);
      const parsed = parseContractOutput(session.contract!, session.lastOutput!.text);
      expect(parsed.errors).toEqual([]);
      // Several named fields each come back exactly as the agent delivered them.
      if (recorded.outputType === 'fields') expect({ ...parsed.values }).toEqual(Object.fromEntries(recorded.fields!.map(field => [field.id, field.value])));
      else if (recorded.outputType === 'markdown') expect(parsed.values.result).toBe(recorded.output);
      else expect(parsed.values.result).toMatch(/^<!doctype html>/i);
    });
  }
});

it('shows every agent what it received: each wired input resolves to its upstream recording, marked as one', () => {
  for (const id of RECORDED) {
    const copy = copyOf(id), byId = new Map(copy.nodes.map(node => [node.id, node as SessionNode]));
    for (const node of copy.nodes as SessionNode[]) {
      const incoming = copy.edges.filter(edge => edge.toNode === node.id);
      const context = prepareNodeConversation(node, copy.nodes, copy.edges);
      expect(context.error, `${id}/${node.title}`).toBeUndefined();
      for (const edge of incoming) {
        const field = edge.toPort.slice('in:'.length), upstream = byId.get(edge.fromNode)!;
        // The wire carries the one output field it starts from, not the whole delivery.
        expect(context.inputs!.find(input => input.id === field)!.value).toBe(parseContractOutput(upstream.contract!, upstream.lastOutput!.text).values[edge.fromPort.slice('out:'.length)]);
        expect(context.recorded?.[field]).toBe(true);
      }
    }
  }
});

it('copies a media case on the very canvas that ran: agents with their recordings, media nodes fresh, the page they feed made on the first run', () => {
  const media = CASES.filter(id => WORKFLOWS[id].media?.length);
  expect(media.sort()).toEqual(['neon-city', 'shanhai-vn']);
  for (const id of media) {
    const workflow = WORKFLOWS[id], record = records.get(id)!, copy = copyOf(id);
    expect(canonicalCanvasText(copy)).toBe(canonicalCanvasText(createOfficialDocument(workflow, 'zh')));
    const fed = new Set(workflow.media!.flatMap(item => item.feeds ?? []));
    expect(copy.nodes).toHaveLength(workflow.nodes.length + workflow.media!.length);
    copy.nodes.forEach((node, index) => {
      const spec = workflow.nodes[index], session = node as SessionNode;
      if (!spec || fed.has(spec.id)) { expect(session.lastOutput, `${id}/${session.title}`).toBeUndefined(); return; }
      const recorded = record.nodes.find(value => value.id === spec.id)!;
      expect(session.lastOutput?.source, `${id}/${spec.id}`).toBe('case');
      expect(parseContractOutput(session.contract!, session.lastOutput!.text).values.result, `${id}/${spec.id}`).toBe(recorded.output);
    });
  }
});

it('keeps a case recording and its model through a save and reload, and grants no model to other outputs', () => {
  const copy = copyOf('pixel-platformer');
  const reloaded = sanitizeDocument(JSON.parse(JSON.stringify(copy)));
  expect(reloaded.nodes.map(node => (node as SessionNode).lastOutput)).toEqual(copy.nodes.map(node => (node as SessionNode).lastOutput));
  const raw = JSON.parse(JSON.stringify(copy));
  raw.nodes[0].lastOutput = { ...raw.nodes[0].lastOutput, source: 'run' };
  raw.nodes[1].lastOutput = { ...raw.nodes[1].lastOutput, source: 'sample' };
  const [run, unknown] = sanitizeDocument(raw).nodes as SessionNode[];
  expect(run.lastOutput).toEqual({ text: raw.nodes[0].lastOutput.text, at: raw.nodes[0].lastOutput.at, source: 'run' });
  expect(unknown.lastOutput?.source).toBe('run');
  expect(unknown.lastOutput?.model).toBeUndefined();
});

it('replaces every recording when the whole graph runs, and reuses the upstream recordings when one node reruns', () => {
  const copy = copyOf('pixel-platformer');
  const build = copy.nodes[PRODUCTION_WORKFLOWS['pixel-platformer'].nodes.findIndex(node => node.id === 'build')];
  const whole = prepareRunDocument(copy, copy.nodes.map(node => node.id), false);
  expect(whole.nodes.every(node => (node as SessionNode).lastOutput == null)).toBe(true);
  const single = prepareRunDocument(copy, [build.id], false);
  for (const node of single.nodes as SessionNode[]) {
    if (node.id === build.id) expect(node.lastOutput).toBeNull();
    else if (copy.edges.some(edge => edge.fromNode === node.id && edge.toNode === build.id)) expect(node.lastOutput?.source).toBe('case');
  }
});

it('refuses a recording of another canvas instead of pinning results to the wrong agents', () => {
  const workflow = PRODUCTION_WORKFLOWS['pixel-platformer'], record = records.get('pixel-platformer')!;
  expect(() => createProductionCopyDocument(workflow, { ...record, edges: record.edges.slice(1) }, 'zh', null)).toThrow(/does not match/);
  expect(() => createProductionCopyDocument(workflow, { ...record, nodes: record.nodes.map((node, index) => index ? node : { ...node, id: 'renamed' }) }, 'zh', null)).toThrow(/does not match/);
  expect(() => createProductionCopyDocument(PRODUCTION_WORKFLOWS['party-game'], record, 'zh', null)).toThrow(/does not match/);
});

it('wraps a recorded text that reads as JSON naming its field, so downstream receives exactly what was delivered', () => {
  const workflow = PRODUCTION_WORKFLOWS['pixel-platformer'], record = records.get('pixel-platformer')!;
  const odd = JSON.stringify({ result: 'nested' });
  const copy = createProductionCopyDocument(workflow, { ...record, nodes: record.nodes.map(node => node.id === 'design' ? { ...node, output: odd } : node) }, 'zh', null);
  const design = copy.nodes[workflow.nodes.findIndex(node => node.id === 'design')] as SessionNode;
  expect(design.lastOutput?.text).toBe(JSON.stringify({ result: odd }));
  expect(parseContractOutput(design.contract!, design.lastOutput!.text).values.result).toBe(odd);
});

it('keeps the recordings through settings, task and wire edits and undo, and clears them only below a replaced output', () => {
  const copy = copyOf('pixel-platformer'), workflow = PRODUCTION_WORKFLOWS['pixel-platformer'];
  const at = (id: string, doc = copy) => doc.nodes[workflow.nodes.findIndex(node => node.id === id)] as SessionNode;
  const recordings = (doc: typeof copy) => doc.nodes.filter(node => (node as SessionNode).lastOutput?.source === 'case').length;
  const edit = (id: string, change: Partial<SessionNode>) => ({ ...copy, nodes: copy.nodes.map(node => node.id === at(id).id ? { ...node, ...change } : node) });
  // Choosing a model or rewording a task: the recordings are references, not this configuration's results.
  expect(recordings(invalidateOutputs(copy, edit('design', { runtime: 'openai-agents', model: 'qwen3.8-27b-p6' })))).toBe(6);
  const reworded = invalidateOutputs(copy, edit('design', { persona: `${at('design').persona}\n多一条要求。` }));
  expect(recordings(reworded)).toBe(6);
  expect(recordings(invalidateOutputs(reworded, copy))).toBe(6);
  expect(recordings(invalidateOutputs(copy, { ...copy, edges: copy.edges.slice(1) }))).toBe(6);
  // The build delivers its own result: the review stood on the case's build, so it is cleared; the upstream stays.
  const built = invalidateOutputs(copy, edit('build', { lastOutput: { text: at('build').lastOutput!.text, at: Date.now(), source: 'run' } }));
  expect(at('review', built).lastOutput).toBeNull();
  expect(['design', 'art', 'levels', 'sound'].every(id => at(id, built).lastOutput?.source === 'case')).toBe(true);
  expect(at('build', built).lastOutput?.source).toBe('run');
});

it('names a case recording for what it is, with its model and day, and never as a run of this workspace', () => {
  const node = copyOf('pixel-platformer').nodes[0] as SessionNode;
  render(<NodeDeliverables node={node} readOnly onUpdateNode={() => {}} />);
  expect(screen.getByText('案例实录 · Claude Opus 5.5 · 2026-10-11 真实运行')).toBeVisible();
  expect(screen.getByText('没有在你的工作区运行；运行整张图会换成你自己的结果')).toBeVisible();
  expect(screen.queryByText(/来自运行|交付$/)).toBeNull();
  cleanup();
  const field = { id: 'from_design', label: '玩法与数值', type: 'markdown' as const, required: true, value: '' };
  render(<ContractFields fields={[field]} resolvedFields={[{ ...field, value: '交付内容' }]} sources={{ from_design: '玩法与数值' }} recorded={{ from_design: true }} label="输入" onChange={() => {}} readOnly />);
  expect(screen.getByText('收到“玩法与数值”的案例实录：真实运行的内容，没有在你的工作区执行；断开连线后可手动填写。')).toBeVisible();
});

it('marks a recording on the collapsed card and opens a node on what it was asked, received and delivered', () => {
  resetAllSessions();
  const art = copyOf('pixel-platformer').nodes[1] as SessionNode;
  const { unmount } = render(<SessionTile node={art} compact scale={1} focused={false} onToggleFocus={vi.fn()} />);
  expect(screen.getByRole('button', { name: `打开 ${art.title}` })).toHaveTextContent(/^.*案例实录 · \/\/ 状态：以下 12 个精灵/);
  unmount();
  const { container, rerender } = render(<SessionTile node={art} scale={1} focused onToggleFocus={vi.fn()} />);
  expect(container.querySelector('.awwo-node-workbench')).toHaveClass('is-case-intro');
  expect(screen.getByRole('region', { name: '输入表单' })).toBeVisible();
  expect(within(screen.getByRole('region', { name: '交付物' })).getByText('案例实录 · Claude Opus 5.5 · 2026-10-11 真实运行')).toBeVisible();
  // The member's own result is not a recording: the node lays out as any other.
  rerender(<SessionTile node={{ ...art, lastOutput: { text: art.lastOutput!.text, at: Date.now(), source: 'run' } }} scale={1} focused onToggleFocus={vi.fn()} />);
  expect(container.querySelector('.awwo-node-workbench')).not.toHaveClass('is-case-intro');
  cleanup();
  // Once set up (it may have a conversation), the node no longer opens on its inputs.
  render(<SessionTile node={{ ...art, binding: { companyId: 'c1', agentId: 'a1', agentName: 'Agent' } }} scale={1} focused onToggleFocus={vi.fn()} />);
  expect(screen.queryByRole('region', { name: '输入表单' })).toBeNull();
});

function server() {
  const posts: { url: string; body: any }[] = [];
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/runtime')) return json({ available: true, configured: true, plannerAvailable: true, runtimes: [], models: [] });
    if (url.endsWith('/canvases') && init.method === 'POST') { const body = JSON.parse(init.body as string); posts.push({ url, body }); return json({ id: 'new-copy', document: body.document }, 201); }
    if (url.includes('/canvases?')) return json({ items: [], nextCursor: null });
    throw new Error(`Unexpected endpoint: ${url}`);
  }));
  return posts;
}
async function openCopy(name = '像素平台跳跃') {
  // The first row shows three cases; the others are one click away.
  if (!screen.queryByRole('button', { name })) fireEvent.click(screen.getByRole('button', { name: /^(查看全部 \d+ 个制作案例|See all \d+ cases)$/ }));
  fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.click(await within(screen.getByRole('dialog', { name })).findByRole('button', { name: '复制这张画布' }));
  return screen.getByRole('dialog', { name: '复制案例到我的画布' });
}

it('copies a case from the workspace home with every agent’s recording, and says so before it does', async () => {
  const posts = server(), onOpen = vi.fn();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy();
  expect(within(setup).getByText(/并带上 2026-10-11 真实运行中每个 Agent 收到和交付的内容（6\/6 个节点，标为「案例实录」）/)).toBeVisible();
  expect(within(setup).getByText(/案例实录由 Claude Opus 5\.5 生成，没有在你的工作区运行；运行整张图会换成你自己的结果。/)).toBeVisible();
  fireEvent.click(within(setup).getByRole('button', { name: '创建草稿' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledExactlyOnceWith('new-copy'));
  expect(posts).toHaveLength(1);
  const sent = posts[0].body.document.nodes;
  expect(sent).toHaveLength(6);
  expect(sent.every((node: any) => node.lastOutput?.source === 'case' && node.lastOutput.model === 'Claude Opus 5.5' && node.lastOutput.text)).toBe(true);
});

it('tells an English member that the agents worked in Chinese before copying', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  server();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: /^See all \d+ cases$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Pixel platformer' }));
  fireEvent.click(await within(screen.getByRole('dialog', { name: 'Pixel platformer' })).findByRole('button', { name: 'Copy this canvas' }));
  const setup = screen.getByRole('dialog', { name: 'Copy example to my canvases' });
  expect(within(setup).getByText(/with what every agent received and delivered in the real run on 2026-10-11 \(6\/6 nodes, marked “case recording”\)/)).toBeVisible();
  expect(within(setup).getByText(/This case’s agents worked in Chinese, so the recordings are shown as delivered; the canvas’s tasks are copied in English/)).toBeVisible();
});

it('creates nothing when a case has no published recording, rather than an empty copy', async () => {
  const posts = server(), onOpen = vi.fn(), load = vi.mocked(loadProductionRun), actual = load.getMockImplementation()!;
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy();
  load.mockResolvedValue(undefined);
  try {
    fireEvent.click(within(setup).getByRole('button', { name: '创建草稿' }));
    expect(await within(setup).findByText('无法读取这个案例的运行实录，没有创建画布。请刷新后重试。')).toBeVisible();
    expect(posts).toHaveLength(0);
  } finally { load.mockImplementation(actual); }
});

it('creates nothing when the recording cannot be read, rather than an empty copy', async () => {
  const posts = server(), onOpen = vi.fn(), load = vi.mocked(loadProductionRun), actual = load.getMockImplementation()!;
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy();
  load.mockRejectedValue(new Error('chunk failed'));
  try {
    fireEvent.click(within(setup).getByRole('button', { name: '创建草稿' }));
    expect(await within(setup).findByText('无法读取这个案例的运行实录，没有创建画布。请刷新后重试。')).toBeVisible();
    expect(posts).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
  } finally { load.mockImplementation(actual); }
});

it('copies the knowledge base as it ran: its Chinese canvas in an English copy too, each wire carrying one recorded field', () => {
  const zh = copyOf('knowledge-base'), en = copyOf('knowledge-base', 'en'), record = records.get('knowledge-base')!;
  expect(canonicalCanvasText(en)).toBe(canonicalCanvasText(zh));
  const nodes = en.nodes as SessionNode[];
  expect(nodes.map(node => node.title)).toEqual(['产品边界与架构需求', '用户登录与工作区权限', '文档数据治理', '知识库上线物料', '后端接口与业务规则', '知识库 Web 工作台', '交付验收']);
  expect(nodes.every(node => node.lastOutput?.source === 'case' && node.lastOutput.model === 'Codex')).toBe(true);
  // The workspace received the governance agent's data dictionary in the field it had added for it.
  const context = prepareNodeConversation(nodes[5], en.nodes, en.edges);
  expect(context.inputs!.find(input => input.label === '文档数据字典')!.value).toBe(record.nodes.find(node => node.id === 'data')!.fields!.find(field => field.id === 'schema')!.value);
  expect(context.recorded?.documentSchema).toBe(true);
  render(<NodeDeliverables node={nodes[6]} readOnly onUpdateNode={() => {}} />);
  // A delivery of several fields counts them after the run it came from.
  expect(screen.getByText('案例实录 · Codex · 2026-09-04 真实运行 · 3/3 项')).toBeVisible();
});

it('copies the knowledge base from the workspace home as it ran, and says where it ran before it does', async () => {
  const posts = server(), onOpen = vi.fn();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy('团队知识库 SaaS');
  expect(within(setup).getByText(/^复制 2026-09-04 真实运行的那张画布（7 个节点）：每个 Agent 的人设、它当时收到的任务和字段说明以及连线都与那次运行一致，并带上每个 Agent 收到和交付的内容（7\/7 个节点，标为「案例实录」）。/)).toBeVisible();
  expect(within(setup).getByText(/案例实录由 Codex 生成，没有在你的工作区运行；运行整张图会换成你自己的结果。 这张画布 2026-09-04 在 AwwO 的本地开发预览里运行，每个 Agent 是一个在那台电脑上有独立工作目录的 Codex 会话。实录里的本机目录和内部 ID 已隐去；实录提到的 artifacts\/ 文件和前端原型留在那台电脑上，没有随画布复制。画布里的任务是按当时的 Codex 本地执行器写的，在你的工作区重新运行时由你选择的模型执行，结果可能不同。$/)).toBeVisible();
  fireEvent.click(within(setup).getByRole('button', { name: '创建草稿' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledExactlyOnceWith('new-copy'));
  expect(posts).toHaveLength(1);
  expect(posts[0].body.name).toBe('团队知识库 SaaS');
  const sent = posts[0].body.document;
  expect([sent.nodes.length, sent.edges.length]).toEqual([7, 12]);
  expect(sent.nodes.every((node: any) => node.lastOutput?.source === 'case' && node.lastOutput.model === 'Codex' && node.lastOutput.text)).toBe(true);
});

it('tells an English member that the knowledge base comes over in Chinese, canvas and recordings alike', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  server();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Team knowledge-base SaaS' }));
  fireEvent.click(await within(screen.getByRole('dialog', { name: 'Team knowledge-base SaaS' })).findByRole('button', { name: 'Copy this canvas' }));
  const setup = screen.getByRole('dialog', { name: 'Copy example to my canvases' });
  expect(within(setup).getByText(/^Copy the canvas of the real run on 2026-09-04 \(7 nodes\): every agent’s persona, the task and field descriptions it received, and the wires are as they were in that run/)).toBeVisible();
  expect(within(setup).getByText(/the artifacts\/ files and the front-end prototype they mention stayed on that computer and are not copied\. The canvas’s tasks were written for that local Codex runtime; a rerun in your workspace uses the model you choose and may turn out differently\. This case’s canvas and recordings are in Chinese, as they ran, and are copied as they are\.$/)).toBeVisible();
  expect(within(setup).queryByText(/copied in English/)).toBeNull();
});

it('stops the copy when a delivered node cannot hold its recording, rather than copying it blank under a 7/7 claim', () => {
  const record = records.get('knowledge-base')!, workflow = WORKFLOWS['knowledge-base'];
  const renamed = { ...record, nodes: record.nodes.map(node => node.id === 'review' ? { ...node, fields: node.fields!.map((field, index) => index ? field : { ...field, id: 'verdict' }) } : node) };
  expect(() => createProductionCopyDocument(workflow, renamed, 'zh', null)).toThrow(/review its canvas cannot hold/);
});

it('carries an optional file a recording left empty as no file, the way the contract and the server read it', () => {
  const record = records.get('knowledge-base')!, workflow = WORKFLOWS['knowledge-base'];
  const empty = { ...record, nodes: record.nodes.map(node => node.id === 'frontend' ? { ...node, fields: node.fields!.map(field => field.id === 'preview' ? { ...field, value: '' } : field) } : node) };
  const frontend = createProductionCopyDocument(workflow, empty, 'zh', null).nodes[workflow.nodes.findIndex(node => node.id === 'frontend')] as SessionNode;
  const parsed = parseContractOutput(frontend.contract!, frontend.lastOutput!.text);
  expect(parsed.errors).toEqual([]);
  expect('preview' in parsed.values).toBe(false);
  expect(parsed.values.delivery).toBe(record.nodes.find(node => node.id === 'frontend')!.fields!.find(field => field.id === 'delivery')!.value);
});
