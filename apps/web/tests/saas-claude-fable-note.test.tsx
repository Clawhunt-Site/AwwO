// Claude Fable models (bedrock.claude-fable-5-2 and any later one): AWS keeps the inputs and outputs of every request
// to one for up to 30 days, or longer where the law requires it, and its staff may read what its systems flag
// (ClawHunt's privacy policy, clause 08, "Claude Fable models"). Wherever a person has one chosen in a model picker, the
// page says so under the picker and points to the clause; on any other model it says nothing. The clause's page is
// linked only where the API named an https site, and the link opens on the clause itself (/legal#s-privacy-c8).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { ClaudeFableNote, PolicySite, privacyPolicyURL } from '../src/canvas/ClaudeFableNote';
import { LocaleProvider } from '../src/canvas/i18n';
import type { ModelPaletteGroup, ModelPaletteSelection } from '../src/canvas/modelPalette';
import { NodeModelSettings } from '../src/canvas/NodeModelSettings';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { NodeTeamEditor } from '../src/canvas/NodeTeamEditor';
import { resetAllSessions } from '../src/canvas/sessions';
import { TileComposer } from '../src/canvas/TileComposer';
import { isBedrockClaudeFableModel, isClaudeFableModel } from '../src/canvas/userChosenModels';
import { SaaSApiError, saasErrorMessage, type Identity, type Tenant } from '../src/saas/api';
import { AccountPreferencesProvider, emptyAccountPreferences } from '../src/saas/accountPreferences';
import type { MarketAgentDetail } from '../src/saas/marketApi';
import { MarketAgentDetailView } from '../src/saas/market/MarketAgentDetail';
import { decisionNote, marketModelDecision } from '../src/saas/market/marketModel';
import { ModelField } from '../src/saas/market/PublishAgentFields';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { GeneralSettings } from '../src/saas/settings/general';

const FABLE = 'bedrock.claude-fable-5-2', OPUS = 'bedrock.claude-opus-5-5', DEEPSEEK = 'deepseek-flash';
const ZH = 'Claude Fable 的请求由 AWS 保存最长 30 天（法律要求时更久），被系统标记的内容可能由 AWS 人员查看。';
const EN = 'AWS keeps Claude Fable requests for up to 30 days, or longer where the law requires it, and its staff may read content its systems flag.';
const SITE = 'https://clawhunt.example';
/** Clause 08 itself: /legal opens on the Terms of Service, about 4,600 px above it; its id is the one clause 07 links to. */
const CLAUSE = `${SITE}/legal#s-privacy-c8`;
const onSite = (view: ReactElement, site = SITE) => <PolicySite.Provider value={site}>{view}</PolicySite.Provider>;
const note = () => screen.queryByRole('note');
/** The clause's link as the settings' privacy link is made: in a new tab, with no opener; it opens on clause 08. */
function expectClauseLink(name: string) {
  const link = within(note()!).getByRole('link', { name });
  expect(link).toHaveAttribute('href', CLAUSE);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); resetAllSessions(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('which models are Claude Fable models', () => {
  it('goes by the id alone, as the API does: claude-fable- after an optional bedrock. prefix', () => {
    // backend user_chosen_models_test.go holds the API's rule to the same ids.
    for (const [id, want] of Object.entries({ 'bedrock.claude-fable-5-2': true, 'bedrock.claude-fable-6': true, 'claude-fable-5': true,
      'bedrock.claude-opus-5-5': false, 'bedrock.claude-fable': false, 'fable-5-2': false, 'bedrock.xclaude-fable-5': false,
      'bedrock.bedrock.claude-fable-5': false, 'deepseek-flash': false, '': false })) expect(isClaudeFableModel(id), id).toBe(want);
    expect(isClaudeFableModel(undefined)).toBe(false);
    expect(isClaudeFableModel(null)).toBe(false);
  });

  it('knows the ones AwwO runs through Amazon Bedrock by their catalog prefix: the sentence about AWS is theirs alone', () => {
    for (const [id, want] of Object.entries({ 'bedrock.claude-fable-5-2': true, 'bedrock.claude-fable-6': true, 'claude-fable-5': false,
      'claude-fable-5-2': false, 'bedrock.claude-opus-5-5': false, 'bedrock.claude-fable': false, 'byok_claude-fable-5-2': false, '': false })) {
      expect(isBedrockClaudeFableModel(id), id).toBe(want);
    }
    expect(isBedrockClaudeFableModel(undefined)).toBe(false);
    expect(isBedrockClaudeFableModel(null)).toBe(false);
  });
});

describe('the line under a picker', () => {
  it('is drawn for a Claude Fable model AwwO runs through Bedrock and for no other, a model only a user may choose included', () => {
    for (const model of [FABLE, 'bedrock.claude-fable-6']) {
      render(onSite(<ClaudeFableNote model={model} locale="zh" />));
      expect(note(), model).toHaveTextContent(`${ZH}隐私政策第 08 条`);
      cleanup();
    }
    // A Claude Fable id without the prefix is a person's own connection (the local edition): AWS never sees its requests.
    for (const model of [OPUS, DEEPSEEK, 'claude-fable-5', '', undefined]) {
      const { container } = render(onSite(<ClaudeFableNote model={model} locale="zh" />));
      expect(container, String(model)).toBeEmptyDOMElement();
      cleanup();
    }
  });

  it('links the clause on an https site, in both languages, and takes the class of the place it is in', () => {
    render(onSite(<ClaudeFableNote model={FABLE} locale="zh" className="canvas-inspector-hint" as="div" />, `${SITE}/`));
    expect(note()).toHaveClass('canvas-inspector-hint');
    expect(note()!.tagName).toBe('DIV');
    expectClauseLink('隐私政策第 08 条');
    cleanup();
    render(onSite(<ClaudeFableNote model={FABLE} locale="en" />));
    expect(note()).toHaveTextContent(`${EN} Privacy policy, clause 08`);
    expectClauseLink('Privacy policy, clause 08');
  });

  it('names the clause without a link where there is no https site to open', () => {
    expect(privacyPolicyURL(SITE)).toBe(CLAUSE);
    expect(privacyPolicyURL(`${SITE}/ `)).toBe(CLAUSE);
    for (const site of ['', 'http://clawhunt.example', 'javascript:alert(1)', '//clawhunt.example', undefined, null]) expect(privacyPolicyURL(site), String(site)).toBe('');
    for (const site of ['', 'http://clawhunt.example']) {
      render(onSite(<ClaudeFableNote model={FABLE} locale="en" />, site));
      expect(note()).toHaveTextContent(`${EN} Privacy policy, clause 08`);
      expect(screen.queryByRole('link')).toBeNull();
      cleanup();
    }
    // Outside the signed-in app (no site given at all) the same.
    render(<ClaudeFableNote model={FABLE} locale="zh" />);
    expect(note()).toHaveTextContent(`${ZH}隐私政策第 08 条`);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says nothing that contradicts the clause', () => {
    render(onSite(<><ClaudeFableNote model={FABLE} locale="zh" /><ClaudeFableNote model={FABLE} locale="en" /></>));
    expect(document.body.textContent).not.toMatch(/不保存|不留存|私密|not stored|private|zero retention/i);
  });
});

describe('a node’s model', () => {
  const entry = (model: string, label: string): ModelPaletteSelection =>
    ({ key: JSON.stringify(['openai-agents', model]), label, providerGroup: 'claude', runtime: 'openai-agents', model, available: true });
  const entries = [entry(FABLE, 'Claude Fable 5.2'), entry(OPUS, 'Claude Opus 5.5'), { ...entry(DEEPSEEK, 'DeepSeek V4.1 Flash'), userChosen: true }];
  const groups: ModelPaletteGroup[] = [{ id: 'claude', label: 'Models', available: true, models: entries }];
  const settings = (model: string) => onSite(<NodeModelSettings node={{ runtime: 'openai-agents', model, effort: '' }} groups={groups} onChange={vi.fn()} />);

  it('says it under the model in the node’s settings while a Claude Fable model is chosen there', () => {
    const { rerender } = render(settings(FABLE));
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue(FABLE);
    expect(note()).toHaveTextContent(ZH);
    expect(note()).toHaveClass('canvas-inspector-hint');
    expectClauseLink('隐私政策第 08 条');
    // Right under the picker, before the settings' other hints.
    expect(screen.getByRole('combobox', { name: '模型' }).nextElementSibling).toBe(note());
    for (const model of [OPUS, DEEPSEEK, '']) {
      rerender(settings(model));
      expect(note(), model).toBeNull();
    }
    rerender(settings('bedrock.claude-fable-5-1'));
    // A Claude Fable model the workspace no longer lists is still the node's model.
    expect(note()).toHaveTextContent(ZH);
  });

  it('draws the composer’s line only under a row that is there', () => {
    const line = <div role="note">line</div>;
    render(<TileComposer streaming={false} draft="" onSend={vi.fn()} accessory={<span>picker</span>} accessoryNote={line} />);
    expect(note()).toHaveTextContent('line');
    cleanup();
    render(<TileComposer streaming={false} draft="" onSend={vi.fn()} accessoryNote={line} />);
    expect(note()).toBeNull();
  });

  it('says it under a team member’s own model', async () => {
    const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title: '研究', model: OPUS, runtime: 'pi' };
    const team = createNodeTeam(node);
    const read = vi.fn(async (path: string) => path.endsWith('/models') ? { models: [FABLE, OPUS] }
      : { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] });
    const editor = (model: string) => onSite(<NodeTeamEditor node={{ ...node, team: { ...team, members: team.members.map((member, index) => index === 0 ? { ...member, model } : member) } }}
      available readJson={read} onChange={vi.fn()} />);
    const { rerender } = render(editor(FABLE));
    const first = within(screen.getByRole('group', { name: 'Agent 1' }));
    await waitFor(() => expect(first.getByLabelText('模型')).toHaveValue(FABLE));
    expect(first.getByRole('note')).toHaveTextContent(ZH);
    expect(first.getByRole('note')).toHaveClass('canvas-inspector-hint');
    // The other member follows the node's model, which is not one.
    expect(within(screen.getByRole('group', { name: 'Agent 2' })).queryByRole('note')).toBeNull();
    rerender(editor(OPUS));
    expect(note()).toBeNull();
  });
});

describe('the Agent market', () => {
  const t = (zh: string) => zh;
  const en = (_zh: string, text: string) => text;
  const catalogue: ModelPaletteSelection[] = [
    { key: 'fable', label: 'Claude Fable 5.2', displayName: 'Claude Fable 5.2', providerGroup: 'claude', runtime: 'openai-agents', model: FABLE, available: true, userChosen: true },
    { key: 'opus', label: 'Claude Opus 5.5', displayName: 'Claude Opus 5.5', providerGroup: 'claude', runtime: 'openai-agents', model: OPUS, available: true },
    { key: 'deepseek', label: 'DeepSeek V4.1 Flash', displayName: 'DeepSeek V4.1 Flash', providerGroup: 'deepseek', runtime: 'openai-agents', model: DEEPSEEK, available: true, userChosen: true },
  ];
  const model = (id: string, locked: boolean) => ({ runtime: 'openai-agents', id, effort: '', locked });

  it('ends the dialog’s note with the same sentence when the Agent’s locked model is a Claude Fable model', () => {
    const locked = marketModelDecision(model(FABLE, true), catalogue);
    expect(locked).toMatchObject({ kind: 'apply', model: FABLE, userChosen: true });
    expect(decisionNote(locked, true, t)).toBe(`作者锁定了模型「Claude Fable 5.2」，这个模型的请求由它的服务商处理；选用这个 Agent 就是选用这个模型。${ZH}`);
    expect(decisionNote(locked, true, en)).toBe(`Its author locked the model “Claude Fable 5.2”, whose requests its own provider handles; choosing this Agent chooses that model. ${EN}`);
    // With the workspace's models unread, the locked model goes to the node as the Agent names it: said then too.
    expect(decisionNote(marketModelDecision(model(FABLE, true), null), true, t)).toContain(ZH);
    // A suggestion is never put on a node, so the node does not run it and nothing is said of it.
    const suggested = marketModelDecision(model(FABLE, false), catalogue);
    expect(suggested).toMatchObject({ kind: 'keep', reason: 'user-chosen' });
    expect(decisionNote(suggested, false, t)).not.toContain('AWS');
    // Any other locked model, a DeepSeek one included, reads as it did.
    expect(decisionNote(marketModelDecision(model(OPUS, true), catalogue), true, t)).toBe('作者锁定了模型「Claude Opus 5.5」，节点会用这个模型运行。');
    expect(decisionNote(marketModelDecision(model(DEEPSEEK, true), catalogue), true, t))
      .toBe('作者锁定了模型「DeepSeek V4.1 Flash」，这个模型的请求由它的服务商处理；选用这个 Agent 就是选用这个模型。');
  });

  it('says what to do about a node that keeps an Agent without the model its author locked, never the model’s id', () => {
    // 409 market_agent_model_choice_required (an imported canvas, say): tests/saas-agent-market-document.test.ts holds the
    // market's other refusals to the same.
    const refusal = new SaaSApiError(409, 'market_agent_model_choice_required',
      "This Agent's author locked the model bedrock.claude-fable-5-2, which runs only where a person chose it: choose the Agent again on the node to see the model before it runs");
    expect(saasErrorMessage(refusal, 'zh')).toBe('这个 Agent 的作者锁定了一个只能由你自己选择的模型。请在节点上重新选一次这个 Agent，看清模型后再运行。');
    expect(saasErrorMessage(refusal, 'en')).toBe('This Agent’s author locked a model that runs only where you chose it. Choose the Agent again on the node to see the model before it runs.');
  });

  it('names the clause after it on the Agent’s page', () => {
    const detail = (id: string): MarketAgentDetail => ({ id: 'agent-1', name: 'Writer', tagline: 'Writes', category: 'writing', kind: 'llm', official: false, author: { name: 'Ada' },
      price: 0, version: 2, model: model(id, true), listedAt: '2026-11-10T00:00:00Z', description: '', examples: [], skills: [], instructionsPublic: false,
      stats: { calls: 2, users: 1, successRate: null, up: 0, down: 0, avgSeconds: null, avgModelCredits: null, score: null, ranked: false } });
    const page = (id: string, locale: 'zh' | 'en' = 'zh') => onSite(<LocaleProvider locale={locale}><MarketAgentDetailView detail={detail(id)} tenantId="team"
      target={{ kind: 'canvas' }} decision={marketModelDecision(model(id, true), catalogue)} planNeeded={false} busy={false} error={null} onUse={vi.fn()} /></LocaleProvider>);
    render(page(FABLE));
    const said = document.querySelector('.awwo-market-note')!;
    expect(said).toHaveTextContent(`选用这个 Agent 就是选用这个模型。${ZH}隐私政策第 08 条`);
    expect(within(said as HTMLElement).getByRole('link', { name: '隐私政策第 08 条' })).toHaveAttribute('href', CLAUSE);
    cleanup();
    render(page(FABLE, 'en'));
    expect(document.querySelector('.awwo-market-note')).toHaveTextContent(`choosing this Agent chooses that model. ${EN} Privacy policy, clause 08`);
    cleanup();
    render(page(DEEPSEEK));
    expect(document.querySelector('.awwo-market-note')).not.toHaveTextContent('AWS');
    expect(screen.queryByRole('link', { name: '隐私政策第 08 条' })).toBeNull();
  });

  it('says it to an author who suggests or locks a Claude Fable model for an Agent', () => {
    const field = (id: string) => onSite(<ModelField model={model(id, true)} models={catalogue} disabled={false} onChange={vi.fn()} />);
    const { rerender } = render(field(FABLE));
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue(JSON.stringify(['openai-agents', FABLE]));
    expect(note()).toHaveTextContent(ZH);
    expectClauseLink('隐私政策第 08 条');
    rerender(field(OPUS));
    expect(note()).toBeNull();
    rerender(field(''));
    expect(note()).toBeNull();
  });
});

describe('the canvas assistant’s default model in the settings', () => {
  const tenant: Tenant = { id: 'tenant-fable-note', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
  const identity = { user: { id: 'user-fable-note', name: 'Ada', email: 'ada@example.test', platformRole: 'user' },
    tenants: [tenant], authentication: 'local', personalCredentialsRequired: false } as unknown as Identity;
  const runtime = { ready: true, capabilities: { workspace: true, approvals: true }, models: [
    { id: FABLE, label: 'Claude Fable 5.2', runtime: 'openai-agents', userChosen: true }, { id: OPUS, label: 'Claude Opus 5.5', runtime: 'openai-agents' }] };
  function settings(model: string) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/preferences')
      ? Response.json({ preferences: { ...emptyAccountPreferences(), defaultModel: { runtime: 'openai-agents', model } }, version: 1 })
      : url.endsWith('/computer-runtime') ? Response.json(runtime) : Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 })));
    return render(onSite(<SaaSPreferencesProvider><AccountPreferencesProvider userId={identity.user.id}><GeneralSettings identity={identity} /></AccountPreferencesProvider></SaaSPreferencesProvider>));
  }

  it('says it under the default model while that is a Claude Fable model', async () => {
    settings(FABLE);
    const select = await screen.findByRole('combobox', { name: '默认模型' });
    await waitFor(() => expect(select).toHaveValue(JSON.stringify(['openai-agents', FABLE])));
    expect(note()).toHaveTextContent(ZH);
    expect(note()).toHaveClass('saas-field-hint');
    expectClauseLink('隐私政策第 08 条');
    cleanup();
    settings(OPUS);
    const other = await screen.findByRole('combobox', { name: '默认模型' });
    await waitFor(() => expect(other).toHaveValue(JSON.stringify(['openai-agents', OPUS])));
    expect(note()).toBeNull();
  });
});
