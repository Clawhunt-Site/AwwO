// 分享 / Share (canvas/multiplayer/ShareDialog.tsx, saas/useCanvasSharing.ts): what joining the workspace grants and who
// pays, inviting people with a link bound to an email or not, the
// invitations waiting, who is in the workspace and who may change whose access, this canvas's link, and agents under 高级;
// the 同屏 panel putting people first; and the canvas header, which offers Share only where the server does. Every id,
// name, email and link here is made up.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/canvas/i18n';
import { ShareDialog, grantable, mayManage, type ShareDialogProps, type ShareInvite, type ShareMember } from '../src/canvas/multiplayer/ShareDialog';
import { MultiplayerPanel, type MultiplayerPanelProps } from '../src/canvas/multiplayer/MultiplayerPanel';
import type { AgentInviteProps } from '../src/canvas/multiplayer/AgentInvite';
import type { LiveParticipant, LiveState } from '../src/canvas/multiplayer/types';
import { MULTIPLAYER_TEXT } from '../src/canvas/multiplayer/multiplayerText';
import { MultiplayerHeader, type CanvasMultiplayer } from '../src/saas/useCanvasMultiplayer';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { CanvasLive, LiveSnapshot } from '../src/saas/canvasLive';

const OWNER: ShareMember = { userId: 'user-owner', name: 'Olive', role: 'owner', email: 'olive@example.test' };
const ADMIN: ShareMember = { userId: 'user-admin', name: 'Ada', role: 'admin', email: 'ada@example.test' };
const MEMBER: ShareMember = { userId: 'user-member', name: 'Milo', role: 'member', email: 'milo@example.test' };
const READER: ShareMember = { userId: 'user-reader', name: 'Rui', role: 'reader', email: 'rui@example.test' };
const PEOPLE = [READER, MEMBER, ADMIN, OWNER];
const PENDING: ShareInvite[] = [
  { id: 'inv-1', role: 'member', status: 'active', expiresAt: '2026-11-10T10:00:00Z', email: 'bob@example.test', canvasId: 'canvas-one', canvasName: 'Plan' },
  { id: 'inv-2', role: 'admin', status: 'active', expiresAt: '2026-11-10T10:00:00Z', email: null, canvasId: 'canvas-two', canvasName: 'Other' },
  { id: 'inv-3', role: 'reader', status: 'accepted', expiresAt: '2026-11-10T10:00:00Z', email: 'cy@example.test', canvasId: null, canvasName: null },
];
const CANVAS_URL = 'https://awwo.example/?tenant=tenant-one&canvas=canvas-one';
const AGENTS: AgentInviteProps = { tokens: { items: [], loading: false, error: null }, onCreate: vi.fn(), onRevoke: vi.fn(async () => undefined),
  mcpUrl: 'https://awwo.example/api/v1/mcp', apiBase: 'https://awwo.example/api/v1', tenantId: 'tenant-one', canvasId: 'canvas-one' };

function shareProps(over: Partial<ShareDialogProps> = {}): ShareDialogProps {
  return { open: true, onClose: vi.fn(), workspaceName: 'Studio', role: 'owner', selfUserId: OWNER.userId, canvasId: 'canvas-one', canvasUrl: CANVAS_URL,
    members: { items: PEOPLE, loading: false, error: null }, invites: { items: PENDING, loading: false, error: null }, here: new Map([[MEMBER.userId, '#f59e0b']]),
    onCreateInvite: vi.fn(async ({ email, role }) => ({ id: 'inv-new', role, inviteUrl: 'https://awwo.example/?invite=made-up-invitation-token', expiresAt: '2026-11-11T10:00:00Z', email: email || null })),
    onRevokeInvite: vi.fn(async () => undefined), onChangeRole: vi.fn(async () => undefined), onRemove: vi.fn(async () => undefined), agents: AGENTS, ...over };
}
const english = (element: ReactElement) => render(<LocaleProvider locale="en">{element}</LocaleProvider>);
const memberRow = (container: HTMLElement, userId: string) => container.querySelector<HTMLElement>(`li[data-member="${userId}"]`)!;

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('who may grant and change what', () => {
  it('follows the server: an owner grants every role, an admin never another admin, a member nothing', () => {
    expect(grantable('owner')).toEqual(['reader', 'member', 'admin']);
    expect(grantable('admin')).toEqual(['reader', 'member']);
    expect(grantable('member')).toEqual([]);
    expect(grantable(null)).toEqual([]);
    expect(mayManage('owner', ADMIN, OWNER.userId)).toBe(true);
    expect(mayManage('owner', OWNER, ADMIN.userId)).toBe(false);
    expect(mayManage('admin', ADMIN, 'user-another-admin')).toBe(false);
    expect(mayManage('admin', MEMBER, ADMIN.userId)).toBe(true);
    expect(mayManage('admin', ADMIN, ADMIN.userId)).toBe(false);
    expect(mayManage('member', READER, MEMBER.userId)).toBe(false);
  });
});

describe('the Share dialog', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<ShareDialog {...shareProps({ open: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says what joining the workspace grants and who pays before anyone is invited', () => {
    render(<ShareDialog {...shareProps()} />);
    const dialog = screen.getByRole('dialog', { name: '分享画布' });
    expect(dialog).toHaveTextContent('受邀的人会加入工作区「Studio」：能打开其中所有画布，以及它的记忆、知识、技能和对话；可编辑的人还能改动其中的 Agent。');
    expect(dialog).toHaveTextContent('可编辑的人运行 Agent 时，费用记在工作区所有者的套餐上');
  });

  it('lets an owner invite people by a link bound to an email, opening this canvas', async () => {
    const props = shareProps();
    render(<ShareDialog {...props} />);
    const dialog = within(screen.getByRole('dialog', { name: '分享画布' }));
    const access = dialog.getByRole('combobox', { name: '权限' }) as HTMLSelectElement;
    expect([...access.options].map(option => option.textContent)).toEqual(['可查看', '可编辑', '管理员']);
    expect(access.value).toBe('member');
    expect((dialog.getByRole('combobox', { name: '链接有效期' }) as HTMLSelectElement).value).toBe('3');
    fireEvent.change(dialog.getByRole('textbox', { name: '邮箱（可选）' }), { target: { value: '  bob@example.test ' } });
    fireEvent.change(dialog.getByRole('combobox', { name: '链接有效期' }), { target: { value: '7' } });
    fireEvent.click(dialog.getByRole('button', { name: '生成邀请链接' }));
    const made = await dialog.findByRole('status');
    expect(props.onCreateInvite).toHaveBeenCalledWith({ email: 'bob@example.test', role: 'member', days: 7 });
    expect(made).toHaveTextContent('https://awwo.example/?invite=made-up-invitation-token');
    expect(made).toHaveTextContent('只给 bob@example.test 用');
    expect(made).toHaveTextContent('对方接受邀请后，会直接打开这张画布');
    expect((dialog.getByRole('textbox', { name: '邮箱（可选）' }) as HTMLInputElement).value).toBe('');
  });

  it('makes a link for whoever opens it first when no email is given, and says why one was refused', async () => {
    const onCreateInvite = vi.fn().mockRejectedValueOnce(new Error('')).mockResolvedValueOnce({ id: 'inv-new', role: 'reader', inviteUrl: 'https://awwo.example/?invite=x', expiresAt: '2026-11-11T10:00:00Z', email: null });
    render(<ShareDialog {...shareProps({ onCreateInvite })} />);
    const dialog = within(screen.getByRole('dialog', { name: '分享画布' }));
    fireEvent.change(dialog.getByRole('combobox', { name: '权限' }), { target: { value: 'reader' } });
    fireEvent.click(dialog.getByRole('button', { name: '生成邀请链接' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('没能生成链接：请重试');
    fireEvent.click(dialog.getByRole('button', { name: '生成邀请链接' }));
    expect(await dialog.findByRole('status')).toHaveTextContent('第一个打开并确认的人加入');
    expect(onCreateInvite).toHaveBeenLastCalledWith({ email: '', role: 'reader', days: 3 });
  });

  it('points a member already in the workspace to their access instead of a new invitation', () => {
    render(<ShareDialog {...shareProps()} />);
    const dialog = within(screen.getByRole('dialog', { name: '分享画布' }));
    fireEvent.change(dialog.getByRole('textbox', { name: '邮箱（可选）' }), { target: { value: 'Milo@Example.test' } });
    expect(dialog.getByText('Milo 已经在这个工作区里：在下面调整权限即可。')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: '生成邀请链接' })).toBeDisabled();
  });

  it('lists the invitations still waiting, with whom each is for and what it opens, and revokes one', async () => {
    const props = shareProps();
    const { container } = render(<ShareDialog {...props} />);
    const pending = container.querySelectorAll('li[data-invite]');
    expect([...pending].map(item => item.getAttribute('data-invite'))).toEqual(['inv-1', 'inv-2']);
    expect(pending[0]).toHaveTextContent('bob@example.test');
    expect(pending[0]).toHaveTextContent('可编辑');
    expect(pending[0]).toHaveTextContent('打开这张画布');
    expect(pending[1]).toHaveTextContent('任何拿到链接的人');
    expect(pending[1]).toHaveTextContent('打开「Other」');
    fireEvent.click(within(pending[0] as HTMLElement).getByRole('button', { name: '撤销给 bob@example.test 的邀请' }));
    await waitFor(() => expect(props.onRevokeInvite).toHaveBeenCalledWith('inv-1'));
  });

  it('lists everyone in the workspace, this person first, who is here now, and lets an owner change or remove anyone but the owner', async () => {
    const props = shareProps();
    const { container } = render(<ShareDialog {...props} />);
    const rows = [...container.querySelectorAll<HTMLElement>('li[data-member]')];
    expect(rows.map(row => row.dataset.member)).toEqual([OWNER.userId, ADMIN.userId, MEMBER.userId, READER.userId]);
    expect(rows[0]).toHaveTextContent('Olive（你）');
    expect(rows[0]).toHaveTextContent('所有者');
    expect(within(rows[0]).queryByRole('combobox')).toBeNull();
    expect(memberRow(container, MEMBER.userId)).toHaveTextContent('正在这张画布上');
    expect(memberRow(container, READER.userId)).not.toHaveTextContent('正在这张画布上');
    expect(memberRow(container, MEMBER.userId)).toHaveTextContent('milo@example.test');
    const role = within(memberRow(container, MEMBER.userId)).getByRole('combobox', { name: 'Milo 的权限' });
    fireEvent.change(role, { target: { value: 'reader' } });
    await waitFor(() => expect(props.onChangeRole).toHaveBeenCalledWith(MEMBER.userId, 'reader'));
    fireEvent.click(within(memberRow(container, READER.userId)).getByRole('button', { name: '把 Rui 移出工作区' }));
    const confirm = within(memberRow(container, READER.userId)).getByRole('group', { name: '把 Rui 移出工作区' });
    expect(confirm).toHaveTextContent('把 Rui 移出工作区「Studio」？之后对方打不开其中任何画布。');
    expect(props.onRemove).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledWith(READER.userId));
  });

  it('keeps the focus in the dialog when the row that had it goes', async () => {
    const props = shareProps();
    const { container } = render(<ShareDialog {...props} />);
    const dialog = within(screen.getByRole('dialog', { name: '分享画布' }));
    // Cancel puts it back on the person's 移除.
    const remove = within(memberRow(container, READER.userId)).getByRole('button', { name: '把 Rui 移出工作区' });
    fireEvent.click(remove);
    fireEvent.click(within(memberRow(container, READER.userId)).getByRole('button', { name: '取消' }));
    expect(document.activeElement).toBe(remove);
    // A removal moves it to the people's title, before the list read again takes the row away.
    fireEvent.click(remove);
    fireEvent.click(within(within(memberRow(container, READER.userId)).getByRole('group')).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(document.activeElement).toBe(dialog.getByRole('heading', { name: '工作区「Studio」里的人 · 4' })));
    // So does a revoked invitation, to the invitations' title.
    fireEvent.click(within(container.querySelector<HTMLElement>('li[data-invite="inv-1"]')!).getByRole('button', { name: '撤销给 bob@example.test 的邀请' }));
    await waitFor(() => expect(document.activeElement).toBe(dialog.getByRole('heading', { name: '邀请成员' })));
  });

  it('says whom a removal that failed was for', async () => {
    const { container } = render(<ShareDialog {...shareProps({ onRemove: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) })} />);
    const row = within(memberRow(container, READER.userId));
    fireEvent.click(row.getByRole('button', { name: '把 Rui 移出工作区' }));
    fireEvent.click(within(row.getByRole('group')).getByRole('button', { name: '移除' }));
    expect(await row.findByRole('alert')).toHaveTextContent('没能移除 Rui：连不上 AwwO，请检查网络后重试。');
  });

  // An account linked to ClawHunt with no name kept yet is named by nothing (tenant_pagination.go, shownUserName).
  it('calls people the server names by nothing 有人, and names their controls by the email an owner sees', async () => {
    const kite: ShareMember = { userId: 'user-kite', name: '', role: 'member', email: 'kite@example.test' };
    const wren: ShareMember = { userId: 'user-wren', name: '  ', role: 'reader', email: 'wren@example.test' };
    const everyone = [...PEOPLE, kite, wren];
    const { container } = render(<ShareDialog {...shareProps({ members: { items: everyone, loading: false, error: null },
      onRemove: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) })} />);
    for (const person of [kite, wren]) {
      const row = within(memberRow(container, person.userId));
      expect(row.getByText('有人')).toBeInTheDocument();
      expect(row.getByText(person.email!)).toBeInTheDocument();
      expect(row.getByRole('combobox', { name: `${person.email} 的权限` })).toBeInTheDocument();
    }
    // Their email typed to invite them points to their access, by it.
    fireEvent.change(screen.getByRole('textbox', { name: '邮箱（可选）' }), { target: { value: 'wren@example.test' } });
    expect(screen.getByText('wren@example.test 已经在这个工作区里：在下面调整权限即可。')).toBeInTheDocument();
    const row = within(memberRow(container, kite.userId));
    fireEvent.click(row.getByRole('button', { name: '把 kite@example.test 移出工作区' }));
    expect(row.getByRole('group', { name: '把 kite@example.test 移出工作区' })).toHaveTextContent('把 kite@example.test 移出工作区「Studio」？');
    fireEvent.click(within(row.getByRole('group')).getByRole('button', { name: '移除' }));
    expect(await row.findByRole('alert')).toHaveTextContent('没能移除 kite@example.test：连不上 AwwO，请检查网络后重试。');
    cleanup();
    // A member, who sees no emails, sees 有人 and no controls; an owner or admin named by nothing is left out of who invites.
    const withoutEmails = everyone.map(person => ({ ...person, email: undefined, ...(person === OWNER ? { name: '' } : {}) }));
    const { container: asMember } = render(<ShareDialog {...shareProps({ role: 'member', selfUserId: MEMBER.userId,
      invites: { items: [], loading: false, error: null }, members: { items: withoutEmails, loading: false, error: null } })} />);
    expect(within(memberRow(asMember, kite.userId)).getByText('有人')).toBeInTheDocument();
    expect(asMember.querySelectorAll('li[data-member] select')).toHaveLength(0);
    expect(screen.getByText('只有工作区的所有者和管理员能邀请人：Ada。')).toBeInTheDocument();
  });

  it('starts a new link as not copied yet', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
    let made = 0;
    const onCreateInvite = vi.fn(async () => {
      made += 1;
      return { id: 'inv-' + made, role: 'member' as const, inviteUrl: 'https://awwo.example/?invite=made-up-' + made, expiresAt: '2026-11-11T10:00:00Z', email: null };
    });
    render(<ShareDialog {...shareProps({ onCreateInvite })} />);
    const dialog = within(screen.getByRole('dialog', { name: '分享画布' }));
    fireEvent.click(dialog.getByRole('button', { name: '生成邀请链接' }));
    const created = await dialog.findByRole('status');
    const copy = () => within(created).getAllByRole('button')[0];
    const before = copy().textContent;
    fireEvent.click(copy());
    await waitFor(() => expect(copy().textContent).not.toBe(before));
    fireEvent.click(dialog.getByRole('button', { name: '生成邀请链接' }));
    await waitFor(() => expect(created).toHaveTextContent('made-up-2'));
    expect(copy().textContent).toBe(before);
  });

  it('keeps an admin to what the server lets an admin do', () => {
    const { container } = render(<ShareDialog {...shareProps({ role: 'admin', selfUserId: ADMIN.userId })} />);
    const dialog = within(screen.getByRole('dialog', { name: '分享画布' }));
    expect([...(dialog.getByRole('combobox', { name: '权限' }) as HTMLSelectElement).options].map(option => option.value)).toEqual(['reader', 'member']);
    // The owner's and another admin's access are not theirs to change; nor an invitation for an admin to revoke.
    expect(within(memberRow(container, OWNER.userId)).queryByRole('combobox')).toBeNull();
    expect(within(memberRow(container, MEMBER.userId)).getByRole('combobox', { name: 'Milo 的权限' })).toBeInTheDocument();
    expect([...(within(memberRow(container, MEMBER.userId)).getByRole('combobox') as HTMLSelectElement).options].map(option => option.value)).toEqual(['reader', 'member']);
    expect(within(container.querySelector<HTMLElement>('li[data-invite="inv-2"]')!).queryByRole('button')).toBeNull();
    expect(within(container.querySelector<HTMLElement>('li[data-invite="inv-1"]')!).getByRole('button', { name: /撤销/ })).toBeInTheDocument();
  });

  it('tells a member who invites, offers no access changes, and keeps agents to owners and admins', () => {
    const { container } = render(<ShareDialog {...shareProps({ role: 'member', selfUserId: MEMBER.userId, invites: { items: [], loading: false, error: null } })} />);
    const dialog = within(screen.getByRole('dialog', { name: '分享画布' }));
    expect(dialog.queryByRole('button', { name: '生成邀请链接' })).toBeNull();
    expect(dialog.getByText('只有工作区的所有者和管理员能邀请人：Ada、Olive。')).toBeInTheDocument();
    expect(container.querySelectorAll('li[data-member] select')).toHaveLength(0);
    expect(dialog.queryByRole('button', { name: /高级/ })).toBeNull();
    expect(dialog.getByText('只有工作区的所有者和管理员能把 Agent 或程序接进它的画布。')).toBeInTheDocument();
    // Everyone copies the canvas's link.
    expect(dialog.getByText(CANVAS_URL)).toBeInTheDocument();
  });

  it('holds 邀请 Agent under 高级 for an owner, unchanged', () => {
    render(<ShareDialog {...shareProps()} />);
    const dialog = within(screen.getByRole('dialog', { name: '分享画布' }));
    const advanced = dialog.getByRole('button', { name: '高级：连接 Agent 或程序（MCP / API）' });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(advanced);
    expect(dialog.getByRole('button', { name: '生成令牌' })).toBeInTheDocument();
    expect(AGENTS.onCreate).not.toHaveBeenCalled();
  });

  it('says while the people load or why they could not be read', () => {
    const { rerender } = render(<ShareDialog {...shareProps({ members: { items: [], loading: true, error: null } })} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取…');
    rerender(<ShareDialog {...shareProps({ members: { items: [], loading: false, error: new TypeError('Failed to fetch') } })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('没能读取：连不上 AwwO，请检查网络后重试。');
  });

  it('closes on Escape and keeps its keys from the board', () => {
    const props = shareProps();
    const board = vi.fn();
    window.addEventListener('keydown', board);
    try {
      render(<ShareDialog {...props} />);
      const box = screen.getByRole('textbox', { name: '邮箱（可选）' });
      fireEvent.keyDown(box, { key: 'Delete' });
      expect(board).not.toHaveBeenCalled();
      fireEvent.keyDown(box, { key: 'Escape' });
      expect(props.onClose).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('keydown', board); }
  });

  it('renders in English', () => {
    const { container } = english(<ShareDialog {...shareProps({ role: 'admin', selfUserId: ADMIN.userId })} />);
    const dialog = within(screen.getByRole('dialog', { name: 'Share this canvas' }));
    expect(dialog.getByRole('button', { name: 'Close Share' })).toBeInTheDocument();
    expect(dialog.getByText(/People you invite join the workspace “Studio”/)).toBeInTheDocument();
    expect(dialog.getByRole('heading', { name: 'People in “Studio” · 4' })).toBeInTheDocument();
    expect([...(dialog.getByRole('combobox', { name: 'Access' }) as HTMLSelectElement).options].map(option => option.textContent)).toEqual(['Can view', 'Can edit']);
    expect(memberRow(container, ADMIN.userId)).toHaveTextContent('Ada (you)');
    expect(memberRow(container, MEMBER.userId)).toHaveTextContent('Here now');
    expect(dialog.getByRole('button', { name: 'Advanced: connect an Agent or a program (MCP / API)' })).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Create invitation link' })).toBeInTheDocument();
  });

  it('has its words in both languages', () => {
    const keys = (locale: 'en' | 'zh') => Object.keys(MULTIPLAYER_TEXT[locale]).filter(key => key.startsWith('share.')).sort();
    expect(keys('zh')).toEqual(keys('en'));
    expect(keys('en').length).toBeGreaterThan(40);
  });
});

describe('the 同屏 panel where people share canvases', () => {
  const state = (over: Partial<LiveState> = {}): LiveState => ({ selection: [], focus: null, cursor: null, status: null, ...over });
  const SELF: LiveParticipant = { id: 'page-self-0001', kind: 'human', port: 'web', name: 'Olive', color: '#2563eb', userId: OWNER.userId, role: 'owner', state: state(), since: '2026-11-08T10:00:00Z' };
  const panel = (over: Partial<MultiplayerPanelProps> = {}): MultiplayerPanelProps => ({ open: true, onClose: vi.fn(), participants: [SELF], selfId: SELF.id,
    claims: [], messages: [], activity: [], canWrite: true, canInvite: false, nodeTitle: () => undefined, onFocusNode: vi.fn(),
    onSend: vi.fn(async () => undefined), onRelease: vi.fn(async () => undefined), invite: AGENTS, ...over });

  it('asks a person alone on the canvas to share it, and holds no 邀请 Agent of its own', () => {
    const onShare = vi.fn();
    render(<MultiplayerPanel {...panel({ onShare })} />);
    expect(screen.getByText('现在只有你在这张画布上。分享给同事，一起编辑。')).toBeInTheDocument();
    expect(screen.queryByText(/邀请一个 Agent/)).toBeNull();
    expect(screen.queryByRole('button', { name: '邀请 Agent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '分享' }));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('is as it was where the server does not offer sharing with people', () => {
    render(<MultiplayerPanel {...panel({ canInvite: true })} />);
    expect(screen.getByText('现在只有你在这张画布上。可以在下面邀请一个 Agent 一起改。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '邀请 Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '分享' })).toBeNull();
  });
});

describe('the canvas header', () => {
  const state = (over: Partial<LiveState> = {}): LiveState => ({ selection: [], focus: null, cursor: null, status: null, ...over });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  function header(role: string, people: boolean, { hello = true } = {}) {
    const self: LiveParticipant = { id: 'page-self-0001', kind: 'human', port: 'web', name: 'Olive', color: '#2563eb', userId: OWNER.userId, role, state: state(), since: '2026-11-08T10:00:00Z' };
    // Without its hello the stream has named nobody yet, this page included (a tab past the server's streams never gets one).
    const snapshot: LiveSnapshot = { status: hello ? 'live' : 'connecting', ended: null, you: null, participants: hello ? [self] : [], claims: [], messages: [] };
    const live = { clientId: self.id, start: vi.fn(), stop: vi.fn(), snapshot: () => snapshot, subscribe: () => () => undefined, setPresence: vi.fn(),
      claim: vi.fn(), release: vi.fn(async () => undefined), say: vi.fn(), olderMessages: vi.fn(), listTokens: vi.fn(async () => []),
      createToken: vi.fn(), revokeToken: vi.fn() } as unknown as CanvasLive;
    let attention = { focus: null, selection: [] as readonly string[] };
    // The canvas surface's model names too (the header names a running AwwO Agent's model by them): none yet here.
    const names = {};
    const multiplayer = { live, recent: [], attention: { get: () => attention, set: (next: typeof attention) => { attention = next; }, subscribe: () => () => undefined },
      modelNames: { get: () => names, set: () => undefined, subscribe: () => () => undefined } } as unknown as CanvasMultiplayer;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path.endsWith('/invites') && init?.method === 'POST') return json({ id: 'inv-new', role: 'member', token: 'made-up-invitation-token', inviteUrl: 'https://awwo.example/?invite=made-up-invitation-token',
        expiresAt: '2026-11-11T10:00:00Z', email: null, canvasId: 'canvas-one', canvasName: 'Plan' }, 201);
      if (path.endsWith('/capabilities')) return json({ skills: { enabled: true }, memory: { enabled: true }, webReader: { enabled: false }, render: { enabled: false }, multiplayer: { enabled: true, maxChangeOps: 500, people } });
      if (path.endsWith('/auth/me')) return json({ user: { id: OWNER.userId, name: 'Olive', email: 'olive@example.test', platformRole: 'user' }, tenants: [{ id: 'tenant-one', name: 'Studio', role, status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] });
      if (path.endsWith('/members')) return json({ items: PEOPLE, nextCursor: null });
      if (path.endsWith('/invites')) return json({ items: [], nextCursor: null });
      return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    vi.stubGlobal('fetch', fetch);
    localStorage.setItem('superclaw_locale', 'zh');
    render(<SaaSPreferencesProvider><MultiplayerHeader multiplayer={multiplayer} tenantId="tenant-one" canvasId="canvas-one" canWrite={role !== 'reader'}
      role={role} workspaceName="Studio" nodeTitle={() => undefined} onFocusNode={vi.fn()} /></SaaSPreferencesProvider>);
    return { fetch, live };
  }

  it('offers Share where the server shares canvases with people, and opens the dialog with the workspace and its people', async () => {
    const { fetch } = header('owner', true);
    const share = await screen.findByRole('button', { name: '分享这张画布' });
    fireEvent.click(share);
    // The workspace is named at once, from the page, before its people are read.
    expect(screen.getByRole('dialog', { name: '分享画布' })).toHaveTextContent('受邀的人会加入工作区「Studio」');
    expect(screen.getByRole('dialog', { name: '分享画布' })).not.toHaveTextContent('有人');
    const dialog = await screen.findByRole('dialog', { name: '分享画布' });
    expect(await within(dialog).findByText('受邀的人会加入工作区「Studio」：能打开其中所有画布，以及它的记忆、知识、技能和对话；可编辑的人还能改动其中的 Agent。')).toBeInTheDocument();
    expect(await within(dialog).findByRole('heading', { name: '工作区「Studio」里的人 · 4' })).toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/tenants/tenant-one/invites'))).toBe(true));
    // The 同屏 panel and Share take turns.
    fireEvent.click(screen.getByRole('button', { name: /同屏/ }));
    expect(screen.queryByRole('dialog', { name: '分享画布' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '同屏' })).toHaveTextContent('分享给同事，一起编辑。');
    // Agents are under Share's 高级 then, never also in the 同屏 panel.
    expect(screen.queryByRole('button', { name: '邀请 Agent' })).toBeNull();
  });

  it('makes an invitation for this canvas, its days in hours, and an email only when one is given', async () => {
    const { fetch } = header('owner', true);
    fireEvent.click(await screen.findByRole('button', { name: '分享这张画布' }));
    const dialog = within(await screen.findByRole('dialog', { name: '分享画布' }));
    const posted = () => fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/tenants/tenant-one/invites') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    fireEvent.click(await dialog.findByRole('button', { name: '生成邀请链接' }));
    await waitFor(() => expect(posted()).toEqual([{ role: 'member', expiresInHours: 72, canvasId: 'canvas-one' }]));
    fireEvent.change(dialog.getByRole('textbox', { name: '邮箱（可选）' }), { target: { value: ' bob@example.test ' } });
    fireEvent.change(dialog.getByRole('combobox', { name: '链接有效期' }), { target: { value: '7' } });
    fireEvent.click(dialog.getByRole('button', { name: '生成邀请链接' }));
    await waitFor(() => expect(posted()[1]).toEqual({ role: 'member', expiresInHours: 168, canvasId: 'canvas-one', email: 'bob@example.test' }));
  });

  it('lets an owner whose live stream has not said hello connect Agents', async () => {
    const { fetch } = header('owner', false, { hello: false });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/capabilities'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /同屏/ }));
    expect(screen.getByRole('button', { name: '邀请 Agent' })).toBeInTheDocument();
  });

  it('asks a member’s workspace for no invitations', async () => {
    const { fetch } = header('member', true);
    fireEvent.click(await screen.findByRole('button', { name: '分享这张画布' }));
    expect(await screen.findByText('只有工作区的所有者和管理员能邀请人：Ada、Olive。')).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/invites'))).toBe(false);
  });

  it('keeps today’s canvas where the server does not offer it: no Share, and 邀请 Agent only for owners and admins', async () => {
    const { fetch } = header('member', false);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/capabilities'))).toBe(true));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: '分享这张画布' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /同屏/ }));
    expect(screen.getByRole('dialog', { name: '同屏' })).toHaveTextContent('现在只有你在这张画布上。');
    expect(screen.queryByRole('button', { name: '邀请 Agent' })).toBeNull();
    cleanup();
    header('admin', false);
    fireEvent.click(screen.getByRole('button', { name: /同屏/ }));
    expect(screen.getByRole('button', { name: '邀请 Agent' })).toBeInTheDocument();
  });
});
