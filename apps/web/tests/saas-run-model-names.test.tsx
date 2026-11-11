// The run timeline, the 成果 view's run receipt and an opened node (its task card, its composer's model chip and the
// choices the chip lists) name a node's model by its published name, never by its selector: `bedrock.claude-opus-5-5`
// names the service AwwO reaches the model through, which AwwO never says (owner decisions 2026-10-11). Each of them
// fell back to the selector wherever the workspace's catalogue did not name the model: on a reader's canvas, which never
// reads the catalogue (CanvasSurface), before the catalogue arrives, and for a model the workspace no longer offers, so
// a reader's opened node read 使用 bedrock.claude-opus-5-5. Where the catalogue named it, the timeline and the receipt
// took its label, which the picker does not show: a free workspace's plan tag (Claude Opus 5.5 · Pro) and, for a
// connection's model, the connection's service and the model's id there (connections.go), AwwO's own selector for an
// AwwO 云端 connection, by which the local edition's picker listed those models too.
// Every id here is made up, but for the models', which are the Bedrock catalogue's (apps/bedrock-models.json).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { LocaleProvider } from '../src/canvas/i18n';
import { parseMediaCatalogue } from '../src/canvas/mediaCatalog';
import { choiceModelName, nodeModelName, selectorModelName, unlistedModelLabel, unnamedModelText } from '../src/canvas/modelNames';
import { groupModels, type ModelPaletteSelection } from '../src/canvas/modelPalette';
import type { NodeModelChoice } from '../src/canvas/NodeModelPicker';
import { RunTimeline } from '../src/canvas/RunTimeline';
import { PolicySite } from '../src/canvas/ClaudeFableNote';
import { SessionTile } from '../src/canvas/SessionTile';
import { resetAllSessions } from '../src/canvas/sessions';
import type { Tenant } from '../src/saas/api';
import { CanvasRunReceipt } from '../src/saas/CanvasRunReceipt';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { publishGraphRuns, type GraphRunSnapshot } from '../src/saas/graphRuns';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { SaaSRuntimeStatus } from '../src/saas/runtimeCatalog';
import { graphRunSummary } from './saas-graph-run-summary-fixture';

const bedrock = JSON.parse(readFileSync(resolve(process.cwd(), '../bedrock-models.json'), 'utf8')) as { models: { id: string; name: string }[] };
/** What the provider and route names look like anywhere in the views' words: a selector's route, a media model's id. */
const PROVIDER_ID = /bedrock|runninghub|tripo|\b(?:rh|xt|jm)\.[a-z0-9]/i;

const OPUS = 'bedrock.claude-opus-5-5';
const SOL = 'bedrock.gpt-6-1-sol';
/** A model the workspace no longer offers, and a single Bedrock profile's id (docs/awwo-bedrock.md). */
const WITHDRAWN = 'bedrock.claude-sonnet-4-6';
const PROFILE = 'bedrock-kimi';
/** A person's own connection to AwwO 云端 (connections.go): its selector, its model named by AwwO's selector for it. */
const CLOUD_MODEL = 'byok_' + 'c'.repeat(33) + '_' + 'a'.repeat(16);
/** A team's connection to a service of its own, and a connection's model the catalogue no longer lists. */
const TEAM_MODEL = 'byok_' + 'd'.repeat(33) + '_' + 'b'.repeat(16);
const GONE_MODEL = 'byok_' + 'e'.repeat(33) + '_' + '0'.repeat(8) + '12345678';
const STILL = 'xt.seedream-5-pro';

/** The workspace's runtime catalogue as the API sends it (runs.go runtime), for a free workspace: Claude Opus 5.5 is
 *  outside its allowance on both runtimes (its label tagged · Pro), GPT-6.1 Sol's published name is spelt otherwise
 *  than its selector, and two connections' models carry their connections' labels. */
const runtimeStatus = {
  available: true, configured: true,
  runtimes: [
    { id: 'pi', name: 'Pi', available: true, configured: true, supportsEffortSelection: false, tools: [] },
    { id: 'openai-agents', name: 'OpenAI Agents', available: true, configured: true, supportsEffortSelection: false, tools: [] },
  ],
  models: [
    { id: OPUS, name: 'Claude Opus 5.5', provider: 'bedrock', runtime: 'openai-agents', route: 'bedrock', requiresUpgrade: true },
    { id: OPUS, name: 'Claude Opus 5.5', provider: 'bedrock', runtime: 'pi', route: 'bedrock', requiresUpgrade: true },
    { id: SOL, name: 'GPT-6.1 Sol', provider: 'bedrock', runtime: 'openai-agents', route: 'bedrock' },
    { id: CLOUD_MODEL, name: OPUS, label: `${OPUS} · AwwO Cloud · awwo / cccccc`, provider: 'awwo', providerModel: OPUS, runtime: 'openai-agents' },
    { id: TEAM_MODEL, name: 'gpt-5.5', label: 'gpt-5.5 · Team · openai / dddddd', provider: 'openai', providerModel: 'gpt-5.5', runtime: 'pi' },
  ],
} as unknown as SaaSRuntimeStatus;
const models: ModelPaletteSelection[] = groupModels(runtimeStatus, 'zh').flatMap(group => group.models);
/** A model the catalogue lists for a node's own computer only, by a published name its selector does not spell whole. */
const NEMOTRON = 'bedrock.nemotron-3-super';
const computer: ModelPaletteSelection[] = [{ key: JSON.stringify(['sandbox', NEMOTRON]), runtime: 'sandbox', model: NEMOTRON,
  label: 'Nemotron 3 Super 120B · Pro', displayName: 'Nemotron 3 Super 120B', providerGroup: 'nemotron', available: true, requiresUpgrade: true }];
const media = parseMediaCatalogue({ configured: true, available: true, models: [
  { id: STILL, name: 'seedream 5 pro', label: ['图片 · 高清', 'Image · HD'], vendor: 'xtasy', kind: 'image', prompt: { minLength: 1, maxLength: 2000 }, params: [] },
] });

const chat = (id: string, title: string, runtime: string, model: string): SessionNode =>
  ({ ...createSessionNode('llm', { x: 0, y: 0 }), id, title, runtime, model }) as SessionNode;
/** A canvas whose nodes run on every kind of model: AwwO's own (on either runtime), a withdrawn one, a profile's, three
 *  connections' (one the catalogue no longer lists) and a media model. */
const nodes = (): SessionNode[] => [
  chat('opus', 'Plan', 'pi', OPUS), chat('sol', 'Build', 'openai-agents', SOL), chat('cloud', 'Check', 'openai-agents', CLOUD_MODEL),
  chat('team', 'Review', 'pi', TEAM_MODEL), chat('gone', 'Notes', 'pi', GONE_MODEL), chat('old', 'Draft', 'pi', WITHDRAWN),
  chat('kimi', 'Ideas', 'pi', PROFILE), { ...createSessionNode('image', { x: 0, y: 0 }), id: 'still', title: 'Poster', runtime: 'openai-agents', model: STILL } as SessionNode,
];

/** Every word an element shows or says: its text (its options' too) and every attribute a person reads or hears. */
function shownWords(root: Element): string {
  const words = [root.textContent ?? ''];
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const name of ['title', 'aria-label', 'placeholder', 'alt']) { const value = element.getAttribute(name); if (value) words.push(value); }
  }
  return words.join('\n');
}
/** No provider, no connection's selector, no plan tag anywhere in a view's words. */
function expectNoSelector(root: Element) {
  const words = shownWords(root);
  expect(words).not.toMatch(PROVIDER_ID);
  expect(words).not.toMatch(/byok_/i);
  expect(words).not.toContain('· Pro');
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); resetAllSessions(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('a node’s model as a run report names it', () => {
  it('is built from a catalogue whose labels carry the plan tag and the connections’ services', () => {
    // What this file's catalogue shows the views were given: the picker's names and the labels it does not show.
    expect(models.filter(entry => entry.model === OPUS).map(entry => [entry.label, entry.displayName])).toEqual([
      ['Claude Opus 5.5 · Pro', 'Claude Opus 5.5'], ['Claude Opus 5.5 · Pro', 'Claude Opus 5.5']]);
    expect(models.find(entry => entry.model === CLOUD_MODEL)).toMatchObject({ label: `${OPUS} · AwwO Cloud · awwo / cccccc`, displayName: OPUS });
    expect(models.find(entry => entry.model === TEAM_MODEL)).toMatchObject({ label: 'gpt-5.5 · Team · openai / dddddd', displayName: 'gpt-5.5' });
  });

  it('names every model of the Bedrock catalogue without its route when no catalogue is at hand', () => {
    expect(bedrock.models.length).toBeGreaterThan(40);
    for (const { id } of bedrock.models) {
      for (const locale of ['zh', 'en'] as const) {
        const name = nodeModelName({ agentKind: 'llm', runtime: 'pi', model: id }, {}, locale);
        expect(name, id).toBe(selectorModelName(id));
        expect(name, id).not.toBe('');
        expect(name, id).not.toMatch(PROVIDER_ID);
        expect(unlistedModelLabel({ agentKind: 'llm', runtime: 'pi', model: id }, locale), id).toBe(name);
      }
    }
  });

  it('takes the name the picker shows, never the label’s plan tag or a connection’s service, on any runtime', () => {
    const sources = { models, media };
    expect(nodeModelName(chat('a', 'A', 'pi', OPUS), sources, 'zh')).toBe('Claude Opus 5.5');
    expect(nodeModelName(chat('a', 'A', 'openai-agents', OPUS), sources, 'en')).toBe('Claude Opus 5.5');
    // A runtime the catalogue does not list the model on (a computer's, an old node's): still the picker's name.
    expect(nodeModelName(chat('a', 'A', 'sandbox', OPUS), sources, 'zh')).toBe('Claude Opus 5.5');
    expect(nodeModelName(chat('a', 'A', 'openai-agents', SOL), sources, 'zh')).toBe('GPT-6.1 Sol');
    expect(nodeModelName(chat('a', 'A', 'pi', SOL), sources, 'zh')).toBe('GPT-6.1 Sol');
    // AwwO 云端's model is named by AwwO's selector for it: read as one.
    expect(nodeModelName(chat('a', 'A', 'openai-agents', CLOUD_MODEL), sources, 'zh')).toBe('Claude Opus 5.5');
    expect(nodeModelName(chat('a', 'A', 'pi', TEAM_MODEL), sources, 'en')).toBe('gpt-5.5');
    // Not in the catalogue: a name read from the selector.
    expect(nodeModelName(chat('a', 'A', 'pi', WITHDRAWN), sources, 'zh')).toBe('Claude Sonnet 4.6');
    expect(nodeModelName(chat('a', 'A', 'pi', PROFILE), sources, 'zh')).toBe('Kimi');
    expect(nodeModelName({ agentKind: 'image', runtime: 'openai-agents', model: STILL }, sources, 'en')).toBe('Image · HD');
  });

  it('names a model by its own runtime’s entry where two runtimes’ workers give one id to different models', () => {
    // Workers are configured apart (apps/openai-agents-worker/config.mjs profiles): one id, two models.
    const shared: ModelPaletteSelection[] = [
      { key: JSON.stringify(['openai-agents', 'reviewer']), runtime: 'openai-agents', model: 'reviewer', label: 'GPT-6.1 Sol', displayName: 'GPT-6.1 Sol', providerGroup: 'codex', available: true },
      { key: JSON.stringify(['sandbox', 'reviewer']), runtime: 'sandbox', model: 'reviewer', label: 'Claude Opus 5.5 · Pro', displayName: 'Claude Opus 5.5', providerGroup: 'claude', available: true, requiresUpgrade: true },
    ];
    expect(nodeModelName(chat('a', 'A', 'sandbox', 'reviewer'), { models: shared }, 'zh')).toBe('Claude Opus 5.5');
    expect(nodeModelName(chat('a', 'A', 'openai-agents', 'reviewer'), { models: shared }, 'zh')).toBe('GPT-6.1 Sol');
    // A runtime that lists it not at all: the entry the picker lists it by.
    expect(nodeModelName(chat('a', 'A', 'pi', 'reviewer'), { models: shared }, 'zh')).toBe('GPT-6.1 Sol');
    // The own runtime's name is read as a selector where it is one.
    expect(nodeModelName(chat('a', 'A', 'sandbox', 'reviewer'), { models: [shared[0], { ...shared[1], displayName: 'us.anthropic.claude-opus-5-5' }] }, 'zh'))
      .toBe('Claude Opus 5.5');
    render(<RunTimeline nodes={[chat('ran', 'Review', 'sandbox', 'reviewer')]} runs={{ ran: { state: 'done' } }} runStartedAt={1_000} now={2_000}
      onClose={vi.fn()} modelCatalogue={shared} />);
    expect(screen.getByTestId('runline-ran').querySelector('.canvas-runline-runtime')!.textContent).toBe('sandbox · Claude Opus 5.5');
  });

  it('says a model it cannot name is missing, and never shows what the node holds instead', () => {
    expect(nodeModelName(chat('a', 'A', 'pi', GONE_MODEL), { models, media }, 'zh')).toBe('当前目录未包含该模型 · 12345678');
    expect(nodeModelName(chat('a', 'A', 'pi', CLOUD_MODEL), {}, 'en')).toBe('Model not in current catalogue · aaaaaaaa');
    // A value no selector looks like holds no name, whatever it says.
    for (const odd of ['bedrock.claude opus', 'bedrock.', '<b>bedrock.claude-opus-5-5</b>', 'RH.Seedance-Pro', '   ']) {
      expect(nodeModelName(chat('a', 'A', 'pi', odd), { models }, 'zh'), JSON.stringify(odd)).toBe('当前目录未包含该模型');
      expect(nodeModelName(chat('a', 'A', 'pi', odd), {}, 'en'), JSON.stringify(odd)).toBe('Model not in current catalogue');
    }
    expect(nodeModelName(chat('a', 'A', 'pi', ''), { models }, 'zh')).toBe('');
  });

  it('calls a model the catalogue lists by nothing but a selector that holds no name unnamed, never by the selector', () => {
    // An entry whose only name is its connection's selector (groupModels names it by its id when nothing else names it).
    const unnamed: ModelPaletteSelection[] = [{ key: JSON.stringify(['pi', GONE_MODEL]), runtime: 'pi', model: GONE_MODEL, label: GONE_MODEL,
      displayName: GONE_MODEL, providerGroup: 'clawhunt', available: true }];
    expect(nodeModelName(chat('a', 'A', 'pi', GONE_MODEL), { models: unnamed }, 'zh')).toBe('未命名的模型 · 12345678');
    expect(nodeModelName(chat('a', 'A', 'openai-agents', GONE_MODEL), { models: unnamed }, 'en')).toBe('Unnamed model · 12345678');
    expect(unlistedModelLabel(chat('a', 'A', 'pi', GONE_MODEL), 'zh', unnamed)).toBe('未命名的模型 · 12345678');
    // A name that is a route alone, or a media model's id, names nothing either: the model's own selector is read instead.
    expect(nodeModelName(chat('a', 'A', 'pi', OPUS), { models: [{ ...unnamed[0], model: OPUS, label: 'bedrock.', displayName: 'bedrock.' }] }, 'zh'))
      .toBe('Claude Opus 5.5');
    expect(nodeModelName(chat('a', 'A', 'pi', CLOUD_MODEL), { models: [{ ...unnamed[0], model: CLOUD_MODEL, label: 'rh.example-clip', displayName: 'rh.example-clip' }] }, 'en'))
      .toBe('Unnamed model · aaaaaaaa');
    for (const nameless of ['RH.Seedance-Pro', TEAM_MODEL]) {
      expect(nodeModelName(chat('a', 'A', 'pi', CLOUD_MODEL), { models: [{ ...unnamed[0], model: CLOUD_MODEL, label: nameless, displayName: nameless }] }, 'zh'), nameless)
        .toBe('未命名的模型 · aaaaaaaa');
    }
    expect(unnamedModelText('bedrock.', true, 'zh')).toBe('未命名的模型');
    expect(unnamedModelText('bedrock.', false, 'en')).toBe('Model not in current catalogue');
  });

  it('labels a model the chip’s choices do not list as reports name it, by the catalogue where it lists it elsewhere', () => {
    // Listed for a computer of its own only (the picker offers a chat model on the runtime AwwO runs it on), by a
    // published name its selector does not spell whole.
    expect(unlistedModelLabel(chat('a', 'A', 'sandbox', NEMOTRON), 'zh', computer)).toBe('Nemotron 3 Super 120B');
    expect(unlistedModelLabel(chat('a', 'A', 'sandbox', NEMOTRON), 'zh')).toBe('Nemotron 3 Super');
    expect(unlistedModelLabel(chat('a', 'A', 'pi', GONE_MODEL), 'en', models)).toBe('Model not in current catalogue · 12345678');
    expect(unlistedModelLabel({ agentKind: 'image', model: STILL }, 'zh', models)).toBe('图片');
    expect(unlistedModelLabel(chat('a', 'A', 'pi', ''), 'zh', models)).toBeUndefined();
  });

  it('reads a choice named by a selector as one and keeps a published name as published', () => {
    expect(choiceModelName('Claude Opus 5.5', OPUS)).toBe('Claude Opus 5.5');
    expect(choiceModelName(OPUS, CLOUD_MODEL)).toBe('Claude Opus 5.5');
    expect(choiceModelName(' qwen3.8-27b-p6 ', 'qwen3.8-27b-p6')).toBe('Qwen3.8 27B P6');
    for (const published of ['GPT-5.6/Team', 'Dr. Model 2', 'Kimi K2.5', '图片 · 高清']) expect(choiceModelName(published, CLOUD_MODEL), published).toBe(published);
    expect(choiceModelName('rh.example-clip', CLOUD_MODEL)).toBe('');
    expect(choiceModelName('', OPUS)).toBe('');
    // A selector that holds no name, in any case: a connection's (a catalogue relayed from another AwwO may name a
    // model by its own connection's selector) or a media model's id.
    for (const nameless of ['RH.Seedance-Pro', 'Tripo.V3-Turbo', TEAM_MODEL, TEAM_MODEL.toUpperCase(), ' ' + GONE_MODEL]) {
      expect(choiceModelName(nameless, CLOUD_MODEL), nameless).toBe('');
    }
    // A published name that only mentions such a word is kept.
    expect(choiceModelName('Byok fixture model', CLOUD_MODEL)).toBe('Byok fixture model');
  });
});

describe('the run timeline', () => {
  const runs = Object.fromEntries(nodes().map(node => [node.id, { state: 'done' as const }]));
  const row = (id: string) => screen.getByTestId(`runline-${id}`).querySelector('.canvas-runline-runtime')!;
  const timeline = (catalogue: { modelCatalogue?: ModelPaletteSelection[]; mediaCatalogue?: typeof media }) =>
    <RunTimeline nodes={nodes()} runs={runs} runStartedAt={1_000} now={2_000} onClose={vi.fn()} onOpenNode={vi.fn()} {...catalogue} />;

  it('names each row’s model as the picker does, and reads the rest from their selectors (中文)', () => {
    const { rerender } = render(timeline({ modelCatalogue: models, mediaCatalogue: media }));
    const expected = { opus: 'pi · Claude Opus 5.5', sol: 'openai-agents · GPT-6.1 Sol', cloud: 'openai-agents · Claude Opus 5.5', team: 'pi · gpt-5.5',
      gone: 'pi · 当前目录未包含该模型 · 12345678', old: 'pi · Claude Sonnet 4.6', kimi: 'pi · Kimi', still: '媒体 · 图片 · 高清' };
    for (const [id, text] of Object.entries(expected)) {
      expect(row(id).textContent, id).toBe(text);
      expect(row(id).getAttribute('title'), id).toBe(text);
    }
    expectNoSelector(screen.getByRole('region', { name: '执行时间线' }));
    // A reader's canvas, or before the catalogue arrives: no catalogue at all.
    rerender(timeline({}));
    expect(row('opus').textContent).toBe('pi · Claude Opus 5.5');
    expect(row('sol').textContent).toBe('openai-agents · GPT 6.1 Sol');
    expect(row('cloud').textContent).toBe('openai-agents · 当前目录未包含该模型 · aaaaaaaa');
    expect(row('team').textContent).toBe('pi · 当前目录未包含该模型 · bbbbbbbb');
    expect(row('still').textContent).toBe('媒体 · 图片');
    expectNoSelector(screen.getByRole('region', { name: '执行时间线' }));
  });

  it('says the same in English', () => {
    const { rerender } = render(<LocaleProvider locale="en">{timeline({ modelCatalogue: models, mediaCatalogue: media })}</LocaleProvider>);
    expect(row('opus').textContent).toBe('pi · Claude Opus 5.5');
    expect(row('cloud').textContent).toBe('openai-agents · Claude Opus 5.5');
    expect(row('gone').textContent).toBe('pi · Model not in current catalogue · 12345678');
    expect(row('still').textContent).toBe('Media · Image · HD');
    expectNoSelector(screen.getByRole('region', { name: 'Execution timeline' }));
    rerender(<LocaleProvider locale="en">{timeline({})}</LocaleProvider>);
    expect(row('old').textContent).toBe('pi · Claude Sonnet 4.6');
    expect(row('team').textContent).toBe('pi · Model not in current catalogue · bbbbbbbb');
    expectNoSelector(screen.getByRole('region', { name: 'Execution timeline' }));
  });
});

describe('the 成果 view’s run receipt', () => {
  const TENANT = 'tenant-run-names';
  const finishedAt = '2026-11-08T06:03:12Z';
  /** The result's step, and the run that completed it with the canvas it froze: every node above ran in it. */
  const page: SessionNode = { ...chat('page', 'Page', 'openai-agents', OPUS),
    contract: { version: 1, inputs: [], outputs: [{ id: 'result', label: 'Page', type: 'html', required: true, value: '' }] },
    lastOutput: { text: JSON.stringify({ result: '<p>Fox</p>' }), at: Date.parse(finishedAt), source: 'run' } };
  const frozen: CanvasNode[] = [page, ...nodes()];
  const run = (canvasId: string): GraphRunSnapshot => ({ id: `names-run-${canvasId}`, operationId: `op-${canvasId}`, canvasId, documentVersion: 1,
    scope: frozen.map(node => node.id), status: 'completed', createdAt: '2026-11-08T06:00:00Z', updatedAt: finishedAt,
    nodes: frozen.map(node => ({ nodeId: node.id, state: 'done' as const })),
    document: { version: 2, updatedAt: 1, waypoints: [], view: null, edges: [], nodes: frozen } });
  function receipt(canvasId: string, names?: { models: ModelPaletteSelection[]; media: typeof media }) {
    const made = run(canvasId);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes(`/graph-runs/${made.id}`) ? Response.json(made)
      : Response.json({ error: { code: 'not_found', message: 'Resource not found' } }, { status: 404 })));
    publishGraphRuns(TENANT, canvasId, [graphRunSummary(made)]);
    return render(<SaaSPreferencesProvider><CanvasRunReceipt tenantId={TENANT} canvasId={canvasId} final={page} {...(names ? { names } : {})} /></SaaSPreferencesProvider>);
  }
  const modelsRow = async (label: string) => (await screen.findByText(label)).parentElement!.querySelector('dd')!;

  it('lists the models its steps ran on as the picker names them, with the canvas’s names or without (中文)', async () => {
    receipt('canvas-names-zh', { models, media });
    const region = screen.getByRole('region', { name: '运行回执' });
    expect((await modelsRow('模型')).textContent).toBe(
      'Claude Opus 5.5（3 步），GPT-6.1 Sol（1 步），gpt-5.5（1 步），当前目录未包含该模型 · 12345678（1 步），Claude Sonnet 4.6（1 步），Kimi（1 步），图片 · 高清（1 步）');
    expectNoSelector(region);
    cleanup();
    receipt('canvas-names-bare');
    expect((await modelsRow('模型')).textContent).toBe(
      'Claude Opus 5.5（2 步），GPT 6.1 Sol（1 步），当前目录未包含该模型 · aaaaaaaa（1 步），当前目录未包含该模型 · bbbbbbbb（1 步），当前目录未包含该模型 · 12345678（1 步），Claude Sonnet 4.6（1 步），Kimi（1 步），图片（1 步）');
    expectNoSelector(screen.getByRole('region', { name: '运行回执' }));
  });

  it('says the same in English', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    // Each model with its count of steps, whatever separates them.
    const listed = async () => (await modelsRow('Models')).textContent!.split(/，|, /);
    receipt('canvas-names-en', { models, media });
    expect(await listed()).toEqual(['Claude Opus 5.5 (3)', 'GPT-6.1 Sol (1)', 'gpt-5.5 (1)', 'Model not in current catalogue · 12345678 (1)',
      'Claude Sonnet 4.6 (1)', 'Kimi (1)', 'Image · HD (1)']);
    expectNoSelector(screen.getByRole('region', { name: 'Run receipt' }));
    cleanup();
    receipt('canvas-names-en-bare');
    expect(await listed()).toEqual(['Claude Opus 5.5 (2)', 'GPT 6.1 Sol (1)', 'Model not in current catalogue · aaaaaaaa (1)',
      'Model not in current catalogue · bbbbbbbb (1)', 'Model not in current catalogue · 12345678 (1)', 'Claude Sonnet 4.6 (1)', 'Kimi (1)', 'Image (1)']);
    expectNoSelector(screen.getByRole('region', { name: 'Run receipt' }));
  });
});

describe('an opened node', () => {
  const brief = (model: string, runtime = 'openai-agents'): SessionNode =>
    ({ ...createAgentTemplate('general', { x: 0, y: 0 }, 'zh'), id: 'n', title: '关卡设计', persona: '设计三段关卡，每段一个检查点。', runtime, model }) as SessionNode;
  const card = () => screen.getByRole('region', { name: '「关卡设计」的任务' });
  const chip = () => document.querySelector('.awwo-node-model-picker')!;
  /** The picker's choices as CanvasSurface makes them from the catalogue (its published name, else its label). */
  const choices = (entries: ModelPaletteSelection[]): NodeModelChoice[] =>
    entries.map(entry => ({ key: entry.key, label: entry.displayName || entry.label, available: entry.available, model: entry.model }));

  it('tells a reader, who never reads the catalogue, the model by a name read from its selector', () => {
    render(<SessionTile node={brief(OPUS)} scale={1} focused readOnly />);
    expect(within(card()).getByText('使用 Claude Opus 5.5')).toBeVisible();
    expectNoSelector(card());
    cleanup();
    render(<LocaleProvider locale="en"><SessionTile node={brief(SOL)} scale={1} focused readOnly /></LocaleProvider>);
    expect(within(screen.getByRole('region', { name: 'What “关卡设计” is asked to do' })).getByText('Runs GPT 6.1 Sol')).toBeVisible();
  });

  it('reads a choice its picker names by a selector as one (a connection’s model, named by its service’s id)', () => {
    // The local edition's AwwO 云端 connection names its models by AwwO's selectors (connections.go `Name: model`).
    render(<SessionTile node={brief(CLOUD_MODEL)} scale={1} focused modelChoices={choices(models)} onChangeModel={vi.fn()} onUpdateNode={vi.fn()}
      freeConversation initializeOnSend onSend={vi.fn()} modelNames={{ models, media }} />);
    expect(within(card()).getByText('使用 Claude Opus 5.5')).toBeVisible();
    // The chip, its tooltip and every choice it lists say the same: the picker never lists a model by a selector.
    expect(chip().querySelector('.awwo-node-model-picker-value')!.textContent).toBe('Claude Opus 5.5');
    expect(chip().getAttribute('title')).toBe('当前模型：Claude Opus 5.5，点击切换');
    const listed = Object.fromEntries([...chip().querySelectorAll('option')].map(option => [option.getAttribute('value'), option.textContent]));
    expect(listed[JSON.stringify(['openai-agents', CLOUD_MODEL])]).toBe('Claude Opus 5.5');
    expect(listed[JSON.stringify(['pi', TEAM_MODEL])]).toBe('gpt-5.5');
    expect(listed[JSON.stringify(['openai-agents', SOL])]).toBe('GPT-6.1 Sol');
    expectNoSelector(card());
    expectNoSelector(chip());
  });

  it('lists a choice named by nothing but a selector that holds no name as unnamed, and the card says the same', () => {
    const entries: ModelPaletteSelection[] = [
      { key: JSON.stringify(['openai-agents', GONE_MODEL]), runtime: 'openai-agents', model: GONE_MODEL, label: GONE_MODEL, displayName: GONE_MODEL, providerGroup: 'clawhunt', available: true },
      { key: JSON.stringify(['openai-agents', OPUS]), runtime: 'openai-agents', model: OPUS, label: 'bedrock.', displayName: 'bedrock.', providerGroup: 'claude', available: false, reason: 'Not ready' },
      // Named by another connection's selector, and by a media model's id, as a relayed catalogue might.
      { key: JSON.stringify(['openai-agents', CLOUD_MODEL]), runtime: 'openai-agents', model: CLOUD_MODEL, label: TEAM_MODEL, displayName: TEAM_MODEL, providerGroup: 'clawhunt', available: true },
      { key: JSON.stringify(['pi', CLOUD_MODEL]), runtime: 'pi', model: CLOUD_MODEL, label: 'RH.Seedance-Pro', displayName: 'RH.Seedance-Pro', providerGroup: 'clawhunt', available: true },
    ];
    render(<SessionTile node={brief(GONE_MODEL)} scale={1} focused modelChoices={choices(entries)} onChangeModel={vi.fn()} onUpdateNode={vi.fn()}
      freeConversation initializeOnSend onSend={vi.fn()} modelNames={{ models: entries, media }} />);
    expect(chip().querySelector('.awwo-node-model-picker-value')!.textContent).toBe('未命名的模型 · 12345678');
    expect([...chip().querySelectorAll('option')].map(option => option.textContent)).toEqual(['未命名的模型 · 12345678', 'Claude Opus 5.5 · 未就绪',
      '未命名的模型 · aaaaaaaa', '未命名的模型 · aaaaaaaa']);
    expect(within(card()).getByText('使用 未命名的模型 · 12345678')).toBeVisible();
    expectNoSelector(chip());
    expectNoSelector(card());
  });

  it('says in the card what the chip says, whatever the chip’s choice is named by', () => {
    // One id on two runtimes (workers configured apart), the one the picker offers named by nothing but a media id: the
    // chip reads the choice's selector, and the card names its model as the chip does.
    const entries: ModelPaletteSelection[] = [
      { key: JSON.stringify(['openai-agents', 'reviewer']), runtime: 'openai-agents', model: 'reviewer', label: 'RH.Seedance-Pro', displayName: 'RH.Seedance-Pro', providerGroup: 'clawhunt', available: true },
      { key: JSON.stringify(['sandbox', 'reviewer']), runtime: 'sandbox', model: 'reviewer', label: 'Claude Opus 5.5', displayName: 'Claude Opus 5.5', providerGroup: 'claude', available: true },
    ];
    render(<SessionTile node={brief('reviewer', 'sandbox')} scale={1} focused modelChoices={choices(entries.slice(0, 1))} onChangeModel={vi.fn()} onUpdateNode={vi.fn()}
      freeConversation initializeOnSend onSend={vi.fn()} modelNames={{ models: entries, media }} />);
    expect(chip().querySelector('.awwo-node-model-picker-value')!.textContent).toBe('Reviewer');
    expect(within(card()).getByText('使用 Reviewer')).toBeVisible();
    expectNoSelector(chip());
    expectNoSelector(card());
  });

  it('says what the privacy policy says of Claude Fable under the chip, only while the node’s model is one (2026-11-11)', () => {
    // AWS keeps a Claude Fable request for up to 30 days, or longer where the law requires it, and its staff may read
    // what its systems flag (clause 08): said where the model is chosen, with a pointer to the clause
    // (ClaudeFableNote.tsx), and of no other model.
    const FABLE = 'bedrock.claude-fable-5-2';
    const entries: ModelPaletteSelection[] = [
      { key: JSON.stringify(['openai-agents', FABLE]), runtime: 'openai-agents', model: FABLE, label: 'Claude Fable 5.2', displayName: 'Claude Fable 5.2', providerGroup: 'claude', available: true, userChosen: true },
      { key: JSON.stringify(['openai-agents', OPUS]), runtime: 'openai-agents', model: OPUS, label: 'Claude Opus 5.5', displayName: 'Claude Opus 5.5', providerGroup: 'claude', available: true },
    ];
    // withChip false: no onChangeModel (an argument of undefined would take a parameter's default, so it is a flag).
    const tile = (model: string, withChip = true) => <PolicySite.Provider value="https://clawhunt.example">
      <SessionTile node={brief(model)} scale={1} focused modelChoices={choices(entries)} onChangeModel={withChip ? vi.fn() : undefined} onUpdateNode={vi.fn()}
        freeConversation initializeOnSend onSend={vi.fn()} modelNames={{ models: entries, media }} /></PolicySite.Provider>;
    const line = () => document.querySelector('.awwo-fable-note');
    render(tile(FABLE));
    expect(chip().querySelector('.awwo-node-model-picker-value')!.textContent).toBe('Claude Fable 5.2');
    expect(line()).toHaveTextContent('Claude Fable 的请求由 AWS 保存最长 30 天（法律要求时更久），被系统标记的内容可能由 AWS 人员查看。隐私政策第 08 条');
    expect(line()).toHaveClass('canvas-composer-notice');
    // Under the row the chip is in.
    expect(chip().closest('.canvas-composer-accessory')!.nextElementSibling).toBe(line());
    const clause = within(line() as HTMLElement).getByRole('link', { name: '隐私政策第 08 条' });
    expect(clause).toHaveAttribute('href', 'https://clawhunt.example/legal#s-privacy-c8');
    expect(clause).toHaveAttribute('target', '_blank');
    expect(clause).toHaveAttribute('rel', 'noopener noreferrer');
    cleanup();
    render(tile(OPUS));
    expect(chip().querySelector('.awwo-node-model-picker-value')!.textContent).toBe('Claude Opus 5.5');
    expect(line()).toBeNull();
    cleanup();
    // A box without the chip (nothing there changes the model) has no line either.
    render(tile(FABLE, false));
    expect(document.querySelector('.awwo-node-model-picker')).toBeNull();
    expect(line()).toBeNull();
  });

  it('names a model its chip’s choices no longer list in the chip and the card, never by its selector', () => {
    const offered = choices(models.filter(entry => entry.model === SOL));
    const tile = (model: string) => <SessionTile node={brief(model)} scale={1} focused modelChoices={offered} onChangeModel={vi.fn()} onUpdateNode={vi.fn()}
      freeConversation initializeOnSend onSend={vi.fn()} modelNames={{ models: models.filter(entry => entry.model === SOL), media }} />;
    const { rerender } = render(tile(OPUS));
    expect(chip().querySelector('.awwo-node-model-picker-value')!.textContent).toBe('Claude Opus 5.5');
    expect(chip().getAttribute('title')).toBe('当前模型：Claude Opus 5.5，点击切换');
    expect([...chip().querySelectorAll('option')].map(option => option.textContent)).toEqual(['当前：Claude Opus 5.5', 'GPT-6.1 Sol']);
    expect(within(card()).getByText('使用 Claude Opus 5.5')).toBeVisible();
    expectNoSelector(chip());
    expectNoSelector(card());
    // A connection's model the catalogue no longer lists: said to be missing, never by its selector.
    rerender(tile(GONE_MODEL));
    expect(chip().querySelector('.awwo-node-model-picker-value')!.textContent).toBe('当前目录未包含该模型 · 12345678');
    expect(within(card()).getByText('使用 当前目录未包含该模型 · 12345678')).toBeVisible();
    expectNoSelector(chip());
    expectNoSelector(card());
  });

  it('names a model the catalogue lists for the node’s own computer only by the catalogue’s name, in the chip too', () => {
    render(<SessionTile node={brief(NEMOTRON, 'sandbox')} scale={1} focused modelChoices={choices(models.filter(entry => entry.model === SOL))}
      onChangeModel={vi.fn()} onUpdateNode={vi.fn()} freeConversation initializeOnSend onSend={vi.fn()} modelNames={{ models: [...models, ...computer], media }} />);
    expect(chip().querySelector('.awwo-node-model-picker-value')!.textContent).toBe('Nemotron 3 Super 120B');
    expect(within(card()).getByText('使用 Nemotron 3 Super 120B')).toBeVisible();
    expectNoSelector(chip());
    expectNoSelector(card());
  });
});

describe('a reader’s canvas', () => {
  const READER: Tenant = { id: 'tenant-run-names-reader', name: 'Workspace', status: 'active', role: 'reader', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
  // The surface as a reader has it (ReadOnlyCanvas): the workspace's canvas, read-only, so it never reads the
  // workspace's model catalogue, which would name GPT-6.1 Sol as published.
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() {} });
    configureCanvasStorage('user-run-names', READER.id, 'canvas-run-names-reader');
    configureSaaSCanvas({ tenant: READER, canvasId: 'canvas-run-names-reader' });
    const level = { ...chat('level', '关卡设计', 'openai-agents', SOL), persona: '设计三段关卡，每段一个检查点。' };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ version: 2, updatedAt: 1, nodes: [level], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } }));
  });
  afterEach(() => clearSaaSCanvas());

  it('names an opened node’s model by a name read from its selector, never by the selector', async () => {
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') throw new Error('Unexpected write request');
      return Response.json(String(input).endsWith('/runtime') ? runtimeStatus : { items: [], companies: [], available: false, conversations: [] });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<CanvasSurface readOnly storageMode="cloud" />);
    fireEvent.click(screen.getByRole('button', { name: '打开 关卡设计', exact: true }));
    const card = await screen.findByRole('region', { name: '「关卡设计」的任务' });
    expect(within(card).getByText('使用 GPT 6.1 Sol')).toBeVisible();
    expectNoSelector(card);
    expectNoSelector(screen.getByTestId('canvas-tile-level'));
    // The page asked for no model catalogue: the name came from the selector alone.
    expect(fetcher.mock.calls.map(([url]) => String(url)).filter(url => url.includes('/runtime'))).toEqual([]);
  });
});
