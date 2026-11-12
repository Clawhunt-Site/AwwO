import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, SaaSApiError, type Identity } from './api';
import { useSaaSPreferences } from './preferences';

/** A workspace invitation as its link shows it (GET /invites/{token}, invitations.go previewInvite): the canvas it opens,
 *  when it was sent from one, and, when it is bound to an email, that email masked and whether it is this account's. */
type InvitePreview = { tenantId: string; tenantName: string; role: string; expiresAt: string; status: string;
  canvasId?: string; canvasName?: string; email?: string; emailMatches?: boolean };
type Accepted = { tenantId: string; role: string; canvasId?: string };

/** Where a joined workspace opens: the canvas the invitation was sent from, while it still exists, else the workspace. */
export function joinedURL(accepted: Accepted): string {
  const tenant = `/?tenant=${encodeURIComponent(accepted.tenantId)}`;
  return accepted.canvasId ? `${tenant}&canvas=${encodeURIComponent(accepted.canvasId)}` : tenant;
}

export function InviteAcceptance({ token, identity, controls, navigate = url => window.location.assign(url) }: {
  token: string; identity: Identity; controls: ReactNode;
  /** Opens the canvas (or workspace) once joined; the page itself in production. */
  navigate?: (url: string) => void;
}) {
  const { locale, t } = useSaaSPreferences();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const opened = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setPreview(null); setError(null);
    api<InvitePreview>(`/invites/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPreview(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error); });
    return () => controller.abort();
  }, [token, identity.user.id, revision]);
  // Joined: the link to what it opens takes the keyboard, while the page goes there.
  useEffect(() => { if (accepted) opened.current?.focus(); }, [accepted]);
  const reason = (status: string) => ({
    expired: t('邀请已过期，请联系管理员创建新链接。', 'This invitation has expired. Ask an administrator for a new link.'),
    revoked: t('邀请已撤销，请联系管理员。', 'This invitation has been revoked. Contact an administrator.'),
    unavailable: t('邀请创建者已无权授予此角色，请联系工作区所有者。', 'The inviter can no longer grant this role. Contact the workspace owner.'),
    suspended: t('工作区已暂停，暂时不能加入。', 'This workspace is suspended and cannot be joined.'),
    // The free trial's end has the workspace closed (invitations.go previewInvite): nobody joins until its owner subscribes.
    closed: t('这个工作区的免费试用已结束，所有者订阅 Pro、Max 或 Ultra 后才能加入。邀请在有效期内仍然可用。', 'This workspace’s free trial has ended: it can be joined once its owner subscribes to Pro, Max or Ultra. The invitation stays good until it expires.'),
    accepted: t('链接已被领取。若由当前账号领取，可确认查看原有成员身份。', 'This link has been claimed. If you claimed it, confirm to return to your membership.'),
  }[status] || '');
  const errorText = error instanceof SaaSApiError ? ({
    invite_used: t('此邀请已被其他账号领取。', 'This invitation has been claimed by another account.'),
    invite_membership_removed: t('你原来的成员身份已被移除，请索取新邀请。', 'Your previous membership was removed. Request a new invitation.'),
    invite_wrong_account: t('这个邀请是发给另一个邮箱的：请用收到邀请的那个邮箱的账号登录，再打开链接。', 'This invitation was sent to another email: sign in with the account of the email it was sent to, then open the link again.'),
    not_found: t('找不到此邀请，请核对链接。', 'Invitation not found. Check the link.'),
    invite_expired: reason('expired'), invite_revoked: reason('revoked'), invite_unavailable: reason('unavailable'), tenant_suspended: reason('suspended'),
    free_plan_ended: reason('closed'),
  }[error.code] || error.message) : error instanceof Error ? error.message : t('邀请暂时无法读取。', 'The invitation could not be loaded.');
  const roleLabel = (role: string) => ({ reader: t('只读成员', 'Reader'), member: t('成员', 'Member'), admin: t('管理员', 'Administrator'), owner: t('所有者', 'Owner') }[role] || role);
  // A bound invitation for another email: while it waits for its person it says whose it is and is not offered to this
  // account. One already taken is offered, as the server lets the account that took it confirm again (invitations.go
  // acceptInvite, which asks no email of it) and tells any other account it is used.
  const otherEmail = preview?.email !== undefined && preview.emailMatches === false;
  const otherAccount = otherEmail && (preview?.status === 'active' || preview?.status === 'closed');
  const opensCanvas = Boolean(preview?.canvasId && preview.canvasName);
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><h1>{t('加入工作区', 'Join a workspace')}</h1><p>{t(`当前账号：${identity.user.email}`, `Signed in as ${identity.user.email}`)}</p></section>
    <section className="saas-card saas-invite-acceptance">
      {Boolean(error) && <p role="alert" className="saas-error">{errorText}</p>}
      {accepted ? <><h2>{t('已加入工作区', 'Workspace joined')}</h2><p role="status">{t('你的当前角色：', 'Your current role: ')}{roleLabel(accepted.role)}</p>
        <a ref={opened} className="saas-primary-link" href={joinedURL(accepted)}>{accepted.canvasId ? t('打开画布', 'Open the canvas') : t('打开工作区', 'Open workspace')}</a></> : preview ? <>
        <h2>{preview.tenantName}</h2>
        {opensCanvas && <p>{t(`邀请你打开画布「${preview.canvasName}」。`, `You are invited to the canvas “${preview.canvasName}”.`)}</p>}
        <p>{t('邀请角色：', 'Invited role: ')}{roleLabel(preview.role)}</p><p>{t('到期时间：', 'Expires: ')}{new Date(preview.expiresAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</p>
        {preview.email !== undefined && <p role={otherAccount ? 'alert' : undefined} className={otherAccount ? 'saas-error' : undefined}>{otherAccount
          ? t(`这个邀请是发给 ${preview.email} 的，不是当前账号：请用那个邮箱的账号登录后再打开这个链接。`, `This invitation was sent to ${preview.email}, not to this account: sign in with that email’s account, then open this link again.`)
          : otherEmail ? t(`这个邀请是发给 ${preview.email} 的。`, `This invitation was sent to ${preview.email}.`)
            : t(`这个邀请是发给你的邮箱（${preview.email}）的。`, `This invitation was sent to your email (${preview.email}).`)}</p>}
        {reason(preview.status) && <p role="status">{reason(preview.status)}</p>}
        {preview.status !== 'closed' && <p>{t('确认后将加入此工作区，能打开其中所有画布。已有成员身份会保留原角色，不会因链接自动提权。', 'Confirm to join this workspace and open all its canvases. Existing members keep their current role; this link will not automatically elevate it.')}</p>}
        <button className="saas-primary" disabled={busy || otherAccount || !['active', 'accepted'].includes(preview.status)} onClick={async () => {
          setBusy(true); setError(null);
          try {
            const joined = await api<Accepted>(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' });
            setAccepted(joined);
            // The canvas it was sent from opens at once: that is where the person was asked to come.
            if (joined.canvasId) navigate(joinedURL(joined));
          }
          catch (error) { setError(error); } finally { setBusy(false); }
        }}>{busy ? t('正在确认…', 'Confirming…') : opensCanvas ? t('加入并打开画布', 'Join and open the canvas') : t('确认加入', 'Confirm membership')}</button>
      </> : !error && <p role="status">{t('正在读取邀请…', 'Loading invitation…')}</p>}
      {!accepted && <><button onClick={() => setRevision(value => value + 1)} disabled={busy}>{t('重新读取邀请', 'Reload invitation')}</button><a href="/">{t('暂不加入，返回工作区', 'Return without joining')}</a></>}
    </section></main>;
}
