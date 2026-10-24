import { useEffect, useRef, useState } from 'react';
import { api, SaaSApiError, saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';

// AwwO 本地版's 「AwwO 线上」 engine (docs/awwo-cloud-relay.md): its person links this computer to their account on the
// hosted site, and its runs then call the hosted site's Bedrock models through the hosted site, on the workspace they
// chose there, with no API key here. The link is asked for by this edition's API (POST /auth/cloud-link), approved on
// the hosted site's 本机连接 page, which the person opens in their browser with the code shown here, and taken once
// approved (POST /auth/cloud-link/poll, asked at the interval the hosted site gives).

type Waiting = { userCode: string; verificationURL: string; expiresAt: string; interval: number };
type Poll = { status: 'pending' | 'connected' | 'denied' | 'expired'; workspace?: { id: string; name: string }; expiresAt?: string; models?: number; warning?: string };
export type CloudLink = { workspace: { id: string; name: string }; expiresAt: string };

const day = (value: string) => new Date(value).toLocaleDateString();
// A moment's trouble reaching AwwO online, or this computer's own API, which asking again may get past: no answer, a
// limit, or a server's failure. A refusal of the request itself ends the wait.
const transient = (cause: unknown) => !(cause instanceof SaaSApiError) || cause.status === 0 || cause.status === 429 || cause.status >= 500;

export function CloudLinkCard({ linked, onConnected }: { linked: CloudLink | null; onConnected: () => Promise<unknown> }) {
  const { t, locale } = useSaaSPreferences();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Poll | null>(null);
  const [retrying, setRetrying] = useState(false);
  const live = useRef(true);
  // Set again on every mount: React's development checks mount, unmount and mount again.
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // While a code waits, ask whether it was approved, at the hosted site's interval, until it says otherwise.
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      try {
        const answer = await api<Poll>('/auth/cloud-link/poll', { method: 'POST' });
        if (stopped) return;
        failures = 0;
        setRetrying(false);
        if (answer.status === 'pending') { timer = setTimeout(ask, waiting.interval * 1000); return; }
        setWaiting(null);
        setOutcome(answer);
        if (answer.status === 'connected') await onConnected();
      } catch (cause) {
        if (stopped) return;
        // Waited out while the code lasts, asking less often each time.
        if (transient(cause) && Date.now() < Date.parse(waiting.expiresAt)) {
          failures++;
          setRetrying(true);
          timer = setTimeout(ask, Math.min(30, waiting.interval * 2 ** Math.min(failures, 3)) * 1000);
          return;
        }
        setRetrying(false);
        setWaiting(null);
        setError(cause);
      }
    };
    timer = setTimeout(ask, waiting.interval * 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [waiting]);
  const start = async () => {
    if (busy) return;
    setBusy(true); setError(null); setOutcome(null);
    try {
      const flow = await api<Waiting>('/auth/cloud-link', { method: 'POST' });
      if (live.current) setWaiting(flow);
    } catch (cause) { if (live.current) setError(cause); }
    finally { if (live.current) setBusy(false); }
  };
  const cancel = async () => {
    setWaiting(null);
    setRetrying(false);
    try { await api('/auth/cloud-link', { method: 'DELETE' }); } catch { /* the code lapses on its own */ }
  };
  return <section className="saas-card saas-cloud-link-card" aria-labelledby="cloud-link-title" data-onboarding="cloud-link">
    <span className="saas-eyebrow">AWWO {t('线上', 'ONLINE')}</span>
    <h2 id="cloud-link-title">{linked ? t('已连接 AwwO 线上', 'Connected to AwwO online') : t('使用 AwwO 线上账号', 'Use your AwwO online account')}</h2>
    {!waiting && !linked && <p>{t(
      '连接你在 awwo.clawhunt.store 的账号后，本地版经线上调用 Claude Opus 5.5 等 Bedrock 模型，不用填 API Key；次数和点数计入你在线上选的工作区。',
      'Connect your account at awwo.clawhunt.store and AwwO 本地版 calls Bedrock models such as Claude Opus 5.5 through AwwO online, with no API key here; its calls count against the workspace you choose there.')}</p>}
    {!waiting && linked && <p>{t(
      `工作区：${linked.workspace.name} · ${day(linked.expiresAt)} 到期。到期或在线上断开后，在这里重新连接。`,
      `Workspace: ${linked.workspace.name} · ends ${day(linked.expiresAt)}. Once it ends, or is disconnected online, connect again here.`)}</p>}
    {waiting && <div className="saas-cloud-link-waiting">
      <p>{t('确认码', 'Code')}</p>
      <p className="saas-cloud-link-code" aria-label={t('确认码', 'Code')}>{waiting.userCode}</p>
      <a className="saas-primary saas-buy-link" href={waiting.verificationURL} target="_blank" rel="noopener noreferrer">{t('在浏览器中打开确认页', 'Open the approval page in your browser')} ↗</a>
      <p className="saas-field-hint">{t(
        '在打开的页面登录线上账号，选择工作区并确认，这里会自动完成。确认码 15 分钟内有效。',
        'Sign in on that page, choose a workspace and approve: this finishes by itself. The code is valid for 15 minutes.')}</p>
      <p role="status">{retrying
        ? t('暂时连不上 AwwO 线上，正在重试…', 'AwwO online cannot be reached right now; trying again…')
        : t('正在等待确认…', 'Waiting for approval…')}</p>
      <button type="button" onClick={() => void cancel()}>{t('取消', 'Cancel')}</button>
    </div>}
    {outcome?.status === 'connected' && <p role="status" className="saas-connection-success">{outcome.warning
      ? t('已连接，但暂时没读到模型列表；稍后在下方点「刷新模型」。', 'Connected, but the model list could not be read yet; choose 「刷新模型」 below shortly.')
      : t(`已连接，工作区「${outcome.workspace?.name ?? ''}」的 ${outcome.models ?? 0} 个模型可以用了。`, `Connected: ${outcome.models ?? 0} models of 「${outcome.workspace?.name ?? ''}」 are ready.`)}</p>}
    {outcome?.status === 'denied' && <p role="alert">{t('你在线上拒绝了这次连接。', 'The connection was declined online.')}</p>}
    {outcome?.status === 'expired' && <p role="alert">{t('确认码已过期，请重新连接。', 'The code has expired. Connect again.')}</p>}
    {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {!waiting && <div className="saas-connection-actions">
      <button type="button" className={linked ? undefined : 'saas-primary'} disabled={busy} onClick={() => void start()}>
        {busy ? t('正在连接…', 'Connecting…') : linked ? t('重新连接', 'Connect again') : t('连接线上账号', 'Connect online account')}
      </button>
    </div>}
  </section>;
}
