// 多人同屏 names a running AwwO Agent's model as the node's model picker does, never by its selector
// (docs/awwo-canvas-live-collaboration.md, The canvas page): the server sends the node's model as the document holds it
// (canvas_live.go liveAwwoAgents), and `bedrock.claude-opus-5-5` names the service AwwO reaches the model through, which
// AwwO never says (owner decisions 2026-10-11). A recording of 2026-11-07 read `Running · bedrock.claude-opus-5-5`: the
// page's people bar and 同屏 panel were never given the workspace's model names. Every id here is made up, but for the
// models', which are the Bedrock catalogue's (apps/bedrock-models.json).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appearanceFixture } from './saas-appearance-fixture';
import { SaaSApp } from '../src/saas/SaaSApp';
import type { CanvasRecord, Tenant } from '../src/saas/api';
import { createSessionNode, emptyDocument, sanitizeDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { pickerModelName, selectorModelName, shownChatModelName } from '../src/canvas/modelNames';
import type { ModelPaletteSelection } from '../src/canvas/modelPalette';

const catalogue = JSON.parse(readFileSync(resolve(process.cwd(), '../bedrock-models.json'), 'utf8')) as { models: { id: string; name: string; target: string }[] };
/** What the provider and route names look like anywhere in the views' words: a selector's route, a media model's id. */
const PROVIDER_ID = /bedrock|runninghub|tripo|\b(?:rh|xt|jm)\.[a-z0-9]/i;
const squeeze = (name: string) => name.toLowerCase().replace(/[^a-z0-9.]/g, '');

const entry = (over: Partial<ModelPaletteSelection> & Pick<ModelPaletteSelection, 'model'>): ModelPaletteSelection =>
  ({ key: JSON.stringify(['openai-agents', over.model]), label: over.model, providerGroup: 'claude', runtime: 'openai-agents', available: true, ...over });

describe('a model’s name read from its selector', () => {
  it('names every model of the Bedrock catalogue without its route, as far as its catalogue name goes', () => {
    expect(catalogue.models.length).toBeGreaterThan(40);
    for (const model of catalogue.models) {
      const name = selectorModelName(model.id);
      expect(name, model.id).not.toMatch(PROVIDER_ID);
      expect(name, model.id).not.toBe('');
      // What the selector spells of the published name, in its order (Nemotron 3 Super's "120B" is not in its selector).
      expect(squeeze(model.name).startsWith(squeeze(name)), `${model.id}: "${name}" for "${model.name}"`).toBe(true);
    }
    // Those the selector spells whole come out as the catalogue writes them.
    for (const id of ['bedrock.claude-opus-5-5', 'bedrock.claude-haiku-4-5', 'bedrock.llama-3-3-70b', 'bedrock.kimi-k2-5', 'bedrock.deepseek-v3-2',
      'bedrock.minimax-m2-5', 'bedrock.qwen3-vl-235b', 'bedrock.ministral-3-14b', 'bedrock.nova-2-lite', 'bedrock.gemma-3-27b']) {
      expect(selectorModelName(id)).toBe(catalogue.models.find(model => model.id === id)!.name);
    }
  });

  it('drops a cross-region profile, a vendor and a path, and writes the rest as words', () => {
    expect(selectorModelName('bedrock.claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(selectorModelName('global.anthropic.claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(selectorModelName('us.anthropic.claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(selectorModelName('anthropic/claude-sonnet-5')).toBe('Claude Sonnet 5');
    expect(selectorModelName('Bedrock.Claude-Opus-5-5')).toBe('Claude Opus 5.5');
    expect(selectorModelName('anthropic.claude-sonnet-4-6-v1:0')).toBe('Claude Sonnet 4.6 V1');
    // A single Bedrock profile's id as docs/awwo-bedrock.md writes one: the service's name before a hyphen.
    expect(selectorModelName('bedrock-kimi')).toBe('Kimi');
    expect(selectorModelName('bedrock_glm')).toBe('GLM');
    expect(selectorModelName('Bedrock-Kimi-K2-5')).toBe('Kimi K2.5');
    expect(selectorModelName('llmgate-gpt-5.5')).toBe('GPT 5.5');
    // A brand that is a word of its own is no route.
    expect(selectorModelName('deepseek-flash')).toBe('DeepSeek Flash');
    expect(selectorModelName('bedrockish-model-1')).toBe('Bedrockish Model 1');
    // The workspace's other models have no route in their selectors.
    expect(selectorModelName('gpt-5.6-sol')).toBe('GPT 5.6 Sol');
    expect(selectorModelName('qwen3.8-27b-p6')).toBe('Qwen3.8 27B P6');
    expect(selectorModelName('gemini-3.1-pro-preview')).toBe('Gemini 3.1 Pro Preview');
    expect(selectorModelName(' claude-opus-4-8 ')).toBe('Claude Opus 4.8');
    // A date stays a word of its own; only one or two digits join a version.
    expect(selectorModelName('claude-3-5-sonnet-20241022')).toBe('Claude 3.5 Sonnet 20241022');
  });

  it('names nothing that holds no name: a media model, a team connection, a value no selector looks like', () => {
    for (const media of ['rh.seedance-pro', 'tripo.v3-turbo', 'xt.seedream-5-pro', 'jm.video-3', 'RH.Seedance-Pro']) expect(selectorModelName(media), media).toBe('');
    expect(selectorModelName('byok_' + 'a'.repeat(33) + '_' + '0'.repeat(16))).toBe('');
    // A selector never holds a space, markup or a control character, and a route with nothing after it names nothing.
    for (const odd of ['', '   ', 'claude opus', 'claude\u202eopus', '<b>opus</b>', '---', 'bedrock.', 'bedrock.us.']) expect(selectorModelName(odd), JSON.stringify(odd)).toBe('');
    expect(selectorModelName(undefined)).toBe('');
    expect(selectorModelName(42)).toBe('');
  });

  it('keeps a long one to a line', () => {
    const name = selectorModelName('bedrock.' + Array.from({ length: 20 }, (_, i) => `part${i}`).join('-'));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith('…')).toBe(true);
    expect(name.startsWith('Part0 Part1')).toBe(true);
  });
});

describe('a model’s name as the node’s model picker shows it', () => {
  it('takes the published name, never the label’s plan tag, from the entry the picker lists', () => {
    const models = [
      entry({ model: 'bedrock.claude-opus-5-5', runtime: 'pi', displayName: 'Claude Opus 5.5 (Pi)', label: 'Claude Opus 5.5 (Pi)' }),
      entry({ model: 'bedrock.claude-opus-5-5', displayName: 'Claude Opus 5.5', label: 'Claude Opus 5.5 · Pro', requiresUpgrade: true }),
    ];
    // The picker lists a model once, on the runtime AwwO runs it on (nodeRuntime.ts): openai-agents before pi.
    expect(pickerModelName('bedrock.claude-opus-5-5', models)).toBe('Claude Opus 5.5');
    // An entry with no published name (one made by hand) goes by its label.
    expect(pickerModelName('bedrock.claude-opus-5-5', [entry({ model: 'bedrock.claude-opus-5-5', label: 'Claude Opus 5.5' })])).toBe('Claude Opus 5.5');
    // A model only a computer of its own runs (the sandbox) is still named.
    expect(pickerModelName('bedrock.kimi-k3', [entry({ model: 'bedrock.kimi-k3', runtime: 'sandbox', displayName: 'Kimi K3' })])).toBe('Kimi K3');
    expect(pickerModelName('bedrock.kimi-k3', [])).toBe('');
    expect(pickerModelName('bedrock.kimi-k3', undefined)).toBe('');
  });

  it('reads the name from the selector where the catalogue names a model by nothing but its selector, or lacks it', () => {
    const models = [entry({ model: 'bedrock.claude-opus-5-5', displayName: 'bedrock.claude-opus-5-5', label: 'bedrock.claude-opus-5-5 · Pro' })];
    expect(pickerModelName('bedrock.claude-opus-5-5', models)).toBe('Claude Opus 5.5');
    expect(shownChatModelName('bedrock.claude-opus-5-5', { models })).toBe('Claude Opus 5.5');
    expect(shownChatModelName('bedrock.claude-sonnet-4-6', { models })).toBe('Claude Sonnet 4.6');
    expect(shownChatModelName('bedrock.gpt-6-1-sol', { models: [entry({ model: 'bedrock.gpt-6-1-sol', displayName: 'GPT-6.1 Sol' })] })).toBe('GPT-6.1 Sol');
    // A selector with no route is read as words too where the catalogue has no other name for it.
    expect(pickerModelName('gpt-5.6-sol', [entry({ model: 'gpt-5.6-sol', displayName: 'gpt-5.6-sol' })])).toBe('GPT 5.6 Sol');
    // A media model and a team connection the catalogue does not name have no name here; a media model none at all.
    expect(shownChatModelName('rh.seedance-pro', { models })).toBe('');
    expect(shownChatModelName('rh.example-clip', { models: [entry({ model: 'rh.example-clip', displayName: 'Example Clip' })] })).toBe('');
    expect(shownChatModelName(' RH.Seedance-Pro', { models })).toBe('');
    const team = 'byok_' + 'b'.repeat(33) + '_' + 'f'.repeat(16);
    expect(shownChatModelName(team, {})).toBe('');
    expect(shownChatModelName(team, { models: [entry({ model: team, displayName: 'gpt-5.5', label: 'gpt-5.5 · Team · openai / ffffff' })] })).toBe('gpt-5.5');
    expect(shownChatModelName('', { models })).toBe('');
  });

  it('reads a connection’s model named by its service’s selector as a selector (AwwO 云端’s are AwwO’s own)', () => {
    // connections.go names a connection's model by the id its service gives it, and its label after the connection.
    const cloud = 'byok_' + 'c'.repeat(33) + '_' + 'a'.repeat(16);
    const models = [entry({ model: cloud, displayName: 'bedrock.claude-opus-5-5', label: 'bedrock.claude-opus-5-5 · AwwO Cloud · awwo / cccccc' })];
    expect(shownChatModelName(cloud, { models })).toBe('Claude Opus 5.5');
    // Before the catalogue arrives a connection's selector names nothing.
    expect(shownChatModelName(cloud, {})).toBe('');
    // A path's vendor goes too; a media model's id named nothing even there.
    expect(shownChatModelName(cloud, { models: [entry({ model: cloud, displayName: 'anthropic/claude-sonnet-4.6' })] })).toBe('Claude Sonnet 4.6');
    expect(shownChatModelName(cloud, { models: [entry({ model: cloud, displayName: 'rh.example-clip' })] })).toBe('');
    // A single Bedrock profile's id, as the local edition's AwwO 云端 connection would name its model by it, in any case.
    expect(shownChatModelName(cloud, { models: [entry({ model: cloud, displayName: 'bedrock-kimi' })] })).toBe('Kimi');
    expect(shownChatModelName(cloud, { models: [entry({ model: cloud, displayName: 'Bedrock-Kimi' })] })).toBe('Kimi');
    expect(shownChatModelName(cloud, { models: [entry({ model: cloud, displayName: 'Bedrock.Claude-Opus-5-5' })] })).toBe('Claude Opus 5.5');
    // A published name with a dot or a slash of its own is kept as published.
    expect(shownChatModelName(cloud, { models: [entry({ model: cloud, displayName: 'Qwen3.8 27B' })] })).toBe('Qwen3.8 27B');
    expect(shownChatModelName(cloud, { models: [entry({ model: cloud, displayName: 'Kimi K2.5' })] })).toBe('Kimi K2.5');
    expect(shownChatModelName(cloud, { models: [entry({ model: cloud, displayName: 'GPT-5.6 Sol / Team' })] })).toBe('GPT-5.6 Sol / Team');
  });

  it('keeps an operator’s published name as published, a slash or a dot in it too', () => {
    // A worker profile may name its model anything up to 80 characters (apps/openai-agents-worker/config.mjs): the
    // picker shows it so, and so does 多人同屏.
    for (const published of ['GPT-5.6/Team', 'Qwen/Team', 'Dr. Model 2', 'Claude Opus 5.5 · EU', 'Anthropic/Claude-Sonnet-5', 'GPT-5.6 Sol / Team']) {
      expect(shownChatModelName('team-sol', { models: [entry({ model: 'team-sol', displayName: published })] }), published).toBe(published);
    }
    // A profile with no published name is named by its provider's id (config.mjs `name ?? model`): read as a selector.
    expect(shownChatModelName('team-opus', { models: [entry({ model: 'team-opus', displayName: 'us.anthropic.claude-opus-5-5' })] })).toBe('Claude Opus 5.5');
    expect(shownChatModelName('team-kimi', { models: [entry({ model: 'team-kimi', displayName: 'moonshotai.kimi-k2.5' })] })).toBe('Kimi K2.5');
  });
});

// ── The hosted page ──────────────────────────────────────────────────────────────────────────────────────────────

const tenant: Tenant = { id: 'tenant-mp-names', name: 'Workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity = { user: { id: 'user-mp-names', email: 'names@example.test', name: 'Owner', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const capabilities = {
  skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: true, maxRunItems: 0, maxRunBytes: 0, maxPerScope: 0 },
  webReader: { enabled: false, perDay: 0, usedToday: 0 }, render: { enabled: false, perDay: 0, usedToday: 0, limits: {} },
  multiplayer: { enabled: true, maxChangeOps: 500 },
};
/** A person's own connection to AwwO 云端 (connections.go): its selector, and its model named by AwwO's selector for it. */
const CLOUD_MODEL = 'byok_' + 'c'.repeat(33) + '_' + 'a'.repeat(16);
/** The workspace's runtime catalogue as the API sends it (runs.go runtime): Claude Opus 5.5 outside a free workspace's
 *  allowance (its label tagged · Pro), a model whose published name its selector spells otherwise, and a model of a
 *  connection named by its service's selector. */
const runtimeStatus = {
  available: true, configured: true,
  runtimes: [{ id: 'openai-agents', name: 'OpenAI Agents', available: true, configured: true, supportsEffortSelection: false, tools: [] }],
  models: [
    { id: 'bedrock.claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'bedrock', runtime: 'openai-agents', route: 'bedrock', requiresUpgrade: true },
    { id: 'bedrock.gpt-6-1-sol', name: 'GPT-6.1 Sol', provider: 'bedrock', runtime: 'openai-agents', route: 'bedrock' },
    { id: CLOUD_MODEL, name: 'bedrock.claude-opus-5-5', label: 'bedrock.claude-opus-5-5 · AwwO Cloud · awwo / cccccc', provider: 'awwo',
      providerModel: 'bedrock.claude-opus-5-5', runtime: 'openai-agents' },
  ],
};

function canvasDocument(): CanvasDocument {
  const a = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: 'Plan' };
  const b = { ...createSessionNode('llm', { x: 420, y: 0 }), id: 'b', title: 'Build' };
  const c = { ...createSessionNode('llm', { x: 840, y: 0 }), id: 'c', title: 'Check' };
  return sanitizeDocument({ ...emptyDocument(), view: { x: 10, y: 10, scale: 1 }, nodes: [a, b, c] });
}

type Frame = { event: string; data: unknown };
function scriptedStream() {
  const encoder = new TextEncoder();
  let push: (frame: Frame) => void = () => {};
  const body = new ReadableStream<Uint8Array>({ start(controller) { push = frame => controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)); } });
  return { body, push: (frame: Frame) => push(frame) };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(`awwo.workmode.v1:${identity.user.id}`, 'completed');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openLive(options: { locale: 'zh' | 'en'; runtime?: () => Response }) {
  localStorage.setItem('superclaw_locale', options.locale);
  const cloud: CanvasRecord = { id: 'canvas-mp-names', tenantId: tenant.id, name: 'Live canvas', version: 3, document: canvasDocument(), createdAt: '', updatedAt: '' };
  const streams: ReturnType<typeof scriptedStream>[] = [];
  const streamUrls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method && init.method !== 'GET') {
      if (url.endsWith('/live/presence')) return new Response(null, { status: 204 });
      return json({});
    }
    if (url.includes('/live/events')) {
      streamUrls.push(url);
      const stream = scriptedStream();
      streams.push(stream);
      return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith('/appearance')) return json(appearanceFixture);
    if (url.endsWith('/auth/me')) return json(identity);
    if (url.endsWith('/runtime')) return options.runtime ? options.runtime() : json(runtimeStatus);
    if (url.endsWith('/capabilities')) return json(capabilities);
    if (url.endsWith('/agent-tokens')) return json({ items: [{ id: 'tok-names-01', name: 'Codex', prefix: 'awwo_ct_00000000000000cc', scope: 'edit',
      createdAt: '2026-11-07T10:00:00Z', expiresAt: '2026-12-07T10:00:00Z', lastUsedAt: null, revokedAt: null, createdBy: { id: identity.user.id, name: 'Owner' } }] });
    if (url.endsWith('/graph-runs')) return json({ items: [] });
    if (url.includes('/canvases/canvas-mp-names')) return json(cloud);
    return json({ items: [] });
  }));
  window.history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=canvas-mp-names`);
  render(<SaaSApp />);
  return { streams, streamUrls };
}

const idle = { selection: [], focus: null, cursor: null, status: null };
const OPUS_RUN = 'run_names000000001';
const GPT_RUN = 'run_names000000002';
const CLOUD_RUN = 'run_names000000003';

/** Everyone on the canvas comes: this page, AwwO's own Agent running each node (on Claude Opus 5.5, on GPT-6.1 Sol, and
 *  on a model of the owner's AwwO 云端 connection), an outside Agent with a claim and a message. */
async function othersArrive(view: ReturnType<typeof openLive>) {
  await waitFor(() => expect(view.streams).toHaveLength(1));
  const you = new URL(view.streamUrls[0], 'http://localhost').searchParams.get('client')!;
  const self = { id: you, kind: 'human', port: 'web', name: 'Owner', color: '#2563eb', userId: identity.user.id, role: 'owner', state: idle, since: '' };
  const opus = { id: OPUS_RUN, kind: 'awwo', port: 'awwo', name: 'Plan', color: '#10b981', model: 'bedrock.claude-opus-5-5',
    state: { ...idle, selection: ['a'], focus: 'a', status: 'running' }, since: '' };
  const gpt = { id: GPT_RUN, kind: 'awwo', port: 'awwo', name: 'Build', color: '#0ea5e9', model: 'bedrock.gpt-6-1-sol',
    state: { ...idle, selection: ['b'], focus: 'b', status: 'queued' }, since: '' };
  const cloud = { id: CLOUD_RUN, kind: 'awwo', port: 'awwo', name: 'Check', color: '#f97316', model: CLOUD_MODEL,
    state: { ...idle, selection: ['c'], focus: 'c', status: 'running' }, since: '' };
  const agent = { id: 't_00000000000000cc', kind: 'agent', port: 'mcp', name: 'Codex', color: '#7c3aed', userId: identity.user.id, state: { ...idle, status: 'reading' }, since: '' };
  const claims = [{ nodeId: 'b', participantId: agent.id, holderKind: 'agent', name: 'Codex', note: 'tests', expiresAt: new Date(Date.now() + 600_000).toISOString() }];
  const messages = [{ id: 'msg-names-1', authorKind: 'agent', participantId: agent.id, name: 'Codex', color: agent.color, nodeId: 'a', text: 'Plan looks done', createdAt: '2026-11-07T10:01:00Z' }];
  await act(async () => view.streams[0].push({ event: 'hello', data: { you: self, version: 3, participants: [self, opus, gpt, cloud, agent], claims, messages } }));
}

const avatarTitle = (id: string) => document.querySelector(`.awwo-multiplayer-bar .awwo-multiplayer-avatar[data-participant="${id}"]`)?.getAttribute('title');
const rowStatus = (id: string) => document.querySelector(`.awwo-multiplayer-panel .awwo-multiplayer-person[data-participant="${id}"] .awwo-multiplayer-person-status`)?.textContent;

/** Every word the people bar and the 同屏 panel show or say: their text and every attribute a person reads or hears. */
function shownWords(): string {
  const roots = [...document.querySelectorAll<HTMLElement>('.awwo-multiplayer-bar, .awwo-multiplayer-panel')];
  expect(roots.length).toBe(2);
  const words: string[] = [];
  for (const root of roots) {
    words.push(root.textContent ?? '');
    for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      for (const name of ['title', 'aria-label', 'placeholder', 'alt']) { const value = element.getAttribute(name); if (value) words.push(value); }
    }
  }
  return words.join('\n');
}

describe('the hosted canvas page’s people bar and 同屏 panel', () => {
  it('name each running AwwO Agent’s model by the name the model picker shows, and no provider anywhere (中文)', async () => {
    const view = openLive({ locale: 'zh' });
    await screen.findByTestId('canvas-tile-a');
    await othersArrive(view);
    // The workspace's names reach the header once the canvas has its catalogue: GPT-6.1 Sol as published.
    await waitFor(() => expect(avatarTitle(GPT_RUN)).toBe('Build · AwwO · 排队中 · GPT-6.1 Sol'));
    expect(avatarTitle(OPUS_RUN)).toBe('Plan · AwwO · 运行中 · Claude Opus 5.5');
    // The connection's model is named by AwwO's selector for it in the catalogue: read as one.
    expect(avatarTitle(CLOUD_RUN)).toBe('Check · AwwO · 运行中 · Claude Opus 5.5');
    fireEvent.click(screen.getByRole('button', { name: /同屏 · 5 人在线/ }));
    await screen.findByRole('dialog', { name: '同屏' });
    expect(rowStatus(OPUS_RUN)).toBe('运行中 · Claude Opus 5.5');
    expect(rowStatus(GPT_RUN)).toBe('排队中 · GPT-6.1 Sol');
    expect(rowStatus(CLOUD_RUN)).toBe('运行中 · Claude Opus 5.5');
    // The token list (邀请 Agent, opened) and the messages are in the panel too.
    fireEvent.click(document.querySelector<HTMLButtonElement>('.awwo-multiplayer-panel .awwo-multiplayer-disclosure')!);
    await waitFor(() => expect(document.querySelector('.awwo-multiplayer-panel')!.textContent).toContain('awwo_ct_00000000000000cc'));
    expect(document.querySelector('.awwo-multiplayer-panel')!.textContent).toContain('Plan looks done');
    const words = shownWords();
    expect(words).not.toMatch(PROVIDER_ID);
    // The picker's label for a model outside the free allowance carries a plan tag; the name shown never does.
    expect(words).not.toContain('· Pro');
  }, 30000);

  it('says the same in English', async () => {
    const view = openLive({ locale: 'en' });
    await screen.findByTestId('canvas-tile-a');
    await othersArrive(view);
    await waitFor(() => expect(avatarTitle(GPT_RUN)).toBe('Build · AwwO · Queued · GPT-6.1 Sol'));
    fireEvent.click(screen.getByRole('button', { name: /Multiplayer · 5 here/ }));
    await screen.findByRole('dialog', { name: 'Multiplayer' });
    expect(rowStatus(OPUS_RUN)).toBe('Running · Claude Opus 5.5');
    expect(rowStatus(GPT_RUN)).toBe('Queued · GPT-6.1 Sol');
    expect(rowStatus(CLOUD_RUN)).toBe('Running · Claude Opus 5.5');
    expect(shownWords()).not.toMatch(PROVIDER_ID);
  }, 30000);

  it('names them from their selectors while the workspace’s catalogue cannot be read', async () => {
    const view = openLive({ locale: 'zh', runtime: () => json({ error: { code: 'runtime_unavailable', message: 'unavailable' } }, 503) });
    await screen.findByTestId('canvas-tile-a');
    await othersArrive(view);
    await waitFor(() => expect(avatarTitle(OPUS_RUN)).toBe('Plan · AwwO · 运行中 · Claude Opus 5.5'));
    expect(avatarTitle(GPT_RUN)).toBe('Build · AwwO · 排队中 · GPT 6.1 Sol');
    // A connection's selector names nothing: its run says only that it runs.
    expect(avatarTitle(CLOUD_RUN)).toBe('Check · AwwO · 运行中');
    fireEvent.click(screen.getByRole('button', { name: /同屏 · 5 人在线/ }));
    await screen.findByRole('dialog', { name: '同屏' });
    expect(rowStatus(OPUS_RUN)).toBe('运行中 · Claude Opus 5.5');
    expect(rowStatus(CLOUD_RUN)).toBe('运行中');
    expect(shownWords()).not.toMatch(PROVIDER_ID);
  }, 30000);
});
