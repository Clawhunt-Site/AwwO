// The 设置 centre: one page with every setting of the account, its left navigation grouped as 账户 / 设置 / 功能 /
// 工作区 / 数据 / 关于. Each section is an ?account= address, so the links the app already sends (?account=security,
// plans, engines) open their section here. Pages that existed before (账号安全, 套餐与点数, 我的引擎) are drawn as they
// were, inside the centre (settingsFrame.ts); the others live in settings/. 邀请好友 (?account=invites) is gone with the
// invite codes (the public beta: AwwO is open to every ClawHunt account); its old links open 账号安全.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, CreditCard, Database, Info, KeyRound, Keyboard, LogOut, Monitor, Palette, Plug, Settings2, ShieldCheck, Sparkles, Store, UserRound, Users, Wand2 } from 'lucide-react';
import type { Identity } from './api';
import { isLocalEdition } from './edition';
import { AccountSecurity, accountURL } from './PersonalAccount';
import { PlansPage } from './PlansPage';
import { PreferenceControls, useSaaSPreferences } from './preferences';
import { MainSiteLink } from './SaaSOnboarding';
import { signOut } from './signOut';
import type { SettingsSection } from './settingsFrame';
import { AboutSettings, AppearanceSettings, DataSettings, EngineSettings, GeneralSettings, PersonalizationSettings, PlansUsage, ShortcutSettings, SkillSettings, WorkspaceSettings } from './settings/sections';
import { SettingsIntro } from './settings/general';
import { LocalComputerSettings } from './settings/local';
import { RelaySettings, relayOffered } from './settings/relay';
import { MyAgentsSettings } from './market/MyAgents';
import { useMarketSettings } from './market/useMarket';
import './settings/settings-center.css';

/**
 * The page an address opens in this edition. The local edition sells nothing, so the links the app sends to 用量与计费
 * open 本机 there; the hosted site has no 本机 and opens 账号安全 for it. 邀请好友 is gone (no invite codes since the public
 * beta): an old link to it opens 本机 in the local edition and 账号安全 on the hosted site.
 * 本机版连接 is the hosted site's where it offers AwwO 本地版 its models; elsewhere its address opens the engines page.
 */
export function editionSection(identity: Identity, section: SettingsSection): SettingsSection {
  if (section === 'relay' && !relayOffered(identity)) return 'engines';
  if (isLocalEdition(identity)) return section === 'plans' || section === 'invites' ? 'local' : section;
  return section === 'local' || section === 'invites' ? 'security' : section;
}

const home = () => {
  const query = new URLSearchParams(location.search);
  for (const key of ['account', 'reset', 'billing']) query.delete(key);
  return '/' + (query.size ? '?' + query : '');
};

type Item = { id: SettingsSection; icon: ReactNode; zh: string; en: string };
type Group = { zh: string; en: string; items: Item[] };
/** `market`: 我的 Agent is listed where the server offers the Agent market, and while it is the page open. */
function navigation(identity: Identity, market = false): Group[] {
  return [
    { zh: '账户', en: 'Account', items: [
      { id: 'security', icon: <UserRound size={16} />, zh: '账号安全', en: 'Account security' },
      isLocalEdition(identity) ? { id: 'local', icon: <Monitor size={16} />, zh: '本机', en: 'This computer' }
        : { id: 'plans', icon: <CreditCard size={16} />, zh: '用量与计费', en: 'Usage and billing' },
    ] },
    { zh: '设置', en: 'Settings', items: [
      { id: 'general', icon: <Settings2 size={16} />, zh: '通用', en: 'General' },
      { id: 'appearance', icon: <Palette size={16} />, zh: '外观', en: 'Appearance' },
      { id: 'shortcuts', icon: <Keyboard size={16} />, zh: '快捷键', en: 'Shortcuts' },
    ] },
    { zh: '功能', en: 'Features', items: [
      { id: 'personalization', icon: <Wand2 size={16} />, zh: '个性化', en: 'Personalization' },
      { id: 'skills', icon: <Sparkles size={16} />, zh: '技能', en: 'Skills' },
      ...(market ? [{ id: 'agents' as const, icon: <Store size={16} />, zh: '我的 Agent', en: 'My Agents' }] : []),
      { id: 'engines', icon: <Plug size={16} />, zh: identity.personalCredentialsRequired ? '我的执行引擎' : '模型服务', en: identity.personalCredentialsRequired ? 'My engines' : 'Model service' },
      ...(relayOffered(identity) ? [{ id: 'relay' as const, icon: <KeyRound size={16} />, zh: '本机版连接', en: 'AwwO Local' }] : []),
    ] },
    { zh: '工作区', en: 'Workspace', items: [
      { id: 'workspace', icon: <Users size={16} />, zh: '成员与工作区', en: 'Members and workspaces' },
    ] },
    { zh: '数据', en: 'Data', items: [
      { id: 'data', icon: <Database size={16} />, zh: '数据管理', en: 'Data management' },
    ] },
    { zh: '关于', en: 'About', items: [
      { id: 'about', icon: <Info size={16} />, zh: '关于 AwwO', en: 'About AwwO' },
    ] },
  ];
}

function SettingsNav({ identity, section }: { identity: Identity; section: SettingsSection }) {
  const { t } = useSaaSPreferences();
  const [error, setError] = useState('');
  // The market is the service's: any of the account's workspaces says whether this server offers it.
  const market = useMarketSettings(identity.tenants.find(tenant => tenant.status === 'active')?.id);
  const listsMarket = Boolean(market) || section === 'agents';
  const nav = useRef<HTMLElement>(null);
  // Where this placed the list last: a list the person has scrolled since stays where they put it.
  const placed = useRef<{ left: number; top: number } | null>(null);
  // On a phone the list is one scrolling row: centre the open page's entry in it. In the column of a wider screen, bring
  // it into the list's view, clear of the fade its scroll padding keeps at the bottom (settings-center.css). Again once
  // 我的 Agent joins the list (it waits for the workspace's market), which moves the entries after it, unless the person
  // has scrolled the list by then. Only the list scrolls, never the page: by then the reader may have scrolled it.
  useEffect(() => {
    const list = nav.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !current) return;
    if (placed.current && (list.scrollLeft !== placed.current.left || list.scrollTop !== placed.current.top)) return;
    const box = list.getBoundingClientRect();
    const entry = current.getBoundingClientRect();
    list.scrollLeft += entry.left + entry.width / 2 - (box.left + box.width / 2);
    if (list.scrollHeight > list.clientHeight) {
      const top = box.top + list.clientTop;
      const bottom = top + list.clientHeight - (parseFloat(getComputedStyle(list).scrollPaddingBottom) || 0);
      if (entry.bottom > bottom) list.scrollTop += entry.bottom - bottom;
      else if (entry.top < top) list.scrollTop -= top - entry.top;
    }
    placed.current = { left: list.scrollLeft, top: list.scrollTop };
  }, [section, listsMarket]);
  return <nav ref={nav} className="saas-settings-nav" aria-label={t('设置', 'Settings')}>
    <a className="saas-settings-back" href={home()}><ArrowLeft size={15} aria-hidden="true" />{t('返回工作区', 'Back to workspace')}</a>
    {navigation(identity, listsMarket).map(group => <div key={group.en} className="saas-settings-group">
      <span className="saas-settings-group-label">{t(group.zh, group.en)}</span>
      <div className="saas-settings-group-items">{group.items.map(item =>
        <a key={item.id} href={accountURL(item.id)} aria-current={item.id === section ? 'page' : undefined}>
          <span aria-hidden="true">{item.icon}</span>{t(item.zh, item.en)}
        </a>)}</div>
    </div>)}
    <div className="saas-settings-nav-foot">
      {identity.user.platformRole === 'admin' && !isLocalEdition(identity) && <a href="/admin"><ShieldCheck size={16} aria-hidden="true" />{t('平台管理', 'Administration')}</a>}
      <button type="button" onClick={async () => { setError(''); const failure = await signOut(identity, t); if (failure) setError(failure); }}>
        <LogOut size={16} aria-hidden="true" />{t('退出登录', 'Sign out')}
      </button>
      {error && <p role="alert" className="saas-error">{error}</p>}
    </div>
  </nav>;
}

function SectionPage({ identity, section, engines, onProfile }: { identity: Identity; section: SettingsSection; engines: ReactNode; onProfile?: (name: string) => void }) {
  const { t } = useSaaSPreferences();
  switch (section) {
    case 'security': return <AccountSecurity personalCredentialsRequired={identity.personalCredentialsRequired === true} identity={identity} />;
    case 'plans': return <>
      <SettingsIntro title={t('用量与计费', 'Usage and billing')} intro={t('免费试用期间，免费版每天有一定的次数（Claude、GPT 等高级模型由全站共享一份每日免费名额）；试用结束后，要有 Pro 或 Max 才能继续规划和运行。Pro 和 Max 每月给一笔点数，用于这些高级模型和图片视频生成，默认模型的次数也更多。', 'During the free trial the free plan has a number of calls a day (premium models such as Claude and GPT share one daily number of free calls across the service); after the trial, planning and running need Pro or Max. Pro and Max add credits every month for those premium models and for image and video generation, and more calls on the default model.')} />
      <PlansUsage identity={identity} />
      <PlansPage identity={identity} />
    </>;
    case 'local': return <LocalComputerSettings />;
    case 'general': return <GeneralSettings identity={identity} />;
    case 'appearance': return <AppearanceSettings />;
    case 'shortcuts': return <ShortcutSettings />;
    case 'personalization': return <PersonalizationSettings />;
    case 'skills': return <SkillSettings identity={identity} />;
    case 'agents': return <MyAgentsSettings identity={identity} />;
    case 'engines': return engines ?? <EngineSettings identity={identity} />;
    case 'relay': return <RelaySettings identity={identity} />;
    case 'workspace': return <WorkspaceSettings identity={identity} onProfile={onProfile} />;
    case 'data': return <DataSettings identity={identity} />;
    case 'about': return <AboutSettings identity={identity} />;
  }
}

export default function SettingsCenter({ identity, section: asked, engines, onProfile }: { identity: Identity; section: SettingsSection; engines: ReactNode; onProfile?: (name: string) => void }) {
  const section = editionSection(identity, asked);
  return <main className="saas-dashboard saas-personal saas-settings">
    <header>
      <a href="/" className="saas-logo">AwwO</a>
      <div className="saas-account-header-actions"><PreferenceControls /><MainSiteLink /></div>
    </header>
    <div className="saas-settings-layout">
      <SettingsNav identity={identity} section={section} />
      <div className="saas-settings-content" data-settings-section={section}>
        <SectionPage identity={identity} section={section} engines={engines} onProfile={onProfile} />
      </div>
    </div>
  </main>;
}
