import { useEffect, useRef, useState } from 'react';
import { Lightbulb, Sparkles } from 'lucide-react';
import { saasErrorMessage, type Identity } from '../api';
import { readLearningSettings, updateLearningSettings, type LearningSetting, type LearningSettings } from '../learningApi';
import { useSaaSPreferences } from '../preferences';
import { SettingsCard } from './general';
import { TenantPicker, useSettingsTenant } from './tenant';

// The 数据管理 page's learning settings of one workspace (learning.go): self-learning, on wherever this AwwO offers it
// unless an admin turns it off, and Help improve AwwO, which only the owner turns on. Each shows where this AwwO offers
// it, and the consent also where it is on though no longer offered, to be turned off; every member sees whether each is
// on, and since when. Settings that cannot be read (an API without them, which a website released before its API meets)
// show nothing; an API before self-learning shows the consent alone. Once shown, the card stays while another workspace's settings are read, so its picker does not
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
  const worth = (value: LearningSettings) => visible(value.consent) || visible(value.selfLearning) || !!value.memorySuggestions || value.elsewhere;
  // Shown while this workspace has a setting to show, or another has one of the person's on, which its picker reaches.
  if (!tenant || !loaded || (loaded.settings && !worth(loaded.settings))) return null;
  const settings = loaded.id === tenant.id ? loaded.settings : undefined;
  const owner = tenant.role === 'owner';
  const admin = owner || tenant.role === 'admin';
  const change = async (patch: { consent?: boolean; selfLearning?: boolean; memorySuggestions?: false }) => {
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
    description={t('对下面选中的工作区生效。', 'For the workspace chosen below.')}>
    <TenantPicker identity={identity} tenant={tenant} onChange={setTenant} disabled={busy} />
    {error !== null && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}
    {settings === undefined && <p className="saas-field-hint" role="status">{t('正在读取这个工作区的设置…', 'Reading this workspace’s settings…')}</p>}
    {settings === null && <p className="saas-field-hint" role="status">{t('读不到这个工作区的学习设置。', 'This workspace’s learning settings cannot be read.')}</p>}
    {settings && !visible(settings.consent) && !visible(settings.selfLearning) && !settings.memorySuggestions && <p className="saas-field-hint">{t('这个工作区没有可以更改的学习设置；你在另一个工作区开启了设置，在上面选它就能关闭。',
      'Nothing to change in this workspace; a setting of yours is on in another workspace: choose it above to turn it off.')}</p>}
    {settings && visible(settings.selfLearning) && <>
      <label className="saas-settings-toggle">
        <input type="checkbox" checked={settings.selfLearning.on} disabled={locked(settings.selfLearning, admin)} onChange={event => void change({ selfLearning: event.target.checked })} />
        <span><Sparkles size={15} aria-hidden="true" />{t('自动学习', 'Self-learning')}</span>
      </label>
      <p className="saas-field-hint">{t('开启时，画布运行结束后，ClawHunt 的默认模型会读这次运行的记录（每个节点的任务和交付摘录，去掉看起来像密钥、邮箱、大多数电话、卡号或账号的内容，人名照留），为这张画布记下值得记住的笔记（事实、决定、偏好、风格）；记下的笔记先在试用中，之后的运行又独立记下同样的一条，才交给运行。它还会在学习周期里整理（多久一次，见「经验」）：合并重复的、把试用中 30 天里没有运行再印证的归档、把几张画布都印证过的偏好和风格提升到整个工作区，并把一直有用的经验推广到同类节点。你们自己写的、改过或置顶的笔记不会作为笔记发给模型（交付内容里转述到的除外，AwwO 也可能用自己的话记下转述的内容），AwwO 也从不改它们；你们删掉的 AwwO 笔记，或改过文字的 AwwO 笔记原来的说法，同样或大体相同的内容不会再在那里记（它若用的是某张画布的原话，那张画布删掉后就不再记着）。记下的笔记和经验只留在这个工作区，在「记忆」和「经验」里都能看到、修改和撤销。为了不再记下删掉的内容，它会留着这些文字用 ClawHunt 持有的密钥算出的哈希，不留原文，但有这把密钥就能还原出其中大部分内容，一直留到那张画布或这个工作区删掉、或密钥更换；运行也会留着交给它们的笔记的副本。默认开启，管理员或所有者可以关闭：关闭后不再读取新的运行，AwwO 记下的笔记不再交给运行，经验也不再推广，已经记下的保留；再次开启后只读开启之后开始的运行。',
        'While on, when a canvas run ends, ClawHunt’s default model reads its record (each node’s task and an excerpt of its delivery, without what looks like a key, an email address, most phone numbers, or a card or account number; names stay) and keeps notes worth remembering for the canvas (facts, decisions, preferences, style); each waits on probation, and goes to runs once a later run writes the same note again on its own. In its learning cycles (how often, see Lessons) it also tidies them: merging duplicates, archiving the notes on probation that no run bore out again within 30 days, moving preferences and style rules that several canvases bore out to the whole workspace, and giving lessons that kept helping to nodes like theirs. The notes you write, change or pin are never sent to the model as notes (a delivery may still restate one, and AwwO may keep what it restates in its own words), and AwwO never changes them; a note of AwwO’s you delete, or what one said before you changed its text, is not kept there again, in those words or most of them (one in a canvas’s own words is remembered only while that canvas is kept). The notes and lessons it keeps stay in this workspace, where Memory and Lessons show them, to change or undo. To hold back what you deleted, it keeps hashes of those words, made with a key ClawHunt holds, not the text, though with that key much of it could be worked out again, until the canvas or the workspace is deleted or the key is replaced; and runs keep copies of the notes they were given. It is on unless an admin or the owner turns it off: off, no new run is read, no note AwwO kept is given to a run and no lesson is moved, and what was kept stays; on again, only runs begun after that are read.')}
        {settings.selfLearning.on ? ` ${t('开启于', 'On since')} ${since(settings.selfLearning.since)}。` : ''}</p>
    </>}
    {settings?.memorySuggestions && <>
      <label className="saas-settings-toggle">
        <input type="checkbox" checked disabled={!admin || busy} onChange={() => void change({ memorySuggestions: false })} />
        <span><Sparkles size={15} aria-hidden="true" />{t('从运行中提炼记忆建议', 'Memory suggestions from runs')}</span>
      </label>
      <p className="saas-field-hint">{t('这个 AwwO 还是旧版本：这项设置开着，管理员或所有者可以在这里关闭它。', 'This AwwO is still the earlier release: this setting is on, and an admin or the owner can turn it off here.')}</p>
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
