import { useEffect, useState, type ReactNode } from 'react';
import { Bell, Volume2 } from 'lucide-react';
import { saasErrorMessage, type Identity } from '../api';
import { useAccountPreferences, type AccountPreferences } from '../accountPreferences';
import { clawHuntAccountURL } from '../clawhuntAuth';
import { executionModelKey } from '../useManagedExecution';
import { readExecutionRuntime, type ExecutionModel } from '../managedExecutionApi';
import { UiModeSwitch, useSaaSPreferences } from '../preferences';
import { browserNotificationsSupported, playChime, requestNotificationPermission } from '../taskNotifications';
import { TenantPicker, useSettingsTenant } from './tenant';

export function SettingsIntro({ title, intro }: { title: string; intro: string }) {
  return <section className="saas-page-intro"><h1>{title}</h1><p>{intro}</p></section>;
}
export function SettingsCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return <section className="saas-card saas-settings-card">
    <h2>{title}</h2>
    {description && <p className="saas-settings-description">{description}</p>}
    {children}
  </section>;
}

/**
 * The account's saved settings for a page that changes them: null while they load or cannot (with the reason on
 * screen), else the current value and a save that reports how it went.
 */
export function useSavedPreferences() {
  const { t, locale } = useSaaSPreferences();
  const state = useAccountPreferences();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const save = async (next: AccountPreferences, done = t('已保存。', 'Saved.')) => {
    if (!state || saving) return false;
    setSaving(true); setMessage(null);
    try { await state.save(next); setMessage({ error: false, text: done }); return true; }
    catch (cause) { setMessage({ error: true, text: saasErrorMessage(cause, locale) }); return false; }
    finally { setSaving(false); }
  };
  const status = !state ? <p role="status">{t('登录后才能保存这些设置。', 'Sign in to save these settings.')}</p>
    : state.loadError ? <p role="alert" className="saas-error">{saasErrorMessage(state.loadError, locale)} <button type="button" onClick={state.reload}>{t('重试', 'Retry')}</button></p>
      : !state.preferences ? <p role="status">{t('正在读取设置…', 'Loading settings…')}</p> : null;
  const feedback = message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'saas-error' : 'saas-connection-success'}>{message.text}</p>;
  return { preferences: state?.preferences ?? null, status, save, saving, feedback };
}

function LanguageChoice() {
  const { locale, setLocale, t } = useSaaSPreferences();
  return <div className="saas-settings-segments" role="radiogroup" aria-label={t('界面语言', 'Interface language')}>
    {([['zh', '简体中文'], ['en', 'English']] as const).map(([value, name]) =>
      <button key={value} type="button" role="radio" aria-checked={locale === value} onClick={() => setLocale(value)}>{name}</button>)}
  </div>;
}

function DefaultModel({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const saved = useSavedPreferences();
  const [tenant, setTenant] = useSettingsTenant(identity);
  const [models, setModels] = useState<ExecutionModel[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!tenant || tenant.status !== 'active') { setModels([]); return; }
    const controller = new AbortController(); setModels(null); setError(null);
    readExecutionRuntime(tenant.id, controller.signal).then(value => { if (!controller.signal.aborted) setModels(value.models); },
      cause => { if (!controller.signal.aborted) { setError(cause); setModels([]); } });
    return () => controller.abort();
  }, [tenant?.id, tenant?.status]);
  const current = saved.preferences?.defaultModel;
  const currentKey = current ? executionModelKey(current.runtime, current.model) : '';
  const listed = (models || []).some(item => executionModelKey(item.runtime, item.id) === currentKey);
  return <SettingsCard title={t('画布助手默认模型', 'Canvas assistant default model')}
    description={t('画布助手在一个工作区里还没被你选过模型时，先用这里的模型；工作区不提供它时，仍用服务列表里的第一个模型（只能由你自己选的模型除外）。在画布里另选的模型照旧记在那个工作区。', 'Where you have not picked a model for the canvas assistant in a workspace yet, it starts with this one; a workspace that does not offer it keeps the first model on the service’s list (other than models only you can choose). A model you pick on a canvas is still kept for that workspace.')}>
    {saved.status}
    {saved.preferences && <>
      <TenantPicker identity={identity} tenant={tenant} onChange={setTenant} label={t('按这个工作区的模型列表选择', 'Choose from this workspace’s models')} />
      {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
      <label>{t('默认模型', 'Default model')}
        <select value={currentKey} disabled={saved.saving || models === null} onChange={event => {
          const value = event.target.value;
          const [runtime, model] = value ? JSON.parse(value) as [string, string] : ['', ''];
          void saved.save({ ...saved.preferences!, defaultModel: value ? { runtime, model } : null });
        }}>
          <option value="">{t('不设默认（用服务列表里的第一个模型）', 'No default (the first model on the service’s list)')}</option>
          {current && !listed && <option value={currentKey}>{current.model}{t('（这个工作区不提供）', ' (not offered in this workspace)')}</option>}
          {(models || []).map(item => <option key={executionModelKey(item.runtime, item.id)} value={executionModelKey(item.runtime, item.id)}>{item.label || item.id}{item.requiresUpgrade ? t('（需升级套餐）', ' (needs an upgrade)') : ''}</option>)}
        </select>
      </label>
      {models === null && <p role="status">{t('正在读取模型列表…', 'Loading models…')}</p>}
      {saved.feedback}
    </>}
  </SettingsCard>;
}

function TaskAlerts() {
  const { t } = useSaaSPreferences();
  const saved = useSavedPreferences();
  const [permission, setPermission] = useState(() => browserNotificationsSupported() ? Notification.permission : 'unsupported');
  const prefs = saved.preferences;
  const update = (change: Partial<AccountPreferences['notifications']>) => prefs && saved.save({ ...prefs, notifications: { ...prefs.notifications, ...change } });
  return <SettingsCard title={t('任务提醒', 'Task alerts')}
    description={t('你切到别的标签页或窗口时，画布页上的画布运行或画布规划结束，就提醒你；画布助手里正打开着的任务，在它前 6 分钟内结束时也会提醒。画布页需要保持打开。每台设备的浏览器要各自允许通知。', 'While you are on another tab or window, you are told when a canvas run or a canvas plan on an open canvas page ends, and when the task open in the canvas assistant ends within its first six minutes. The canvas page has to stay open. Each device’s browser has to allow notifications on its own.')}>
    {saved.status}
    {prefs && <>
      <label className="saas-settings-toggle">
        <input type="checkbox" checked={prefs.notifications.browser} disabled={saved.saving || permission === 'unsupported'} onChange={async event => {
          const on = event.target.checked;
          if (on) {
            const granted = await requestNotificationPermission();
            setPermission(browserNotificationsSupported() ? Notification.permission : 'unsupported');
            if (!granted) return;
          }
          await update({ browser: on });
        }} />
        <span><Bell size={15} aria-hidden="true" />{t('浏览器通知', 'Browser notifications')}</span>
      </label>
      {permission === 'denied' && <p className="saas-field-hint" role="status">{t('浏览器拒绝了 AwwO 的通知。请在地址栏左侧的网站设置里允许通知，再回来打开。', 'Your browser blocks notifications from AwwO. Allow them in the site settings next to the address bar, then turn this on.')}</p>}
      {permission === 'unsupported' && <p className="saas-field-hint">{t('这个浏览器不支持网页通知。', 'This browser does not support web notifications.')}</p>}
      <div className="saas-settings-row">
        <label className="saas-settings-toggle">
          <input type="checkbox" checked={prefs.notifications.sound} disabled={saved.saving} onChange={event => void update({ sound: event.target.checked })} />
          <span><Volume2 size={15} aria-hidden="true" />{t('声音提醒', 'Sound alert')}</span>
        </label>
        <button type="button" onClick={playChime}>{t('试听', 'Play sample')}</button>
      </div>
      {saved.feedback}
    </>}
  </SettingsCard>;
}

export function GeneralSettings({ identity }: { identity: Identity }) {
  const { t } = useSaaSPreferences();
  const accountLink = clawHuntAccountURL(identity.clawhuntSiteURL);
  return <>
    <SettingsIntro title={t('通用', 'General')} intro={t('语言和使用模式只记在这个浏览器里；默认模型和任务提醒保存在账号上，换设备也在。', 'Language and mode are kept in this browser; the default model and task alerts are saved to your account and follow you to other devices.')} />
    <div className="saas-settings-stack">
      <SettingsCard title={t('语言', 'Language')}><LanguageChoice /></SettingsCard>
      <SettingsCard title={t('使用模式', 'Mode')} description={t('普通模式只保留对话、组件聊天与选模型；开发者模式显示连线、配置、模型栏与运行记录等全部控制。切换不改动任何画布。', 'Simple mode keeps the chats and model choice; developer mode shows wiring, configuration, the model rail, run records and every other control. Switching changes no canvas.')}>
        <UiModeSwitch />
      </SettingsCard>
      <DefaultModel identity={identity} />
      <TaskAlerts />
      {identity.authentication === 'clawhunt' && <SettingsCard title={t('邮件通知', 'Email')} description={t('活动和产品更新邮件由 ClawHunt 发送，AwwO 不另发。不想再收到，点任意一封邮件底部的退订链接即可。', 'ClawHunt sends the event and product-update emails; AwwO sends none of its own. To stop them, use the unsubscribe link at the bottom of any of them.')}>
        {accountLink && <a className="saas-buy-link" href={accountLink} target="_blank" rel="noopener noreferrer">{t('打开 ClawHunt 账号', 'Open ClawHunt account')}</a>}
      </SettingsCard>}
    </div>
  </>;
}
