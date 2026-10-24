import { useEffect, useRef, useState } from 'react';
import { api, SaaSApiError, saasErrorMessage, type Identity } from '../api';
import { linkCode, rememberPendingLink } from '../pendingLink';
import { useSaaSPreferences } from '../preferences';
import { signOut } from '../signOut';
import { SettingsCard, SettingsIntro } from './general';

// 本机连接 (docs/awwo-cloud-relay.md): AwwO 本地版 on a person's Mac or Windows computer asks to call the hosted site's
// Bedrock models on one of their workspaces, shows a code, and opens this page (?link=CODE, kept across a sign-in by
// pendingLink.ts). Here the person sees which computer asks and from which network, confirms the code is their own
// computer's, picks the workspace whose allowance and credits its calls spend, and approves or declines; and sees every
// computer connected, to disconnect one or all. A link outlives the session that approves it by months, so approving
// needs a sign-in of the last 15 minutes (local_links.go localLinkFreshSignIn): an older session signs in again first.

type Waiting = {
  userCode: string; deviceName: string; createdAt: string; expiresAt: string;
  requestIP: string; yourIP: string; sameNetwork: boolean; signInAgain: boolean;
};
// status approved: the person approved it here and its computer has not taken its token yet (it does within seconds).
type Linked = { id: string; status?: 'approved' | 'issued'; deviceName: string; workspace: { id: string; name: string }; createdAt: string; approvedAt?: string | null; lastUsedAt?: string | null; expiresAt?: string | null };

const when = (value?: string | null) => value ? new Date(value).toLocaleString() : '';

export function LocalLinksSettings({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  // A workspace whose reader may not spend its allowance cannot be granted: the API refuses it the same way.
  const eligible = identity.tenants.filter(item => item.status === 'active' && ['owner', 'admin', 'member'].includes(item.role));
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code') ?? '');
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [tenantId, setTenantId] = useState(eligible[0]?.id ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'approved' | 'denied'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [links, setLinks] = useState<Linked[] | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // Each read of the list is numbered: only the latest one asked shows, so a slow earlier answer never overwrites it.
  const listRead = useRef(0);
  const reload = async () => {
    const read = ++listRead.current;
    try {
      const items = (await api<{ items: Linked[] }>('/local-links')).items;
      if (read !== listRead.current) return null;
      setLinks(items);
      setListError(null);
      return items;
    } catch (cause) {
      if (read === listRead.current) setListError(cause);
      return null;
    }
  };
  // After an approval, the list is read again, one read at a time, until its computer has taken its token, for at
  // most a minute.
  const [awaiting, setAwaiting] = useState(0);
  useEffect(() => {
    if (!awaiting) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let left = 12;
    const next = () => {
      timer = setTimeout(async () => {
        const items = await reload();
        if (stopped) return;
        if (--left > 0 && !(items && !items.some(item => item.status === 'approved'))) next();
      }, 5000);
    };
    next();
    return () => { stopped = true; clearTimeout(timer); };
  }, [awaiting]);
  const forgetCode = () => {
    const url = new URL(location.href);
    if (!url.searchParams.has('code')) return;
    url.searchParams.delete('code');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  };
  const lookup = async (raw: string) => {
    const normal = linkCode(raw);
    setError(null); setWaiting(null); setConfirmed(false); setPhase('idle');
    if (!normal) { setError(new Error(t('确认码是 8 位字母和数字，形如 KQ7M-3XHD。', 'A code is 8 letters and digits, such as KQ7M-3XHD.'))); return; }
    setPhase('busy');
    try { setWaiting(await api<Waiting>(`/local-links/pending/${encodeURIComponent(normal)}`)); setCode(normal); }
    catch (cause) { setError(cause); }
    finally { setPhase('idle'); }
  };
  useEffect(() => { void reload(); }, []);
  // A code the address brought (the local edition's link) is looked up at once.
  useEffect(() => { if (code) void lookup(code); }, []);
  // Signing in again keeps the code for the page the sign-in comes back to (pendingLink.ts); a ClawHunt account signs
  // out of ClawHunt too, so its sign-in is a real one.
  const signInAgain = async () => {
    if (!waiting) return;
    rememberPendingLink(waiting.userCode);
    setPhase('busy');
    const failure = await signOut(identity, t);
    if (failure) { setError(new Error(failure)); setPhase('idle'); }
  };
  const decide = async (approve: boolean) => {
    if (!waiting || phase === 'busy') return;
    setPhase('busy'); setError(null);
    try {
      if (approve) await api('/local-links/approve', { method: 'POST', body: JSON.stringify({ userCode: waiting.userCode, tenantId, confirmed }) });
      else await api('/local-links/deny', { method: 'POST', body: JSON.stringify({ userCode: waiting.userCode }) });
      setPhase(approve ? 'approved' : 'denied');
      setWaiting(null); setCode(''); setConfirmed(false); forgetCode();
      if (approve) { void reload(); setAwaiting(count => count + 1); }
    } catch (cause) {
      // The session grew older than the window since the code was looked up.
      if (cause instanceof SaaSApiError && cause.code === 'sign_in_again') setWaiting({ ...waiting, signInAgain: true });
      setError(cause); setPhase('idle');
    }
  };
  const disconnect = async (path: string, id: string) => {
    setRemoving(id);
    try { await api(path, { method: 'DELETE' }); await reload(); }
    catch (cause) { setListError(cause); }
    finally { setRemoving(null); }
  };
  return <>
    <SettingsIntro title={t('本机连接', 'Connected computers')} intro={t(
      'AwwO 本地版（Mac、Windows）连上你的线上账号后，会经线上调用 Claude Opus 5.5 等 Bedrock 模型，次数和点数计入你选的工作区。这里确认新的连接，管理已经连接的电脑。',
      'Once AwwO 本地版 (Mac, Windows) is connected to your online account, it calls Bedrock models such as Claude Opus 5.5 through AwwO online, and its calls count against the workspace you choose. Approve new connections and manage connected computers here.')} />
    <div className="saas-settings-stack">
      <SettingsCard title={t('确认连接', 'Approve a connection')} description={t('在 AwwO 本地版的「我的引擎 → AwwO 线上」点「连接线上账号」，它会显示确认码并打开这一页。', 'In AwwO 本地版, choose 「连接线上账号」 under My engines → AwwO online: it shows a code and opens this page.')}>
        {phase === 'approved' && <p role="status" className="saas-connection-success">{t('已连接。回到 AwwO 本地版，几秒内就会显示已连接。', 'Connected. Back in AwwO 本地版, it shows as connected within a few seconds.')}</p>}
        {phase === 'denied' && <p role="status">{t('已拒绝这次连接。', 'You declined the connection.')}</p>}
        {!waiting && <form className="saas-link-code-form" onSubmit={event => { event.preventDefault(); void lookup(code); }}>
          <label>{t('确认码', 'Code')}
            <input value={code} onChange={event => setCode(event.target.value)} placeholder="KQ7M-3XHD" autoComplete="off" spellCheck={false} maxLength={16} disabled={phase === 'busy'} />
          </label>
          <button disabled={phase === 'busy' || !code.trim()}>{phase === 'busy' ? t('正在查找…', 'Looking…') : t('查看', 'Look up')}</button>
        </form>}
        {waiting && <div className="saas-link-request" role="group" aria-label={t('等待确认的连接', 'Connection waiting for approval')}>
          <p><strong>{waiting.deviceName}</strong>{t(' 请求连接你的账号', ' asks to connect to your account')}</p>
          <p className="saas-field-hint">{t('名称由发起请求的设备自己报告。', 'The name is the one the asking device reports for itself.')}{' '}
            {t(`确认码 ${waiting.userCode} · ${when(waiting.createdAt)} 发起 · ${when(waiting.expiresAt)} 前有效`, `Code ${waiting.userCode} · asked ${when(waiting.createdAt)} · valid until ${when(waiting.expiresAt)}`)}</p>
          <p className="saas-field-hint">{t(`发起请求的网络：${waiting.requestIP || '未知'} · 你现在的网络：${waiting.yourIP || '未知'}`, `Asked from ${waiting.requestIP || 'an unknown address'} · you are on ${waiting.yourIP || 'an unknown address'}`)}</p>
          {!waiting.sameNetwork && <p role="alert" className="saas-link-warning">{t(
            '这个请求不是从你现在的网络发起的。如果这个确认码不是你刚刚在自己的电脑上看到的（例如别人发给你的链接），请拒绝。',
            'This request did not come from the network you are on. If this code is not one you just saw on your own computer (a link someone sent you, say), decline it.')}</p>}
          {eligible.length === 0
            ? <p role="alert" className="saas-error">{t('你没有可以使用的工作区：连接需要工作区成员及以上的权限。', 'You have no workspace this can use: connecting needs a member or higher role in a workspace.')}</p>
            : <label>{t('次数和点数计入的工作区', 'Workspace its calls count against')}
              <select value={tenantId} onChange={event => setTenantId(event.target.value)} disabled={phase === 'busy'}>
                {eligible.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>}
          <p className="saas-settings-description">{t('确认后，这台电脑可以用这个工作区的次数和点数调用线上的模型，直到你在这里断开，最长 90 天。只确认你自己电脑上发起的请求。', 'Once approved, this computer can call the online models on this workspace’s calls and credits until you disconnect it here, for at most 90 days. Approve only a request you made on your own computer.')}</p>
          <label className="saas-link-confirm">
            <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={phase === 'busy'} />
            {t(`确认码 ${waiting.userCode} 就显示在我自己的电脑上，是我刚刚发起的连接`, `The code ${waiting.userCode} is shown on my own computer, in a connection I just started`)}
          </label>
          {waiting.signInAgain && <p role="status" className="saas-field-hint">{t('为保护你的账号，确认连接需要最近 15 分钟内登录过。重新登录后会回到这一页，确认码保留。', 'To protect your account, approving needs a sign-in within the last 15 minutes. After you sign in again you come back to this page with the code kept.')}</p>}
          <div className="saas-connection-actions">
            {waiting.signInAgain
              ? <button className="saas-primary" disabled={phase === 'busy'} onClick={() => void signInAgain()}>{t('重新登录后确认', 'Sign in again to approve')}</button>
              : <button className="saas-primary" disabled={phase === 'busy' || eligible.length === 0 || !confirmed} onClick={() => void decide(true)}>{t('确认连接', 'Approve')}</button>}
            <button disabled={phase === 'busy'} onClick={() => void decide(false)}>{t('拒绝', 'Decline')}</button>
          </div>
        </div>}
        {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
      </SettingsCard>
      <SettingsCard title={t('已连接的电脑', 'Connected computers')} description={t('电脑丢失，或你在 ClawHunt 改了密码，就在这里断开所有电脑：连接不会随网页登录一起失效。', 'If a computer is lost, or you changed your ClawHunt password, disconnect every computer here: connections do not end with a web sign-in.')}>
        {listError !== null && <p role="alert" className="saas-error">{saasErrorMessage(listError, locale)}</p>}
        {links === null && listError === null && <p role="status">{t('正在读取…', 'Loading…')}</p>}
        {links?.length === 0 && <p>{t('还没有电脑连接到这个账号。', 'No computer is connected to this account.')}</p>}
        {links && links.length > 0 && <ul className="saas-link-list">{links.map(link => <li key={link.id}>
          <div>
            <strong>{link.deviceName}</strong>
            <p className="saas-field-hint">{t(`工作区：${link.workspace.name}`, `Workspace: ${link.workspace.name}`)}{' · '}
              {link.status === 'approved'
                ? t('已确认，等待这台电脑完成连接', 'approved, waiting for the computer to finish connecting')
                : <>{link.lastUsedAt ? t(`最近使用 ${when(link.lastUsedAt)}`, `last used ${when(link.lastUsedAt)}`) : t('尚未使用', 'not used yet')}{' · '}
                  {t(`到期 ${when(link.expiresAt)}`, `ends ${when(link.expiresAt)}`)}</>}</p>
          </div>
          <button disabled={removing !== null} onClick={() => void disconnect(`/local-links/${encodeURIComponent(link.id)}`, link.id)}>{removing === link.id ? t('正在断开…', 'Disconnecting…') : t('断开', 'Disconnect')}</button>
        </li>)}</ul>}
        {links && links.length > 0 && <div className="saas-connection-actions">
          <button disabled={removing !== null} onClick={() => void disconnect('/local-links', '*')}>{removing === '*' ? t('正在断开…', 'Disconnecting…') : t('断开所有电脑', 'Disconnect every computer')}</button>
        </div>}
      </SettingsCard>
    </div>
  </>;
}
