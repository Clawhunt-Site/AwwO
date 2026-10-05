import { useEffect, useState } from 'react';
import { Check, Copy, Link as LinkIcon } from 'lucide-react';
import { api, SaaSApiError, saasErrorMessage, type Identity } from './api';
import { clawHuntInviteLink } from './clawhuntAuth';
import { useSaaSPreferences } from './preferences';
import './invite-friends.css';

export type InviteStatus = 'unused' | 'used' | 'revoked';
export type ClawHuntInvites = { member: boolean; limit: number; codes: Array<{ code: string; status: InviteStatus }> };

const CODE = /^AWWO(-[0-9A-Z]{4}){3}$/;
const STATUSES: readonly string[] = ['unused', 'used', 'revoked'];

/** The API's answer in its documented shape, or null: nothing else is ever rendered or copied. */
export function readInvites(value: unknown): ClawHuntInvites | null {
  if (!value || typeof value !== 'object') return null;
  const { member, limit, codes } = value as Record<string, unknown>;
  if (typeof member !== 'boolean' || typeof limit !== 'number' || !Array.isArray(codes)) return null;
  const valid = codes.every(item => item && typeof item === 'object'
    && typeof (item as { code?: unknown }).code === 'string' && CODE.test((item as { code: string }).code)
    && STATUSES.includes((item as { status?: unknown }).status as string));
  if (!valid || codes.length > limit || (!member && codes.length > 0)) return null;
  return { member, limit, codes: codes as ClawHuntInvites['codes'] };
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* fall back to a selection below */ }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  area.remove();
  return copied;
}

type Load = { phase: 'loading' } | { phase: 'ready'; data: ClawHuntInvites } | { phase: 'none' } | { phase: 'error'; error?: unknown };

/** The account's own AwwO invite codes, from ClawHunt: each one opens AwwO for one friend. */
export function InviteFriends({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);
  const linked = identity.authentication === 'clawhunt';
  useEffect(() => {
    // Codes come with a ClawHunt account. For a linked one every failure, a 404 included (an API
    // older than this page), reads as "unavailable", never as "you have no ClawHunt account".
    if (!linked) { setLoad({ phase: 'none' }); return; }
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    api<unknown>('/auth/clawhunt/invites', { method: 'POST', signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        const data = readInvites(value);
        setLoad(data ? { phase: 'ready', data } : { phase: 'error' });
      })
      .catch(error => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', error });
      });
    return () => controller.abort();
  }, [identity.user.id, linked, revision]);
  const statusLabel: Record<InviteStatus, string> = { unused: t('未使用', 'Unused'), used: t('已使用', 'Used'), revoked: t('已失效', 'No longer valid') };
  const copy = async (key: string, value: string) => {
    const ok = await copyText(value);
    setCopyFailed(!ok);
    setCopied(ok ? key : '');
  };
  if (load.phase === 'loading') return <section className="saas-card saas-invite-friends" role="status">{t('正在读取你的邀请码…', 'Loading your invite codes…')}</section>;
  if (load.phase === 'none') return <section className="saas-card saas-invite-friends"><p>{t('邀请码随 ClawHunt 账号提供。使用 ClawHunt 账号登录 AwwO 后即可在这里看到。', 'Invite codes come with a ClawHunt account. Sign in to AwwO with ClawHunt to see yours here.')}</p></section>;
  if (load.phase === 'error') {
    const error = load.error instanceof SaaSApiError ? load.error : null;
    // An ended session has its own notice and way back in; a retry here could only fail again.
    if (error?.status === 401) return null;
    const message = error?.status === 429 ? t('请求太频繁，请等一分钟再试。', 'Too many requests. Wait a minute and try again.')
      : !error || error.status >= 500 || error.status === 404 || error.code === 'invites_unavailable' ? t('暂时无法读取你的邀请码，请稍后再试。', 'Your invite codes are unavailable right now. Try again in a moment.')
      : saasErrorMessage(error, locale);
    return <section className="saas-card saas-invite-friends">
      <p role="alert" className="saas-error">{message}</p>
      <button type="button" onClick={() => setRevision(value => value + 1)}>{t('重试', 'Retry')}</button>
    </section>;
  }
  const { data } = load;
  if (!data.member || data.codes.length === 0) {
    return <section className="saas-card saas-invite-friends"><p>{t('这个账号暂时没有可分享的邀请码。', 'This account has no invite codes to share yet.')}</p></section>;
  }
  const left = data.codes.filter(item => item.status === 'unused').length;
  return <section className="saas-card saas-invite-friends" aria-labelledby="saas-invite-friends-title">
    <h2 id="saas-invite-friends-title">{t('你的邀请码', 'Your invite codes')}</h2>
    <p className="saas-invite-friends-summary">{t(`还可邀请 ${left} 位好友。把邀请链接发给好友，对方注册或登录 ClawHunt 后即可开通 AwwO；每个邀请码只能用一次。`, `${left} of ${data.codes.length} left. Send a friend the invite link: they sign up or sign in to ClawHunt and AwwO opens for them. Each code works once.`)}</p>
    <ul className="saas-invite-list">
      {data.codes.map((item, index) => {
        const link = clawHuntInviteLink(item.code, identity.clawhuntSiteURL);
        const usable = item.status === 'unused';
        const codeId = `saas-invite-code-${index}`;
        return <li key={item.code} className="saas-invite-row" data-status={item.status}>
          <code className="saas-invite-code" id={codeId}>{item.code}</code>
          <span className={usable ? 'saas-invite-status is-unused' : 'saas-invite-status'}>{statusLabel[item.status]}</span>
          {usable && <span className="saas-invite-actions">
            {link && <button type="button" aria-describedby={codeId} onClick={() => void copy(`link:${item.code}`, link)}>
              {copied === `link:${item.code}` ? <Check size={15} aria-hidden="true" /> : <LinkIcon size={15} aria-hidden="true" />}
              {copied === `link:${item.code}` ? t('链接已复制', 'Link copied') : t('复制邀请链接', 'Copy invite link')}
            </button>}
            <button type="button" aria-describedby={codeId} onClick={() => void copy(`code:${item.code}`, item.code)}>
              {copied === `code:${item.code}` ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
              {copied === `code:${item.code}` ? t('邀请码已复制', 'Code copied') : t('复制邀请码', 'Copy code')}
            </button>
          </span>}
        </li>;
      })}
    </ul>
    <p className="saas-visually-hidden" role="status">{copied.startsWith('link:') ? t('邀请链接已复制', 'Invite link copied') : copied ? t('邀请码已复制', 'Invite code copied') : ''}</p>
    {copyFailed && <p role="alert" className="saas-error">{t('无法自动复制，请手动选择邀请码复制。', 'Copying failed. Select the code and copy it yourself.')}</p>}
    <p className="saas-invite-friends-note">{t('好友用你的邀请码开通后，也会得到自己的 3 个邀请码。', 'A friend who joins with one of your codes gets three of their own.')}</p>
  </section>;
}
