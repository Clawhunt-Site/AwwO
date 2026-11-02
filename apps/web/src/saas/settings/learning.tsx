import { useEffect, useRef, useState } from 'react';
import { Lightbulb, Sparkles } from 'lucide-react';
import { saasErrorMessage, type Identity } from '../api';
import { readLearningSettings, updateLearningSettings, type LearningSetting, type LearningSettings } from '../learningApi';
import { useSaaSPreferences } from '../preferences';
import { SettingsCard } from './general';
import { TenantPicker, useSettingsTenant } from './tenant';

// The 数据管理 page's learning settings of one workspace (learning.go): memory suggestions from runs, which an admin turns
// on, and Help improve AwwO, which only the owner turns on. Each shows where this AwwO offers it, off unless turned on,
// and where it is on though no longer offered, to be turned off; every member sees whether it is on, and since when.
// Settings that cannot be read (an API without them, which a website released before its API meets) show nothing:
// both are off there. Once shown, the card stays while another workspace's settings are read, so its picker does not
// vanish. A change answers for the workspace it was made in, and the workspace cannot be switched while one is on its
// way.
export function LearningCard({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const [tenant, setTenant] = useSettingsTenant(identity);
  // The workspace the settings were last read for, and what they were (null: they could not be read).
  const [loaded, setLoaded] = useState<{ id: string; settings: LearningSettings | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef('');
  useEffect(() => {
    if (!tenant) return;
    shown.current = tenant.id;
    const controller = new AbortController();
    setError(null);
    readLearningSettings(tenant.id, controller.signal).then(value => { if (!controller.signal.aborted) setLoaded({ id: tenant.id, settings: value }); },
      () => { if (!controller.signal.aborted) setLoaded(previous => previous && { id: tenant.id, settings: null }); });
    return () => controller.abort();
  }, [tenant?.id]);
  const visible = (setting: LearningSetting) => setting.offered || setting.on;
  const worth = (value: LearningSettings) => visible(value.consent) || visible(value.memorySuggestions) || value.elsewhere;
  // Shown while this workspace has a setting to show, or another has one of the person's on, which its picker reaches.
  if (!tenant || !loaded || (loaded.settings && !worth(loaded.settings))) return null;
  const settings = loaded.id === tenant.id ? loaded.settings : undefined;
  const owner = tenant.role === 'owner';
  const admin = owner || tenant.role === 'admin';
  const change = async (patch: { consent?: boolean; memorySuggestions?: boolean }) => {
    if (busy) return;
    const id = tenant.id;
    setBusy(true); setError(null);
    try {
      const value = await updateLearningSettings(id, patch);
      if (shown.current === id) setLoaded({ id, settings: value });
    } catch (cause) { if (shown.current === id) setError(cause); }
    finally { setBusy(false); }
  };
  // One that is not offered can only be turned off.
  const locked = (setting: LearningSetting, may: boolean) => !may || busy || (!setting.offered && !setting.on);
  const since = (value: string | null) => value ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : '';
  return <SettingsCard title={t('学习与改进', 'Learning and improvement')}
    description={t('对下面选中的工作区生效，默认都是关闭的。', 'For the workspace chosen below; both are off unless turned on.')}>
    <TenantPicker identity={identity} tenant={tenant} onChange={setTenant} disabled={busy} />
    {error !== null && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}
    {settings === undefined && <p className="saas-field-hint" role="status">{t('正在读取这个工作区的设置…', 'Reading this workspace’s settings…')}</p>}
    {settings === null && <p className="saas-field-hint" role="status">{t('读不到这个工作区的学习设置。', 'This workspace’s learning settings cannot be read.')}</p>}
    {settings && !visible(settings.consent) && !visible(settings.memorySuggestions) && <p className="saas-field-hint">{t('这个工作区没有可以更改的学习设置；你在另一个工作区开启了设置，在上面选它就能关闭。',
      'Nothing to change in this workspace; a setting of yours is on in another workspace: choose it above to turn it off.')}</p>}
    {settings && visible(settings.memorySuggestions) && <>
      <label className="saas-settings-toggle">
        <input type="checkbox" checked={settings.memorySuggestions.on} disabled={locked(settings.memorySuggestions, admin)} onChange={event => void change({ memorySuggestions: event.target.checked })} />
        <span><Sparkles size={15} aria-hidden="true" />{t('从运行中提炼记忆建议', 'Memory suggestions from runs')}</span>
      </label>
      <p className="saas-field-hint">{t('开启后，值得学习的画布运行结束时，ClawHunt 的默认模型会读这次运行的记录（每个节点的任务和交付摘录），提出最多 3 条值得这张画布记住的笔记，放在画布的「经验」里等成员确认；确认前不会交给任何运行。只读开启之后开始的运行；关闭后，还没发给模型的运行都不再提炼。需要管理员开启。',
        'When on, a canvas run worth learning from has ClawHunt’s default model read its record (each node’s task and an excerpt of its delivery) and propose up to 3 notes worth keeping for the canvas, in its 经验 (Lessons) panel, for a member to accept; none is given to a run before that. Only runs begun after it was turned on are read; turning it off stops every run not yet sent to the model. An admin turns it on.')}
        {settings.memorySuggestions.on ? ` ${t('开启于', 'On since')} ${since(settings.memorySuggestions.since)}。` : ''}</p>
    </>}
    {settings && visible(settings.consent) && <>
      <label className="saas-settings-toggle">
        <input type="checkbox" checked={settings.consent.on} disabled={locked(settings.consent, owner)} onChange={event => void change({ consent: event.target.checked })} />
        <span><Lightbulb size={15} aria-hidden="true" />{t('帮助改进 AwwO', 'Help improve AwwO')}</span>
      </label>
      <p className="saas-field-hint">{t('开启后，这个工作区从此刻起的画布运行（发给模型的提示和上下文、运行的步骤、交付的内容和评分）可能被 ClawHunt 留存副本，用于评估和训练 AI 模型，使用前会去掉能识别的密钥；只有隐私政策第 08 条列出的模型的输出可能用于训练，其他模型（包括 Claude 和 OpenAI 的）只用于评估。开启之前的运行不会被复制（之后的运行里仍可能引用它们交付的内容）；关闭后不再留存新的副本。只有工作区的所有者能开关；工作区交给别人后，要新的所有者重新开启。详见隐私政策第 08 条。',
        'When on, ClawHunt may keep copies of the canvas runs this workspace makes from then on (the prompts and context sent to models, each run’s steps, what it delivered and its ratings) to evaluate and train AI models, with the secrets it can detect removed first; only outputs of the models clause 08 of the privacy policy names may train models, and every other model’s, Claude’s and OpenAI’s among them, are used only to evaluate. Runs made before it was on are not copied (later runs may still quote what they delivered); turning it off stops new copies. Only the workspace’s owner can change it, and a workspace handed to someone else is off until its new owner turns it on; see clause 08 of the privacy policy.')}
        {settings.consent.on ? ` ${t('开启于', 'On since')} ${since(settings.consent.since)}。` : ''}</p>
    </>}
  </SettingsCard>;
}
