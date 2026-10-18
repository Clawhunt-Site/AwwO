import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Scale } from 'lucide-react';
import { canvasKeyBindings, type CanvasKeyAction } from '../../canvas/useCanvasKeys';
import { AccountWorkspacePanel } from '../../account';
import { saasErrorMessage, type Identity } from '../api';
import { createSaaSAccountApi } from '../accountApi';
import { clawHuntAccountURL } from '../clawhuntAuth';
import { readExecutionRuntime, type ExecutionRuntime } from '../managedExecutionApi';
import { accountURL } from '../PersonalAccount';
import { useSaaSPreferences } from '../preferences';
import { RouteUsageMeter } from '../RouteUsageMeter';
import { GuideLauncher, MainSiteLink, TutorialLauncher } from '../SaaSOnboarding';
import { SkillLibrary } from '../SkillLibrary';
import { ThemeChoices } from '../ThemePicker';
import { SettingsCard, SettingsIntro } from './general';
import { TenantPicker, useSettingsTenant } from './tenant';

export { GeneralSettings } from './general';
export { PersonalizationSettings } from './personalization';
export { DataSettings } from './data';

const home = () => {
  const query = new URLSearchParams(location.search);
  query.delete('account');
  return '/' + (query.size ? '?' + query : '');
};

export function PlansUsage({ identity }: { identity: Identity }) {
  const { t } = useSaaSPreferences();
  const [tenant, setTenant] = useSettingsTenant(identity);
  if (!tenant || tenant.status !== 'active') return null;
  return <section className="saas-card saas-settings-card saas-settings-usage">
    <h2>{t('今天的用量', 'Today’s usage')}</h2>
    <TenantPicker identity={identity} tenant={tenant} onChange={setTenant} />
    <RouteUsageMeter key={tenant.id} tenantId={tenant.id} />
  </section>;
}

export function AppearanceSettings() {
  const { t } = useSaaSPreferences();
  return <>
    <SettingsIntro title={t('外观', 'Appearance')} intro={t('选一套预设风格，整个 AwwO 立刻换上。只记在这个浏览器里。', 'Pick a preset style and all of AwwO switches to it at once. Kept in this browser only.')} />
    <section className="saas-card saas-settings-card saas-settings-themes"><ThemeChoices /></section>
  </>;
}

const SHORTCUT_EN: Record<CanvasKeyAction, string> = {
  'focus-toggle': 'Focus / leave focus', 'cycle-next': 'Next node', 'cycle-prev': 'Previous node', palette: 'Command palette',
  search: 'Search the canvas', 'fit-all': 'Fit all', 'delete-selection': 'Delete selection', undo: 'Undo', redo: 'Redo',
  'save-waypoint': 'Save a waypoint', 'recall-waypoint': 'Go to a waypoint', escape: 'Leave focus / close a panel',
};
export function ShortcutSettings() {
  const { t } = useSaaSPreferences();
  // The canvas's own binding table, so this list can never promise a key the canvas does not answer.
  const bindings = useMemo(() => canvasKeyBindings(), []);
  return <>
    <SettingsIntro title={t('快捷键', 'Shortcuts')} intro={t('在画布上使用。光标在输入框里时只有 Esc 生效，其余按键交给输入框。', 'They work on a canvas. While you type in a field only Esc applies; every other key goes to the field.')} />
    <SettingsCard title={t('画布', 'Canvas')}>
      <table className="saas-settings-keys">
        <tbody>{bindings.map(binding => <tr key={binding.action}><td>{t(binding.label, SHORTCUT_EN[binding.action])}</td><td><kbd>{binding.hint}</kbd></td></tr>)}</tbody>
      </table>
    </SettingsCard>
    <SettingsCard title={t('对话输入框', 'Chat composers')}>
      <table className="saas-settings-keys">
        <tbody>
          <tr><td>{t('发送', 'Send')}</td><td><kbd>Enter</kbd></td></tr>
          <tr><td>{t('换行', 'New line')}</td><td><kbd>Shift</kbd> + <kbd>Enter</kbd></td></tr>
        </tbody>
      </table>
    </SettingsCard>
  </>;
}

export function SkillSettings({ identity }: { identity: Identity }) {
  const { t } = useSaaSPreferences();
  const [tenant, setTenant] = useSettingsTenant(identity);
  return <>
    <SettingsIntro title={t('技能', 'Skills')} intro={t('技能按工作区保存。选一个工作区，查看、新建或导入它的技能。', 'Skills are kept per workspace. Choose one to read, create or import its skills.')} />
    <TenantPicker identity={identity} tenant={tenant} onChange={setTenant} />
    {!tenant || tenant.status !== 'active'
      ? <p role="status">{t('没有可用的工作区。', 'No active workspace.')}</p>
      : <div className="saas-settings-library"><SkillLibrary key={tenant.id} tenantId={tenant.id} readOnly={tenant.role === 'reader'} onClose={() => location.assign(home())} /></div>}
  </>;
}

/** 模型服务 for accounts on the platform's models (no personal key): what this workspace can use now. */
export function EngineSettings({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const [tenant, setTenant] = useSettingsTenant(identity);
  const [runtime, setRuntime] = useState<ExecutionRuntime | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!tenant || tenant.status !== 'active') return;
    const controller = new AbortController(); setRuntime(null); setError(null);
    readExecutionRuntime(tenant.id, controller.signal).then(value => { if (!controller.signal.aborted) setRuntime(value); },
      cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [tenant?.id, tenant?.status]);
  return <>
    <SettingsIntro title={t('模型服务', 'Model service')} intro={t('AwwO 已通过 LLM Gate 提供模型，无需填写个人 API Key。模型实际可用性以运行结果为准。', 'AwwO provides models through LLM Gate. No personal API key is needed; an actual run verifies model connectivity.')} />
    <SettingsCard title={t('画布助手可用的模型', 'Models for the canvas assistant')} description={<>{t('默认用哪个，在', 'Choose the default in ')}<a href={accountURL('general')}>{t('通用', 'General')}</a>{t('里设置。', '.')}</>}>
      <TenantPicker identity={identity} tenant={tenant} onChange={setTenant} />
      {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
      {!runtime && error === null && tenant?.status === 'active' && <p role="status">{t('正在读取…', 'Loading…')}</p>}
      {runtime && <>
        <p role="status">{runtime.ready ? t('服务可用。', 'The service is available.') : t('服务暂时不可用：', 'The service is unavailable right now: ') + (runtime.reason ? saasErrorMessage(runtime.reason, locale) : '')}</p>
        <ul className="saas-settings-models">{runtime.models.map(item => <li key={item.runtime + ':' + item.id}>
          <strong>{item.label || item.id}</strong>{item.requiresUpgrade && <span>{t('需升级套餐', 'Needs an upgrade')}</span>}
        </li>)}</ul>
      </>}
    </SettingsCard>
  </>;
}

export function WorkspaceSettings({ identity, onProfile }: { identity: Identity; onProfile?: (name: string) => void }) {
  const { t, locale } = useSaaSPreferences();
  const [tenant, setTenant] = useSettingsTenant(identity);
  const api = useMemo(() => createSaaSAccountApi(onProfile || (() => {})), [identity.user.id, onProfile]);
  const clawhunt = identity.authentication === 'clawhunt';
  return <>
    <SettingsIntro title={t('成员与工作区', 'Members and workspaces')} intro={t('你的资料、所在的工作区和成员。管理成员和邀请链接需要工作区的管理权限。', 'Your profile, the workspaces you belong to and their members. Managing members and invite links needs a manager role in the workspace.')} />
    <div className="saas-connection-actions saas-settings-actions"><a className="saas-buy-link" href="/?createWorkspace=1">{t('新建工作区', 'Create workspace')}</a></div>
    <section className="saas-card saas-settings-card saas-settings-members">
      <AccountWorkspacePanel key={tenant?.id || 'none'} locale={locale} clawHuntIdentity={null} selectedCompanyId={tenant?.id || null}
        onCompanyChange={setTenant} onClawHuntLogin={() => {}} onClawHuntLogout={() => {}} api={api} workspaceOnly
        {...(clawhunt ? { externalProfile: { url: clawHuntAccountURL(identity.clawhuntSiteURL) || undefined, invitesUrl: accountURL('invites'), plansUrl: accountURL('plans') } } : {})} />
    </section>
  </>;
}

const LICENSES_URL = '/third-party-licenses.txt';
export function AboutSettings({ identity }: { identity: Identity }) {
  const { t } = useSaaSPreferences();
  const version = import.meta.env.VITE_AWWO_VERSION as string | undefined;
  const site = identity.clawhuntSiteURL ? identity.clawhuntSiteURL.replace(/\/+$/, '') : '';
  return <>
    <SettingsIntro title={t('关于 AwwO', 'About AwwO')} intro={t('ClawHunt 孵化出品。', 'Incubated by ClawHunt.')} />
    <div className="saas-settings-stack">
      <SettingsCard title={t('版本', 'Version')}><p>{version ? `AwwO ${version}` : 'AwwO'}</p></SettingsCard>
      <SettingsCard title={t('条款与许可', 'Terms and licences')}>
        <ul className="saas-settings-links">
          {/^https:\/\//.test(site) && <li><a href={site + '/legal'} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} aria-hidden="true" />{t('隐私政策', 'Privacy policy')}</a></li>}
          <li><a href={LICENSES_URL} target="_blank" rel="noreferrer"><Scale size={15} aria-hidden="true" />{t('开源许可', 'Open-source licenses')}</a></li>
        </ul>
      </SettingsCard>
      <SettingsCard title={t('帮助', 'Help')}>
        <div className="saas-settings-help"><TutorialLauncher /><GuideLauncher /><MainSiteLink /></div>
      </SettingsCard>
    </div>
  </>;
}
