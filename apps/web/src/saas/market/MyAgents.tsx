// 设置 → 功能 → 我的 Agent: the author's Agents of the market, each with its listing, its latest version's review, and
// how its runs went; new Agents and new versions are written here or published from a canvas node, and the earnings
// they made are below. The market is the service's, not a workspace's: the workspace picked here only supplies the
// skills and models the form offers.
import { useEffect, useState } from 'react';
import { Pencil, Plus, ThumbsDown, ThumbsUp } from 'lucide-react';
import { saasErrorMessage, type Identity } from '../api';
import { SettingsIntro } from '../settings/general';
import { TenantPicker, useSettingsTenant } from '../settings/tenant';
import { readMyMarketAgents, relistMarketAgent, submitMarketAgent, unlistMarketAgent, withdrawMarketAgent, type MarketSettings, type MyMarketAgent } from '../marketApi';
import { MarketEarningsPanel } from './MarketEarnings';
import { PublishAgentDialog } from './PublishAgentDialog';
import { agentStatusName, numberText, percentText, priceText, useMarketI18n, versionStateName } from './marketText';
import { forgetMarketAgent, useMarketSettings } from './useMarket';
import './market.css';

export function MyAgentsSettings({ identity }: { identity: Identity }) {
  const { t } = useMarketI18n();
  const [tenant, setTenant] = useSettingsTenant(identity);
  const active = tenant?.status === 'active' ? tenant : undefined;
  const settings = useMarketSettings(active?.id ?? identity.tenants.find(item => item.status === 'active')?.id);
  return <>
    <SettingsIntro title={t('我的 Agent', 'My Agents')} intro={t('你发布到 Agent 市场的 Agent。每个版本要平台审核通过才上架；别人用你的付费 Agent 成功完成一次，你就得到一份收益。',
      'The Agents you publish to the Agent market. Each version lists once the platform approves it; each time someone’s node completes with your paid Agent, you earn a share.')} />
    {settings === undefined ? <p role="status">{t('正在读取…', 'Loading…')}</p>
      : settings === null ? <div className="saas-settings-stack">
        <p role="status">{t('这个服务器没有开放 Agent 市场。', 'This server does not offer the Agent market.')}</p>
        <MarketEarningsPanel onlyIfAny />
      </div>
      : <div className="saas-settings-stack">
        <TenantPicker identity={identity} tenant={tenant} onChange={setTenant} label={t('技能和模型取自工作区', 'Skills and models from the workspace')} />
        <MyAgentsList tenantId={active?.id} settings={settings} />
        <MarketEarningsPanel />
      </div>}
  </>;
}

type Editing = { agentId?: string } | null;

function MyAgentsList({ tenantId, settings }: { tenantId?: string; settings: MarketSettings }) {
  const { locale, t } = useMarketI18n();
  const [agents, setAgents] = useState<MyMarketAgent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    readMyMarketAgents(controller.signal).then(value => { if (!controller.signal.aborted) { setAgents(value); setError(null); } },
      cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [revision]);
  const act = async (agent: MyMarketAgent, action: () => Promise<void>, done: string) => {
    if (busy) return;
    setBusy(agent.id); setError(null); setNotice('');
    try { await action(); forgetMarketAgent(agent.id); setNotice(done); setRevision(value => value + 1); }
    catch (cause) { setError(cause); }
    finally { setBusy(null); }
  };
  return <section className="saas-card saas-settings-card saas-market-mine" aria-label={t('我的 Agent', 'My Agents')}>
    <div className="saas-market-mine-head"><h2>{t('我的 Agent', 'My Agents')}</h2>
      {tenantId && <button type="button" className="saas-primary" onClick={() => setEditing({})}><Plus size={15} aria-hidden="true" />{t('新建 Agent', 'New Agent')}</button>}</div>
    <p className="saas-settings-description">{t('也可以在画布节点的配置里点「发布到 Agent 市场」，用节点的人设、技能和模型开始。', 'You can also start from a canvas node: choose “Publish to the Agent market” in its configuration to use its persona, skills and model.')}</p>
    {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {notice && <p role="status" className="saas-connection-success">{notice}</p>}
    {!agents ? error === null && <p role="status">{t('正在读取你的 Agent…', 'Loading your Agents…')}</p>
      : !agents.length ? <p>{t('你还没有发布过 Agent。', 'You have not published an Agent yet.')}</p>
      : <ul className="saas-market-mine-list">{agents.map(agent => {
        const latest = agent.latest;
        const working = busy === agent.id;
        return <li key={agent.id} aria-label={agent.name}>
          <div className="saas-market-mine-head"><strong>{agent.name}</strong>
            <span className="saas-market-badge">{agentStatusName(agent.status, t)}{agent.listedVersion ? ` · v${agent.listedVersion}` : ''}</span></div>
          <div className="saas-market-mine-meta">
            <span>{t(`最新版本 v${latest.version}：${versionStateName(latest.state, t)}`, `Latest version v${latest.version}: ${versionStateName(latest.state, t)}`)}</span>
            <span>{priceText(latest.price, t)}</span>
          </div>
          {latest.reviewNote && <p className="saas-settings-description">{t(`审核意见：${latest.reviewNote}`, `Review note: ${latest.reviewNote}`)}</p>}
          <div className="saas-market-mine-meta">
            <span>{t(`调用 ${numberText(agent.stats.calls, locale)} 次`, `${numberText(agent.stats.calls, locale)} calls`)}</span>
            <span>{t(`成功率 ${percentText(agent.stats.successRate)}`, `${percentText(agent.stats.successRate)} succeeded`)}</span>
            <span>{t(`${numberText(agent.stats.users, locale)} 人用过`, `${numberText(agent.stats.users, locale)} users`)}</span>
            <span className="awwo-market-votes"><ThumbsUp size={12} aria-label={t('好评', 'Up')} />{agent.stats.up}<ThumbsDown size={12} aria-label={t('差评', 'Down')} />{agent.stats.down}</span>
            {!agent.stats.ranked && <span>{t('还没进排行', 'Not ranked yet')}</span>}
          </div>
          {/* What the server lets an author do (market_author.go): nothing once the platform suspended the Agent, no
              change while a version waits for review, and listing again only with an approved version. */}
          {agent.status !== 'suspended' && <div className="saas-market-actions">
            {tenantId && latest.state !== 'pending' && <button type="button" disabled={Boolean(busy)} onClick={() => setEditing({ agentId: agent.id })}><Pencil size={14} aria-hidden="true" />{latest.state === 'draft' ? t('编辑草稿', 'Edit the draft') : t('编辑（新版本）', 'Edit (a new version)')}</button>}
            {latest.state === 'draft' && <button type="button" disabled={Boolean(busy)} onClick={() => void act(agent, () => submitMarketAgent(agent.id), t('已提交审核。', 'Submitted for review.'))}>{working ? t('请稍候…', 'Please wait…') : t('提交审核', 'Submit for review')}</button>}
            {latest.state === 'pending' && <button type="button" disabled={Boolean(busy)} onClick={() => void act(agent, () => withdrawMarketAgent(agent.id), t('已撤回，版本回到草稿。', 'Withdrawn; the version is a draft again.'))}>{t('撤回审核', 'Withdraw from review')}</button>}
            {agent.status === 'listed' && <button type="button" disabled={Boolean(busy)} onClick={() => void act(agent, () => unlistMarketAgent(agent.id), t('已下架：市场里不再显示，已经在用的节点照常运行。', 'Unlisted: the market no longer shows it, and nodes already using it keep running.'))}>{t('下架', 'Unlist')}</button>}
            {agent.status === 'unlisted' && agent.listedVersion !== null && <button type="button" disabled={Boolean(busy)} onClick={() => void act(agent, () => relistMarketAgent(agent.id), t('已重新上架。', 'Listed again.'))}>{t('重新上架', 'List again')}</button>}
          </div>}
          {latest.state === 'pending' && agent.status !== 'suspended' && <p className="saas-settings-description">{t('这个版本正在审核：要修改，先撤回审核。', 'This version is in review: withdraw it to change it.')}</p>}
          {agent.status === 'suspended' && <p className="saas-settings-description">{t('平台已停用这个 Agent：所有使用都已停止，也不能再修改。', 'The platform suspended this Agent: every use of it has stopped, and it can no longer change.')}</p>}
        </li>;
      })}</ul>}
    {editing && tenantId && <PublishAgentDialog tenantId={tenantId} settings={settings} agentId={editing.agentId}
      onSaved={() => setRevision(value => value + 1)} onClose={() => setEditing(null)} />}
  </section>;
}
