// 多人同屏's views (docs/awwo-canvas-live-collaboration.md, The canvas page), rendered from fixtures: the header's people
// bar, the 同屏 panel, 邀请 Agent, the layer on the board, the one-line summaries of changes, and the mode's words in both
// languages. Every id and token here is made up; the participants, claims and messages have the shapes the API sends
// them in (canvas_live.go, canvas_live_hub.go, canvas_live_claims.go).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/canvas/i18n';
import type { ModelNameSources } from '../src/canvas/modelNames';
import { SaaSApiError } from '../src/saas/api';
import type { AgentTokenItem, CanvasChange, CanvasOp, LiveClaim, LiveParticipant, LiveState } from '../src/canvas/multiplayer/types';
import { MultiplayerBar, awwoModelName, labelColorFor, participantStatus, participantTitle, safeColor } from '../src/canvas/multiplayer/MultiplayerBar';
import { MultiplayerPanel, type MultiplayerPanelProps, type PanelMessage } from '../src/canvas/multiplayer/MultiplayerPanel';
import { AgentInvite, connectionSnippets, mayRevokeToken, type AgentInviteProps } from '../src/canvas/multiplayer/AgentInvite';
import { MultiplayerBoardLayer, type MultiplayerBoardLayerProps } from '../src/canvas/multiplayer/MultiplayerBoardLayer';
import { activityItem, describeChange, type ActivityItem } from '../src/canvas/multiplayer/activity';
import { MULTIPLAYER_TEXT, failureDetail, mt, participantInitials, timeLeft, type MultiplayerTextKey } from '../src/canvas/multiplayer/multiplayerText';

const SINCE = '2026-11-06T10:00:00Z';
const NOW = Date.parse('2026-11-06T10:00:00Z');
const state = (over: Partial<LiveState> = {}): LiveState => ({ selection: [], focus: null, cursor: null, status: null, ...over });
// A page is named by its client id; the person on it by their account, which names their messages ('u_' + it).
const person = (id: string, name: string, color: string, userId: string, over: Partial<LiveParticipant> = {}): LiveParticipant =>
  ({ id, kind: 'human', port: 'web', name, color, userId, role: 'member', state: state(), since: SINCE, ...over });

const SELF = person('page-self-0001', 'Leon', '#2563eb', 'user-0001', { state: state({ selection: ['n3'], cursor: { x: 1, y: 1 } }) });
const ADA = person('page-ada-00001', 'Ada Lovelace', '#f59e0b', 'user-0002', { state: state({ selection: ['n1'], cursor: { x: 120, y: 80 } }) });
// An agent is named by its token ('t_' + the token's id); its userId is the person who made the token.
const CLAUDE: LiveParticipant = { id: 't_00000000000000aa', kind: 'agent', port: 'mcp', name: 'Claude Code', color: '#7c3aed', userId: 'user-0001',
  state: state({ focus: 'n2', status: '正在写后端接口' }), since: SINCE };
// AwwO's own Agent on a node it runs: named after the node, its run's status as its status, the node's model as the
// document holds it, its selector (canvas_live.go liveAwwoAgents), which names the service AwwO reaches the model through.
const RUNNER: LiveParticipant = { id: 'run_example0001', kind: 'awwo', port: 'awwo', name: '测试', color: '#10b981', model: 'bedrock.claude-opus-5-5',
  state: state({ selection: ['n3'], focus: 'n3', status: 'running' }), since: SINCE };

const TITLES: Record<string, string> = { n1: '后端接口', n2: '前端页面', n3: '测试' };
const nodeTitle = (id: string): string | undefined => TITLES[id];
// The workspace's chat models as the node's model picker has them (modelPalette.ts groupModels): a published name, and a
// label that carries the plan tag on a workspace whose free allowance leaves the model out; a name the selector does
// not spell (GPT-6.1 Sol).
const MODEL_NAMES: ModelNameSources = { models: [
  { key: '["openai-agents","bedrock.claude-opus-5-5"]', label: 'Claude Opus 5.5 · Pro', displayName: 'Claude Opus 5.5', providerGroup: 'claude',
    runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', available: true, requiresUpgrade: true },
  { key: '["openai-agents","bedrock.gpt-6-1-sol"]', label: 'GPT-6.1 Sol', displayName: 'GPT-6.1 Sol', providerGroup: 'codex',
    runtime: 'openai-agents', model: 'bedrock.gpt-6-1-sol', available: true },
] };

const TOKEN = 'awwo_ct_example_secret_for_tests';
const MCP_URL = 'https://awwo.example/api/v1/mcp';
const API_BASE = 'https://awwo.example/api/v1';

const tokenItem = (over: Partial<AgentTokenItem> = {}): AgentTokenItem => ({ id: 'tok-0001', name: 'Codex', prefix: 'awwo_ct_00000000000000aa', scope: 'edit',
  createdAt: '2026-11-01T10:00:00Z', expiresAt: '2026-12-01T10:00:00Z', lastUsedAt: null, revokedAt: null, createdBy: { id: 'user-0001', name: 'Leon' }, ...over });

function inviteProps(over: Partial<AgentInviteProps> = {}): AgentInviteProps {
  return { tokens: { items: [tokenItem()], loading: false, error: null }, onCreate: vi.fn(async () => ({ token: TOKEN, item: tokenItem({ id: 'tok-0002', name: 'Claude Code', prefix: 'awwo_ct_00000000000000bb' }) })),
    onRevoke: vi.fn(async () => undefined), mcpUrl: MCP_URL, apiBase: API_BASE, tenantId: 'tenant-one', canvasId: 'canvas-one', now: NOW, ...over };
}

// A person's claim names the page that took it; an agent's its token.
const CLAIMS: LiveClaim[] = [
  { nodeId: 'n2', participantId: CLAUDE.id, holderKind: 'agent', name: 'Claude Code', note: '写接口', expiresAt: '2026-11-06T10:02:05Z' },
  { nodeId: 'n1', participantId: SELF.id, holderKind: 'human', name: 'Leon', note: '', expiresAt: '2026-11-06T10:10:00Z' },
];
const MESSAGES: PanelMessage[] = [
  { id: 'msg-2', authorKind: 'agent', participantId: CLAUDE.id, name: 'Claude Code', color: CLAUDE.color, nodeId: 'n2', text: '我来写前端', createdAt: '2026-11-06T10:05:00Z' },
  { id: 'msg-1', authorKind: 'human', participantId: 'u_user-0002', name: 'Ada Lovelace', color: ADA.color, nodeId: '', text: '大家好', createdAt: '2026-11-06T10:01:00Z' },
  { id: 'msg-3', authorKind: 'human', participantId: 'u_user-0001', name: 'Leon', color: SELF.color, nodeId: '', text: '好的', createdAt: '2026-11-06T10:06:00Z' },
];
const ACTIVITY: ActivityItem[] = [
  { version: 7, text: 'Claude Code 添加了节点「前端页面」', nodeIds: ['n2'], at: '2026-11-06T10:03:00Z', color: CLAUDE.color },
  { version: 9, text: 'Ada Lovelace 移动了「后端接口」', nodeIds: ['n1'], at: '2026-11-06T10:04:00Z' },
];

function panelProps(over: Partial<MultiplayerPanelProps> = {}): MultiplayerPanelProps {
  return { open: true, onClose: vi.fn(), participants: [ADA, CLAUDE, SELF, RUNNER], selfId: SELF.id, claims: CLAIMS, messages: MESSAGES, activity: ACTIVITY,
    canWrite: true, canInvite: true, nodeTitle, onFocusNode: vi.fn(), onSend: vi.fn(async () => undefined), onRelease: vi.fn(async () => undefined),
    invite: inviteProps(), now: NOW, ...over };
}

const english = (element: ReactElement) => render(<LocaleProvider locale="en">{element}</LocaleProvider>);
const row = (container: HTMLElement, participantId: string) => container.querySelector<HTMLElement>(`li[data-participant="${participantId}"]`)!;
const nodeOf = (element: Element) => element.closest<HTMLElement>('[data-node]')!.dataset.node;

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('the words of 多人同屏', () => {
  it('has every key in both languages, with the same placeholders and nothing empty', () => {
    const zh = Object.keys(MULTIPLAYER_TEXT.zh).sort();
    const en = Object.keys(MULTIPLAYER_TEXT.en).sort();
    expect(zh).toEqual(en);
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const key of en as MultiplayerTextKey[]) {
      expect(MULTIPLAYER_TEXT.zh[key].trim(), key).not.toBe('');
      expect(MULTIPLAYER_TEXT.en[key].trim(), key).not.toBe('');
      expect(names(MULTIPLAYER_TEXT.zh[key]), key).toEqual(names(MULTIPLAYER_TEXT.en[key]));
    }
  });

  it('names the mode and its panel as the contract does, never with a bare 协作', () => {
    expect(mt('zh', 'mode.name')).toBe('多人同屏');
    expect(mt('en', 'mode.name')).toBe('Multiplayer');
    expect(mt('zh', 'panel.title')).toBe('同屏');
    expect(mt('en', 'panel.title')).toBe('Multiplayer');
    expect([mt('zh', 'port.web'), mt('en', 'port.web'), mt('zh', 'port.mcp'), mt('zh', 'port.api'), mt('zh', 'port.awwo')]).toEqual(['网页', 'Web', 'MCP', 'API', 'AwwO']);
    for (const text of Object.values(MULTIPLAYER_TEXT.zh)) expect(text).not.toContain('协作');
  });

  it('fills placeholders and leaves a missing one as written', () => {
    expect(mt('zh', 'bar.live', { count: 3 })).toBe('同屏 · 3 人在线');
    expect(mt('en', 'bar.live', { count: 3 })).toBe('Multiplayer · 3 here');
    expect(mt('en', 'bar.live')).toBe('Multiplayer · {count} here');
  });

  it('makes initials and the time a claim has left', () => {
    expect(participantInitials('Claude Code')).toBe('CC');
    expect(participantInitials('codex')).toBe('C');
    expect(participantInitials('张三')).toBe('张');
    expect(participantInitials('  ')).toBe('?');
    expect(timeLeft('zh', 125_000)).toBe('还剩 2 分 05 秒');
    expect(timeLeft('en', 45_000)).toBe('45 s left');
    expect(timeLeft('zh', 0)).toBe('即将到期');
  });

  it('reads a label colour that contrasts with a participant colour, 4.5:1 at least', () => {
    expect(labelColorFor('#ffffff')).toBe('#0b1220');
    expect(labelColorFor('#f59e0b')).toBe('#0b1220');
    expect(labelColorFor('#1e3a8a')).toBe('#ffffff');
    // A mid grey, where neither the dark ink nor white reaches 4.5:1.
    expect(labelColorFor('#797979')).toBe('#000000');
    const channel = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (hex: string) => 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) + 0.7152 * channel(parseInt(hex.slice(3, 5), 16)) + 0.0722 * channel(parseInt(hex.slice(5, 7), 16));
    for (let grey = 0; grey <= 255; grey += 5) {
      const fill = `#${grey.toString(16).padStart(2, '0').repeat(3)}`;
      const [a, b] = [lum(fill), lum(labelColorFor(fill))].sort((x, y) => y - x);
      expect((a + 0.05) / (b + 0.05), fill).toBeGreaterThanOrEqual(4.5);
    }
    expect(safeColor('red; background: url(x)')).toBe('#7c8c9c');
    expect(safeColor('#7C3AED')).toBe('#7c3aed');
  });

  it('says what went wrong in the reader’s language, keeping the service’s own words only for a code it does not know', () => {
    // The mode's own refusals.
    expect(failureDetail('zh', new SaaSApiError(409, 'agent_token_limit', 'A canvas has at most 10 live agent tokens; revoke one first')))
      .toBe('一张画布最多同时有 10 个有效的 Agent 令牌，请先撤销一个。');
    expect(failureDetail('en', new SaaSApiError(429, 'too_many_streams', 'Too many open streams on this canvas')))
      .toBe('Too many connections are open on this canvas. Try again shortly.');
    // The service's other codes, as the app says them.
    expect(failureDetail('zh', new SaaSApiError(403, 'forbidden', 'Only the token’s maker or a workspace admin may revoke it'))).toBe('你没有执行此操作的权限。');
    expect(failureDetail('en', new SaaSApiError(400, 'invalid_input', 'clientId and a text of 1 to 2000 characters are required'))).toBe('Check the entered values and try again.');
    // An answer that carried no refusal of the service's, and a request that never got an answer.
    expect(failureDetail('en', new SaaSApiError(502, 'request_failed', '请求失败（502）'))).toBe('The request did not go through (502). Try again.');
    expect(failureDetail('zh', new SaaSApiError(502, 'request_failed', '请求失败（502）'))).toBe('请求没有完成（502），请重试。');
    expect(failureDetail('zh', new TypeError('Failed to fetch'))).toBe('连不上 AwwO，请检查网络后重试。');
    // A code nobody knows keeps the service's words; an error that is no answer at all reads "try again".
    expect(failureDetail('en', new SaaSApiError(409, 'brand_new_code', 'Something new'))).toBe('Something new');
    expect(failureDetail('zh', new Error('internal detail'))).toBe('请重试');
    expect(failureDetail('en', 'Words of the caller’s own')).toBe('Words of the caller’s own');
  });
});

describe('the people bar', () => {
  it('puts this page first, marked as you, with each one’s devices (an Agent’s port) and status in its title', () => {
    const onOpen = vi.fn();
    const { container } = render(<MultiplayerBar participants={[ADA, CLAUDE, SELF]} selfId={SELF.id} status="live" onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: '同屏 · 3 人在线' });
    const avatars = [...container.querySelectorAll<HTMLElement>('.awwo-multiplayer-avatar')];
    expect(avatars.map(avatar => avatar.dataset.participant)).toEqual([SELF.id, ADA.id, CLAUDE.id]);
    expect(avatars[0]).toHaveAttribute('data-self', 'true');
    // A person by the devices their pages run in (a page that says none is a browser's); an Agent by its port.
    expect(avatars[0]).toHaveAttribute('title', 'Leon（你） · 浏览器');
    expect(avatars[0]).toHaveTextContent('L');
    expect(avatars[2]).toHaveAttribute('title', 'Claude Code · MCP · 正在写后端接口');
    expect(avatars[2]).toHaveTextContent('CC');
    // An Agent wears the Agent mark; a person does not.
    expect(avatars[2].querySelector('.awwo-multiplayer-agent-mark')).not.toBeNull();
    expect(avatars[1].querySelector('.awwo-multiplayer-agent-mark')).toBeNull();
    expect(avatars[1].style.getPropertyValue('--mp-color')).toBe('#f59e0b');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows five avatars and a +N for the rest', () => {
    const crowd = Array.from({ length: 7 }, (_, index) => person(`page-crowd-00${index}`, `Guest ${index}`, '#0ea5e9', `user-crowd-${index}`));
    const { container } = render(<MultiplayerBar participants={[...crowd, SELF]} selfId={SELF.id} status="live" onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: '同屏 · 8 人在线' })).toBeInTheDocument();
    const avatars = container.querySelectorAll<HTMLElement>('.awwo-multiplayer-avatar');
    expect(avatars).toHaveLength(5);
    expect(avatars[0].dataset.participant).toBe(SELF.id);
    const more = container.querySelector('.awwo-multiplayer-more')!;
    expect(more).toHaveTextContent('+3');
    expect(more).toHaveAttribute('title', '还有 3 位在线');
  });

  it('says what the connection is doing, in English too', () => {
    const { rerender } = english(<MultiplayerBar participants={[SELF, ADA, CLAUDE]} selfId={SELF.id} status="live" onOpen={() => {}} open={false} />);
    const button = screen.getByRole('button', { name: 'Multiplayer · 3 here' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button.querySelector('.awwo-multiplayer-avatar')).toHaveAttribute('title', 'Leon (you) · Browser');
    rerender(<LocaleProvider locale="en"><MultiplayerBar participants={[SELF]} selfId={SELF.id} status="connecting" onOpen={() => {}} /></LocaleProvider>);
    expect(screen.getByRole('button', { name: 'Multiplayer · connecting' })).toBeInTheDocument();
    rerender(<MultiplayerBar participants={[SELF]} selfId={SELF.id} status="offline" onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: '同屏 · 未连接' })).toBeInTheDocument();
  });

  it('says a running AwwO Agent’s run in words, with its model named as the canvas names it and a media model’s never', () => {
    // The server sends the run's status ('running', 'queued') as the participant's status: never shown as that word.
    // Without the workspace's names, the model goes by a name read from its selector, never by the selector.
    expect(participantTitle('zh', RUNNER, false)).toBe('测试 · AwwO · 运行中 · Claude Opus 5.5');
    expect(participantStatus('en', { ...RUNNER, state: state({ selection: ['n3'], focus: 'n3', status: 'queued' }) })).toBe('Queued · Claude Opus 5.5');
    // With them, by the name the node's model picker shows, never the label's plan tag.
    expect(participantStatus('zh', RUNNER, MODEL_NAMES)).toBe('运行中 · Claude Opus 5.5');
    // The catalogue's own name where the selector spells it otherwise.
    const gpt = { ...RUNNER, model: 'bedrock.gpt-6-1-sol' };
    expect(participantStatus('en', gpt, MODEL_NAMES)).toBe('Running · GPT-6.1 Sol');
    expect(participantStatus('en', gpt)).toBe('Running · GPT 6.1 Sol');
    // A media model's id names the service that makes it: nothing names it here.
    const media = { ...RUNNER, model: 'tripo.v3-turbo' };
    expect(participantStatus('zh', media)).toBe('运行中');
    expect(participantTitle('en', media, false)).toBe('测试 · AwwO · Running');
    expect(awwoModelName('zh', 'rh.seedance-pro')).toBe('');
    // A team connection's selector is no name; a node with no model has none.
    expect(awwoModelName('zh', 'byok_abcdef123456')).toBe('');
    expect(awwoModelName('en', undefined)).toBe('');
    // One on an untitled node is the AwwO Agent.
    expect(participantTitle('zh', { ...RUNNER, name: '' }, false)).toBe('AwwO Agent · AwwO · 运行中 · Claude Opus 5.5');
    // A person's status is theirs; none, no line.
    expect(participantStatus('zh', ADA)).toBe('');
    const { container, rerender } = render(<MultiplayerBar participants={[SELF, RUNNER]} selfId={SELF.id} status="live" onOpen={() => {}} modelNames={MODEL_NAMES} />);
    expect(container.querySelector(`.awwo-multiplayer-avatar[data-participant="${RUNNER.id}"]`)).toHaveAttribute('title', '测试 · AwwO · 运行中 · Claude Opus 5.5');
    rerender(<MultiplayerBar participants={[SELF, RUNNER]} selfId={SELF.id} status="live" onOpen={() => {}} />);
    expect(container.querySelector(`.awwo-multiplayer-avatar[data-participant="${RUNNER.id}"]`)).toHaveAttribute('title', '测试 · AwwO · 运行中 · Claude Opus 5.5');
    expect(container.innerHTML).not.toMatch(/bedrock/i);
  });

  it('counts this page while its stream is open, before the server lists it', () => {
    const { container } = render(<MultiplayerBar participants={[ADA, CLAUDE]} selfId={SELF.id} status="live" onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: '同屏 · 3 人在线' })).toBeInTheDocument();
    expect([...container.querySelectorAll<HTMLElement>('.awwo-multiplayer-avatar')].map(avatar => avatar.dataset.participant)).toEqual([ADA.id, CLAUDE.id]);
  });
});

describe('the 同屏 panel', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<MultiplayerPanel {...panelProps({ open: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists people, Agents and AwwO’s running Agents, with what each has selected or is on', () => {
    const props = panelProps();
    const { container } = render(<MultiplayerPanel {...props} />);
    const dialog = screen.getByRole('dialog', { name: '同屏' });
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: '同屏' }));
    expect(within(dialog).getByText('4 人在线')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: '人 · 2' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Agent · 1' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'AwwO 运行中的 Agent · 1' })).toBeInTheDocument();
    const people = [...container.querySelectorAll<HTMLElement>('.awwo-multiplayer-people li[data-participant]')].map(item => item.dataset.participant);
    expect(people).toEqual([SELF.id, ADA.id, CLAUDE.id, RUNNER.id]);
    expect(row(container, SELF.id)).toHaveTextContent('Leon（你）');

    const ada = row(container, ADA.id);
    expect(ada).toHaveTextContent('浏览器');
    expect(ada).toHaveTextContent('选中了');
    fireEvent.click(within(ada).getByRole('button', { name: '后端接口' }));
    expect(props.onFocusNode).toHaveBeenLastCalledWith('n1');

    const claude = row(container, CLAUDE.id);
    expect(claude).toHaveTextContent('MCP');
    expect(claude).toHaveTextContent('正在写后端接口');
    expect(claude).toHaveTextContent('正在处理');
    fireEvent.click(within(claude).getByRole('button', { name: '前端页面' }));
    expect(props.onFocusNode).toHaveBeenLastCalledWith('n2');

    const runner = row(container, RUNNER.id);
    expect(runner.querySelector('.awwo-multiplayer-person-status')).toHaveTextContent('运行中 · Claude Opus 5.5');
    expect(runner.textContent).not.toMatch(/running/);
    expect(runner.textContent).not.toMatch(/bedrock/i);
    expect(within(runner).getByRole('button', { name: '测试' })).toBeInTheDocument();
    // This page's own selection is the board's: its row names no node.
    expect(within(row(container, SELF.id)).queryByRole('button')).toBeNull();
  });

  it('names an AwwO Agent’s model by the workspace’s names when it is given them', () => {
    // A second run, on a model whose published name its selector spells otherwise: the catalogue's name is the one shown.
    const gpt: LiveParticipant = { ...RUNNER, id: 'run_example0002', name: '前端页面', model: 'bedrock.gpt-6-1-sol', state: state({ selection: ['n2'], focus: 'n2', status: 'running' }) };
    const { container, rerender } = render(<MultiplayerPanel {...panelProps({ participants: [ADA, CLAUDE, SELF, RUNNER, gpt], modelNames: MODEL_NAMES })} />);
    const status = (id: string) => row(container, id).querySelector('.awwo-multiplayer-person-status');
    expect(status(RUNNER.id)?.textContent).toBe('运行中 · Claude Opus 5.5');
    expect(status(gpt.id)?.textContent).toBe('运行中 · GPT-6.1 Sol');
    // Before the catalogue arrives: a name read from each selector.
    rerender(<MultiplayerPanel {...panelProps({ participants: [ADA, CLAUDE, SELF, RUNNER, gpt] })} />);
    expect(status(RUNNER.id)?.textContent).toBe('运行中 · Claude Opus 5.5');
    expect(status(gpt.id)?.textContent).toBe('运行中 · GPT 6.1 Sol');
    expect(container.innerHTML).not.toMatch(/bedrock/i);
  });

  it('lists the claims with their time left, and lets this page release only its own', async () => {
    const props = panelProps();
    const { container } = render(<MultiplayerPanel {...props} />);
    const claims = container.querySelector<HTMLElement>('.awwo-multiplayer-claims')!;
    expect(within(claims).getByRole('heading', { name: '已认领的节点 · 2' })).toBeInTheDocument();
    const rows = [...claims.querySelectorAll<HTMLElement>('li[data-node]')];
    // This page's own first.
    expect(rows.map(item => item.dataset.node)).toEqual(['n1', 'n2']);
    expect(rows[0]).toHaveTextContent('还剩 10 分 00 秒');
    expect(rows[1]).toHaveTextContent('还剩 2 分 05 秒');
    expect(rows[1]).toHaveTextContent('Claude Code');
    expect(rows[1]).toHaveTextContent('写接口');
    expect(within(rows[1]).getByRole('img', { name: 'Agent' })).toBeInTheDocument();
    // A person's claim has no Agent mark, and one holder of this page's own is “you”.
    expect(within(rows[0]).queryByRole('img', { name: 'Agent' })).toBeNull();
    expect(rows[0]).toHaveTextContent('Leon（你）');
    expect(within(claims).queryByRole('button', { name: '释放「前端页面」' })).toBeNull();
    // With one claim of its own, there is nothing to release all of.
    expect(within(claims).queryByRole('button', { name: '释放我认领的全部' })).toBeNull();
    fireEvent.click(within(claims).getByRole('button', { name: '释放「后端接口」' }));
    await waitFor(() => expect(props.onRelease).toHaveBeenCalledWith(['n1']));
    fireEvent.click(within(rows[1]).getByRole('button', { name: '前端页面' }));
    expect(props.onFocusNode).toHaveBeenLastCalledWith('n2');
  });

  it('releases every claim of this page’s own at once', async () => {
    let finish: () => void = () => {};
    const onRelease = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const mine: LiveClaim[] = [...CLAIMS, { nodeId: 'n3', participantId: SELF.id, holderKind: 'human', name: 'Leon', note: '', expiresAt: '2026-11-06T10:05:00Z' }];
    render(<MultiplayerPanel {...panelProps({ claims: mine, onRelease })} />);
    const all = screen.getByRole('button', { name: '释放我认领的全部' });
    fireEvent.click(all);
    // This page's own, the soonest to end first.
    expect(onRelease).toHaveBeenCalledWith(['n3', 'n1']);
    expect(all).toBeDisabled();
    expect(screen.getByRole('button', { name: '释放「测试」' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '释放「后端接口」' })).toHaveTextContent('正在释放…');
    await act(async () => { finish(); });
    expect(all).toBeEnabled();
  });

  it('drops a claim once it runs out, though the server sends nothing when one does', () => {
    const props = panelProps({ now: Date.parse('2026-11-06T10:02:05Z') });
    const { container, rerender } = render(<MultiplayerPanel {...props} />);
    const claims = container.querySelector<HTMLElement>('.awwo-multiplayer-claims')!;
    // Claude Code's claim ends this moment: it is not listed, counted, nor shown as ending.
    expect(within(claims).getByRole('heading', { name: '已认领的节点 · 1' })).toBeInTheDocument();
    expect([...claims.querySelectorAll<HTMLElement>('li[data-node]')].map(item => item.dataset.node)).toEqual(['n1']);
    expect(claims).not.toHaveTextContent('即将到期');
    rerender(<MultiplayerPanel {...props} now={Date.parse('2026-11-06T10:10:00Z')} />);
    expect(within(claims).getByRole('heading', { name: '已认领的节点 · 0' })).toBeInTheDocument();
    expect(within(claims).queryByRole('button', { name: '释放「后端接口」' })).toBeNull();
    expect(within(claims).getByText('还没有节点被认领。Agent 开始处理一个节点前会先认领它。')).toBeInTheDocument();
  });

  it('counts down and drops a claim by its own clock when it is given none', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const soon: LiveClaim = { ...CLAIMS[0], expiresAt: new Date(NOW + 2_000).toISOString() };
    const { container } = render(<MultiplayerPanel {...panelProps({ claims: [soon], now: undefined })} />);
    const claims = container.querySelector<HTMLElement>('.awwo-multiplayer-claims')!;
    expect(claims).toHaveTextContent('还剩 2 秒');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(claims).toHaveTextContent('还剩 1 秒');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(claims.querySelector('li[data-node]')).toBeNull();
    expect(within(claims).getByRole('heading', { name: '已认领的节点 · 0' })).toBeInTheDocument();
  });

  it('says why a release failed, in the reader’s language', async () => {
    const refusal = new SaaSApiError(403, 'forbidden', 'You may not release this claim');
    render(<MultiplayerPanel {...panelProps({ onRelease: vi.fn(async () => { throw refusal; }) })} />);
    fireEvent.click(screen.getByRole('button', { name: '释放「后端接口」' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('没能释放：你没有执行此操作的权限。');
  });

  it('shows the messages oldest first, each author in their colour, and this person’s own as theirs', () => {
    const props = panelProps();
    render(<MultiplayerPanel {...props} />);
    const log = screen.getByRole('log', { name: '留言' });
    // The log holds a list, whose items keep it as their parent.
    const items = within(within(log).getByRole('list')).getAllByRole('listitem');
    expect(items.map(item => item.querySelector('.awwo-multiplayer-message-text')?.textContent)).toEqual(['大家好', '我来写前端', '好的']);
    const who = (item: HTMLElement) => item.querySelector<HTMLElement>('.awwo-multiplayer-who')!;
    // A person's message is named by their account, which finds their page.
    expect(who(items[0])).toHaveTextContent('Ada Lovelace');
    expect(who(items[0])).toHaveAttribute('data-colored', 'true');
    expect(who(items[0]).style.getPropertyValue('--mp-color')).toBe(ADA.color);
    expect(items[0]).not.toHaveAttribute('data-own');
    // An agent's by its token.
    expect(who(items[1])).toHaveTextContent('Claude Code');
    expect(within(items[1]).getByRole('img', { name: 'Agent' })).toBeInTheDocument();
    expect(who(items[1]).style.getPropertyValue('--mp-color')).toBe(CLAUDE.color);
    fireEvent.click(within(items[1]).getByRole('button', { name: '前端页面' }));
    expect(props.onFocusNode).toHaveBeenLastCalledWith('n2');
    // This person's own, written from this page or another of theirs.
    expect(items[2]).toHaveAttribute('data-own', 'true');
    expect(who(items[2])).toHaveTextContent('Leon（你）');
    expect(who(items[2]).style.getPropertyValue('--mp-color')).toBe(SELF.color);
  });

  it('finds a person’s page by their account even for a message that brings no colour of its own', () => {
    const bare: PanelMessage[] = MESSAGES.map(({ color: _color, ...message }) => message);
    render(<MultiplayerPanel {...panelProps({ messages: bare })} />);
    const items = within(screen.getByRole('log', { name: '留言' })).getAllByRole('listitem');
    const who = (item: HTMLElement) => item.querySelector<HTMLElement>('.awwo-multiplayer-who')!;
    expect(who(items[0])).toHaveAttribute('data-colored', 'true');
    expect(who(items[0]).style.getPropertyValue('--mp-color')).toBe(ADA.color);
    expect(who(items[1]).style.getPropertyValue('--mp-color')).toBe(CLAUDE.color);
    expect(who(items[2]).style.getPropertyValue('--mp-color')).toBe(SELF.color);
    expect(items[2]).toHaveAttribute('data-own', 'true');
  });

  it('colours a message by its own colour once its author has left, and names a node it was about that is gone', () => {
    const gone: PanelMessage = { id: 'msg-0', authorKind: 'human', participantId: 'u_user-0009', name: 'Grace Hopper', color: '#30a46c', nodeId: 'n-gone',
      text: '旧消息', createdAt: '2026-11-06T09:59:00Z' };
    const { rerender } = render(<MultiplayerPanel {...panelProps({ messages: [gone] })} />);
    const item = within(screen.getByRole('log', { name: '留言' })).getByRole('listitem');
    const who = item.querySelector<HTMLElement>('.awwo-multiplayer-who')!;
    expect(who).toHaveTextContent('Grace Hopper');
    expect(who).toHaveAttribute('data-colored', 'true');
    expect(who.style.getPropertyValue('--mp-color')).toBe('#30a46c');
    expect(item).not.toHaveAttribute('data-own');
    // The node is named, not offered: the canvas no longer holds it.
    expect(within(item).queryByRole('button')).toBeNull();
    expect(within(item).getByText('已删除的节点')).toHaveClass('is-missing');
    // A colour that is not the server's reaches no style.
    rerender(<MultiplayerPanel {...panelProps({ messages: [{ ...gone, color: 'red; background: url(x)' }] })} />);
    const plain = screen.getByRole('log', { name: '留言' }).querySelector<HTMLElement>('.awwo-multiplayer-who')!;
    expect(plain).not.toHaveAttribute('data-colored');
    expect(plain.style.getPropertyValue('--mp-color')).toBe('#7c8c9c');
  });

  it('sends with Enter, about the selected node unless it is taken off, and keeps Shift+Enter for a new line', async () => {
    const props = panelProps({ messageNodeId: 'n1' });
    render(<MultiplayerPanel {...props} />);
    const box = screen.getByRole('textbox', { name: '给同屏的人和 Agent 留言' });
    expect(box).toHaveAttribute('maxLength', '2000');
    expect(screen.getByText('关于「后端接口」')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '第一行' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '  看一下后端  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect(vi.mocked(props.onSend).mock.calls[0]).toEqual(['看一下后端', 'n1']);
    await waitFor(() => expect(box).toHaveValue(''));

    fireEvent.click(screen.getByRole('button', { name: '不关联「后端接口」' }));
    expect(screen.queryByText('关于「后端接口」')).toBeNull();
    fireEvent.change(box, { target: { value: '没有节点' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(2));
    expect(vi.mocked(props.onSend).mock.calls[1]).toEqual(['没有节点']);
  });

  it('counts the characters once a message nears the longest the server takes', () => {
    render(<MultiplayerPanel {...panelProps()} />);
    const box = screen.getByRole('textbox', { name: '给同屏的人和 Agent 留言' });
    fireEvent.change(box, { target: { value: '字'.repeat(1800) } });
    expect(screen.queryByText('1800/2000')).toBeNull();
    fireEvent.change(box, { target: { value: '字'.repeat(1801) } });
    expect(screen.getByText('1801/2000')).toBeInTheDocument();
  });

  it('keeps the text and says why a message was refused, in either language', async () => {
    const refusal = new SaaSApiError(429, 'rate_limited', 'Too many requests');
    render(<MultiplayerPanel {...panelProps({ onSend: vi.fn(async () => { throw refusal; }) })} />);
    const box = screen.getByRole('textbox', { name: '给同屏的人和 Agent 留言' });
    fireEvent.change(box, { target: { value: '还在吗' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('没能发送：请求过于频繁，请稍后重试。');
    expect(box).toHaveValue('还在吗');
    cleanup();
    english(<MultiplayerPanel {...panelProps({ onSend: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) })} />);
    const englishBox = screen.getByRole('textbox', { name: 'Message everyone here' });
    fireEvent.change(englishBox, { target: { value: 'Still there?' } });
    fireEvent.keyDown(englishBox, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t send: AwwO could not be reached. Check your connection and try again.');
  });

  it('gives a reader no box to write in', () => {
    render(<MultiplayerPanel {...panelProps({ canWrite: false })} />);
    expect(screen.queryByRole('textbox', { name: '给同屏的人和 Agent 留言' })).toBeNull();
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    expect(screen.getByText('你是只读成员，可以看留言，不能发送。')).toBeInTheDocument();
  });

  it('lists the latest changes newest first, a click showing the node', () => {
    const props = panelProps();
    const { container } = render(<MultiplayerPanel {...props} />);
    const lines = [...container.querySelectorAll('.awwo-multiplayer-activity-line')].map(line => line.textContent);
    expect(lines).toEqual(['Ada Lovelace 移动了「后端接口」', 'Claude Code 添加了节点「前端页面」']);
    fireEvent.click(screen.getByRole('button', { name: 'Ada Lovelace 移动了「后端接口」' }));
    expect(props.onFocusNode).toHaveBeenLastCalledWith('n1');
  });

  it('closes on Escape and keeps its keys from the board', () => {
    const props = panelProps();
    const board = vi.fn();
    window.addEventListener('keydown', board);
    try {
      render(<MultiplayerPanel {...props} />);
      const dialog = screen.getByRole('dialog', { name: '同屏' });
      fireEvent.keyDown(within(dialog).getByRole('button', { name: '释放「后端接口」' }), { key: 'Backspace' });
      expect(board).not.toHaveBeenCalled();
      // An Escape that ends an input method's composition stays the input method's.
      const box = within(dialog).getByRole('textbox', { name: '给同屏的人和 Agent 留言' });
      fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
      expect(props.onClose).not.toHaveBeenCalled();
      // Escape in a box holding a draft leaves the box first.
      fireEvent.change(box, { target: { value: '草稿' } });
      fireEvent.keyDown(box, { key: 'Escape' });
      expect(props.onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: '同屏' }));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(props.onClose).toHaveBeenCalledTimes(1);
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭同屏' }));
      expect(props.onClose).toHaveBeenCalledTimes(2);
      expect(board).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', board);
    }
  });

  it('gives the focus back to what opened it as it closes, by Escape, by ✕ or from the people bar', () => {
    function Page() {
      const [open, setOpen] = useState(false);
      return <>
        <MultiplayerBar participants={[SELF, ADA]} selfId={SELF.id} status="live" open={open} onOpen={() => setOpen(was => !was)} />
        <button type="button">Elsewhere</button>
        <MultiplayerPanel {...panelProps({ open, onClose: () => setOpen(false) })} />
      </>;
    }
    render(<Page />);
    const bar = screen.getByRole('button', { name: '同屏 · 2 人在线' });
    const openPanel = () => { fireEvent.click(bar); return screen.getByRole('dialog', { name: '同屏' }); };
    bar.focus();
    let dialog = openPanel();
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: '同屏' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(bar);
    dialog = openPanel();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭同屏' }));
    expect(document.activeElement).toBe(bar);
    // Where a pressed button takes no focus (Safari), the people bar still gets it back.
    bar.blur();
    expect(document.activeElement).toBe(document.body);
    dialog = openPanel();
    fireEvent.keyDown(within(dialog).getByRole('heading', { name: '同屏' }), { key: 'Escape' });
    expect(document.activeElement).toBe(bar);
    // A focus the reader put somewhere else stays there.
    openPanel();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    fireEvent.click(bar);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('keeps a token just made through a stray Escape: only 「已保存，关闭」 lets it go', async () => {
    const props = panelProps({ invite: inviteProps({ defaultOpen: true }) });
    render(<MultiplayerPanel {...props} />);
    const dialog = screen.getByRole('dialog', { name: '同屏' });
    const create = within(dialog).getByRole('button', { name: '生成令牌' });
    create.focus();
    fireEvent.click(create);
    const secret = await within(dialog).findByRole('group', { name: '「Claude Code」的令牌' });
    // The secret takes the form's place, and the keyboard with it.
    expect(document.activeElement).toBe(secret);
    fireEvent.keyDown(within(dialog).getByRole('heading', { name: '同屏' }), { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
    const done = within(secret).getByRole('button', { name: '已保存，关闭' });
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(done, { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toContain(TOKEN);
    fireEvent.click(done);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    // The form comes back with the focus on its button; Escape closes the panel again.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '生成令牌' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('offers 邀请 Agent only to those who may invite', () => {
    const { rerender } = render(<MultiplayerPanel {...panelProps()} />);
    expect(screen.getByRole('button', { name: '邀请 Agent' })).toBeInTheDocument();
    rerender(<MultiplayerPanel {...panelProps({ canInvite: false })} />);
    expect(screen.queryByRole('button', { name: '邀请 Agent' })).toBeNull();
  });

  it('offers Revoke on the tokens this person made, and on every one to an admin', () => {
    const theirs = tokenItem({ id: 'tok-0005', name: 'Ada bot', prefix: 'awwo_ct_00000000000000cc', createdBy: { id: 'user-0002', name: 'Ada Lovelace' } });
    const invite = inviteProps({ defaultOpen: true, tokens: { items: [tokenItem(), theirs], loading: false, error: null } });
    const { rerender } = render(<MultiplayerPanel {...panelProps({ invite })} />);
    expect(screen.getByRole('button', { name: '撤销令牌「Codex」' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤销令牌「Ada bot」' })).toBeNull();
    // Listed all the same, by its prefix.
    expect(document.querySelector('li[data-token="tok-0005"]')).toHaveTextContent('awwo_ct_00000000000000cc');
    const admin: LiveParticipant = { ...SELF, role: 'admin' };
    rerender(<MultiplayerPanel {...panelProps({ invite, participants: [ADA, CLAUDE, admin, RUNNER] })} />);
    expect(screen.getByRole('button', { name: '撤销令牌「Ada bot」' })).toBeInTheDocument();
  });

  it('says when only you are here, but not while the stream is down', () => {
    const alone = panelProps({ participants: [SELF], claims: [], messages: [], activity: [] });
    const { rerender } = render(<MultiplayerPanel {...alone} />);
    expect(screen.getByText('现在只有你在这张画布上。可以在下面邀请一个 Agent 一起改。')).toBeInTheDocument();
    expect(screen.getByText('还没有节点被认领。Agent 开始处理一个节点前会先认领它。')).toBeInTheDocument();
    expect(screen.getByText('还没有留言。')).toBeInTheDocument();
    expect(screen.getByText('还没有改动。')).toBeInTheDocument();
    rerender(<MultiplayerPanel {...alone} status="offline" />);
    expect(screen.queryByText('现在只有你在这张画布上。可以在下面邀请一个 Agent 一起改。')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('未连接');
  });

  it('renders in English', () => {
    const { container } = english(<MultiplayerPanel {...panelProps({ status: 'offline' })} />);
    const dialog = screen.getByRole('dialog', { name: 'Multiplayer' });
    expect(within(dialog).getByRole('button', { name: 'Close Multiplayer' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'People · 2' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Claimed nodes · 2' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Message everyone here' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Release “后端接口”' })).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Not connected');
    expect(within(dialog).getByText('2 min 05 s left')).toBeInTheDocument();
    expect(row(container, RUNNER.id).querySelector('.awwo-multiplayer-person-status')).toHaveTextContent('Running · Claude Opus 5.5');
    expect(within(screen.getByRole('log', { name: 'Messages' })).getByText('Leon (you)')).toBeInTheDocument();
  });
});

describe('邀请 Agent', () => {
  const clipboard = (writeText: (text: string) => Promise<void>) => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  afterEach(() => { Reflect.deleteProperty(navigator, 'clipboard'); Reflect.deleteProperty(document, 'execCommand'); });

  it('shows the token only once it is made, with lines that connect each agent', async () => {
    const props = inviteProps();
    const writeText = vi.fn(async () => undefined);
    clipboard(writeText);
    render(<AgentInvite {...props} />);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    fireEvent.click(screen.getByRole('button', { name: '邀请 Agent' }));
    expect(screen.getByLabelText('Agent 名称')).toHaveValue('Claude Code');
    expect(screen.getByLabelText('有效期')).toHaveValue('30');
    expect(screen.getByRole('radio', { name: '编辑' })).toBeChecked();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    fireEvent.click(screen.getByRole('button', { name: '生成令牌' }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith('Claude Code', 30, 'edit'));
    const secret = await screen.findByRole('group', { name: '「Claude Code」的令牌' });
    const blocks = [...secret.querySelectorAll('pre')].map(block => block.textContent ?? '');
    expect(blocks[0]).toBe(TOKEN);
    expect(blocks).toHaveLength(8);
    expect(blocks[1]).toBe(`claude mcp add --transport http awwo-canvas ${MCP_URL} --header "Authorization: Bearer ${TOKEN}"`);
    expect(blocks[2]).toBe(`[mcp_servers.awwo_canvas]\nurl = "${MCP_URL}"\nbearer_token_env_var = "AWWO_CANVAS_TOKEN"`);
    expect(blocks[3]).toBe(`export AWWO_CANVAS_TOKEN="${TOKEN}"`);
    // Unattended, a CLI can answer no prompt: its own run allows the canvas's tools, never its config file.
    expect(blocks[4]).toBe('claude -p "<task>" --allowedTools mcp__awwo-canvas');
    expect(blocks[5]).toBe(`codex exec --skip-git-repo-check -c 'mcp_servers.awwo_canvas.default_tools_approval_mode="approve"' "<task>"`);
    const labels = [...secret.querySelectorAll('.awwo-multiplayer-copy-label')].map(label => label.textContent);
    expect(labels.slice(4, 6)).toEqual(['Claude Code · 无人值守（claude -p）', 'Codex · 无人值守（codex exec）']);
    // What the two unattended lines allow, right under them: an edit token's runs may change and delete.
    const unattended = within(secret).getByText('把 <task> 换成要 Agent 做的事；claude -p 要在运行过 claude mcp add 的文件夹里启动。这两条无人值守命令不经询问就使用这张画布的全部工具，包括删除节点，也会照画布上别人写的内容去做，所以请在没有私密文件的文件夹里运行。交互使用时，Claude Code 用画布工具前仍会先问你，Codex 则在可能弄丢别人工作的工具前问你（改动或删除节点、拆掉连线、原始操作）。随时可以在下面撤销令牌。');
    expect(unattended.previousElementSibling?.querySelector('pre')?.textContent).toBe(blocks[5]);
    expect(JSON.parse(blocks[6])).toEqual({ mcpServers: { 'awwo-canvas': { url: MCP_URL, headers: { Authorization: `Bearer ${TOKEN}` } } } });
    expect(blocks[7]).toBe(`curl -H "Authorization: Bearer ${TOKEN}" "${API_BASE}/tenants/tenant-one/canvases/canvas-one/changes?after=0"`);
    // The secret is in the shown lines only: never a title or a label.
    for (const element of document.body.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) expect(element.getAttribute(attribute) ?? '').not.toContain(TOKEN);
    }
    fireEvent.click(within(secret).getByRole('button', { name: '复制：Claude Code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(blocks[1]));
    expect(await within(secret).findAllByText('已复制')).not.toHaveLength(0);
    // The new token is listed by its prefix alone.
    const listed = document.querySelector('li[data-token="tok-0002"]')!;
    expect(listed).toHaveTextContent('awwo_ct_00000000000000bb');
    fireEvent.click(screen.getByRole('button', { name: '已保存，关闭' }));
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(screen.getByRole('button', { name: '生成令牌' })).toBeInTheDocument();
  });

  it('copies by the browser’s own command where the clipboard refuses or is missing, and says when that fails too', async () => {
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    clipboard(vi.fn(async () => { throw new Error('denied'); }));
    render(<AgentInvite {...inviteProps({ defaultOpen: true })} />);
    fireEvent.click(screen.getByRole('button', { name: '生成令牌' }));
    const secret = await screen.findByRole('group', { name: '「Claude Code」的令牌' });
    fireEvent.click(within(secret).getByRole('button', { name: '复制：令牌' }));
    expect(await within(secret).findByRole('alert')).toHaveTextContent('没能复制，请手动选中后复制。');
    expect(execCommand).toHaveBeenCalledWith('copy');
    // The shown text stays selected, for a copy by hand.
    expect(window.getSelection()?.toString()).toBe(TOKEN);
    // Without a clipboard at all, the browser's command copies it.
    Reflect.deleteProperty(navigator, 'clipboard');
    execCommand.mockReturnValue(true);
    fireEvent.click(within(secret).getByRole('button', { name: '复制：Claude Code' }));
    await waitFor(() => expect(execCommand).toHaveBeenCalledTimes(2));
    expect(await within(secret).findAllByText('已复制')).not.toHaveLength(0);
  });

  it('forgets a token just made when the section closes', async () => {
    render(<AgentInvite {...inviteProps()} />);
    const toggle = screen.getByRole('button', { name: '邀请 Agent' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: '生成令牌' }));
    await screen.findByRole('group', { name: '「Claude Code」的令牌' });
    expect(document.body.innerHTML).toContain(TOKEN);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    fireEvent.click(toggle);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(screen.queryByRole('group', { name: '「Claude Code」的令牌' })).toBeNull();
  });

  it('tells its holder the secret’s 「已保存，关闭」 while one is on screen', async () => {
    const onSecretShown = vi.fn();
    render(<AgentInvite {...inviteProps({ defaultOpen: true, onSecretShown })} />);
    expect(onSecretShown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '生成令牌' }));
    const secret = await screen.findByRole('group', { name: '「Claude Code」的令牌' });
    const done = within(secret).getByRole('button', { name: '已保存，关闭' });
    expect(onSecretShown).toHaveBeenLastCalledWith(done);
    fireEvent.click(done);
    expect(onSecretShown).toHaveBeenLastCalledWith(null);
  });

  it('makes a token with the chosen name, expiry and access, and says why one was refused', async () => {
    const onCreate = vi.fn(async () => { throw new SaaSApiError(409, 'agent_token_limit', 'A canvas has at most 10 live agent tokens; revoke one first'); });
    const onOpen = vi.fn();
    render(<AgentInvite {...inviteProps({ onCreate, onOpen })} />);
    fireEvent.click(screen.getByRole('button', { name: '邀请 Agent' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Agent 名称'), { target: { value: '  Cursor  ' } });
    fireEvent.change(screen.getByLabelText('有效期'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('radio', { name: '只读' }));
    expect(screen.getByText('只看画布、也被大家看到，不做任何改动。')).toBeInTheDocument();
    expect([...screen.getByLabelText('有效期').querySelectorAll('option')].map(option => option.textContent)).toEqual(['1 天', '7 天', '30 天', '90 天']);
    fireEvent.click(screen.getByRole('button', { name: '生成令牌' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Cursor', 7, 'read'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('没能生成令牌：一张画布最多同时有 10 个有效的 Agent 令牌，请先撤销一个。');
    expect(alert).not.toHaveTextContent('revoke one first');
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('lists the canvas’s tokens and revokes one only once confirmed', async () => {
    const onRevoke = vi.fn(async () => undefined);
    const items = [tokenItem({ lastUsedAt: '2026-11-05T09:00:00Z' }), tokenItem({ id: 'tok-0003', name: 'Old bot', scope: 'read', revokedAt: '2026-11-02T10:00:00Z' }),
      tokenItem({ id: 'tok-0004', name: 'Expired bot', expiresAt: '2026-11-03T10:00:00Z' })];
    render(<AgentInvite {...inviteProps({ tokens: { items, loading: false, error: null }, onRevoke, defaultOpen: true })} />);
    const live = document.querySelector<HTMLElement>('li[data-token="tok-0001"]')!;
    expect(live).toHaveTextContent('Codex');
    expect(live).toHaveTextContent('awwo_ct_00000000000000aa');
    expect(live).toHaveTextContent('编辑');
    expect(live).toHaveTextContent('Leon 创建');
    expect(live).toHaveTextContent('上次使用');
    expect(document.querySelector('li[data-token="tok-0003"]')).toHaveAttribute('data-state', 'revoked');
    expect(document.querySelector('li[data-token="tok-0003"]')).toHaveTextContent('已撤销');
    expect(document.querySelector('li[data-token="tok-0004"]')).toHaveAttribute('data-state', 'expired');
    expect(screen.queryByRole('button', { name: '撤销令牌「Old bot」' })).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销令牌「Expired bot」' })).toBeNull();

    const revoke = screen.getByRole('button', { name: '撤销令牌「Codex」' });
    fireEvent.click(revoke);
    expect(revoke).toHaveAttribute('aria-expanded', 'true');
    let confirm = screen.getByRole('group', { name: '撤销令牌「Codex」' });
    expect(confirm).toHaveTextContent('撤销「Codex」？正在用它的 Agent 会立刻断开，令牌从此失效。');
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: '取消' }));
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(onRevoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: '撤销令牌「Codex」' })).toBeNull();
    expect(document.activeElement).toBe(revoke);
    fireEvent.click(revoke);
    confirm = screen.getByRole('group', { name: '撤销令牌「Codex」' });
    fireEvent.click(within(confirm).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith('tok-0001'));
    await waitFor(() => expect(screen.queryByRole('group', { name: '撤销令牌「Codex」' })).toBeNull());
    expect(document.activeElement).toBe(document.querySelector('li[data-token="tok-0001"]'));
  });

  it('offers Revoke only where its reader may, as the server judges it', () => {
    const others = tokenItem({ id: 'tok-0005', name: 'Ada bot', createdBy: { id: 'user-0002', name: 'Ada Lovelace' } });
    const mine = tokenItem();
    expect(mayRevokeToken(others, undefined)).toBe(true);
    expect(mayRevokeToken(mine, { userId: 'user-0001', role: 'member' })).toBe(true);
    expect(mayRevokeToken(others, { userId: 'user-0001', role: 'member' })).toBe(false);
    expect(mayRevokeToken(others, { userId: 'user-0001', role: 'admin' })).toBe(true);
    expect(mayRevokeToken(others, { userId: 'user-0001', role: 'owner' })).toBe(true);
    render(<AgentInvite {...inviteProps({ defaultOpen: true, tokens: { items: [mine, others], loading: false, error: null }, viewer: { userId: 'user-0001', role: 'member' } })} />);
    expect(screen.getByRole('button', { name: '撤销令牌「Codex」' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤销令牌「Ada bot」' })).toBeNull();
  });

  it('keeps the confirmation and says why a revoke was refused', async () => {
    const onRevoke = vi.fn(async () => { throw new SaaSApiError(403, 'forbidden', 'Only the token’s maker or a workspace admin may revoke it'); });
    render(<AgentInvite {...inviteProps({ onRevoke, defaultOpen: true })} />);
    fireEvent.click(screen.getByRole('button', { name: '撤销令牌「Codex」' }));
    fireEvent.click(within(screen.getByRole('group', { name: '撤销令牌「Codex」' })).getByRole('button', { name: '撤销' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('没能撤销：你没有执行此操作的权限。');
    expect(alert).not.toHaveTextContent('workspace admin');
    expect(screen.getByRole('group', { name: '撤销令牌「Codex」' })).toBeInTheDocument();
  });

  it('lists a token just made until the caller does, and never brings back one the caller dropped', async () => {
    const made = tokenItem({ id: 'tok-0002', name: 'Claude Code', prefix: 'awwo_ct_00000000000000bb' });
    const props = inviteProps({ tokens: { items: [], loading: false, error: null }, defaultOpen: true });
    const { rerender } = render(<AgentInvite {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '生成令牌' }));
    await screen.findByRole('group', { name: '「Claude Code」的令牌' });
    expect(document.querySelectorAll('li[data-token="tok-0002"]')).toHaveLength(1);
    rerender(<AgentInvite {...props} tokens={{ items: [made], loading: false, error: null }} />);
    expect(document.querySelectorAll('li[data-token="tok-0002"]')).toHaveLength(1);
    rerender(<AgentInvite {...props} tokens={{ items: [], loading: false, error: null }} />);
    expect(document.querySelector('li[data-token="tok-0002"]')).toBeNull();
  });

  it('says when the list is loading or could not be read, in the reader’s language', () => {
    const list = (error: unknown) => ({ items: [], loading: false, error });
    const { rerender } = render(<AgentInvite {...inviteProps({ tokens: { items: [], loading: true, error: null }, defaultOpen: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取令牌…');
    rerender(<AgentInvite {...inviteProps({ tokens: list(new SaaSApiError(429, 'rate_limited', 'Too many requests')), defaultOpen: true })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('没能读取令牌：请求过于频繁，请稍后重试。');
    rerender(<AgentInvite {...inviteProps({ tokens: list(new TypeError('Failed to fetch')), defaultOpen: true })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('没能读取令牌：连不上 AwwO，请检查网络后重试。');
    // A caller's own words are shown as they are.
    rerender(<AgentInvite {...inviteProps({ tokens: list('离线'), defaultOpen: true })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('没能读取令牌：离线');
  });

  it('renders in English', async () => {
    const onCreate = vi.fn(async () => { throw new SaaSApiError(409, 'agent_token_limit', 'A canvas has at most 10 live agent tokens; revoke one first'); });
    english(<AgentInvite {...inviteProps({ defaultOpen: true, onCreate })} />);
    expect(screen.getByRole('button', { name: 'Invite an Agent' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Agent name')).toHaveValue('Claude Code');
    expect(screen.getByRole('radio', { name: 'Edit' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Revoke the token “Codex”' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create a token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t create the token: A canvas holds at most 10 live Agent tokens. Revoke one first.');
  });

  it('shows the unattended lines and what they allow, in English', async () => {
    english(<AgentInvite {...inviteProps({ defaultOpen: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a token' }));
    const secret = await screen.findByRole('group', { name: 'Token for “Claude Code”' });
    expect(within(secret).getByText('Claude Code · unattended (claude -p)')).toBeInTheDocument();
    expect(within(secret).getByText('Codex · unattended (codex exec)')).toBeInTheDocument();
    const hint = within(secret).getByText('Put what the Agent should do in place of <task>, and start claude -p in the folder where you ran claude mcp add. These two unattended runs use all of this canvas’s tools without asking, deleting nodes included, and act on what others write on the canvas, so run them in a folder with nothing private. Used interactively, Claude Code still asks before using a canvas tool, and Codex before the ones that can lose someone’s work (changing or deleting a node, removing a wire, raw ops). You can revoke the token below at any time.');
    expect(hint.previousElementSibling?.querySelector('pre')?.textContent).toBe(`codex exec --skip-git-repo-check -c 'mcp_servers.awwo_canvas.default_tools_approval_mode="approve"' "<task>"`);
  });

  it('tells a read-only token’s maker that its unattended runs can only look', async () => {
    const onCreate = vi.fn(async () => ({ token: TOKEN, item: tokenItem({ id: 'tok-0002', name: 'Watcher', scope: 'read' as const }) }));
    const { unmount } = render(<AgentInvite {...inviteProps({ defaultOpen: true, onCreate })} />);
    fireEvent.change(screen.getByLabelText('Agent 名称'), { target: { value: 'Watcher' } });
    fireEvent.click(screen.getByRole('radio', { name: '只读' }));
    fireEvent.click(screen.getByRole('button', { name: '生成令牌' }));
    const secret = await screen.findByRole('group', { name: '「Watcher」的令牌' });
    expect(within(secret).getByText('把 <task> 换成要 Agent 做的事；claude -p 要在运行过 claude mcp add 的文件夹里启动。这两条无人值守命令不经询问就使用这张画布的工具；这个令牌只读，它们只能看，改不了任何东西。随时可以在下面撤销令牌。')).toBeInTheDocument();
    expect(secret).not.toHaveTextContent('包括删除节点');
    unmount();
    english(<AgentInvite {...inviteProps({ defaultOpen: true, onCreate })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a token' }));
    const english_ = await screen.findByRole('group', { name: 'Token for “Watcher”' });
    expect(within(english_).getByText('Put what the Agent should do in place of <task>, and start claude -p in the folder where you ran claude mcp add. These two unattended runs use this canvas’s tools without asking; the token is read only, so they can look but change nothing. You can revoke the token below at any time.')).toBeInTheDocument();
  });

  it('builds the connection lines from the API’s own base and ids', () => {
    const lines = connectionSnippets({ token: TOKEN, mcpUrl: MCP_URL, apiBase: `${API_BASE}/`, tenantId: 'tenant one', canvasId: 'canvas/1' });
    expect(lines.http).toBe(`curl -H "Authorization: Bearer ${TOKEN}" "${API_BASE}/tenants/tenant%20one/canvases/canvas%2F1/changes?after=0"`);
    expect(lines.claude).toContain(MCP_URL);
    expect(lines.codex).toContain(`url = "${MCP_URL}"`);
    // One table, each line a TOML key with a basic string: what Codex 0.162's --strict-config took.
    const [table, ...keys] = lines.codex.split('\n');
    expect(table).toBe('[mcp_servers.awwo_canvas]');
    expect(Object.fromEntries(keys.map(line => { const [key, value] = line.split(' = '); return [key, JSON.parse(value)]; })))
      .toEqual({ url: MCP_URL, bearer_token_env_var: 'AWWO_CANVAS_TOKEN' });
    // The approval rides on the unattended run alone, never into config.toml: an interactive Codex still asks, and a
    // table pasted before stays as it is (a second [mcp_servers.awwo_canvas] would break the whole file).
    expect(lines.codex).not.toContain('approval');
    // The lines' words, for these lines' whole-word quoting (no word mixes quoted and bare parts).
    const words = (line: string) => [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
    expect(words(lines.codexUnattended)).toEqual(['codex', 'exec', '--skip-git-repo-check', '-c', 'mcp_servers.awwo_canvas.default_tools_approval_mode="approve"', '<task>']);
    // The task before --allowedTools: it takes a list, which would swallow a task after it.
    expect(words(lines.claudeUnattended)).toEqual(['claude', '-p', '<task>', '--allowedTools', 'mcp__awwo-canvas']);
    for (const line of [lines.codex, lines.claudeUnattended, lines.codexUnattended]) expect(line).not.toContain(TOKEN);
  });

  it('offers treg’s lines, which name no key, in a disclosure of their own that stays closed until asked', async () => {
    const writeText = vi.fn(async () => undefined);
    clipboard(writeText);
    render(<AgentInvite {...inviteProps({ defaultOpen: true })} />);
    const toggle = screen.getByRole('button', { name: '加上 treg：让 Agent 查实时数据' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.body).not.toHaveTextContent('treg.to/mcp');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '')!;
    expect(body).not.toBeNull();
    const blocks = () => [...body.querySelectorAll('pre')].map(block => block.textContent ?? '');
    expect(blocks()).toEqual([
      'claude mcp add --transport http treg https://treg.to/mcp/',
      'codex mcp add treg --url https://treg.to/mcp/',
      // The entry to add inside .cursor/mcp.json's mcpServers, beside awwo-canvas: never a whole file that would replace it.
      '"treg": { "url": "https://treg.to/mcp/" }',
      '用 treg 查「<主题>」的最新资料，每条事实附上来源链接，再用 AwwO 画布工具写进「<节点>」。',
    ]);
    // No line names a key: treg's own sign-in asks the person, in their browser, which of their teams pays.
    for (const line of blocks()) expect(line).not.toMatch(/token|bearer|authorization|header|x-treg|--oauth-client/i);
    expect(within(body).getByText('treg 按次计费，记在你自己的 treg 团队账户上，调用前会先给出价格。AwwO 不收这笔钱，也不经手、不保存你的 treg 登录。发给 treg 的内容会离开 AwwO。')).toBeInTheDocument();
    expect([...body.querySelectorAll('ol > li')].map(item => item.textContent)).toEqual([
      '先在 treg.to 注册并建一个团队：调用的费用由这个团队付。',
      '用下面的一行命令把 treg 加进同一个 Agent，按提示登录。',
      '让 Agent 用 treg 查资料，再用画布工具把结果写进节点。',
    ]);
    const link = within(body).getByRole('link', { name: '在新标签页打开 treg.to（第三方网站）' });
    expect(link).toHaveAttribute('href', 'https://treg.to/');
    expect(link).toHaveAttribute('target', '_blank');
    expect((link.getAttribute('rel') ?? '').split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    fireEvent.click(within(body).getByRole('button', { name: '复制：Codex · 会马上打开浏览器登录（以后可用 codex mcp login treg）' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('codex mcp add treg --url https://treg.to/mcp/'));
    // A token made meanwhile never reaches treg's lines, and treg's disclosure stays as it was: the same nodes, still on
    // the page (a remount would leave these references detached and every check below passing vacuously).
    fireEvent.click(screen.getByRole('button', { name: '生成令牌' }));
    await screen.findByRole('group', { name: '「Claude Code」的令牌' });
    expect(toggle.isConnected && body.isConnected).toBe(true);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const line of blocks()) expect(line).not.toContain(TOKEN);
    fireEvent.click(toggle);
    expect(document.body).not.toHaveTextContent('treg.to/mcp');
  });

  it('says what treg is and who pays for it, in English', () => {
    english(<AgentInvite {...inviteProps({ defaultOpen: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add treg: live data for your Agent' }));
    expect(screen.getByText('treg charges per call, to your own treg team, and shows the price before a call. AwwO takes no part of that money and never sees or keeps your treg sign-in. What you send to treg leaves AwwO.')).toBeInTheDocument();
    expect(screen.getByText('Claude Code · then /mcp, pick treg and sign in')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open treg.to (a third-party site) in a new tab' })).toHaveAttribute('href', 'https://treg.to/');
    // No Chinese in the English section (which must be there for this to mean anything).
    const section = document.querySelector('.awwo-multiplayer-treg');
    expect(section).not.toBeNull();
    expect(section!.textContent).not.toMatch(/[㐀-鿿]/);
  });

  it('offers You.com’s lines, the free ones first, in a disclosure of their own that stays closed until asked', async () => {
    const writeText = vi.fn(async () => undefined);
    clipboard(writeText);
    render(<AgentInvite {...inviteProps({ defaultOpen: true })} />);
    const toggle = screen.getByRole('button', { name: '加上 You.com：让 Agent 联网搜索' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.body).not.toHaveTextContent('api.you.com');
    // Opening one tool's panel leaves the other's as it was.
    const tregToggle = screen.getByRole('button', { name: '加上 treg：让 Agent 查实时数据' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(tregToggle).toHaveAttribute('aria-expanded', 'false');
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '')!;
    expect(body).not.toBeNull();
    const blocks = () => [...body.querySelectorAll('pre')].map(block => block.textContent ?? '');
    expect(blocks()).toEqual([
      // Quoted: zsh would read a bare ? as a glob and refuse the line.
      'claude mcp add --transport http you-free "https://api.you.com/mcp?profile=free"',
      '"you-free": { "url": "https://api.you.com/mcp?profile=free" }',
      'claude mcp add --transport http you https://api.you.com/mcp',
      'codex mcp add you --url https://api.you.com/mcp',
      '用 You.com 查「<主题>」的最新资料，每条事实附上来源链接，再用 AwwO 画布工具写进「<节点>」。',
    ]);
    // No line names a key: the free profile needs none, and You.com's own sign-in handles the full server.
    for (const line of blocks()) expect(line).not.toMatch(/token|bearer|authorization|header|x-api-key|ydc/i);
    expect(within(body).getByText('免注册的几行不用账户：每天 100 次搜索，只能搜索（不能读全文）。')).toBeInTheDocument();
    expect(within(body).getByText('完整版要登录你自己的 You.com 账户，每次调用都记在这个账户上。AwwO 不收这笔钱，也不经手、不保存你的 You.com 登录。发给 You.com 的内容会离开 AwwO。')).toBeInTheDocument();
    // The full line's calls cost money and Codex may make them unasked (You.com marks its tools read-only).
    expect(within(body).getByText(/Codex 可能不问你就调用.*先在 You\.com 设好花费上限/)).toBeInTheDocument();
    // Each step names the Agents it is for: Codex has no free line, Cursor no full one.
    expect([...body.querySelectorAll('ol > li')].map(item => item.textContent)).toEqual([
      'Claude Code 或 Cursor：把下面对应的免注册一行加进同一个 Agent，不用账户，马上能用。',
      '要读全文，或者用的是 Codex（它连免费版也要登录），改用完整版那一行，按提示登录 You.com。',
      '让 Agent 用 You.com 查资料，再用画布工具把结果写进节点。',
    ]);
    const link = within(body).getByRole('link', { name: '在新标签页打开 you.com（第三方网站）' });
    expect(link).toHaveAttribute('href', 'https://you.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect((link.getAttribute('rel') ?? '').split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    fireEvent.click(within(body).getByRole('button', { name: '复制：Claude Code · 免注册' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude mcp add --transport http you-free "https://api.you.com/mcp?profile=free"'));
    // A token made meanwhile never reaches You.com's lines, and its disclosure stays as it was: the same nodes, still on
    // the page.
    fireEvent.click(screen.getByRole('button', { name: '生成令牌' }));
    await screen.findByRole('group', { name: '「Claude Code」的令牌' });
    expect(toggle.isConnected && body.isConnected).toBe(true);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const line of blocks()) expect(line).not.toContain(TOKEN);
    fireEvent.click(toggle);
    expect(document.body).not.toHaveTextContent('api.you.com');
  });

  it('says what You.com is and who pays for it, in English', () => {
    english(<AgentInvite {...inviteProps({ defaultOpen: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add You.com: web search for your Agent' }));
    expect(screen.getByText('The free lines need no account: 100 searches a day, search only (no page reads).')).toBeInTheDocument();
    expect(screen.getByText('A full line signs you in to your own You.com account, which pays for each call. AwwO takes no part of that money and never sees or keeps your You.com sign-in. What you send to You.com leaves AwwO.')).toBeInTheDocument();
    expect(screen.getByText('Codex · full, it opens the sign-in at once (later: codex mcp login you)')).toBeInTheDocument();
    expect(screen.getByText(/Codex may make them without asking.*set a spending limit at You\.com first/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open you.com (a third-party site) in a new tab' })).toHaveAttribute('href', 'https://you.com/');
    // No Chinese in the English section (which must be there for this to mean anything).
    const section = document.querySelector('.awwo-multiplayer-you');
    expect(section).not.toBeNull();
    expect(section!.textContent).not.toMatch(/[㐀-鿿]/);
  });
});

describe('the layer on the board', () => {
  const boxes = [{ id: 'n1', x: 0, y: 0, w: 300, h: 200 }, { id: 'n2', x: 400, y: 0, w: 300, h: 200 }, { id: 'n3', x: 0, y: 300, w: 300, h: 200 }];
  const layer = (over: Partial<MultiplayerBoardLayerProps> = {}) =>
    render(<MultiplayerBoardLayer participants={[SELF, ADA, CLAUDE]} selfId={SELF.id} claims={CLAIMS} nodes={boxes} flashes={[]} now={NOW} {...over} />);

  it('rings what others have selected or are on, never what this page has', () => {
    const { container } = layer();
    const board = container.querySelector<HTMLElement>('.awwo-multiplayer-board')!;
    expect(board).toHaveAttribute('aria-hidden', 'true');
    // It never takes a press from the cards under it.
    expect(board.style.pointerEvents).toBe('none');
    const rings = [...board.querySelectorAll<HTMLElement>('.awwo-multiplayer-ring')];
    expect(rings.map(ring => [nodeOf(ring), ring.dataset.participant])).toEqual([['n1', ADA.id], ['n2', CLAUDE.id]]);
    expect(board.querySelector(`.awwo-multiplayer-ring[data-participant="${SELF.id}"]`)).toBeNull();
    expect(board.querySelector('[data-node="n3"]')).toBeNull();
    expect(rings[0].style.getPropertyValue('--mp-color')).toBe(ADA.color);
    const tag = board.querySelector<HTMLElement>(`[data-node="n1"] .awwo-multiplayer-tag`)!;
    expect(tag).toHaveTextContent('Ada Lovelace');
    expect(tag.style.getPropertyValue('--mp-ink')).toBe('#0b1220');
    const mark = board.querySelector<HTMLElement>('[data-node="n2"]')!;
    expect(mark.style.transform).toBe('translate(400px, 0px)');
    expect(mark.style.width).toBe('300px');
  });

  it('names a participant on its first node alone past three, and stacks the rings of several on one node', () => {
    const busy: LiveParticipant = { ...ADA, state: state({ selection: ['n1', 'n2', 'n3', 'n4'] }) };
    const grace = person('page-grace-001', 'Grace Hopper', '#30a46c', 'user-0009', { state: state({ focus: 'n1' }) });
    const four = [...boxes, { id: 'n4', x: 0, y: 600, w: 300, h: 200 }];
    const { container } = layer({ participants: [SELF, busy, grace], nodes: four, claims: [] });
    expect([...container.querySelectorAll(`.awwo-multiplayer-ring[data-participant="${ADA.id}"]`)].map(nodeOf)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect([...container.querySelectorAll(`.awwo-multiplayer-tag[data-participant="${ADA.id}"]`)].map(nodeOf)).toEqual(['n1']);
    // Two on one node: the second ring outside the first, and the names lifted clear of both.
    const n1 = container.querySelector<HTMLElement>('[data-node="n1"]')!;
    expect([...n1.querySelectorAll<HTMLElement>('.awwo-multiplayer-ring')].map(ring => [ring.dataset.participant, ring.style.getPropertyValue('--mp-ring')]))
      .toEqual([[ADA.id, '0'], [grace.id, '1']]);
    expect(n1.style.getPropertyValue('--mp-rings')).toBe('2');
    expect([...n1.querySelectorAll('.awwo-multiplayer-tag')].map(tag => tag.textContent)).toEqual(['Ada Lovelace', 'Grace Hopper']);
  });

  it('tags AwwO’s own Agent as the AwwO Agent, not by the title of the node it runs', () => {
    const { container } = layer({ participants: [SELF, RUNNER], claims: [] });
    const tag = container.querySelector<HTMLElement>('[data-node="n3"] .awwo-multiplayer-tag')!;
    expect(tag).toHaveTextContent('AwwO Agent');
    expect(tag).not.toHaveTextContent('测试');
    expect(container.querySelector('[data-node="n3"] .awwo-multiplayer-ring')).toHaveAttribute('data-participant', RUNNER.id);
  });

  it('draws one badge per claim that still holds, with the Agent mark on an Agent’s alone', () => {
    const expired: LiveClaim = { nodeId: 'n3', participantId: CLAUDE.id, holderKind: 'agent', name: 'Claude Code', note: '', expiresAt: '2026-11-06T09:59:00Z' };
    const { container } = layer({ claims: [...CLAIMS, expired] });
    const badges = [...container.querySelectorAll<HTMLElement>('.awwo-multiplayer-claim')];
    expect(badges).toHaveLength(2);
    const agent = container.querySelector<HTMLElement>('[data-node="n2"] .awwo-multiplayer-claim')!;
    expect(agent).toHaveTextContent('Claude Code 正在处理');
    expect(agent.querySelector('svg')).not.toBeNull();
    expect(agent.style.getPropertyValue('--mp-color')).toBe(CLAUDE.color);
    const own = container.querySelector<HTMLElement>('[data-node="n1"] .awwo-multiplayer-claim')!;
    expect(own).toHaveTextContent('Leon 正在处理');
    expect(own).toHaveAttribute('data-holder', 'human');
    expect(own.querySelector('svg')).toBeNull();
  });

  it('takes a claim off the board at its end, even while its caller’s clock stands still', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { container } = layer();
    expect(container.querySelectorAll('.awwo-multiplayer-claim')).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(124_000); });
    expect(container.querySelectorAll('.awwo-multiplayer-claim')).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(container.querySelector('[data-node="n2"] .awwo-multiplayer-claim')).toBeNull();
    expect(container.querySelector('[data-node="n1"] .awwo-multiplayer-claim')).not.toBeNull();
    // Claude Code is still on the node: its ring stays.
    expect(container.querySelector(`[data-node="n2"] .awwo-multiplayer-ring[data-participant="${CLAUDE.id}"]`)).not.toBeNull();
  });

  it('draws a pointer for each other person, none for an Agent or this page', () => {
    // A pointer an agent should never send (the server drops it) is not drawn either.
    const pointing: LiveParticipant = { ...CLAUDE, state: { ...CLAUDE.state, cursor: { x: 5, y: 5 } } };
    const { container } = layer({ participants: [SELF, ADA, pointing] });
    const cursors = [...container.querySelectorAll<HTMLElement>('.awwo-multiplayer-cursor')];
    expect(cursors.map(cursor => cursor.dataset.participant)).toEqual([ADA.id]);
    expect(cursors[0].style.transform).toBe('translate(120px, 80px)');
    expect(cursors[0]).toHaveTextContent('Ada Lovelace');
    expect(cursors[0].querySelector('svg path')).not.toBeNull();
  });

  it('glows on a node someone just changed, until the glow runs out', () => {
    const flashes = [{ nodeId: 'n3', color: '#10b981', until: NOW + 1000 }, { nodeId: 'n1', color: '#10b981', until: NOW - 1 }];
    const { container, rerender } = layer({ participants: [], claims: [], flashes });
    expect([...container.querySelectorAll('.awwo-multiplayer-flash')].map(nodeOf)).toEqual(['n3']);
    rerender(<MultiplayerBoardLayer participants={[]} selfId={SELF.id} claims={[]} nodes={boxes} flashes={flashes} now={NOW + 1000} />);
    expect(container.querySelector('.awwo-multiplayer-flash')).toBeNull();
  });

  it('keeps its names at their size on screen at any zoom, and speaks English', () => {
    const { container } = english(<MultiplayerBoardLayer participants={[ADA, CLAUDE]} selfId={SELF.id} claims={CLAIMS} nodes={boxes} flashes={[]} now={NOW} scale={2} />);
    expect(container.querySelector<HTMLElement>('.awwo-multiplayer-board')!.style.getPropertyValue('--mp-inv')).toBe('0.5');
    expect(container.querySelector('[data-node="n2"] .awwo-multiplayer-claim')).toHaveTextContent('Claude Code · working');
  });

  it('reads the zoom from the canvas world it is drawn in when it is given none', async () => {
    const { container } = render(<div className="canvas-world" style={{ transform: 'translate(10px, 20px) scale(2)', transformOrigin: '0 0' }}>
      <MultiplayerBoardLayer participants={[SELF, ADA]} selfId={SELF.id} claims={[]} nodes={boxes} flashes={[]} now={NOW} />
    </div>);
    const board = container.querySelector<HTMLElement>('.awwo-multiplayer-board')!;
    const world = container.querySelector<HTMLElement>('.canvas-world')!;
    expect(board.style.getPropertyValue('--mp-inv')).toBe('0.5');
    world.style.transform = 'translate(-40px, 5px) scale(0.5)';
    await waitFor(() => expect(board.style.getPropertyValue('--mp-inv')).toBe('2'));
    // Outside a canvas world, a zoom of 1.
    cleanup();
    const alone = render(<MultiplayerBoardLayer participants={[SELF, ADA]} selfId={SELF.id} claims={[]} nodes={boxes} flashes={[]} now={NOW} />);
    expect(alone.container.querySelector<HTMLElement>('.awwo-multiplayer-board')!.style.getPropertyValue('--mp-inv')).toBe('');
  });

  it('skips nodes it is not given', () => {
    const { container } = layer({ nodes: [boxes[0]] });
    expect(container.querySelector('[data-node="n2"]')).toBeNull();
    expect(container.querySelectorAll('.awwo-multiplayer-ring')).toHaveLength(1);
  });

  it('marks nothing of a node it is not given, and names a participant by the nodes it is given alone', () => {
    // n8 and n9 are not given (members inside a converged icon, say): Ada is on n9 and has n8 selected before n1 and n2.
    const ada: LiveParticipant = { ...ADA, state: state({ focus: 'n9', selection: ['n8', 'n1', 'n2'] }) };
    const runner: LiveParticipant = { ...RUNNER, state: state({ selection: ['n9'], focus: 'n9', status: 'running' }) };
    const { container } = layer({ participants: [SELF, ada, runner], claims: [{ ...CLAIMS[0], nodeId: 'n9' }],
      flashes: [{ nodeId: 'n8', color: '#10b981', until: NOW + 1000 }] });
    expect([...container.querySelectorAll<HTMLElement>('.awwo-multiplayer-mark')].map(item => item.dataset.node)).toEqual(['n1', 'n2']);
    // Named on both nodes given: her marks on nodes not given do not count toward the three named.
    expect([...container.querySelectorAll(`.awwo-multiplayer-tag[data-participant="${ADA.id}"]`)].map(nodeOf)).toEqual(['n1', 'n2']);
    expect(container.textContent).not.toContain('AwwO Agent');
    expect(container.querySelector('.awwo-multiplayer-claim')).toBeNull();
    expect(container.querySelector('.awwo-multiplayer-flash')).toBeNull();
  });
});

describe('a change in one line', () => {
  const actor = { kind: 'agent' as const, tokenId: '00000000000000aa', name: 'Claude Code', clientId: 'mcp-client-0001' };
  const change = (ops: CanvasOp[], over: Partial<CanvasChange> = {}): CanvasChange => ({ version: 5, actor, label: 'agent', ops, at: SINCE, ...over });

  it('names a node added, in both languages', () => {
    const add: CanvasOp = { op: 'set', path: ['nodes', 'n9'], value: { id: 'n9', kind: 'session', title: '后端接口' } };
    expect(describeChange(change([add]), nodeTitle, 'zh')).toEqual({ text: 'Claude Code 添加了节点「后端接口」', nodeIds: ['n9'] });
    const englishAdd = { ...add, value: { id: 'n9', kind: 'session', title: 'Backend API' } };
    expect(describeChange(change([englishAdd]), () => undefined, 'en').text).toBe('Claude Code added the node “Backend API”');
  });

  it('counts moves, sizes and settings', () => {
    const moves: CanvasOp[] = ['n1', 'n2', 'n3'].flatMap(id => [{ op: 'set', path: ['nodes', id, 'x'], value: 10 }, { op: 'set', path: ['nodes', id, 'y'], value: 20 }] as CanvasOp[]);
    expect(describeChange(change(moves), nodeTitle, 'zh')).toEqual({ text: 'Claude Code 移动了 3 个节点', nodeIds: ['n1', 'n2', 'n3'] });
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'x'], value: 1 }]), nodeTitle, 'en').text).toBe('Claude Code moved “后端接口”');
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'w'], value: 400 }, { op: 'set', path: ['nodes', 'n1', 'deliverablesOpen'], value: true }]), nodeTitle, 'zh').text)
      .toBe('Claude Code 调整了「后端接口」的大小');
    // A resize from the left edge moves the node too: it is one resize.
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'x'], value: -40 }, { op: 'set', path: ['nodes', 'n1', 'w'], value: 340 }]), nodeTitle, 'zh').text)
      .toBe('Claude Code 调整了「后端接口」的大小');
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'persona'], value: '更严格' }]), nodeTitle, 'zh').text).toBe('Claude Code 修改了「后端接口」的设置');
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'title'], value: '新接口' }]), nodeTitle, 'en').text).toBe('Claude Code renamed a node to “新接口”');
  });

  it('tells results, forms, conversations, wires and the canvas apart', () => {
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'lastOutput'], value: { text: 'ok' } }]), nodeTitle, 'zh').text).toBe('Claude Code 把结果写进了「后端接口」');
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'threads', 't1', 'outputValues'], value: {} }]), nodeTitle, 'zh').text).toBe('Claude Code 把结果写进了「后端接口」');
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'threads', 't1', 'draft'], value: '你好' }]), nodeTitle, 'zh').text).toBe('Claude Code 修改了「后端接口」的对话');
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n3', 'fields', 'a', 'value'], value: '42' }]), nodeTitle, 'zh').text).toBe('Claude Code 修改了表单「测试」');
    const wire: CanvasOp = { op: 'set', path: ['edges', 'e1'], value: { id: 'e1', fromNode: 'n1', fromPort: 'result', toNode: 'n2', toPort: 'context', dataType: 'text' } };
    expect(describeChange(change([wire]), nodeTitle, 'zh')).toEqual({ text: 'Claude Code 连接了「后端接口」→「前端页面」', nodeIds: ['n1', 'n2'] });
    expect(describeChange(change([wire]), nodeTitle, 'en').text).toBe('Claude Code connected “后端接口” → “前端页面”');
    expect(describeChange(change([{ op: 'del', path: ['edges', 'e1'] }, { op: 'del', path: ['edges', 'e2'] }]), nodeTitle, 'zh').text).toBe('Claude Code 删除了 2 条连线');
    expect(describeChange(change([{ op: 'del', path: ['doc', 'execution'] }]), nodeTitle, 'zh').text).toBe('Claude Code 修改了画布设置');
    expect(describeChange(change([{ op: 'order', path: ['nodes'], ids: ['n2', 'n1'] }]), nodeTitle, 'zh').text).toBe('Claude Code 调整了画布上的顺序');
    expect(describeChange(change([{ op: 'set', path: ['waypoints', '3'], value: { slot: 3, view: { x: 0, y: 0, scale: 1 } } }]), nodeTitle, 'en').text)
      .toBe('Claude Code changed the saved viewpoints');
  });

  it('tells a run’s results in a contract only by the contract before it, as the server’s fence does', () => {
    const output = { id: 'o1', label: '结果', type: 'text', required: false, value: '42' };
    const after = { version: 1, inputs: [], outputs: [output] };
    const before = { version: 1, inputs: [], outputs: [{ ...output, value: '' }] };
    const set: CanvasOp = { op: 'set', path: ['nodes', 'n1', 'contract'], value: after };
    // A page publishing a run's results labels its change 'edit' as any other: the change alone cannot tell.
    expect(describeChange(change([set], { label: 'edit' }), nodeTitle, 'zh').text).toBe('Claude Code 更新了「后端接口」的输入和输出');
    expect(describeChange(change([set]), nodeTitle, 'zh', { contractBefore: id => id === 'n1' ? before : undefined }).text).toBe('Claude Code 把结果写进了「后端接口」');
    // Anything else changed beside the values is a change of the contract.
    const relabelled = { ...before, outputs: [{ ...before.outputs[0], label: '答案' }] };
    expect(describeChange(change([set]), nodeTitle, 'en', { contractBefore: () => relabelled }).text).toBe('Claude Code updated the inputs and outputs of “后端接口”');
    // A node without a contract before is given one: no result.
    expect(describeChange(change([set]), nodeTitle, 'zh', { contractBefore: () => undefined }).text).toBe('Claude Code 更新了「后端接口」的输入和输出');
    expect(activityItem(change([set], { version: 8 }), nodeTitle, 'zh', [], { contractBefore: () => before }).text).toBe('Claude Code 把结果写进了「后端接口」');
  });

  it('names a removed node only while the caller still knows it, and leaves it out of the nodes to show', () => {
    expect(describeChange(change([{ op: 'del', path: ['nodes', 'gone'] }]), nodeTitle, 'zh')).toEqual({ text: 'Claude Code 删除了 1 个节点', nodeIds: [] });
    expect(describeChange(change([{ op: 'del', path: ['nodes', 'n1'] }]), nodeTitle, 'en').text).toBe('Claude Code removed the node “后端接口”');
    expect(describeChange(change([{ op: 'del', path: ['nodes', 'n1'] }, { op: 'del', path: ['nodes', 'n2'] }]), nodeTitle, 'zh').text).toBe('Claude Code 删除了 2 个节点');
  });

  it('joins two edits and counts the rest', () => {
    const add: CanvasOp = { op: 'set', path: ['nodes', 'n9'], value: { id: 'n9', title: 'API' } };
    const wire: CanvasOp = { op: 'set', path: ['edges', 'e9'], value: { id: 'e9', fromNode: 'n9', toNode: 'n1' } };
    expect(describeChange(change([add, wire]), nodeTitle, 'zh').text).toBe('Claude Code 添加了节点「API」，连接了「API」→「后端接口」');
    expect(describeChange(change([add, wire]), nodeTitle, 'en').text).toBe('Claude Code added the node “API” and connected “API” → “后端接口”');
    const many: CanvasOp[] = [add, wire, { op: 'set', path: ['nodes', 'n2', 'x'], value: 1 }, { op: 'del', path: ['doc', 'execution'] }];
    expect(describeChange(change(many), nodeTitle, 'zh').text).toBe('Claude Code 添加了节点「API」，连接了「API」→「后端接口」，另有 2 处改动');
    expect(describeChange(change(many.slice(0, 3)), nodeTitle, 'en').text).toBe('Claude Code added the node “API”, connected “API” → “后端接口” and made one more change');
  });

  it('names someone for a change without a name, cuts a long title, and reads a change with no ops', () => {
    const nameless = { ...actor, name: '  ' };
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'x'], value: 1 }], { actor: nameless }), nodeTitle, 'zh').text).toBe('有人 移动了「后端接口」');
    const long = '一'.repeat(60);
    expect(describeChange(change([{ op: 'set', path: ['nodes', 'n1', 'x'], value: 1 }]), () => long, 'zh').text).toBe(`Claude Code 移动了「${'一'.repeat(39)}…」`);
    expect(describeChange(change([]), nodeTitle, 'en').text).toBe('Claude Code changed the canvas');
  });

  it('colours a line by its author while they are here', () => {
    const item = activityItem(change([{ op: 'set', path: ['nodes', 'n1', 'x'], value: 1 }], { version: 12 }), nodeTitle, 'zh', [ADA, CLAUDE]);
    expect(item).toEqual({ version: 12, text: 'Claude Code 移动了「后端接口」', nodeIds: ['n1'], at: SINCE, color: CLAUDE.color });
    const human = activityItem(change([], { actor: { kind: 'human', userId: 'user-0002', name: 'Ada Lovelace', clientId: ADA.id } }), nodeTitle, 'en', [ADA]);
    expect(human.color).toBe(ADA.color);
    expect(activityItem(change([]), nodeTitle, 'en', []).color).toBeUndefined();
  });
});

describe('the live lane on the board and in the people bar', () => {
  it('draws the wire someone is drawing, and names who is typing in a node', () => {
    const editors = new Map([['n1', [{ participantId: ADA.id, name: 'Ada Lovelace', color: '#f59e0b', field: 'title' }]]]);
    const wires = [{ participantId: ADA.id, name: 'Ada Lovelace', color: '#f59e0b', from: { x: 10, y: 20 }, to: { x: 210, y: 120 } }];
    const { container } = render(<MultiplayerBoardLayer participants={[SELF, ADA]} selfId={SELF.id} claims={[]} flashes={[]} now={0} scale={1}
      nodes={[{ id: 'n1', x: 0, y: 0, w: 200, h: 100 }]} wires={wires} editors={editors} />);
    const wire = container.querySelector<SVGPathElement>(`.awwo-multiplayer-wire[data-participant="${ADA.id}"]`)!;
    expect(wire.getAttribute('d')).toBe('M 10 20 C 110 20, 110 120, 210 120');
    expect(wire.style.getPropertyValue('--mp-color')).toBe('#f59e0b');
    const tag = container.querySelector(`.awwo-multiplayer-tag[data-participant="${ADA.id}"]`)!;
    expect(tag).toHaveAttribute('data-editing');
    expect(tag).toHaveTextContent('Ada Lovelace 正在编辑');
  });

  it('takes a card’s marks along with someone else’s move, and outlines the size a resize is taking', () => {
    const moves = new Map([['n1', { x: 300, y: 40, color: '#f59e0b' }], ['n2', { x: 10, y: 20, w: 400, h: 300, color: '#f59e0b', resize: true as const }]]);
    const ringed = { ...ADA, state: state({ selection: ['n1'] }) };
    const { container } = render(<MultiplayerBoardLayer participants={[SELF, ringed]} selfId={SELF.id} claims={[]} flashes={[]} now={0} scale={1}
      nodes={[{ id: 'n1', x: 0, y: 0, w: 200, h: 100 }, { id: 'n2', x: 10, y: 20, w: 200, h: 100 }]} moves={moves} />);
    expect(container.querySelector<HTMLElement>('.awwo-multiplayer-mark[data-node="n1"]')!.style.transform).toBe('translate(300px, 40px)');
    const outline = container.querySelector<SVGRectElement>('.awwo-multiplayer-resize[data-node="n2"]')!;
    expect([outline.getAttribute('x'), outline.getAttribute('y'), outline.getAttribute('width'), outline.getAttribute('height')]).toEqual(['10', '20', '400', '300']);
  });

  it('carries marks by the offset the cards are carried by, an icon’s plate too, none where this page leaves a card alone', () => {
    const moves = new Map([['n1', { x: 300, y: 40 }], ['icon', { x: 500, y: 0 }], ['open', { x: 900, y: 0 }],
      ['n2', { x: 10, y: 20, w: 400, h: 300, resize: true as const }], ['chat', { x: 0, y: 400, w: 500, h: 500, resize: true as const }],
      ['drag', { x: 0, y: 700 }]]);
    const drawn = new Map([['n1', { x: 0, y: 0 }], ['icon', { x: 100, y: 0 }], ['open', { x: 0, y: 0 }], ['n2', { x: 10, y: 20 }],
      ['chat', { x: 0, y: 400 }], ['drag', { x: 0, y: 600 }]]);
    const carry = { drawn, excluded: (id: string) => id === 'open', ownSize: (id: string) => id !== 'chat' };
    const ringed = { ...ADA, state: state({ selection: ['n1', 'icon', 'open'] }) };
    const { container } = render(<MultiplayerBoardLayer participants={[SELF, ringed]} selfId={SELF.id} claims={[]} flashes={[]} now={0} scale={1}
      nodes={[{ id: 'n1', x: 0, y: 0, w: 200, h: 100 }, { id: 'icon', x: 120, y: 10, w: 64, h: 64, round: true }, { id: 'open', x: 0, y: 0, w: 900, h: 700 },
        { id: 'n2', x: 10, y: 20, w: 200, h: 100 }, { id: 'chat', x: 0, y: 400, w: 260, h: 128 }, { id: 'drag', x: 0, y: 600, w: 200, h: 100 }]}
      moves={moves} carry={carry} />);
    const at = (id: string) => container.querySelector<HTMLElement>(`.awwo-multiplayer-mark[data-node="${id}"]`)!.style.transform;
    expect(at('n1')).toBe('translate(300px, 40px)');
    // The icon's plate goes by the icon's own offset (400 to the right of where it is drawn).
    expect(at('icon')).toBe('translate(520px, 10px)');
    // The node this page has open stays where it is drawn, its marks with it.
    expect(at('open')).toBe('translate(0px, 0px)');
    // Only a resize is outlined, and only on a card drawn at its own size (not a conversation's compact card).
    expect([...container.querySelectorAll('.awwo-multiplayer-resize')].map(rect => rect.getAttribute('data-node'))).toEqual(['n2']);
  });

  it('draws a pointer where it is first heard, then glides it after each place on the glide spring', () => {
    let queue: FrameRequestCallback[] = [];
    let time = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queue.push(callback); return queue.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const step = (count: number) => { for (let i = 0; i < count; i += 1) { time += 16; const due = queue; queue = []; for (const callback of due) callback(time); } };
    try {
      const at = (x: number, y: number) => ({ ...ADA, state: state({ cursor: { x, y } }) });
      const board = (participant: LiveParticipant) => <MultiplayerBoardLayer participants={[SELF, participant]} selfId={SELF.id} claims={[]} flashes={[]} now={0} scale={1} nodes={[]} />;
      const { container, rerender } = render(board(at(100, 100)));
      const cursor = () => container.querySelector<HTMLElement>('.awwo-multiplayer-cursor')!;
      expect(cursor().style.transform).toBe('translate(100px, 100px)');
      rerender(board(at(300, 100)));
      step(1);
      const first = Number(/translate\(([-\d.]+)px/.exec(cursor().style.transform)![1]);
      expect(first).toBeGreaterThan(100);
      expect(first).toBeLessThan(300);
      // A re-render with nothing new leaves the glide where it is.
      rerender(board(at(300, 100)));
      expect(cursor().style.transform).toBe(`translate(${first}px, 100px)`);
      step(150);
      expect(cursor().style.transform).toBe('translate(300px, 100px)');
      expect(queue).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('marks a viewer with an eye, and follows a person from their avatar, a second click stopping', () => {
    const viewer = person('page-viewer-01', 'Grace', '#30a46c', 'user-viewer', { role: 'reader', device: 'tablet' });
    const onFollow = vi.fn();
    const { rerender, container } = render(<MultiplayerBar participants={[SELF, ADA, viewer, CLAUDE]} selfId={SELF.id} status="live" onOpen={() => {}} onFollow={onFollow} />);
    const grace = container.querySelector<HTMLElement>(`.awwo-multiplayer-avatar[data-participant="${viewer.id}"]`)!;
    expect(grace).toHaveAttribute('data-viewer', 'true');
    expect(grace.querySelector('.awwo-multiplayer-viewer-mark')).not.toBeNull();
    expect(grace).toHaveAttribute('title', 'Grace · 平板 · 可查看');
    // An Agent is shown, not followed: it has no screen.
    expect(screen.queryByRole('button', { name: '跟随 Claude Code' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '跟随 Ada Lovelace' }));
    expect(onFollow).toHaveBeenLastCalledWith('u_user-0002');
    rerender(<MultiplayerBar participants={[SELF, ADA, viewer, CLAUDE]} selfId={SELF.id} status="live" onOpen={() => {}} onFollow={onFollow} following="u_user-0002" />);
    const stop = screen.getByRole('button', { name: '停止跟随（Esc）' });
    expect(stop).toHaveAttribute('aria-pressed', 'true');
    expect(stop).toHaveAttribute('data-following');
    fireEvent.click(stop);
    expect(onFollow).toHaveBeenLastCalledWith(null);
  });
});
