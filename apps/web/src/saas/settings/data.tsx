import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, API_BASE, SaaSApiError, saasErrorMessage, type Identity } from '../api';
import { useSaaSPreferences } from '../preferences';
import { SettingsCard, SettingsIntro } from './general';

// A handled request belongs to an account the operator deleted, so a signed-in person never reads one.
type DeletionStatus = 'pending' | 'withdrawn' | 'declined';
type DeletionRequest = { id: string; status: DeletionStatus; reason: string; createdAt: string; withdrawnAt?: string | null;
  /** An operator's decline: when, and the reason they gave. */
  decidedAt?: string | null; decisionNote: string };
const MAX_REASON = 1000;
const STATUSES: readonly string[] = ['pending', 'withdrawn', 'declined'];

function readRequest(value: unknown): DeletionRequest | null {
  const raw = value && typeof value === 'object' ? (value as { request?: unknown }).request : null;
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const text = (key: string) => typeof item[key] === 'string' ? item[key] as string : null;
  return typeof item.id === 'string' && STATUSES.includes(String(item.status)) && typeof item.createdAt === 'string'
    ? { id: item.id, status: item.status as DeletionStatus, reason: text('reason') || '', createdAt: item.createdAt, withdrawnAt: text('withdrawnAt'),
      decidedAt: text('decidedAt'), decisionNote: text('decisionNote') || '' } : null;
}

/** An operator declined the latest request: when, and their reason. */
function DeclinedRequest({ request }: { request: DeletionRequest }) {
  const { t, locale } = useSaaSPreferences();
  if (request.status !== 'declined') return null;
  const when = request.decidedAt ? ' · ' + new Date(request.decidedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en') : '';
  return <div className="saas-settings-pending" role="status">
    <p><strong>{t('删除申请未通过', 'Deletion request declined')}</strong>{when}</p>
    {request.decisionNote && <p>{t('运营人员的说明：', 'Note from the operator: ')}{request.decisionNote}</p>}
    <p className="saas-field-hint">{t('如有需要，可以重新提交申请。', 'You can send a new request if you need to.')}</p>
  </div>;
}

function DeletionRequestCard({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const [request, setRequest] = useState<DeletionRequest | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(null);
    api('/auth/deletion-request', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setRequest(readRequest(value)); },
      cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [identity.user.id, revision]);
  const act = async (init: RequestInit) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { setRequest(readRequest(await api('/auth/deletion-request', init))); setConfirming(false); setReason(''); }
    catch (cause) {
      // Nothing pending to withdraw any more: an operator declined it meanwhile, or another tab withdrew it. Read what is there now.
      if (init.method === 'DELETE' && cause instanceof SaaSApiError && cause.status === 404) setRevision(value => value + 1);
      else setError(cause);
    }
    finally { setBusy(false); }
  };
  const pending = request?.status === 'pending';
  return <SettingsCard title={t('删除账号', 'Delete account')}
    description={t('提交申请后，由运营人员人工核实：删除账号，或者拒绝并在这里说明理由。提交本身不会删除任何东西，处理前随时可以撤回。删除后无法恢复，建议先导出数据。', 'After you send a request, an operator checks it by hand and either deletes the account or declines, with the reason shown here. Sending it deletes nothing by itself, and you can withdraw it until it is decided. A deleted account cannot be restored, so export your data first.')}>
    {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)} {request === undefined && <button type="button" onClick={() => setRevision(value => value + 1)}>{t('重试', 'Retry')}</button>}</p>}
    {request === undefined && error === null && <p role="status">{t('正在读取…', 'Loading…')}</p>}
    {pending && <div className="saas-settings-pending" role="status">
      <p><strong>{t('删除申请已提交', 'Deletion requested')}</strong> · {new Date(request.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en')}</p>
      {request.reason && <p>{t('原因：', 'Reason: ')}{request.reason}</p>}
      <button type="button" disabled={busy} onClick={() => void act({ method: 'DELETE' })}>{busy ? t('请稍候…', 'Please wait…') : t('撤回申请', 'Withdraw request')}</button>
    </div>}
    {request && <DeclinedRequest request={request} />}
    {request !== undefined && !pending && (!confirming
      ? <button type="button" className="saas-danger-button" onClick={() => setConfirming(true)}>{t('申请删除账号', 'Request account deletion')}</button>
      : <form className="saas-settings-form" onSubmit={event => { event.preventDefault(); void act({ method: 'POST', body: JSON.stringify({ reason }) }); }}>
        <label>{t('原因（可选）', 'Reason (optional)')}
          <textarea rows={3} maxLength={MAX_REASON} value={reason} onChange={event => setReason(event.target.value)} />
        </label>
        <p className="saas-field-hint">{t(`将为 ${identity.user.email} 提交删除申请。`, `This sends a deletion request for ${identity.user.email}.`)}</p>
        <div className="saas-connection-actions">
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>{t('取消', 'Cancel')}</button>
          <button className="saas-danger-button" disabled={busy}>{busy ? t('请稍候…', 'Please wait…') : t('确认提交申请', 'Send request')}</button>
        </div>
      </form>)}
  </SettingsCard>;
}

/**
 * Reads the whole export, then saves it. An error answer is never saved as if it were the export, and a download the
 * server had to cut short (it ends with "complete":false) is reported instead of saved.
 */
export async function downloadAccountExport(): Promise<void> {
  const response = await fetch(API_BASE + '/auth/export', { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new SaaSApiError(response.status, payload?.error?.code || 'request_failed', payload?.error?.message || `请求失败（${response.status}）`);
  }
  const file = await response.blob();
  if (!(await file.slice(Math.max(0, file.size - 32)).text()).trimEnd().endsWith('"complete":true}')) throw new SaaSApiError(503, 'export_incomplete', 'The export was cut short.');
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url; link.download = 'awwo-account-export.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function ExportButton() {
  const { t, locale } = useSaaSPreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return <>
    <button type="button" className="saas-primary saas-buy-link" disabled={busy} onClick={async () => {
      setBusy(true); setError(null);
      try { await downloadAccountExport(); } catch (cause) { setError(cause); } finally { setBusy(false); }
    }}><Download size={16} aria-hidden="true" />{busy ? t('正在导出…', 'Exporting…') : t('下载 JSON', 'Download JSON')}</button>
    {error !== null && <p role="alert" className="saas-error">{error instanceof SaaSApiError && error.code === 'export_incomplete'
      ? t('导出没有完整读完，请稍后再试。', 'The export could not be read in full. Try again later.') : saasErrorMessage(error, locale)}</p>}
  </>;
}

export function DataSettings({ identity }: { identity: Identity }) {
  const { t } = useSaaSPreferences();
  return <>
    <SettingsIntro title={t('数据管理', 'Data management')} intro={t('导出你在 AwwO 的数据，或申请删除账号。', 'Export your AwwO data, or ask for your account to be deleted.')} />
    <div className="saas-settings-stack">
      <SettingsCard title={t('导出我的数据', 'Export my data')}
        description={t('下载一个 JSON 文件：账号资料、设置、配色、所在的工作区，以及你所在的每个正常工作区里的全部画布。不含 API Key、登录会话和其他成员的资料。工作区大时下载会慢一些。每小时最多导出 6 次，一次只能导出一份。','Downloads one JSON file: your profile, settings, colour scheme, the workspaces you belong to, and every canvas of each of them that is active. API keys, sign-in sessions and other members’ details are left out. A large workspace takes longer. At most six exports an hour, one at a time.')}>
        <ExportButton />
      </SettingsCard>
      <DeletionRequestCard identity={identity} />
    </div>
  </>;
}
