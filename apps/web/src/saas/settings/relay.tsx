import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { api, SaaSApiError, saasErrorMessage, type Identity } from '../api';
import { isLocalEdition } from '../edition';
import { copyText } from '../InviteFriends';
import { useSaaSPreferences } from '../preferences';
import { SettingsCard, SettingsIntro } from './general';

/**
 * 设置 → 本机版连接: the keys AwwO 本地版 makes its model calls on this site with (backend relay.go). A key belongs to
 * one of the person's workspaces, and each call it makes counts there as any of the workspace's calls does: its free
 * calls and paid-route allowances, or its owner's plan and credits. The key is shown once, when it is made; it works
 * for 90 days, until it is revoked, or while its person may run calls in its workspace.
 */
export type RelayKey = {
  id: string; name: string; prefix: string; tenant: { id: string; name: string };
  createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null;
};

/** The hosted site offers the relay (its API says so on /auth/me); the local edition is the relay's caller, never it. */
export const relayOffered = (identity: Identity): boolean => identity.relay === true && !isLocalEdition(identity);

const KEY = /^awwo_rk_[A-Za-z0-9_-]{43}$/;
const PREFIX = /^awwo_rk_[A-Za-z0-9_-]{4}$/;
const MAX_NAME = 80;

/** A key as the API lists it, or null: nothing else is drawn. */
export function readRelayKey(value: unknown): RelayKey | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const tenant = item.tenant && typeof item.tenant === 'object' ? item.tenant as Record<string, unknown> : null;
  const date = (key: string) => typeof item[key] === 'string' && !Number.isNaN(Date.parse(item[key] as string));
  const maybe = (key: string) => item[key] === null || item[key] === undefined || date(key);
  if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.prefix !== 'string' || !PREFIX.test(item.prefix)
    || !tenant || typeof tenant.id !== 'string' || typeof tenant.name !== 'string' || !date('createdAt') || !date('expiresAt')
    || !maybe('lastUsedAt') || !maybe('revokedAt')) return null;
  return { id: item.id, name: item.name, prefix: item.prefix, tenant: { id: tenant.id, name: tenant.name },
    createdAt: item.createdAt as string, expiresAt: item.expiresAt as string,
    lastUsedAt: (item.lastUsedAt as string | null | undefined) ?? null, revokedAt: (item.revokedAt as string | null | undefined) ?? null };
}

function readRelayKeys(value: unknown): { items: RelayKey[]; limit: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { items, limit } = value as { items?: unknown; limit?: unknown };
  if (!Array.isArray(items) || typeof limit !== 'number') return null;
  const keys = items.map(readRelayKey);
  return keys.every((key): key is RelayKey => key !== null) ? { items: keys, limit } : null;
}

/** An answer of the keys API that is not in its documented shape: drawn as such, never as a key. */
class UnreadableAnswer extends Error {}

type KeyState = 'live' | 'expired' | 'revoked';
const keyState = (key: RelayKey, now = Date.now()): KeyState => key.revokedAt ? 'revoked' : Date.parse(key.expiresAt) <= now ? 'expired' : 'live';

/** The key just made, shown once with its copy button. */
function NewKey({ value, onDone }: { value: string; onDone: () => void }) {
  const { t } = useSaaSPreferences();
  const [copied, setCopied] = useState<boolean | null>(null);
  return <div className="saas-settings-pending saas-relay-new" role="status">
    <p><strong>{t('新密钥只显示这一次', 'The new key is shown this once')}</strong></p>
    <p className="saas-local-path"><code data-relay-key>{value}</code>
      <button type="button" onClick={async () => setCopied(await copyText(value))}>
        {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copied ? t('已复制', 'Copied') : t('复制', 'Copy')}
      </button></p>
    {copied === false && <p role="alert" className="saas-error">{t('无法自动复制，请手动选择密钥复制。', 'Copying failed. Select the key and copy it yourself.')}</p>}
    <p className="saas-field-hint">{t('把它粘贴到 AwwO 本地版的「设置 → 我的引擎 → AwwO 云端」。请像密码一样保管：拿到它的人能用这个工作区的额度和点数。', 'Paste it into AwwO Local under Settings → My engines → AwwO Cloud. Keep it like a password: whoever has it can spend this workspace’s allowance and credits.')}</p>
    <div className="saas-connection-actions"><button type="button" onClick={onDone}>{t('我已保存', 'I saved it')}</button></div>
  </div>;
}

function KeyRow({ item, busy, onRevoke }: { item: RelayKey; busy: boolean; onRevoke: (id: string) => Promise<void> }) {
  const { t, locale } = useSaaSPreferences();
  const [confirming, setConfirming] = useState(false);
  const day = (value: string) => new Date(value).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en');
  const state = keyState(item);
  const label = { live: t('有效', 'Active'), expired: t('已过期', 'Expired'), revoked: t('已撤销', 'Revoked') }[state];
  return <li className="saas-relay-key" data-state={state}>
    <div className="saas-relay-key-name"><strong>{item.name}</strong><code>{item.prefix}…</code><span>{label}</span></div>
    <p className="saas-field-hint">{t('工作区：', 'Workspace: ')}{item.tenant.name} · {t('创建于 ', 'Made ')}{day(item.createdAt)}
      {' · '}{item.revokedAt ? t('撤销于 ', 'Revoked ') + day(item.revokedAt) : (state === 'expired' ? t('已于 ', 'Expired ') : t('到期 ', 'Expires ')) + day(item.expiresAt)}
      {' · '}{item.lastUsedAt ? t('最近使用 ', 'Last used ') + day(item.lastUsedAt) : t('还没用过', 'Not used yet')}</p>
    {state !== 'revoked' && (!confirming
      ? <button type="button" className="saas-danger-button" disabled={busy} onClick={() => setConfirming(true)}>{t('撤销', 'Revoke')}</button>
      : <div className="saas-connection-actions">
        <span className="saas-field-hint">{t('撤销后，用这个密钥的本地版立即不能再调用云端模型，且无法恢复。', 'Once revoked, AwwO Local can no longer call cloud models with this key, and it cannot be restored.')}</span>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>{t('取消', 'Cancel')}</button>
        <button type="button" className="saas-danger-button" disabled={busy} onClick={() => void onRevoke(item.id)}>{busy ? t('请稍候…', 'Please wait…') : t('确认撤销', 'Revoke key')}</button>
      </div>)}
  </li>;
}

export function RelaySettings({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const usable = identity.tenants.filter(item => item.status === 'active' && item.role !== 'reader');
  const [keys, setKeys] = useState<{ items: RelayKey[]; limit: number } | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState('');
  const [tenantId, setTenantId] = useState(usable[0]?.id || '');
  const [created, setCreated] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setLoadError(null);
    api('/auth/relay-keys', { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      const read = readRelayKeys(value);
      if (read) setKeys(read); else setLoadError(new UnreadableAnswer());
    }, cause => { if (!controller.signal.aborted) setLoadError(cause); });
    return () => controller.abort();
  }, [identity.user.id, revision]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !tenantId) return;
    setBusy(true); setError(null);
    try {
      const made = await api<{ key?: unknown }>('/auth/relay-keys', { method: 'POST', body: JSON.stringify({ name: name.trim(), tenantId }) });
      if (typeof made?.key !== 'string' || !KEY.test(made.key)) throw new UnreadableAnswer();
      setCreated(made.key); setName(''); setRevision(value => value + 1);
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    // A key revoked meanwhile (another tab) is gone as asked: read the list again either way.
    try { await api(`/auth/relay-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (cause) { if (!(cause instanceof SaaSApiError && cause.status === 404)) setError(cause); }
    finally { setBusy(false); setRevision(value => value + 1); }
  };
  const live = keys?.items.filter(item => keyState(item) === 'live').length ?? 0;
  const full = keys ? live >= keys.limit : false;
  const site = identity.clawhuntSiteURL ? identity.clawhuntSiteURL.replace(/\/+$/, '') : '';
  const message = (cause: unknown) => cause instanceof UnreadableAnswer
    ? t('线上 AwwO 的回答无法识别，请稍后再试。', 'The online AwwO’s answer could not be read. Try again later.') : saasErrorMessage(cause, locale);
  return <>
    <SettingsIntro title={t('本机版连接', 'AwwO Local connection')} intro={t('AwwO 本地版可以通过线上 AwwO 使用 Claude 等云端模型。在这里生成一个连接密钥，粘贴到本地版。每次调用都计入你选择的工作区，和在线上使用一样：用它的免费次数，或用套餐的点数。', 'AwwO Local can use cloud models such as Claude through the online AwwO. Make a connection key here and paste it into AwwO Local. Each call counts in the workspace you choose, as it would online: its free calls, or your plan’s credits.')} />
    <div className="saas-settings-stack">
      <SettingsCard title={t('生成连接密钥', 'Make a connection key')} description={t('密钥只显示一次，90 天后失效。每个账号最多同时有 5 个有效密钥。', 'A key is shown once and works for 90 days. An account holds at most five live keys.')}>
        {created && <NewKey value={created} onDone={() => setCreated('')} />}
        {usable.length === 0
          ? <p role="status">{t('你还没有可以运行任务的工作区：需要是某个正常工作区的成员、管理员或所有者。', 'You have no workspace you can run tasks in: you need to be a member, an admin or the owner of an active one.')}</p>
          : <form className="saas-settings-form" onSubmit={create}>
            <label>{t('名称', 'Name')}
              <input value={name} maxLength={MAX_NAME} placeholder={t('AwwO 本地版', 'AwwO Local')} onChange={event => setName(event.target.value)} />
            </label>
            <label className="saas-settings-tenant">{t('计入的工作区', 'Workspace it counts in')}
              <select value={tenantId} onChange={event => setTenantId(event.target.value)}>
                {usable.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <div className="saas-connection-actions">
              <button className="saas-primary" disabled={busy || full}>{busy ? t('请稍候…', 'Please wait…') : t('生成密钥', 'Make key')}</button>
            </div>
            {full && <p className="saas-field-hint">{t('已有 5 个有效密钥：撤销一个后才能再生成。', 'You hold five live keys: revoke one to make another.')}</p>}
          </form>}
        {error !== null && <p role="alert" className="saas-error">{message(error)}</p>}
      </SettingsCard>
      <SettingsCard title={t('我的连接密钥', 'My connection keys')}>
        {loadError !== null && <p role="alert" className="saas-error">{message(loadError)} <button type="button" onClick={() => setRevision(value => value + 1)}>{t('重试', 'Retry')}</button></p>}
        {keys === undefined && loadError === null && <p role="status">{t('正在读取…', 'Loading…')}</p>}
        {keys && (keys.items.length === 0
          ? <p>{t('还没有连接密钥。', 'No connection keys yet.')}</p>
          : <ul className="saas-relay-keys" aria-label={t('连接密钥', 'Connection keys')}>{keys.items.map(item => <KeyRow key={item.id} item={item} busy={busy} onRevoke={revoke} />)}</ul>)}
      </SettingsCard>
      <SettingsCard title={t('隐私', 'Privacy')}>
        <p>{t('本地版的每次调用会经过 AwwO 在东京的服务器转给模型。AwwO 只记录每次调用的用量（模型、用量和点数），不保存对话内容。', 'Each call AwwO Local makes goes through AwwO’s server in Tokyo to the model. AwwO records each call’s usage (model, usage and credits) and keeps none of the conversation.')}</p>
        {/^https:\/\//.test(site) && <ul className="saas-settings-links"><li><a href={site + '/legal'} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} aria-hidden="true" />{t('隐私政策', 'Privacy policy')}</a></li></ul>}
      </SettingsCard>
    </div>
  </>;
}
