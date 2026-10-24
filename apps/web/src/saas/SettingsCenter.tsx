// The 设置 centre: one page with every setting of the account, its left navigation grouped as 账户 / 设置 / 功能 /
// 工作区 / 数据 / 关于. Each section is an ?account= address, so the links the app already sends (?account=security,
// plans, invites, engines) open their section here. Pages that existed before (账号安全, 套餐与点数, 邀请好友, 我的引擎)
// are drawn as they were, inside the centre (settingsFrame.ts); the others live in settings/.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, CreditCard, Database, Gift, Info, Keyboard, Laptop, LogOut, Monitor, Palette, Plug, Settings2, ShieldCheck, Sparkles, UserRound, Users, Wand2 } from 'lucide-react';
import type { Identity } from './api';
import { isLocalEdition } from './edition';
import { AccountSecurity, accountURL } from './PersonalAccount';
import { InviteFriends } from './InviteFriends';
import { PlansPage } from './PlansPage';
import { PreferenceControls, useSaaSPreferences } from './preferences';
import { MainSiteLink } from './SaaSOnboarding';
import { signOut } from './signOut';
import type { SettingsSection } from './settingsFrame';
import { AboutSettings, AppearanceSettings, DataSettings, EngineSettings, GeneralSettings, PersonalizationSettings, PlansUsage, ShortcutSettings, SkillSettings, WorkspaceSettings } from './settings/sections';
import { SettingsIntro } from './settings/general';
import { LocalComputerSettings } from './settings/local';
import { LocalLinksSettings } from './settings/links';
import './settings/settings-center.css';

/**
 * The page an address opens in this edition. The local edition sells nothing and takes no invited friends, so the links
 * the app sends to 用量与计费 or 邀请好友 open 本机 there; the hosted site has no 本机 and opens 账号安全 for it. 本机连接
 * is the hosted site's, where it takes AwwO 本地版's links (docs/awwo-cloud-relay.md); the local edition links from 我的引擎.
 */
export function editionSection(identity: Identity, section: SettingsSection): SettingsSection {
  if (isLocalEdition(identity)) return section === 'plans' || section === 'invites' ? 'local' : section === 'links' ? 'engines' : section;
  if (section === 'links' && !identity.localRelay) return 'security';
  return section === 'local' ? 'security' : section;
}

const home = () => {
  const query = new URLSearchParams(location.search);
  for (const key of ['account', 'reset', 'billing']) query.delete(key);
  return '/' + (query.size ? '?' + query : '');
};

type Item = { id: SettingsSection; icon: ReactNode; zh: string; en: string };
type Group = { zh: string; en: string; items: Item[] };
function navigation(identity: Identity): Group[] {
  const clawhunt = identity.authentication === 'clawhunt';
  return [
    { zh: '账户', en: 'Account', items: [
      { id: 'security', icon: <UserRound size={16} />, zh: '账号安全', en: 'Account security' },
      isLocalEdition(identity) ? { id: 'local', icon: <Monitor size={16} />, zh: '本机', en: 'This computer' }
        : { id: 'plans', icon: <CreditCard size={16} />, zh: '用量与计费', en: 'Usage and billing' },
      ...(clawhunt ? [{ id: 'invites' as const, icon: <Gift size={16} />, zh: '邀请好友', en: 'Invite friends' }] : []),
      ...(!isLocalEdition(identity) && identity.localRelay ? [{ id: 'links' as const, icon: <Laptop size={16} />, zh: '本机连接', en: 'Connected computers' }] : []),
    ] },
    { zh: '设置', en: 'Settings', items: [
      { id: 'general', icon: <Settings2 size={16} />, zh: '通用', en: 'General' },
      { id: 'appearance', icon: <Palette size={16} />, zh: '外观', en: 'Appearance' },
      { id: 'shortcuts', icon: <Keyboard size={16} />, zh: '快捷键', en: 'Shortcuts' },
    ] },
    { zh: '功能', en: 'Features', items: [
      { id: 'personalization', icon: <Wand2 size={16} />, zh: '个性化', en: 'Personalization' },
      { id: 'skills', icon: <Sparkles size={16} />, zh: '技能', en: 'Skills' },
      { id: 'engines', icon: <Plug size={16} />, zh: identity.personalCredentialsRequired ? '我的执行引擎' : '模型服务', en: identity.personalCredentialsRequired ? 'My engines' : 'Model service' },
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
  const nav = useRef<HTMLElement>(null);
  // On a phone the list is one scrolling row: bring the open page's entry into it.
  useEffect(() => {
    const current = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [section]);
  return <nav ref={nav} className="saas-settings-nav" aria-label={t('设置', 'Settings')}>
    <a className="saas-settings-back" href={home()}><ArrowLeft size={15} aria-hidden="true" />{t('返回工作区', 'Back to workspace')}</a>
    {navigation(identity).map(group => <div key={group.en} className="saas-settings-group">
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
      <SettingsIntro title={t('用量与计费', 'Usage and billing')} intro={t('免费版每天的次数里也能用 Claude、GPT 等高级模型（全站每天共享一份免费名额）。Pro 和 Max 每月另给一笔点数，用于这些模型和图片视频生成，不占免费名额，默认模型的次数也更多。', 'The free plan can use premium models such as Claude and GPT within its daily calls (the service shares one daily number of free premium calls). Pro and Max add monthly credits for these models and for image or video generation, outside that free number, and more default-model calls.')} />
      <PlansUsage identity={identity} />
      <PlansPage identity={identity} />
    </>;
    case 'invites': return <>
      <SettingsIntro title={t('邀请好友', 'Invite friends')} intro={t('每个开通了 AwwO 的账号都有 3 个邀请码。把邀请链接发给好友，对方就能用 ClawHunt 账号开通 AwwO。', 'Every account with AwwO access has three invite codes. Send a friend an invite link and they can open AwwO with their ClawHunt account.')} />
      <InviteFriends identity={identity} />
    </>;
    case 'local': return <LocalComputerSettings />;
    case 'links': return <LocalLinksSettings identity={identity} />;
    case 'general': return <GeneralSettings identity={identity} />;
    case 'appearance': return <AppearanceSettings />;
    case 'shortcuts': return <ShortcutSettings />;
    case 'personalization': return <PersonalizationSettings />;
    case 'skills': return <SkillSettings identity={identity} />;
    case 'engines': return engines ?? <EngineSettings identity={identity} />;
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
