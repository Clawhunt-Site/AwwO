// Every other place the web shows a node's or an Agent's model names it as the run timeline, the run receipt and the
// node's model picker do (saas-run-model-names.test.tsx), never by its selector: `bedrock.claude-opus-5-5` names the
// service AwwO reaches the model through, which AwwO never says (owner decisions 2026-10-11). These printed the model
// as the node or the Agent holds it: the node's Configure panel (a saved model its list lacks, and its list itself,
// where the local edition's AwwO 云端 models went by AwwO's selectors), a workspace Agent's fixed model and the team
// members that keep a model of their own, the collaboration team's member picker (a model its runtime's catalogue lacks,
// and every model with no label of its own, listed by its selector), the workspace Agent catalogue, the line a plan's
// reply says a node now runs, the account's default model a workspace does not offer, and the title of a node the
// model rail adds. A team member's picker keeps what its labels are there for: the connection a connection's model
// comes by, and a free workspace's plan tag (owner request 2026-10-10, saas-plan-tags.test.tsx), on the choices only.
// Every id here is made up, but for the models', which are the Bedrock catalogue's (apps/bedrock-models.json).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentTemplate, getAgentTemplates } from '../src/canvas/agentTemplates';
import { CanvasSurface, type CanvasEvolution } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { createModelNode } from '../src/canvas/canvasModelDrop';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { canvasText, LocaleProvider } from '../src/canvas/i18n';
import { InspectorPanel } from '../src/canvas/InspectorPanel';
import { parseMediaCatalogue } from '../src/canvas/mediaCatalog';
import { choiceModelName, labelModelName, listedModelName, nodeModelName, selectorModelName, showsSelector } from '../src/canvas/modelNames';
import { applyCanvasPlan } from '../src/canvas/canvasPlan';
import { automaticGroups, groupModels, type ModelPaletteSelection } from '../src/canvas/modelPalette';
import { NodeModelSettings } from '../src/canvas/NodeModelSettings';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { NodeTeamEditor } from '../src/canvas/NodeTeamEditor';
import { resetAllSessions } from '../src/canvas/sessions';
import { WorkspaceAgentPicker } from '../src/canvas/WorkspaceAgentPicker';
import type { WorkspaceAgent } from '../src/canvas/workspaceAgents';
import { createCanvasRuntimeReader } from '../src/canvasRuntimeReader';
import type { Identity } from '../src/saas/api';
import { AccountPreferencesProvider, emptyAccountPreferences } from '../src/saas/accountPreferences';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { SaaSRuntimeStatus } from '../src/saas/runtimeCatalog';
import { GeneralSettings } from '../src/saas/settings/general';

/** What the provider and route names look like anywhere in the views' words: a selector's route, a media model's id. */
const PROVIDER_ID = /bedrock|runninghub|tripo|\b(?:rh|xt|jm)\.[a-z0-9]/i;

const OPUS = 'bedrock.claude-opus-5-5';
const SOL = 'bedrock.gpt-6-1-sol';
const HAIKU = 'bedrock.claude-haiku-4-5';
/** A model the workspace no longer offers. */
const WITHDRAWN = 'bedrock.claude-sonnet-4-6';
/** A person's own connection to AwwO 云端 (connections.go): its selector, its model named by AwwO's selector for it. */
const CLOUD_MODEL = 'byok_' + 'c'.repeat(33) + '_' + 'a'.repeat(16);
/** A team's connection to a service of its own, and a connection's model the catalogue no longer lists. */
const TEAM_MODEL = 'byok_' + 'd'.repeat(33) + '_' + 'b'.repeat(16);
const GONE_MODEL = 'byok_' + 'e'.repeat(33) + '_' + '0'.repeat(8) + '12345678';
const CLOUD_LABEL = `${OPUS} · AwwO Cloud · awwo / cccccc`;
const TEAM_LABEL = 'gpt-5.5 · Team · openai / dddddd';

/** The workspace's runtime catalogue as the API sends it (runs.go runtime), for a free workspace: Claude Opus 5.5 is
 *  outside its allowance (its label tagged · Pro), GPT-6.1 Sol's published name is spelt otherwise than its selector and
 *  comes with no label, and two connections' models carry their connections' labels. */
const runtimeStatus = {
  available: true, configured: true, plannerAvailable: true,
  runtimes: [
    { id: 'pi', name: 'Pi', available: true, configured: true, supportsEffortSelection: false, tools: [] },
    { id: 'openai-agents', name: 'OpenAI Agents', available: true, configured: true, supportsEffortSelection: true, tools: [] },
  ],
  models: [
    { id: OPUS, name: 'Claude Opus 5.5', provider: 'bedrock', runtime: 'openai-agents', route: 'bedrock', requiresUpgrade: true },
    { id: OPUS, name: 'Claude Opus 5.5', provider: 'bedrock', runtime: 'pi', route: 'bedrock', requiresUpgrade: true },
    { id: SOL, name: 'GPT-6.1 Sol', provider: 'bedrock', runtime: 'openai-agents', route: 'bedrock' },
    { id: CLOUD_MODEL, name: OPUS, label: CLOUD_LABEL, provider: 'awwo', providerModel: OPUS, runtime: 'openai-agents',
      reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
    { id: TEAM_MODEL, name: 'gpt-5.5', label: TEAM_LABEL, provider: 'openai', providerModel: 'gpt-5.5', runtime: 'pi' },
  ],
} as unknown as SaaSRuntimeStatus;
const paletteOf = (locale: 'zh' | 'en'): ModelPaletteSelection[] => groupModels(runtimeStatus, locale).flatMap(group => group.models);
const media = parseMediaCatalogue({ configured: true, available: true, models: [
  { id: 'xt.seedream-5-pro', name: 'seedream 5 pro', label: ['图片 · 高清', 'Image · HD'], vendor: 'xtasy', kind: 'image', prompt: { minLength: 1, maxLength: 2000 }, params: [] },
] });
const tenant = { id: 'tenant-shown-names', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };

const chat = (id: string, title: string, runtime: string, model: string, extra: Partial<SessionNode> = {}): SessionNode =>
  ({ ...createAgentTemplate('general', { x: 80, y: 60 }, 'zh'), id, title, runtime, model, effort: '', ...extra }) as SessionNode;

/** Every word an element shows or says: its text (its options' too) and every attribute a person reads or hears. */
function shownWords(root: Element): string {
  const words = [root.textContent ?? ''];
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const name of ['title', 'aria-label', 'placeholder', 'alt', 'label']) { const value = element.getAttribute(name); if (value) words.push(value); }
  }
  return words.join('\n');
}
/** No provider and no connection's selector anywhere in a view's words, nor a plan tag outside the choices given. */
function expectNoSelector(root: Element, tagged: readonly string[] = []) {
  const words = shownWords(root);
  expect(words).not.toMatch(PROVIDER_ID);
  expect(words).not.toMatch(/byok_/i);
  const tags = [...root.querySelectorAll('option')].filter(option => option.textContent?.includes('· Pro')).map(option => option.textContent);
  expect(tags).toEqual(tagged);
  expect(words.replaceAll('· Pro', '').length).toBe(words.length - tags.length * '· Pro'.length);
}
const optionTexts = (select: Element) => [...select.querySelectorAll('option')].map(option => option.textContent);

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); resetAllSessions(); });
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('a catalogue label as a list shows it', () => {
  it('names the model in front, read as a selector where it is one, and keeps the rest', () => {
    expect(labelModelName('Claude Opus 5.5', OPUS, 'zh')).toBe('Claude Opus 5.5');
    expect(labelModelName('Claude Opus 5.5 · Pro', OPUS, 'zh')).toBe('Claude Opus 5.5 · Pro');
    // A model with no label of its own is listed by its selector, plan tag or not.
    expect(labelModelName(OPUS, OPUS, 'zh')).toBe('Claude Opus 5.5');
    expect(labelModelName(`${OPUS} · Pro`, OPUS, 'en')).toBe('Claude Opus 5.5 · Pro');
    expect(labelModelName(` ${SOL} `, SOL, 'zh')).toBe('GPT 6.1 Sol');
    // A connection's label keeps the connection it names; AwwO 云端's names its model by AwwO's selector for it.
    expect(labelModelName(CLOUD_LABEL, CLOUD_MODEL, 'zh')).toBe('Claude Opus 5.5 · AwwO Cloud · awwo / cccccc');
    expect(labelModelName(TEAM_LABEL, TEAM_MODEL, 'en')).toBe(TEAM_LABEL);
    // One named by a selector that holds no name is unnamed, with the end of its own selector.
    expect(labelModelName(TEAM_MODEL, CLOUD_MODEL, 'zh')).toBe('未命名的模型 · aaaaaaaa');
    expect(labelModelName(`RH.Seedance-Pro · Pro`, CLOUD_MODEL, 'en')).toBe('Unnamed model · aaaaaaaa · Pro');
    expect(labelModelName('', OPUS, 'zh')).toBe('Claude Opus 5.5');
    // A published name keeps its own middle dot and its own way of writing.
    for (const published of ['Kimi · 长文本', 'GPT-5.6/Team', 'Dr. Model 2']) expect(labelModelName(published, CLOUD_MODEL, 'zh'), published).toBe(published);
    // No part of a name is shown as a selector, wherever it stands (Codex review): a profile may publish one after a dot.
    expect(labelModelName(`Research · ${OPUS}`, 'review-profile', 'en')).toBe('Research · Claude Opus 5.5');
    expect(labelModelName(`Research · ${TEAM_MODEL} · Pro`, 'review-profile', 'zh')).toBe('Research · Pro');
    expect(choiceModelName(`Research · ${OPUS}`, 'review-profile')).toBe('Research · Claude Opus 5.5');
    expect(choiceModelName(`${OPUS} · RH.Seedance-Pro`, CLOUD_MODEL)).toBe('Claude Opus 5.5');
    expect(choiceModelName(`${TEAM_MODEL} · Research`, CLOUD_MODEL)).toBe('');
    expect(choiceModelName('图片 · 高清', CLOUD_MODEL)).toBe('图片 · 高清');
    // Whatever the spaces around its dots, at either end too (Codex review, round 2).
    expect(labelModelName(` · ${OPUS}`, OPUS, 'zh')).toBe('Claude Opus 5.5');
    expect(labelModelName(` · ${OPUS}`, SOL, 'zh')).toBe('Claude Opus 5.5');
    // A first part left empty is passed over: the published name after it stays (Codex review, round 3).
    expect(choiceModelName(' · Research', 'review-profile')).toBe('Research');
    expect(labelModelName(' · Research · Pro', 'review-profile', 'en')).toBe('Research · Pro');
    // A vendor's path after a dot is read as well (both reviewers); a path of a person's own is not.
    expect(choiceModelName('Research · anthropic/claude-opus-5-5', 'review-profile')).toBe('Research · Claude Opus 5.5');
    expect(choiceModelName('Research · anthropic.claude-opus-5-5', 'review-profile')).toBe('Research · Claude Opus 5.5');
    expect(choiceModelName('Research · dev/research', 'review-profile')).toBe('Research · dev/research');
    // Round 4: a service's path, a GovCloud profile, a gateway's vendor path, each named by its model part; a
    // connection's own name that only looks like one (no vendor in the middle, no version after it) stays as written.
    expect(choiceModelName('Research·bedrock/claude-opus-5-5', 'review-profile')).toBe('Research·Claude Opus 5.5');
    expect(choiceModelName('Research·us-gov.anthropic.claude-opus-5-5-v1:0', 'review-profile')).toBe('Research·Claude Opus 5.5 V1');
    expect(choiceModelName('Research · z-ai/glm-4.6', 'review-profile')).toBe('Research · GLM 4.6');
    // Round 5: a worker profile with no name of its own publishes its Bedrock id, `ai21.` included (Codex); a bare
    // service word goes; a connection's name with a number but no model id's shape stays (Codex, Kiro).
    expect(choiceModelName('ai21.jamba-1-5-mini-v1:0', 'bedrock.jamba')).toBe('Jamba 1.5 Mini V1');
    expect(nodeModelName(chat('a', 'A', 'openai-agents', 'bedrock.jamba'), { models: [{ key: JSON.stringify(['openai-agents', 'bedrock.jamba']),
      runtime: 'openai-agents', model: 'bedrock.jamba', label: 'ai21.jamba-1-5-mini-v1:0', displayName: 'ai21.jamba-1-5-mini-v1:0', providerGroup: 'clawhunt',
      available: true }] }, 'zh')).toBe('Jamba 1.5 Mini V1');
    expect(labelModelName('Research · bedrock- · Pro', 'review-profile', 'en')).toBe('Research · Pro');
    // Round 6 (Codex): a GovCloud profile's id published whole, and a compact vendor id after a dot.
    expect(choiceModelName('us-gov.anthropic.claude-opus-5-5-v1:0', 'bedrock.gov')).toBe('Claude Opus 5.5 V1');
    expect(nodeModelName(chat('a', 'A', 'openai-agents', 'us-gov.anthropic.claude-opus-5-5-v1:0'), {}, 'en')).toBe('Claude Opus 5.5 V1');
    expect(choiceModelName('Research · openai/o3', 'review-profile')).toBe('Research · O3');
    // A connection's label names, after its model, the connection's own name and the service its key is for: a
    // person's words, kept as written whatever they look like (connections.go); only its model part is read.
    for (const own of ['us.team.prod', 'eu.prod.v2', 'openai/work', 'google.work', 'meta/research', 'xai.main', 'openai/v2', 'openai/prod2',
      'microsoft/365', 'google.key2', 'amazon.prod1', 'openai/prod-2', 'openai/2025-01', 'Bedrock-Kimi', 'bedrock-']) {
      expect(labelModelName(`gpt-5.5 · ${own} · openai / dddddd`, TEAM_MODEL, 'en'), own).toBe(`gpt-5.5 · ${own} · openai / dddddd`);
      expect(labelModelName(`${OPUS} · ${own} · awwo / cccccc`, CLOUD_MODEL, 'zh'), own).toBe(`Claude Opus 5.5 · ${own} · awwo / cccccc`);
    }
    expect(labelModelName('gpt-5.5 · gpt-5.5 · openai / dddddd', TEAM_MODEL, 'en')).toBe('gpt-5.5 · gpt-5.5 · openai / dddddd');
    // Round 7 (Codex): the model's own name in a connection's label is read whole, its own unspaced dots too (the hosted
    // AwwO may publish one; an AwwO 云端 name holding a spaced dot is refused): only what follows it stays as written.
    expect(labelModelName(`Research·${OPUS} · Team · awwo / cccccc`, CLOUD_MODEL, 'en')).toBe('Research·Claude Opus 5.5 · Team · awwo / cccccc');
    expect(labelModelName(`${OPUS}·RH.Seedance-Pro · Team · awwo / cccccc`, CLOUD_MODEL, 'zh')).toBe('Claude Opus 5.5 · Team · awwo / cccccc');
    // Round 8 (Codex): a vendor's id with no version after a dot is read too; and a name that still shows a selector
    // however it holds it (in brackets, after a space) is never shown: it goes as one no name can be read for.
    expect(choiceModelName('Research·deepseek/deepseek-flash', 'review-profile')).toBe('Research·DeepSeek Flash');
    expect(choiceModelName(`Claude (${OPUS})`, 'review-profile')).toBe('');
    expect(listedModelName(`Claude (${OPUS})`, OPUS, 'en')).toBe('Claude Opus 5.5');
    expect(listedModelName(`Claude ${TEAM_MODEL}`, CLOUD_MODEL, 'zh')).toBe('未命名的模型 · aaaaaaaa');
    expect(choiceModelName(`Research · ${OPUS} [old]`, 'review-profile')).toBe('Research');
    for (const shows of [`x ${OPUS}`, 'bedrock/x', 'Bedrock-Kimi', TEAM_MODEL, 'see rh.example-clip', 'XT.seedream',
      'Claude (us.anthropic.claude-opus-5-5-v1:0)', 'Claude (anthropic/claude-opus-5-5)', 'qwen/qwen3-235b']) expect(showsSelector(shows), shows).toBe(true);
    for (const none of ['Next.js Expert', 'Kimi · 长文本', 'openai / abc123', 'Claude Opus 5.5 · Pro', 'GPT-5.6/Team', 'Llama XT.2',
      'Kimi · moonshot.ai', 'Gemini · google.com', 'Meta Llama 3.3 70B', 'DeepSeek-V3.2', 'Qwen3.8']) expect(showsSelector(none), none).toBe(false);
    // Round 9 (Codex, Kiro): the guard holds for a name read from a selector, and for a vendor's or Bedrock's id inside a
    // published name; a domain after a dot is no model id.
    expect(selectorModelName('review-bedrock.claude-opus-5-5')).toBe('');
    expect(nodeModelName(chat('a', 'A', 'openai-agents', 'review-bedrock.claude-opus-5-5'), {}, 'en')).toBe('Model not in current catalogue');
    expect(choiceModelName('Claude (anthropic/claude-opus-5-5)', 'review-profile')).toBe('');
    expect(choiceModelName('Claude (us.anthropic.claude-opus-5-5-v1:0)', 'review-profile')).toBe('');
    expect(choiceModelName('Research·deepseek/deepseek-flash [old]', 'review-profile')).toBe('Research');
    expect(choiceModelName('qwen/qwen3-235b', 'review-profile')).toBe('Qwen3 235B');
    expect(choiceModelName('Kimi · moonshot.ai', 'review-profile')).toBe('Kimi · moonshot.ai');
    expect(choiceModelName('Gemini · google.com', 'review-profile')).toBe('Gemini · google.com');
    // A part left out takes the dot before it along; the dot after the part kept before stays.
    expect(labelModelName(`Research ·  · ${TEAM_MODEL} · Pro`, 'review-profile', 'zh')).toBe('Research · Pro');
    // A Bedrock inference profile's id after a dot is read too (Kiro review); a person's dotted name is not.
    expect(choiceModelName('Research · us.anthropic.claude-opus-5-5-v1:0', 'review-profile')).toBe('Research · Claude Opus 5.5 V1');
    expect(choiceModelName('Research · team.v1', 'review-profile')).toBe('Research · team.v1');
    expect(labelModelName(`Research · ${OPUS} · `, 'review-profile', 'en')).toBe('Research · Claude Opus 5.5');
    expect(labelModelName(`Research·${OPUS}`, 'review-profile', 'en')).toBe('Research·Claude Opus 5.5');
    expect(choiceModelName(`Research · ${OPUS} ·`, 'review-profile')).toBe('Research · Claude Opus 5.5');
    // A person's own words in a later part stay as written: a connection called team.v1 or dev/research.
    expect(labelModelName(`${OPUS} · dev/research · awwo / aaaaaa`, CLOUD_MODEL, 'zh')).toBe('Claude Opus 5.5 · dev/research · awwo / aaaaaa');
    expect(labelModelName('gpt-5.5 · team.v1 · openai / dddddd', TEAM_MODEL, 'en')).toBe('gpt-5.5 · team.v1 · openai / dddddd');
    // In any other label (a hosted model's, plan-tagged) a later part written as a selector is read.
    expect(labelModelName('Research · Bedrock-Kimi · Pro', 'review-profile', 'en')).toBe('Research · Kimi · Pro');
    // Rounds 10 and 11 (Codex, Kiro): a service's name anywhere in a name, however it is written, is never shown. A
    // selector holding one reads to no name (a saved profile no catalogue names is then missing); the route in front
    // still goes as before.
    for (const selector of ['review-bedrock-kimi', 'kimi_llmgate', 'bedrock', 'review-kimi.bedrock', 'kimi-bedrock2', 'kimi-bedrockv2',
      'review-llm-gate-kimi', 'Review-Bedrock-Kimi', `review-${'x'.repeat(60)}-bedrock`]) expect(selectorModelName(selector), selector).toBe('');
    // A brand that only starts with the service's letters is another word (saas-multiplayer-model-names).
    expect(selectorModelName('bedrockish-model-1')).toBe('Bedrockish Model 1');
    expect(selectorModelName('bedrock-kimi')).toBe('Kimi');
    expect(selectorModelName('llmgate-gpt-5.5')).toBe('GPT 5.5');
    expect(nodeModelName(chat('a', 'A', 'openai-agents', 'review-kimi.bedrock'), {}, 'en')).toBe('Model not in current catalogue');
    expect(listedModelName('', 'Review-Bedrock-Kimi', 'zh')).toBe('未命名的模型');
    // A published name or a part of it that names the service in words goes as one that shows a selector.
    expect(choiceModelName('Claude Opus 5.5 · Bedrock', 'review-profile')).toBe('Claude Opus 5.5');
    expect(choiceModelName('Claude Opus 5.5 · LLM Gate · Fast', 'review-profile')).toBe('Claude Opus 5.5 · Fast');
    expect(listedModelName('Claude via Bedrock', OPUS, 'en')).toBe('Claude Opus 5.5');
    for (const shows of ['Claude · Bedrock', 'LLM Gate', 'llm_gate', 'bedrock / abc123', 'Kimi.bedrock']) expect(showsSelector(shows), shows).toBe(true);
    // Round 12 (Codex, Kiro): however the words are spaced, and read as a page shows them: full-width letters, an
    // invisible character inside the word.
    for (const shows of ['Claude via LLM  Gate', 'Claude via LLM\u00a0Gate', 'LLM\tGate', '\uff22\uff45\uff44\uff52\uff4f\uff43\uff4b',
      'Bed\u200brock', 'Bed\u00adrock']) expect(showsSelector(shows), shows).toBe(true);
    expect(showsSelector('LLM Gateway')).toBe(false);
    expect(choiceModelName('LLM · Gateway · Fast', 'review-profile')).toBe('LLM · Gateway · Fast');
    // Round 13 (Codex, Kiro): the name the parts make is judged too, so a service spelt across them, or brought together
    // once a part between is left out, never shows; and a combining mark or an accent inside the word is read past.
    for (const name of ['Claude · LLM · Gate', 'Claude · LLM · bedrock · Gate', 'Claude · \uff2c\uff2c\uff2d · \uff27\uff41\uff54\uff45',
      'Claude · LLM\u200b · Gate']) expect(choiceModelName(name, 'review-profile'), name).toBe('');
    expect(listedModelName('Claude · LLM · Gate', OPUS, 'en')).toBe('Claude Opus 5.5');
    // Round 14 (Codex, Kiro): any typography between LLM and Gate (a non-breaking hyphen, the CJK middle dot, a bullet, a
    // slash), and a media model's id with a number after its dot, as ids are written; a capitalised XT.2 is a name.
    for (const shows of ['Claude via LLM\u2011Gate', 'Claude · LLM\u30fbGate', 'LLM\u2022Gate', 'LLM\u2027Gate', 'LLM / Gate',
      'Preview (xt.123)', 'rh.2048 clip']) expect(showsSelector(shows), shows).toBe(true);
    for (const none of ['Llama XT.2', 'LLM服务Gate']) expect(showsSelector(none), none).toBe(false);
    for (const shows of ['Claude via Bed\u034frock', 'B\u00e9drock', 'Be\u0301drock']) expect(showsSelector(shows), shows).toBe(true);
    // A team connection's own name and the service its own key is for stay as written after the model's name.
    expect(labelModelName('gpt-5.5 · My key · llmgate / abc123', TEAM_MODEL, 'en')).toBe('gpt-5.5 · My key · llmgate / abc123');
    // The plan tag is no part of a name: a model published as Pro keeps it on a free workspace (Codex review).
    expect(labelModelName('Pro · Pro', 'review-profile', 'en')).toBe('Pro · Pro');
    expect(labelModelName(`${OPUS} · ${OPUS} · Pro`, OPUS, 'zh')).toBe('Claude Opus 5.5 · Pro');
    // A vendor's id counts only as a word of its own (Kiro review): GPTqwen/2 is a published name, ' qwen/2' is not.
    expect(showsSelector('GPTqwen/2')).toBe(false);
    expect(showsSelector('GPT qwen/2')).toBe(true);
    expect(showsSelector('Claude (US.anthropic.claude-opus-5-5-v1:0)')).toBe(true);
  });
});

describe('the node’s Configure panel', () => {
  const settings = (model: string, locale: 'zh' | 'en' = 'zh') => <LocaleProvider locale={locale}>
    <NodeModelSettings node={{ runtime: 'openai-agents', model, effort: '' }} groups={automaticGroups(groupModels(runtimeStatus, locale))} onChange={vi.fn()} />
  </LocaleProvider>;
  const select = (label: string) => screen.getByRole('combobox', { name: label });

  it('lists each model as the picker does and names a saved one it lacks, never by its selector (中文)', () => {
    const { rerender } = render(settings(WITHDRAWN));
    // By brand, in the catalogue's order (GPT first, then Claude): the AwwO 云端 model is listed as Claude Opus 5.5 too.
    expect(optionTexts(select('模型'))).toEqual(['工作区默认模型', 'Claude Sonnet 4.6 · 当前不可用', 'gpt-5.5', 'GPT-6.1 Sol', 'Claude Opus 5.5', 'Claude Opus 5.5']);
    expect(select('模型')).toHaveValue(WITHDRAWN);
    expectNoSelector(select('模型'));
    rerender(settings(GONE_MODEL));
    expect(optionTexts(select('模型'))[1]).toBe('当前目录未包含该模型 · 12345678 · 当前不可用');
    expectNoSelector(select('模型'));
    // The values are still the selectors: picking the AwwO 云端 model saves its own.
    const onChange = vi.fn();
    cleanup();
    render(<NodeModelSettings node={{ runtime: 'pi', model: '', effort: '' }} groups={automaticGroups(groupModels(runtimeStatus, 'zh'))} onChange={onChange} />);
    fireEvent.change(select('模型'), { target: { value: CLOUD_MODEL } });
    expect(onChange).toHaveBeenCalledWith({ runtime: 'openai-agents', model: CLOUD_MODEL, effort: '' });
  });

  it('says the same in English', () => {
    render(settings(GONE_MODEL, 'en'));
    expect(optionTexts(select('Model'))).toEqual(['Workspace default model', 'Model not in current catalogue · 12345678 · not available now',
      'gpt-5.5', 'GPT-6.1 Sol', 'Claude Opus 5.5', 'Claude Opus 5.5']);
    expectNoSelector(select('Model'));
  });

  it('names a workspace Agent’s fixed model and the team members that keep their own, with the catalogue or without', () => {
    const groups = automaticGroups(groupModels(runtimeStatus, 'zh'));
    const agent = chat('shared', '共享研究员', 'openai-agents', CLOUD_MODEL, { agentRef: { source: 'workspace', agentId: 'agent-shown-names' } });
    // A panel keeps its draft for the node it opened on (InspectorPanel): each case opens its own.
    const panel = (node: SessionNode, modelGroups?: typeof groups, locale: 'zh' | 'en' = 'zh') => <LocaleProvider locale={locale}>
      <InspectorPanel key={JSON.stringify([node.model, Boolean(modelGroups), locale, Boolean(node.team)])} node={node} liveCompanies={[]} apiBase="/api"
        onSave={vi.fn()} onClose={vi.fn()} modelGroups={modelGroups} media={{ status: 'ready', catalogue: media! }} />
    </LocaleProvider>;
    const { rerender } = render(panel(agent, groups));
    expect(screen.getByLabelText('模型')).toHaveTextContent(/^Claude Opus 5\.5$/);
    expectNoSelector(document.body);
    // A local host has no catalogue: a team connection's model is said to be missing, never shown as it is.
    rerender(panel(agent));
    expect(screen.getByLabelText('模型')).toHaveTextContent(/^当前目录未包含该模型 · aaaaaaaa$/);
    rerender(panel({ ...agent, model: OPUS }));
    expect(screen.getByLabelText('模型')).toHaveTextContent(/^Claude Opus 5\.5$/);
    expectNoSelector(document.body);
    rerender(panel({ ...agent, model: OPUS }, groups, 'en'));
    expect(screen.getByLabelText('Model')).toHaveTextContent(/^Claude Opus 5\.5$/);
    // Members that keep a model of their own, listed under the node's model.
    const node = chat('team', '评审', 'openai-agents', SOL);
    const team = createNodeTeam(node, 'zh');
    const withTeam = { ...node, team: { ...team, members: [{ ...team.members[0], model: CLOUD_MODEL }, { ...team.members[1], model: GONE_MODEL }] } };
    rerender(panel(withTeam, groups));
    const kept = screen.getByRole('group', { name: canvasText('zh', 'inspector.teamModelOverrideLabel') });
    expect([...kept.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Agent 1 · 评审 · Claude Opus 5.5', 'Agent 2 · 复核与汇总 · 当前目录未包含该模型 · 12345678']);
    expectNoSelector(kept);
    rerender(panel(withTeam, groups, 'en'));
    expect([...screen.getByRole('group', { name: canvasText('en', 'inspector.teamModelOverrideLabel') }).querySelectorAll('li')].map(item => item.textContent))
      .toEqual(['Agent 1 · 评审 · Claude Opus 5.5', 'Agent 2 · 复核与汇总 · Model not in current catalogue · 12345678']);
  });

  it('names a node’s model by its own runtime’s entry, which the groups the panel lists from leave out (Codex review)', () => {
    // Workers configured apart may give one id to different models; the groups keep one entry per model.
    const entry = (runtime: 'pi' | 'openai-agents', name: string): ModelPaletteSelection => ({ key: JSON.stringify([runtime, 'reviewer']), runtime, model: 'reviewer',
      label: name, displayName: name, providerGroup: 'claude', available: true });
    const whole = [entry('pi', 'Claude Local'), entry('openai-agents', 'Claude Remote')];
    const groups = automaticGroups([{ id: 'claude', label: 'Claude', models: whole, available: true }]);
    expect(groups[0].models.map(item => item.displayName)).toEqual(['Claude Remote']);
    const agent = chat('shared', '共享研究员', 'pi', 'reviewer', { agentRef: { source: 'workspace', agentId: 'agent-shown-names' } });
    render(<InspectorPanel node={agent} liveCompanies={[]} apiBase="/api" onSave={vi.fn()} onClose={vi.fn()} modelGroups={groups} modelNames={{ models: whole, media }} />);
    expect(screen.getByLabelText('模型')).toHaveTextContent(/^Claude Local$/);
    cleanup();
    // The Configure panel names a saved model its list lacks by the whole catalogue too.
    render(<NodeModelSettings node={{ runtime: 'sandbox', model: 'reviewer', effort: '' }} groups={[]} names={{ models: [...whole,
      { ...entry('pi', 'Claude Sandbox'), runtime: 'sandbox', key: JSON.stringify(['sandbox', 'reviewer']) }] }} onChange={vi.fn()} />);
    expect(optionTexts(screen.getByRole('combobox', { name: '模型' }))[1]).toBe('Claude Sandbox · 当前不可用');
    cleanup();
    // A team keeps the runtime it is set up on: its own model reads as that runtime's entry names it (Codex review, round 2).
    render(<NodeModelSettings node={{ runtime: 'pi', model: 'reviewer', effort: '' }} groups={groups} names={{ models: whole }} keepRuntime onChange={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: '模型' });
    expect(select).toHaveValue('reviewer');
    expect(optionTexts(select)).toEqual(['工作区默认模型', 'Claude Local']);
  });
});

describe('the collaboration team’s member picker', () => {
  beforeEach(() => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-shown-names' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(runtimeStatus)));
  });

  it('gives every model the bridge lists a label, so that the picker never lists one by its selector', async () => {
    const read = createCanvasRuntimeReader();
    expect((await read('/api/agents/openai-agents/models')).model_labels).toEqual({ [OPUS]: 'Claude Opus 5.5 · Pro', [SOL]: 'GPT-6.1 Sol', [CLOUD_MODEL]: CLOUD_LABEL });
    expect((await read('/api/agents/pi/models')).model_labels).toEqual({ [OPUS]: 'Claude Opus 5.5 · Pro', [TEAM_MODEL]: TEAM_LABEL });
    // A blank label of its own never wins over the published name (Kiro review).
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...runtimeStatus, models: [{ id: SOL, name: ' GPT-6.1 Sol ', label: '  ', runtime: 'openai-agents' }] })));
    expect((await read('/api/agents/openai-agents/models')).model_labels).toEqual({ [SOL]: 'GPT-6.1 Sol' });
    // Nor does a label that is not text, as a relayed catalogue might send, take the catalogue down.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...runtimeStatus, models: [{ id: SOL, name: 'GPT-6.1 Sol', label: 5, runtime: 'openai-agents' }] })));
    expect((await read('/api/agents/openai-agents/models')).model_labels).toEqual({ [SOL]: 'GPT-6.1 Sol' });
  });

  it.each(['zh', 'en'] as const)('names each choice by its label and a model its catalogue lacks as the node’s picker does (%s)', async locale => {
    const node = chat('team', '评审', 'openai-agents', SOL);
    const team = createNodeTeam(node, locale);
    const withTeam = { ...node, team: { ...team, members: [{ ...team.members[0], model: GONE_MODEL }, { ...team.members[1], model: WITHDRAWN }] } };
    render(<LocaleProvider locale={locale}><NodeTeamEditor node={withTeam} available readJson={createCanvasRuntimeReader()} onChange={vi.fn()}
      modelNames={{ models: paletteOf(locale), media }} /></LocaleProvider>);
    const selects = await screen.findAllByRole('combobox', { name: locale === 'zh' ? '模型' : 'Model' });
    await waitFor(() => expect(within(selects[0]).getByRole('option', { name: 'GPT-6.1 Sol' })).toBeEnabled());
    const unknown = locale === 'zh' ? '当前清单不可用：' : 'Unavailable in current catalog: ';
    const inherit = locale === 'zh' ? '继承节点已绑定模型' : 'Inherit bound node model';
    // A model no name can be read for is said to be missing once.
    expect(optionTexts(selects[0])).toEqual([inherit, `${locale === 'zh' ? '当前目录未包含该模型' : 'Model not in current catalogue'} · 12345678`,
      'Claude Opus 5.5 · Pro', 'GPT-6.1 Sol', 'Claude Opus 5.5 · AwwO Cloud · awwo / cccccc']);
    expect(optionTexts(selects[1])).toEqual([inherit, `${unknown}Claude Sonnet 4.6`, 'Claude Opus 5.5 · Pro', 'GPT-6.1 Sol', 'Claude Opus 5.5 · AwwO Cloud · awwo / cccccc']);
    // The plan tag stays on the choice the workspace's plan does not include, and nowhere else.
    expectNoSelector(screen.getByRole('region', { name: locale === 'zh' ? '节点协作团队' : 'Node collaboration team' }), ['Claude Opus 5.5 · Pro', 'Claude Opus 5.5 · Pro']);
    // The values are still the selectors.
    expect(within(selects[0]).getByRole('option', { name: 'Claude Opus 5.5 · AwwO Cloud · awwo / cccccc' })).toHaveValue(CLOUD_MODEL);
  });
});

describe('the workspace Agent catalogue', () => {
  const agent = (id: string, name: string, runtime: string, model: string): WorkspaceAgent =>
    ({ id: `agent-shown-${id}`, name, runtime, model, effort: '', instructions: `Role ${id}`, status: 'active' });
  const agents = [agent('opus', 'Planner', 'openai-agents', OPUS), agent('cloud', 'Checker', 'openai-agents', CLOUD_MODEL),
    agent('gone', 'Writer', 'pi', GONE_MODEL), agent('old', 'Drafter', 'pi', WITHDRAWN), agent('none', 'Idle', 'pi', '')];
  const card = (name: string, locale: 'zh' | 'en' = 'zh') => screen.getByRole('button', { name: locale === 'zh' ? `选择 ${name}` : `Select ${name}` });
  const modelLine = (name: string, locale: 'zh' | 'en' = 'zh') => card(name, locale).querySelector('span[title]')!;

  it('names each Agent’s model as the picker does, never by its selector, and finds it by that name (中文)', async () => {
    const { rerender } = render(<WorkspaceAgentPicker loadPage={async () => ({ items: agents })} onSelect={vi.fn()} disabled={false} catalogue={paletteOf('zh')} />);
    await screen.findByRole('button', { name: '选择 Planner' });
    const expected: Record<string, string> = { Planner: 'Claude Opus 5.5', Checker: 'Claude Opus 5.5', Writer: '当前目录未包含该模型 · 12345678', Drafter: 'Claude Sonnet 4.6' };
    for (const [name, model] of Object.entries(expected)) {
      expect(modelLine(name).getAttribute('title'), name).toBe(model);
      expect(modelLine(name).textContent, name).toMatch(new RegExp(`^${model.replace(/[.·]/g, '\\$&')} · (pi|openai-agents)$`));
    }
    expect(modelLine('Idle').textContent).toBe('未配置模型 · pi');
    expectNoSelector(screen.getByLabelText('工作区 Agent 目录'));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索已加载的 Agent' }), { target: { value: 'opus 5.5' } });
    expect(screen.getAllByRole('button', { name: /^选择 / }).map(button => button.getAttribute('aria-label'))).toEqual(['选择 Planner', '选择 Checker']);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索已加载的 Agent' }), { target: { value: '' } });
    // Without the catalogue: a name read from the selector, a connection's model missing.
    rerender(<WorkspaceAgentPicker loadPage={async () => ({ items: agents })} onSelect={vi.fn()} disabled={false} />);
    await waitFor(() => expect(modelLine('Checker').getAttribute('title')).toBe('当前目录未包含该模型 · aaaaaaaa'));
    expect(modelLine('Planner').getAttribute('title')).toBe('Claude Opus 5.5');
    expectNoSelector(screen.getByLabelText('工作区 Agent 目录'));
  });

  it('says the same in English', async () => {
    render(<LocaleProvider locale="en"><WorkspaceAgentPicker loadPage={async () => ({ items: agents })} onSelect={vi.fn()} disabled={false} catalogue={paletteOf('en')} /></LocaleProvider>);
    await screen.findByRole('button', { name: 'Select Checker' });
    expect(modelLine('Checker', 'en').getAttribute('title')).toBe('Claude Opus 5.5');
    expect(modelLine('Writer', 'en').getAttribute('title')).toBe('Model not in current catalogue · 12345678');
    expectNoSelector(screen.getByLabelText('Workspace Agent catalogue'));
  });
});

describe('a plan’s reply on the canvas', () => {
  const runtimeReader = async () => ({ agents: [], models: [] });
  const sidebar = () => within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
  const seed = (...nodes: SessionNode[]) => canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes, view: { x: 0, y: 0, scale: 1 } }));
  const stored = (id: string) => loadDocumentWithStatus().doc.nodes.find(item => item.id === id) as SessionNode | undefined;
  beforeEach(() => {
    configureCanvasStorage('user-shown-names', tenant.id, 'canvas-shown-names');
    configureSaaSCanvas({ tenant, canvasId: 'canvas-shown-names' }); configureSaaSCanvasSave(async () => 2);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const originalRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('canvas-root')
        ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
        : originalRect.call(this);
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => new Response(JSON.stringify(String(input).endsWith('/runtime') ? runtimeStatus : { items: [] }))));
  });
  afterEach(() => configureSaaSCanvasSave(null));

  it('says the model a plan put a node on by the name its picker shows, never by the selector its catalogue names it by', async () => {
    seed(chat('check', '检查', 'openai-agents', SOL));
    const planRequest = vi.fn(async () => ({ version: 1 as const, summary: '换一个模型', operations: [{ type: 'set_model' as const, nodeId: 'check', model: CLOUD_MODEL }] }));
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={runtimeReader} planRequest={planRequest} />);
    fireEvent.click(within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true }));
    const box = sidebar().getByRole('textbox', { name: '画布需求' });
    fireEvent.change(box, { target: { value: '换成 AwwO 云端的模型' } });
    // The palette is read before a plan can resolve a model against it.
    await waitFor(() => expect(sidebar().getByRole('button', { name: '修改画布' })).toBeEnabled());
    fireEvent.click(sidebar().getByRole('button', { name: '修改画布' }));
    await waitFor(() => expect(stored('check')).toMatchObject({ runtime: 'openai-agents', model: CLOUD_MODEL }));
    const log = sidebar().getByRole('log', { name: '画布对话' });
    await waitFor(() => expect(log.textContent).toContain(canvasText('zh', 'planning.changeModel', { node: '检查', model: 'Claude Opus 5.5' })));
    expectNoSelector(log);
  });

  it('says the same for a lesson’s suggestion applied as a plan', async () => {
    seed(chat('check', '检查', 'openai-agents', CLOUD_MODEL));
    const settled = vi.fn();
    const surface = (request: CanvasEvolution | null) => <CanvasSurface storageMode="cloud" runtimeReadJson={runtimeReader} evolution={request} onEvolutionSettled={settled} />;
    const { rerender } = render(surface(null));
    rerender(surface({ id: 'lesson:shown:1', nodeId: 'check', effort: 'high', model: CLOUD_MODEL, note: '「检查」把推理强度调成 high，模型不变。' }));
    await waitFor(() => expect(settled).toHaveBeenCalledWith('lesson:shown:1', { applied: true }));
    const line = canvasText('zh', 'planning.changeModelEffort', { node: '检查', model: 'Claude Opus 5.5', effort: canvasText('zh', 'effort.high') });
    await waitFor(() => expect(sidebar().getByRole('log', { name: '画布对话' }).textContent).toContain(line));
    expectNoSelector(sidebar().getByRole('log', { name: '画布对话' }));
  });
});

describe('a plan’s notes on what it applied otherwise', () => {
  const choices = [{ runtime: 'openai-agents', model: CLOUD_MODEL, available: true, name: OPUS, efforts: ['low'] },
    { runtime: 'pi', model: 'qwen3.8-27b-p6', available: true }];
  const userChosen = [{ runtime: 'openai-agents', model: 'deepseek-v4', available: true, name: OPUS }];
  const doc = () => ({ ...emptyDocument(), nodes: [chat('check', '检查', 'openai-agents', SOL)] });
  const notes = (model: string, effort: string | undefined, locale: 'zh' | 'en') => applyCanvasPlan(doc(),
    { version: 1, summary: 'x', operations: [{ type: 'set_model', nodeId: 'check', model, ...(effort ? { effort } : {}) }] }, locale, '', undefined, { choices, userChosen }).adjustments;

  it('names each model as the picker lists it, and one the workspace does not offer by a name read from what the plan wrote', () => {
    expect(notes(CLOUD_MODEL, 'high', 'en')).toEqual(['“检查” now uses “Claude Opus 5.5”, which has no “high” reasoning effort; it uses the model’s default']);
    expect(notes(CLOUD_MODEL, 'high', 'zh')).toEqual(['「检查」改用了「Claude Opus 5.5」，它没有「high」这档思考强度，使用模型默认']);
    expect(notes(WITHDRAWN, undefined, 'en')).toEqual(['Did not switch “检查” to “Claude Sonnet 4.6”: this workspace has no such model ready']);
    expect(notes(GONE_MODEL, undefined, 'zh')).toEqual(['没有把「检查」改用「当前目录未包含该模型 · 12345678」：此工作区现在没有可用的这个模型']);
    expect(notes('deepseek-v4', undefined, 'zh')[0]).toContain('没有把「检查」改用「Claude Opus 5.5」');
    // A model the plan names in words keeps them, unless they still show a selector (Codex review, round 8).
    expect(notes('Claude Haiku 9', undefined, 'en')).toEqual(['Did not switch “检查” to “Claude Haiku 9”: this workspace has no such model ready']);
    expect(notes(`${OPUS} [old]`, undefined, 'en')).toEqual(['Did not switch “检查” to “Model not in current catalogue”: this workspace has no such model ready']);
    // A label the plan copied with its plan tag is named by its name part, never with the tag (Codex review, round 9),
    // and only the tag goes: a name's own parts stay as written (Codex and Kiro, round 10).
    expect(notes(`${OPUS} · Pro`, undefined, 'en')).toEqual(['Did not switch “检查” to “Claude Opus 5.5”: this workspace has no such model ready']);
    expect(notes('Kimi·长文本', undefined, 'zh')).toEqual(['没有把「检查」改用「Kimi·长文本」：此工作区现在没有可用的这个模型']);
    expect(notes('Kimi · Coding · Pro', undefined, 'en')).toEqual(['Did not switch “检查” to “Kimi · Coding”: this workspace has no such model ready']);
    expect(notes(`Research · ${OPUS} · Pro`, undefined, 'en')).toEqual(['Did not switch “检查” to “Research · Claude Opus 5.5”: this workspace has no such model ready']);
    for (const locale of ['zh', 'en'] as const) for (const model of [CLOUD_MODEL, WITHDRAWN, GONE_MODEL, 'deepseek-v4']) {
      const said = notes(model, 'high', locale).join(' | ');
      expect(said, model).not.toMatch(PROVIDER_ID);
      expect(said, model).not.toMatch(/byok_/i);
    }
  });
});

describe('the account’s default model', () => {
  const identity = { user: { id: 'user-shown-names', name: 'Ada', email: 'ada@example.test', platformRole: 'user' },
    tenants: [tenant], authentication: 'local', personalCredentialsRequired: false } as unknown as Identity;
  /** The direct-task catalogue (computer_execution.go): each model's label, else its name, else its id. */
  const computerRuntime = { ready: true, capabilities: { workspace: true, approvals: true }, models: [
    { id: SOL, label: 'GPT-6.1 Sol', runtime: 'openai-agents' },
    { id: HAIKU, label: HAIKU, runtime: 'openai-agents', requiresUpgrade: true },
    { id: CLOUD_MODEL, label: CLOUD_LABEL, runtime: 'openai-agents' },
    { id: TEAM_MODEL, label: TEAM_LABEL, runtime: 'pi' },
  ] };
  function settings(model: string, locale: 'zh' | 'en') {
    localStorage.setItem('superclaw_locale', locale);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/preferences')
      ? Response.json({ preferences: { ...emptyAccountPreferences(), defaultModel: { runtime: 'pi', model } }, version: 1 })
      : url.endsWith('/computer-runtime') ? Response.json(computerRuntime) : Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 })));
    return render(<SaaSPreferencesProvider><AccountPreferencesProvider userId={identity.user.id}><GeneralSettings identity={identity} /></AccountPreferencesProvider></SaaSPreferencesProvider>);
  }

  it('lists the models by their names and names a saved one the workspace does not offer, never by a selector (中文)', async () => {
    settings(WITHDRAWN, 'zh');
    const select = await screen.findByRole('combobox', { name: '默认模型' });
    await waitFor(() => expect(within(select).getByRole('option', { name: 'GPT-6.1 Sol' })).toBeInTheDocument());
    expect(optionTexts(select)).toEqual(['不设默认（用服务列表里的第一个模型）', 'Claude Sonnet 4.6（这个工作区不提供）', 'GPT-6.1 Sol',
      'Claude Haiku 4.5（需升级套餐）', 'Claude Opus 5.5 · AwwO Cloud · awwo / cccccc', TEAM_LABEL]);
    expect(select).toHaveValue(JSON.stringify(['pi', WITHDRAWN]));
    expectNoSelector(select);
    cleanup();
    settings(GONE_MODEL, 'zh');
    const again = await screen.findByRole('combobox', { name: '默认模型' });
    await waitFor(() => expect(optionTexts(again)[1]).toBe('当前目录未包含该模型 · 12345678（这个工作区不提供）'));
    expectNoSelector(again);
    cleanup();
    // Saved for a runtime the workspace lists the model on no more: named as the list names it on another (Kiro review).
    settings(CLOUD_MODEL, 'zh');
    const moved = await screen.findByRole('combobox', { name: '默认模型' });
    await waitFor(() => expect(optionTexts(moved)[1]).toBe('Claude Opus 5.5 · AwwO Cloud · awwo / cccccc（这个工作区不提供）'));
    expectNoSelector(moved);
  });

  it('says the same in English', async () => {
    settings(GONE_MODEL, 'en');
    const select = await screen.findByRole('combobox', { name: 'Default model' });
    await waitFor(() => expect(within(select).getByRole('option', { name: 'GPT-6.1 Sol' })).toBeInTheDocument());
    expect(optionTexts(select).slice(1)).toEqual(['Model not in current catalogue · 12345678 (not offered in this workspace)', 'GPT-6.1 Sol',
      'Claude Haiku 4.5 (needs an upgrade)', 'Claude Opus 5.5 · AwwO Cloud · awwo / cccccc', TEAM_LABEL]);
    expectNoSelector(select);
  });
});

describe('a node the model rail adds', () => {
  it('is titled by its model’s name as the picker lists it, never by a selector its catalogue names it by', () => {
    const cloud = paletteOf('zh').find(entry => entry.model === CLOUD_MODEL)!;
    expect(cloud.displayName).toBe(OPUS);
    const frontend = getAgentTemplates('zh').find(item => item.id === 'frontend')!.title;
    expect(createModelNode(cloud, null, { x: 0, y: 0 }, 'zh')).toMatchObject({ title: 'Claude Opus 5.5', runtime: 'openai-agents', model: CLOUD_MODEL });
    expect(createModelNode(cloud, 'frontend', { x: 0, y: 0 }, 'zh').title).toBe(`Claude Opus 5.5 · ${frontend}`);
    // A name never grows, whatever its dots (a setup holds a title to 200 bytes; Codex review, round 3).
    const long = '中'.repeat(20) + 'AA' + '·A'.repeat(29);
    const titled = createModelNode({ ...cloud, displayName: long }, null, { x: 0, y: 0 }, 'zh').title;
    expect(titled).toBe(long);
    expect(new TextEncoder().encode(titled).length).toBeLessThanOrEqual(new TextEncoder().encode(long).length);
    // Named by nothing but a selector that holds no name: unnamed, with the end of its own; the plan tag never.
    expect(createModelNode({ ...cloud, displayName: TEAM_MODEL }, null, { x: 0, y: 0 }, 'en').title).toBe('Unnamed model · aaaaaaaa');
    const opus = paletteOf('zh').find(entry => entry.model === OPUS)!;
    expect(opus.label).toBe('Claude Opus 5.5 · Pro');
    expect(createModelNode(opus, null, { x: 0, y: 0 }, 'zh').title).toBe('Claude Opus 5.5');
  });
});
