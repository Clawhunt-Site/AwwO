import { useEffect, useState, type ReactNode } from 'react';
import { api, SaaSApiError, type Identity } from './api';
import { useSaaSPreferences } from './preferences';

type InvitePreview = { tenantId: string; tenantName: string; role: string; expiresAt: string; status: string };
export function InviteAcceptance({ token, identity, controls }: { token: string; identity: Identity; controls: ReactNode }) {
  const { locale, t } = useSaaSPreferences();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [accepted, setAccepted] = useState<{ tenantId: string; role: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setPreview(null); setError(null);
    api<InvitePreview>(`/invites/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPreview(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error); });
    return () => controller.abort();
  }, [token, identity.user.id, revision]);
  const reason = (status: string) => ({
    expired: t('邀请已过期，请联系管理员创建新链接。', 'This invitation has expired. Ask an administrator for a new link.'),
    revoked: t('邀请已撤销，请联系管理员。', 'This invitation has been revoked. Contact an administrator.'),
    unavailable: t('邀请创建者已无权授予此角色，请联系工作区所有者。', 'The inviter can no longer grant this role. Contact the workspace owner.'),
    suspended: t('工作区已暂停，暂时不能加入。', 'This workspace is suspended and cannot be joined.'),
    accepted: t('链接已被领取。若由当前账号领取，可确认查看原有成员身份。', 'This link has been claimed. If you claimed it, confirm to return to your membership.'),
  }[status] || '');
  const errorText = error instanceof SaaSApiError ? ({
    invite_used: t('此邀请已被其他账号领取。', 'This invitation has been claimed by another account.'),
    invite_membership_removed: t('你原来的成员身份已被移除，请索取新邀请。', 'Your previous membership was removed. Request a new invitation.'),
    not_found: t('找不到此邀请，请核对链接。', 'Invitation not found. Check the link.'),
    invite_expired: reason('expired'), invite_revoked: reason('revoked'), invite_unavailable: reason('unavailable'), tenant_suspended: reason('suspended'),
  }[error.code] || error.message) : error instanceof Error ? error.message : t('邀请暂时无法读取。', 'The invitation could not be loaded.');
  const roleLabel = (role: string) => ({ reader: t('只读成员', 'Reader'), member: t('成员', 'Member'), admin: t('管理员', 'Administrator'), owner: t('所有者', 'Owner') }[role] || role);
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><h1>{t('加入工作区', 'Join a workspace')}</h1><p>{t(`当前账号：${identity.user.email}`, `Signed in as ${identity.user.email}`)}</p></section>
    <section className="saas-card saas-invite-acceptance">
      {Boolean(error) && <p role="alert" className="saas-error">{errorText}</p>}
      {accepted ? <><h2>{t('已加入工作区', 'Workspace joined')}</h2><p role="status">{t('你的当前角色：', 'Your current role: ')}{roleLabel(accepted.role)}</p><a className="saas-primary-link" href={`/?tenant=${encodeURIComponent(accepted.tenantId)}`}>{t('打开工作区', 'Open workspace')}</a></> : preview ? <>
        <h2>{preview.tenantName}</h2><p>{t('邀请角色：', 'Invited role: ')}{roleLabel(preview.role)}</p><p>{t('到期时间：', 'Expires: ')}{new Date(preview.expiresAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</p>
        {reason(preview.status) && <p role="status">{reason(preview.status)}</p>}
        <p>{t('确认后将加入此工作区。已有成员身份会保留原角色，不会因链接自动提权。', 'Confirm to join this workspace. Existing members keep their current role; this link will not automatically elevate it.')}</p>
        <button className="saas-primary" disabled={busy || !['active', 'accepted'].includes(preview.status)} onClick={async () => {
          setBusy(true); setError(null);
          try { setAccepted(await api(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' })); }
          catch (error) { setError(error); } finally { setBusy(false); }
        }}>{busy ? t('正在确认…', 'Confirming…') : t('确认加入', 'Confirm membership')}</button>
      </> : !error && <p role="status">{t('正在读取邀请…', 'Loading invitation…')}</p>}
      {!accepted && <><button onClick={() => setRevision(value => value + 1)} disabled={busy}>{t('重新读取邀请', 'Reload invitation')}</button><a href="/">{t('暂不加入，返回工作区', 'Return without joining')}</a></>}
    </section></main>;
}
