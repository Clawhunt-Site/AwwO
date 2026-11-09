// 分享 / Share: share a canvas with people. In phase 1 a person
// joins the canvas's workspace, so the dialog says what that grants and who pays before anyone is invited. Owners and
// admins invite people (a single-use link, bound to an email or not, that opens this canvas), see the invitations still
// waiting and revoke them, and change or remove anyone's access as the server lets them (resources.go changeMember);
// everyone sees who is in the workspace and who is here now, and copies this canvas's link. Agents and programs come in
// under 高级, as the 同屏 panel's 邀请 Agent did (AgentInvite, unchanged), for owners and admins only.
//
// Controlled, as the 同屏 panel is: it shows what it is given and hands every action to its callbacks; it talks to no
// server. A link just made is in its own state only, shown once, and goes as the dialog closes.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { AgentInvite, CopyBlock, type AgentInviteProps } from './AgentInvite';
import { useBelowHeader } from './belowHeader';
import { NEUTRAL_COLOR, participantColorStyle } from './MultiplayerBar';
import { failureDetail, mt, participantInitials, shortDate, useMultiplayerText, type MultiplayerTextKey } from './multiplayerText';
import type { UiLocale } from '../../locale';
import './multiplayer.css';

export type ShareRole = 'reader' | 'member' | 'admin' | 'owner';

/** A person in the workspace as its members list gives them (tenant_pagination.go): their email only to owners and admins. */
export interface ShareMember { userId: string; name: string; role: ShareRole; email?: string }
/** An invitation as the owners' and admins' list gives it. */
export interface ShareInvite {
  id: string; role: ShareRole; status: string; expiresAt: string;
  email?: string | null; canvasId?: string | null; canvasName?: string | null;
}
/** An invitation just made: its link, shown once. */
export interface CreatedShareInvite { id: string; role: ShareRole; inviteUrl: string; expiresAt: string; email?: string | null }
export interface ShareList<T> { items: readonly T[]; loading: boolean; error: unknown; more?: boolean }

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  /** The workspace's name; '' while unknown. */
  workspaceName: string;
  /** This person's role in the workspace; null while unknown (nothing is offered then). */
  role: ShareRole | null;
  selfUserId: string;
  /** This canvas: its invitations are marked as opening it. */
  canvasId: string;
  /** The link that opens this canvas for people in the workspace. */
  canvasUrl: string;
  members: ShareList<ShareMember>;
  /** The workspace's invitations (owners and admins read them). */
  invites: ShareList<ShareInvite>;
  /** The people on this canvas now (their account ids), and their colours. */
  here: ReadonlyMap<string, string | undefined>;
  onCreateInvite: (input: { email: string; role: ShareRole; days: number }) => Promise<CreatedShareInvite>;
  onRevokeInvite: (id: string) => Promise<void>;
  onChangeRole: (userId: string, role: ShareRole) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
  /** 高级: connecting Agents and programs (the 同屏 panel's 邀请 Agent), for owners and admins; absent for others. */
  agents?: AgentInviteProps;
}

/** The expiries an invitation can be made with, in days; three unless chosen (the server's 72 hours). */
export const SHARE_DAYS: readonly number[] = [1, 3, 7];
const DEFAULT_SHARE_DAYS = 3;

const manages = (role: ShareRole | null) => role === 'owner' || role === 'admin';
/** The access an owner or an admin grants (invitations.go grantAllowed): an admin never makes another admin. */
export function grantable(role: ShareRole | null): ShareRole[] {
  return role === 'owner' ? ['reader', 'member', 'admin'] : role === 'admin' ? ['reader', 'member'] : [];
}
/** Whether a role may change or remove a member, as the server judges it (resources.go changeMember): never the owner,
 *  and an admin never another admin. Never one's own here: a person leaves in Settings. */
export function mayManage(role: ShareRole | null, member: ShareMember, selfUserId: string): boolean {
  if (!manages(role) || member.userId === selfUserId || member.role === 'owner') return false;
  return role === 'owner' || member.role !== 'admin';
}

const ROLE_ORDER: Record<ShareRole, number> = { owner: 0, admin: 1, member: 2, reader: 3 };
const ROLE_KEYS: Record<ShareRole, MultiplayerTextKey> = { owner: 'share.role.owner', admin: 'share.role.admin', member: 'share.role.member', reader: 'share.role.reader' };
export const shareRoleLabel = (locale: UiLocale, role: ShareRole) => mt(locale, ROLE_KEYS[role] ?? 'share.role.member');

/** An email as the server keeps an invitation's: trimmed and in lower case. */
const normalEmail = (value: string) => value.trim().toLowerCase();

export function ShareDialog(props: ShareDialogProps) {
  return props.open ? <ShareBody {...props} /> : null;
}

/** Gives the focus back as the dialog closes to what had it as it opened (its opener, the header's Share button). */
function useFocusReturn(dialog: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body && active.isConnected
      ? active : document.querySelector<HTMLElement>('button.awwo-multiplayer-share-button');
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || Boolean(dialog.current?.contains(now));
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [dialog]);
}

function ShareBody({ onClose, workspaceName, role, selfUserId, canvasId, canvasUrl, members, invites, here, onCreateInvite, onRevokeInvite,
  onChangeRole, onRemove, agents }: ShareDialogProps) {
  const { t } = useMultiplayerText();
  const headingId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // While an Agent token just made is on screen: its 「已保存，关闭」 (AgentInvite), the one way its secret goes.
  const secretDone = useRef<HTMLButtonElement | null>(null);
  useFocusReturn(dialogRef);
  useBelowHeader(dialogRef);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The dialog's keys are its own: the board's (Delete removes the selected nodes, Escape lets them go) never see them.
    event.stopPropagation();
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const done = secretDone.current;
    if (done?.isConnected) { event.preventDefault(); done.focus({ preventScroll: true }); return; }
    onClose();
  };
  // The page passes the workspace's name it holds (never empty: a workspace is made with one); … only if it ever is.
  const workspace = workspaceName.trim() || '…';
  return <aside className="awwo-multiplayer-panel awwo-multiplayer-share" ref={dialogRef} role="dialog" aria-labelledby={headingId} onKeyDown={onKeyDown}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <header className="awwo-multiplayer-panel-head">
      <div className="awwo-multiplayer-panel-heading"><h2 id={headingId} ref={headingRef} tabIndex={-1}>{t('share.title')}</h2></div>
      <button type="button" className="awwo-multiplayer-close" aria-label={t('share.close')} title={t('share.close')} onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    <div className="awwo-multiplayer-panel-body">
      <section className="awwo-multiplayer-section awwo-multiplayer-share-terms" aria-label={t('share.title')}>
        <p className="awwo-multiplayer-hint">{t('share.joins', { workspace })}</p>
        <p className="awwo-multiplayer-hint">{t('share.pays')}</p>
      </section>
      {role !== null && (manages(role)
        ? <InvitePeople role={role} members={members.items} invites={invites} canvasId={canvasId} onCreate={onCreateInvite} onRevoke={onRevokeInvite} />
        : <WhoInvites members={members.items} />)}
      <People workspace={workspace} role={role} selfUserId={selfUserId} members={members} here={here} onChangeRole={onChangeRole} onRemove={onRemove} />
      <section className="awwo-multiplayer-section awwo-multiplayer-share-link" aria-label={t('share.canvasLink')}>
        <CopyBlock label={t('share.canvasLink')} value={canvasUrl} />
        <p className="awwo-multiplayer-hint">{t('share.canvasLinkHint')}</p>
      </section>
      {agents && manages(role)
        ? <AgentInvite {...agents} label={t('share.advanced')} onSecretShown={done => { secretDone.current = done; agents.onSecretShown?.(done); }} />
        : role !== null && <section className="awwo-multiplayer-section"><p className="awwo-multiplayer-hint">{t('share.advancedMembers')}</p></section>}
    </div>
  </aside>;
}

/** A titled part of the dialog. With `headingRef`, its title takes the focus when what had it goes (a removed person,
 *  a revoked invitation), so the keyboard stays in the dialog, never on the board behind it. */
function Section({ title, className, headingRef, children }: { title: string; className: string; headingRef?: RefObject<HTMLHeadingElement | null>; children: ReactNode }) {
  const id = useId();
  return <section className={`awwo-multiplayer-section ${className}`} aria-labelledby={id}>
    <h3 id={id} ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="awwo-multiplayer-section-title">{title}</h3>
    {children}
  </section>;
}

/** A member's view of who invites: the owner's and admins' names. */
function WhoInvites({ members }: { members: readonly ShareMember[] }) {
  const { locale, t } = useMultiplayerText();
  const names = members.filter(member => member.role === 'owner' || member.role === 'admin').map(member => member.name.trim()).filter(Boolean);
  return <Section title={t('share.invite')} className="awwo-multiplayer-share-invite">
    <p className="awwo-multiplayer-hint">{names.length
      ? t('share.whoInvites', { names: names.join(locale === 'zh' ? '、' : ', ') }) : t('share.whoInvitesBare')}</p>
  </Section>;
}

function InvitePeople({ role, members, invites, canvasId, onCreate, onRevoke }: {
  role: ShareRole; members: readonly ShareMember[]; invites: ShareList<ShareInvite>; canvasId: string;
  onCreate: ShareDialogProps['onCreateInvite']; onRevoke: ShareDialogProps['onRevokeInvite'];
}) {
  const { locale, t } = useMultiplayerText();
  const roles = grantable(role);
  const [email, setEmail] = useState('');
  const [access, setAccess] = useState<ShareRole>('member');
  const [days, setDays] = useState(DEFAULT_SHARE_DAYS);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<CreatedShareInvite | null>(null);
  const emailId = useId();
  const hintId = useId();
  const accessId = useId();
  const daysId = useId();
  // An email that is already a member's: their access is changed in the list, not by a new invitation.
  const already = useMemo(() => {
    const wanted = normalEmail(email);
    return wanted ? members.find(member => member.email && normalEmail(member.email) === wanted) : undefined;
  }, [email, members]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError('');
    try {
      const made = await onCreate({ email: email.trim(), role: access, days });
      if (!made || typeof made.inviteUrl !== 'string' || !made.inviteUrl) throw new Error('');
      setCreated(made);
      setEmail('');
    } catch (failure) {
      setError(t('share.createFailed', { detail: failureDetail(locale, failure) }));
    } finally {
      setCreating(false);
    }
  };
  const pending = invites.items.filter(item => item.status === 'active');
  const heading = useRef<HTMLHeadingElement>(null);
  return <Section title={t('share.invite')} className="awwo-multiplayer-share-invite" headingRef={heading}>
    <form className="awwo-multiplayer-invite-form" onSubmit={submit}>
      <label className="awwo-multiplayer-label" htmlFor={emailId}>{t('share.email')}</label>
      <input id={emailId} className="awwo-multiplayer-field" type="email" autoComplete="off" value={email} maxLength={320}
        aria-describedby={hintId} onChange={event => setEmail(event.target.value)} />
      <p id={hintId} className="awwo-multiplayer-hint">{already ? t('share.emailMember', { name: already.name.trim() || already.email || '' }) : t('share.emailHint')}</p>
      <label className="awwo-multiplayer-label" htmlFor={accessId}>{t('share.access')}</label>
      <select id={accessId} className="awwo-multiplayer-field" value={access} onChange={event => setAccess(event.target.value as ShareRole)}>
        {roles.map(value => <option key={value} value={value}>{shareRoleLabel(locale, value)}</option>)}
      </select>
      <label className="awwo-multiplayer-label" htmlFor={daysId}>{t('share.expires')}</label>
      <select id={daysId} className="awwo-multiplayer-field" value={days} onChange={event => setDays(Number(event.target.value))}>
        {SHARE_DAYS.map(count => <option key={count} value={count}>{count === 1 ? t('share.daysOne') : t('share.daysMany', { days: count })}</option>)}
      </select>
      <button type="submit" className="awwo-multiplayer-primary" disabled={creating || !roles.includes(access) || Boolean(already)}>
        {t(creating ? 'share.creating' : 'share.create')}
      </button>
      {error && <p className="awwo-multiplayer-error" role="alert">{error}</p>}
    </form>
    {created && <div className="awwo-multiplayer-share-created" role="status">
      {/* Keyed by the invitation: a new link starts as not copied yet. */}
      <CopyBlock key={created.id} label={t('share.linkLabel')} value={created.inviteUrl} />
      <p className="awwo-multiplayer-hint">{created.email
        ? t('share.linkFor', { email: created.email, date: shortDate(locale, created.expiresAt) })
        : t('share.linkAnyone', { date: shortDate(locale, created.expiresAt) })}</p>
      <p className="awwo-multiplayer-hint">{t('share.linkSend')}</p>
    </div>}
    {invites.error !== null && invites.error !== undefined && <p className="awwo-multiplayer-error" role="alert">{t('share.loadFailed', { detail: failureDetail(locale, invites.error) })}</p>}
    {pending.length > 0 && <div className="awwo-multiplayer-share-pending">
      <h4 className="awwo-multiplayer-label">{t('share.pending', { count: pending.length })}</h4>
      <ul className="awwo-multiplayer-list">
        {pending.map(item => <PendingInvite key={item.id} item={item} canvasId={canvasId} revocable={grantable(role).includes(item.role)} onRevoke={onRevoke}
          onRevoked={() => heading.current?.focus({ preventScroll: true })} />)}
      </ul>
    </div>}
  </Section>;
}

function PendingInvite({ item, canvasId, revocable, onRevoke, onRevoked }: {
  item: ShareInvite; canvasId: string; revocable: boolean; onRevoke: (id: string) => Promise<void>; onRevoked: () => void;
}) {
  const { locale, t } = useMultiplayerText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const who = item.email || t('share.inviteAnyone');
  const opens = item.canvasId === canvasId ? t('share.inviteHere') : item.canvasId && item.canvasName ? t('share.inviteThere', { canvas: item.canvasName }) : '';
  const revoke = async () => {
    setBusy(true);
    setError('');
    try {
      await onRevoke(item.id);
      // This row goes once the list is read again, and its button with the focus: the section's title takes it.
      onRevoked();
    } catch (failure) {
      setError(t('share.revokeFailed', { detail: failureDetail(locale, failure) }));
    } finally {
      setBusy(false);
    }
  };
  return <li className="awwo-multiplayer-share-row" data-invite={item.id}>
    <div className="awwo-multiplayer-person-main">
      <span className="awwo-multiplayer-person-name">{who}</span>
      <span className="awwo-multiplayer-hint">{[t('share.inviteMeta', { access: shareRoleLabel(locale, item.role), date: shortDate(locale, item.expiresAt) }), opens].filter(Boolean).join(' · ')}</span>
      {error && <p className="awwo-multiplayer-error" role="alert">{error}</p>}
    </div>
    {revocable && <button type="button" className="awwo-multiplayer-small-button is-danger" aria-label={t('share.revokeLabel', { who })} disabled={busy}
      onClick={() => { void revoke(); }}>{t(busy ? 'share.revoking' : 'share.revoke')}</button>}
  </li>;
}

function People({ workspace, role, selfUserId, members, here, onChangeRole, onRemove }: {
  workspace: string; role: ShareRole | null; selfUserId: string; members: ShareList<ShareMember>; here: ReadonlyMap<string, string | undefined>;
  onChangeRole: ShareDialogProps['onChangeRole']; onRemove: ShareDialogProps['onRemove'];
}) {
  const { locale, t } = useMultiplayerText();
  const ordered = useMemo(() => [...members.items].sort((a, b) => Number(b.userId === selfUserId) - Number(a.userId === selfUserId)
    || (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.name.localeCompare(b.name, locale === 'zh' ? 'zh-CN' : 'en')), [members.items, selfUserId, locale]);
  const failed = members.error !== null && members.error !== undefined;
  const heading = useRef<HTMLHeadingElement>(null);
  return <Section title={t('share.people', { workspace, count: members.items.length })} className="awwo-multiplayer-share-people" headingRef={heading}>
    {members.loading && !members.items.length && <p className="awwo-multiplayer-hint" role="status">{t('share.loading')}</p>}
    {failed && <p className="awwo-multiplayer-error" role="alert">{t('share.loadFailed', { detail: failureDetail(locale, members.error) })}</p>}
    {ordered.length > 0 && <ul className="awwo-multiplayer-list">
      {ordered.map(member => <MemberRow key={member.userId} member={member} self={member.userId === selfUserId} workspace={workspace}
        here={here.has(member.userId)} color={here.get(member.userId)} editable={mayManage(role, member, selfUserId)} roles={grantable(role)}
        onChangeRole={onChangeRole} onRemove={onRemove} onRemoved={() => heading.current?.focus({ preventScroll: true })} />)}
    </ul>}
    {members.more && <p className="awwo-multiplayer-hint">{t('share.morePeople')}</p>}
  </Section>;
}

function MemberRow({ member, self, workspace, here, color, editable, roles, onChangeRole, onRemove, onRemoved }: {
  member: ShareMember; self: boolean; workspace: string; here: boolean; color: string | undefined; editable: boolean; roles: ShareRole[];
  onChangeRole: ShareDialogProps['onChangeRole']; onRemove: ShareDialogProps['onRemove']; onRemoved: () => void;
}) {
  const { locale, t } = useMultiplayerText();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const removeButton = useRef<HTMLButtonElement>(null);
  const name = member.name.trim() || t('someone');
  const shown = self ? t('self.name', { name }) : name;
  // Whom its controls and messages name: the person's name, else (one the server names by nothing, tenant_pagination.go)
  // the email an owner or admin sees, so two such people's controls are told apart; 「有人」 / "Someone" with neither.
  const target = member.name.trim() || member.email?.trim() || name;
  const act = async (action: () => Promise<void>, failed: MultiplayerTextKey, done?: () => void) => {
    setBusy(true);
    setError('');
    try { await action(); setConfirming(false); done?.(); }
    catch (failure) { setError(t(failed, { name: target, detail: failureDetail(locale, failure) })); }
    finally { setBusy(false); }
  };
  // The confirmation goes with the focus in it: back to this person's 移除.
  const cancel = () => { setConfirming(false); removeButton.current?.focus({ preventScroll: true }); };
  return <li className="awwo-multiplayer-share-row" data-member={member.userId} data-self={self || undefined}>
    <span className="awwo-multiplayer-avatar awwo-multiplayer-avatar--sm" data-kind="human" style={participantColorStyle(color ?? NEUTRAL_COLOR)}>
      <span className="awwo-multiplayer-initials" aria-hidden="true">{participantInitials(name)}</span>
    </span>
    <div className="awwo-multiplayer-person-main">
      <span className="awwo-multiplayer-person-name">{shown}</span>
      {member.email && <span className="awwo-multiplayer-hint">{member.email}</span>}
      {here && <span className="awwo-multiplayer-share-here"><span className="awwo-multiplayer-dot" data-status="live" aria-hidden="true" />{t('share.here')}</span>}
      {confirming && <div className="awwo-multiplayer-confirm" role="group" aria-label={t('share.removeLabel', { name: target })}>
        <p>{t('share.removeConfirm', { name: target, workspace })}</p>
        <div className="awwo-multiplayer-confirm-actions">
          {/* Removed, this row goes once the list is read again: the section's title takes the focus. */}
          <button type="button" className="awwo-multiplayer-small-button is-danger" disabled={busy} onClick={() => { void act(() => onRemove(member.userId), 'share.removeFailed', onRemoved); }}>
            {t(busy ? 'share.removing' : 'share.remove')}
          </button>
          <button type="button" className="awwo-multiplayer-small-button" disabled={busy} autoFocus onClick={cancel}>{t('share.cancel')}</button>
        </div>
      </div>}
      {error && <p className="awwo-multiplayer-error" role="alert">{error}</p>}
    </div>
    {editable ? <div className="awwo-multiplayer-share-controls">
      <select className="awwo-multiplayer-field" aria-label={t('share.roleFor', { name: target })} value={member.role} disabled={busy}
        onChange={event => { const next = event.target.value as ShareRole; if (next !== member.role) void act(() => onChangeRole(member.userId, next), 'share.changeFailed'); }}>
        {roles.includes(member.role) ? null : <option value={member.role}>{shareRoleLabel(locale, member.role)}</option>}
        {roles.map(value => <option key={value} value={value}>{shareRoleLabel(locale, value)}</option>)}
      </select>
      <button type="button" ref={removeButton} className="awwo-multiplayer-small-button is-danger" aria-label={t('share.removeLabel', { name: target })} aria-expanded={confirming}
        disabled={busy} onClick={() => setConfirming(was => !was)}>{t('share.remove')}</button>
    </div> : <span className="awwo-multiplayer-port">{shareRoleLabel(locale, member.role)}</span>}
  </li>;
}
