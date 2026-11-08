// Under the home's composer (AwwO's 需求发布): when the request names live data that AwwO's own Agents cannot fetch
// (canvas/liveDataNeed.ts), a card recommends pairing treg, Superdesign's third-party tool catalog, with the person's own
// Agent. AwwO only links to treg and shows the lines that add it (AgentInvite.tsx tregSnippets): it hosts none of treg,
// handles no treg sign-in, and treg bills its calls to the person's own treg account. The card never blocks sending; 不需要
// hides it until the request names other needs.
import { useEffect, useId, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, Globe } from 'lucide-react';
import { liveDataNeed, type LiveDataNeed } from '../../canvas/liveDataNeed';
import { TREG_SITE_URL, tregSnippets } from '../../canvas/multiplayer/AgentInvite';
import { copyText } from '../copyText';
import { useSaaSPreferences } from '../preferences';
import './home.css';

type T = (zh: string, en: string) => string;
const NEED_NAMES: Record<LiveDataNeed, readonly [string, string]> = {
  web: ['网页资料', 'web research'], seo: ['SEO 数据', 'SEO data'], social: ['社媒趋势', 'social trends'],
  company: ['公司与人脉数据', 'company and people data'], market: ['市场行情', 'market data'], ads: ['广告情报', 'ad research'],
};
const hiddenKey = (user: string, tenant: string) => `awwo.home.tool-advice.v1:${encodeURIComponent(user)}:${encodeURIComponent(tenant)}`;
function readHidden(key: string): string | null { try { return window.sessionStorage.getItem(key); } catch { return null; } }
function saveHidden(key: string, value: string) { try { window.sessionStorage.setItem(key, value); } catch { /* hidden for this page only */ } }

export function ToolAdvice({ text, scope }: { text: string; scope: { user: string; tenant: string } }) {
  const { t, locale } = useSaaSPreferences();
  const needs = useMemo(() => liveDataNeed(text), [text]);
  const storage = hiddenKey(scope.user, scope.tenant);
  const [hidden, setHidden] = useState(() => readHidden(storage));
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const stepsId = useId();
  const named = needs.join(',');
  if (!needs.length || hidden === named) return null;
  const list = needs.map(need => t(...NEED_NAMES[need])).join(locale === 'zh' ? '、' : ', ');
  const hide = () => { saveHidden(storage, named); setHidden(named); setOpen(false); };
  return <aside className="saas-home-advice" aria-labelledby={titleId}>
    <p className="saas-home-advice-title" id={titleId}><Globe size={15} aria-hidden="true" />{t('推荐搭配 · treg（第三方工具目录）', 'Pairs well with treg (a third-party tool catalog)')}</p>
    {/* The 同屏 button shows a dot and avatars only (MultiplayerBar): the words say where it is and what it looks like. */}
    <p>{t(`这个需求可能要用到实时数据：${list}。AwwO 自己的 Agent 不联网；生成画布后，点画布右上角的「同屏」按钮（一个圆点和你的头像），打开「邀请 Agent」，用画布令牌接入你自己的 Claude Code 或 Codex，再给同一个 Agent 加上 treg，它就能去查，并把结果写进画布。`,
      `This request may need live data: ${list}. AwwO’s own Agents have no live web. Once the canvas is made, click the Multiplayer button at its top right (a dot and your avatar) and open Invite an Agent; connect your own Claude Code or Codex with a canvas token, and add treg to that same Agent: it looks things up and writes them onto the canvas.`)}</p>
    <p className="saas-home-advice-billing">{t('treg 按次计费，记在你自己的 treg 账户上，不经过 AwwO。', 'treg charges per call to your own treg account, never through AwwO.')}</p>
    <div className="saas-home-advice-actions">
      <button type="button" className="saas-home-advice-toggle" aria-expanded={open} aria-controls={open ? stepsId : undefined} onClick={() => setOpen(value => !value)}>{t('怎么接入', 'How to connect')}</button>
      <button type="button" className="saas-home-advice-hide" onClick={hide}>{t('不需要', 'Not needed')}</button>
    </div>
    {open && <AdviceSteps id={stepsId} t={t} />}
  </aside>;
}

/** The three steps and the lines that add treg to the person's own Agent. */
function AdviceSteps({ id, t }: { id: string; t: T }) {
  const lines = tregSnippets();
  return <div className="saas-home-advice-steps" id={id}>
    <ol>
      <li>{t('生成画布后，点画布右上角的「同屏」按钮（一个圆点和你的头像），打开「邀请 Agent」，生成画布令牌，按那里的命令接入你自己的 Claude Code 或 Codex。', 'Once the canvas is made, click the Multiplayer button at its top right (a dot and your avatar), open Invite an Agent, make a canvas token, and connect your own Claude Code or Codex with the lines there.')}</li>
      <li>{t('在 treg.to 注册并建一个团队（调用费用由这个团队付），再用下面一行把 treg 加进同一个 Agent，按提示登录。', 'Sign up at treg.to and create a team (the team pays for the calls), then add treg to that same Agent with a line below and sign in when it asks.')}</li>
      <li>{t('让 Agent 用 treg 查资料，再用画布工具把结果写进节点。', 'Ask the Agent to look things up with treg, then write the findings into the nodes with its canvas tools.')}</li>
    </ol>
    <AdviceLine label="Claude Code" value={lines.claude} t={t} />
    <AdviceLine label="Codex" value={lines.codex} t={t} />
    <AdviceLine label={t('Cursor · 加进 .cursor/mcp.json 的 mcpServers 里', 'Cursor · add it inside mcpServers in .cursor/mcp.json')} value={lines.cursor} t={t} />
    <a className="saas-home-advice-site" href={TREG_SITE_URL} target="_blank" rel="noopener noreferrer"
      aria-label={t('在新标签页打开 treg.to（第三方网站）', 'Open treg.to (a third-party site) in a new tab')}>{t('打开 treg.to', 'Open treg.to')}<ExternalLink size={12} aria-hidden="true" /></a>
  </div>;
}

function AdviceLine({ label, value, t }: { label: string; value: string; t: T }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'copied') return undefined;
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  return <div className="saas-home-advice-line">
    <div className="saas-home-advice-line-head"><span>{label}</span>
      <button type="button" aria-label={t(`复制：${label}`, `Copy: ${label}`)} onClick={async () => setState(await copyText(value) ? 'copied' : 'failed')}>
        {state === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}<span aria-hidden="true">{state === 'copied' ? t('已复制', 'Copied') : t('复制', 'Copy')}</span></button>
      <span className="saas-visually-hidden" aria-live="polite">{state === 'copied' ? t('已复制', 'Copied') : ''}</span>
    </div>
    <pre tabIndex={0}><code>{value}</code></pre>
    {state === 'failed' && <p className="saas-error" role="alert">{t('没能复制，请手动选中上面的文字复制。', 'Could not copy: select the text above and copy it yourself.')}</p>}
  </div>;
}
