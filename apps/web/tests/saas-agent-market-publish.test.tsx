// Publishing to the Agent market (PublishAgentDialog.tsx): a node's persona, skills and model fill the form; what the
// server would refuse is marked on its field before anything is sent; a saved draft is created once and saved again in
// place; submitting sends it to review; a refusal the server ties to a field shows on that field; and an existing
// Agent's draft is read, edited and saved back with its frozen skills.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublishAgentDialog } from '../src/saas/market/PublishAgentDialog';
import { formFromNode, hasHiddenText, reservedName } from '../src/saas/market/publishForm';
import { createSessionNode } from '../src/canvas/canvasDoc';
import { forgetSkillCatalog } from '../src/saas/skillsApi';
import type { MarketSettings } from '../src/saas/marketApi';

type Call = { url: string; method: string; body: any };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settings: MarketSettings = { enabled: true, payouts: false, feeBps: 2500, maxPrice: 50, holdDays: 14 };
const skill = (ref: string, title: string, source: 'builtin' | 'workspace') => ({ ref, name: title.toLowerCase(), title, description: title, category: 'writing', applies: [],
  version: 1, source, bytes: 100, contentHash: 'h' });
const SKILLS = [skill('builtin:critic', 'Critic', 'builtin'), skill(`workspace:a${'b'.repeat(32)}`, 'House style', 'workspace')];
const status = { configured: true, available: true, models: [{ id: 'claude', name: 'Claude Opus', runtime: 'openai-agents', reasoningEfforts: ['low', 'high'] }],
  runtimes: [{ id: 'openai-agents', name: 'OpenAI Agents', configured: true, available: true, tools: [], supportsEffortSelection: true }] };
// The latest version as the author reads it (market_author.go marketVersionJSON, full): its skills with the
// references they were frozen from.
const draft = { version: 3, state: 'rejected', reviewNote: 'Name too generic', name: 'Copy Pro', tagline: 'Sharp', description: 'More', category: 'writing',
  kind: 'llm', instructions: 'Write well', instructionsPublic: false, price: 5, examples: [{ prompt: 'p', result: 'r' }],
  model: { runtime: 'openai-agents', id: 'claude', effort: 'high', locked: true }, submittedAt: null, reviewedAt: '2026-10-28T00:00:00Z',
  skills: [{ ref: 'builtin:critic', tenantId: '', name: 'critic', title: 'Critic', source: 'builtin', attribution: '', body: 'Critique' },
    { ref: `workspace:a${'b'.repeat(32)}`, tenantId: 'team', name: 'style', title: 'House style', source: 'workspace', attribution: '', body: 'Style' }] };
// What every draft request answers (replyMarketDraft): the Agent, its signature, and its latest version under `draft`.
const reply = (version: Record<string, unknown>, authorName = 'Ada', status = 'draft') => ({ id: 'agent-9', status, listedVersion: null, authorName, draft: version });
const stored = (body: any, version: number, state: string) => ({ ...draft, ...body, version, state, reviewNote: '',
  skills: body.skills.map((skill: { tenantId: string; ref: string }) => ({ ...skill, name: skill.ref, title: skill.ref, source: skill.tenantId ? 'workspace' : 'builtin', body: '' })) });

function server(refuse?: { code: string; message?: string; details?: Record<string, unknown> }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const path = call.url.replace('/api/v1', '');
    if (path === '/auth/me') return json({ user: { id: 'u1', name: 'Grace Hopper', email: 'g@example.test', platformRole: 'user' }, tenants: [] });
    if (path === '/tenants/team/runtime') return json(status);
    if (path === '/tenants/team/skills') return json({ items: SKILLS, limits: { maxNodeSkills: 4, maxNodeSkillBytes: 20480, maxSkillBodyBytes: 12288, maxWorkspaceSkills: 100 } });
    if (refuse && call.method !== 'GET') return json({ error: { code: refuse.code, message: refuse.message ?? 'refused', details: refuse.details } }, 400);
    if (path === '/market/agents' && call.method === 'POST') return json(reply(stored(call.body, 1, 'draft'), call.body.authorName), 201);
    if (path === '/market/agents/agent-9/draft' && call.method === 'GET') return json(reply(draft));
    if (path === '/market/agents/agent-9/draft' && call.method === 'PUT') return json(reply(stored(call.body, 1, 'draft'), call.body.authorName));
    if (path === '/market/agents/agent-9/submit') return json(reply({ ...draft, version: 1, state: 'pending' }));
    return json({ error: { code: 'not_found', message: 'missing' } }, 404);
  }));
  return calls;
}
const writes = (calls: Call[]) => calls.filter(call => call.method !== 'GET').map(call => [call.method, call.url.replace('/api/v1', '')]);
const node = () => ({ ...createSessionNode('coding', { x: 0, y: 0 }), title: 'Release notes writer', persona: 'You write release notes.', runtime: 'openai-agents', model: 'claude', effort: 'low',
  skills: ['builtin:critic', `workspace:a${'b'.repeat(32)}`] });
// A field by the start of its label (a label also holds its hint, its error and a select's options).
const field = (name: string) => screen.getByLabelText(new RegExp(`^${name}`));

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); forgetSkillCatalog('team'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('publishing from a node', () => {
  it('fills the form from the node and marks what the server would refuse before sending anything', async () => {
    const calls = server();
    render(<PublishAgentDialog tenantId="team" settings={settings} initial={formFromNode(node(), 'team')} onClose={vi.fn()} />);
    expect(field('名称')).toHaveValue('Release notes writer');
    expect(field('指令')).toHaveValue('You write release notes.');
    // A coding node's persona publishes as a text Agent, which is all the market runs.
    expect(screen.queryByLabelText(/^类型/)).toBeNull();
    expect(screen.getByText(/市场 Agent 目前是文字 Agent/)).toBeVisible();
    await waitFor(() => expect(field('署名')).toHaveValue('Grace Hopper'));
    expect(await screen.findByText('Critic')).toBeVisible();
    expect(await screen.findByText('House style')).toBeVisible();
    fireEvent.change(field('名称'), { target: { value: 'x'.repeat(61) } });
    fireEvent.change(field('每次调用的价格'), { target: { value: '51' } });
    fireEvent.change(field('指令'), { target: { value: `Hidden${String.fromCodePoint(0x200b)}text` } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByText('最多 60 个字符。')).toBeVisible();
    expect(screen.getByText('请写一句话简介，市场的卡片上会显示它。')).toBeVisible();
    expect(screen.getByText('价格是 0 到 50 的整数点数（0 表示免费）。')).toBeVisible();
    expect(screen.getByText('含有看不见的格式字符，请删掉它们。')).toBeVisible();
    expect(writes(calls)).toEqual([]);
    fireEvent.change(field('名称'), { target: { value: 'Release notes writer' } });
    fireEvent.change(field('一句话简介'), { target: { value: 'Writes\trelease notes' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByText('只能写一行。')).toBeVisible();
    expect(field('一句话简介')).toHaveAttribute('aria-invalid', 'true');
    expect(field('名称')).toHaveAttribute('aria-invalid', 'false');
    expect(writes(calls)).toEqual([]);
  });

  it('saves a draft once, then saves it in place and submits it for review', async () => {
    const calls = server();
    const saved = vi.fn();
    render(<PublishAgentDialog tenantId="team" settings={settings} initial={formFromNode(node(), 'team')} onSaved={saved} onClose={vi.fn()} />);
    await waitFor(() => expect(field('署名')).toHaveValue('Grace Hopper'));
    fireEvent.change(field('一句话简介'), { target: { value: 'Writes release notes' } });
    fireEvent.change(field('每次调用的价格'), { target: { value: '4' } });
    expect(screen.getByText(/你获得约 3 点（平台抽成 25%）/)).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: /锁定模型/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByText('草稿已保存。还没有提交审核，市场里看不到它。')).toBeVisible();
    const created = calls.find(call => call.method === 'POST' && call.url.endsWith('/market/agents'))!;
    expect(created.body).toEqual({ name: 'Release notes writer', tagline: 'Writes release notes', description: '', category: 'other', kind: 'llm',
      instructions: 'You write release notes.', instructionsPublic: false,
      skills: [{ tenantId: '', ref: 'builtin:critic' }, { tenantId: 'team', ref: `workspace:a${'b'.repeat(32)}` }],
      model: { runtime: 'openai-agents', id: 'claude', effort: 'low', locked: true }, price: 4, examples: [], authorName: 'Grace Hopper' });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    expect(await screen.findByText(/已提交审核/)).toBeVisible();
    expect(writes(calls)).toEqual([['POST', '/market/agents'], ['PUT', '/market/agents/agent-9/draft'], ['POST', '/market/agents/agent-9/submit']]);
    expect(saved).toHaveBeenCalledWith('agent-9');
  });

  it('shows a refusal the server ties to a field on that field', async () => {
    // A form the client lets through, so each refusal is the server's: by its code, or by the field its message names first.
    const ready = () => ({ ...formFromNode(node(), 'team'), tagline: 'Writes release notes', authorName: 'Grace' });
    const refusals: Array<[{ code: string; message: string }, string, RegExp]> = [
      [{ code: 'market_price_invalid', message: 'The price per call is 0 to 50 credits' }, '每次调用的价格', /价格要是 0 到上限之间的整数点数/],
      [{ code: 'market_hidden_text', message: 'description may not contain a right-to-left override (U+202E)' }, '介绍', /内容里有看不见或会伪装的字符/],
      [{ code: 'market_draft_invalid', message: 'tagline is at most 120 characters' }, '一句话简介', /Agent 的内容不符合要求/],
      [{ code: 'market_draft_invalid', message: 'Instructions of 1–32000 bytes are required' }, '指令', /Agent 的内容不符合要求/],
      [{ code: 'market_draft_invalid', message: "Give an author name: your account's name cannot be shown in the market" }, '署名', /Agent 的内容不符合要求/],
      [{ code: 'market_name_reserved', message: "The author name may not use AwwO's or ClawHunt's name or claim to be official" }, '署名', /名称和署名不能用/],
      [{ code: 'market_name_reserved', message: "The name may not use AwwO's or ClawHunt's name" }, '名称', /名称和署名不能用/],
    ];
    for (const [refusal, label, text] of refusals) {
      server(refusal);
      render(<PublishAgentDialog tenantId="team" settings={settings} initial={ready()} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
      expect(await screen.findByText(text)).toBeVisible();
      expect(field(label)).toHaveAttribute('aria-invalid', 'true');
      cleanup();
    }
  });
});

describe('what the form refuses as the server does', () => {
  it('finds the characters the market refuses, and the platform’s names', () => {
    for (const hidden of ['\u00ad', '\u0085', '\u2028', '\ue000', '\u3164', '\ufe0fA', 'A\ufe00', 'A\ufe0f\ufe0f', '\ufffe', 'A\u200dB', '\u202e', '\u{e0041}'])
      expect(hasHiddenText(`Writes ${hidden} pages`), hidden).toBe(true);
    expect(hasHiddenText('Pages people love \u2764\ufe0f\nand\tmore')).toBe(false);
    // As the server reads them (market.go marketNameSkeleton): look-alike letters of other scripts, digits for letters,
    // any separator, and a claim to be official, in an Agent's name as in an author's.
    for (const name of ['AwwO page writer', 'Claw-Hunt helper', '\uff21\uff57\uff57\uff2f team', '\u5b98\u65b9\u56e2\u961f', '\u0421lawhunt', 'Aww\u041e', 'Claw\u0397unt',
      'Claw\u2010Hunt', 'Claw/Hunt', '\u5b98\u2022\u65b9', '0fficial team', 'C1awHunt', 'Avvwo', '\u5b98\u65b9\u5199\u4f5c\u52a9\u624b', 'Official letter writer',
      // A number that is no decimal digit (an Ethiopic one, No) is left out, as the server does.
      'Aww\u1369O'])
      expect(reservedName(name), name).toBe(true);
    for (const name of ["Bob's bakery", 'Landing page writer', 'Formal letter writer', 'Clawson', 'Awesome works'])
      expect(reservedName(name), name).toBe(false);
  });
});

describe('editing an existing Agent', () => {
  it('reads its latest draft and saves it back with its frozen skills', async () => {
    const calls = server();
    render(<PublishAgentDialog tenantId="team" settings={settings} agentId="agent-9" onClose={vi.fn()} />);
    expect(await screen.findByDisplayValue('Copy Pro')).toBeVisible();
    expect(screen.getByText(/版本 v3 · 已驳回/)).toHaveTextContent('审核意见：Name too generic');
    fireEvent.click(screen.getByRole('button', { name: '移除技能 House style' }));
    fireEvent.change(field('名称'), { target: { value: 'Copy Pro 2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByText('草稿已保存。还没有提交审核，市场里看不到它。')).toBeVisible();
    const put = calls.find(call => call.method === 'PUT')!;
    expect(put.url).toBe('/api/v1/market/agents/agent-9/draft');
    expect(put.body).toMatchObject({ name: 'Copy Pro 2', skills: [{ tenantId: '', ref: 'builtin:critic' }], model: { id: 'claude', effort: 'high', locked: true }, price: 5,
      examples: [{ prompt: 'p', result: 'r' }], authorName: 'Ada' });
    expect(calls.some(call => call.url.endsWith('/auth/me'))).toBe(false);
  });
});
