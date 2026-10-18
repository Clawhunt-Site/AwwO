import { useEffect, useState } from 'react';
import { ABOUT_ME_LIMIT, INSTRUCTIONS_LIMIT } from '../accountPreferences';
import { useSaaSPreferences } from '../preferences';
import { SettingsCard, SettingsIntro, useSavedPreferences } from './general';

const runes = (value: string) => [...value].length;

/** 个性化: what the canvas planner should know about this person and how they want answers (backend planCanvas). */
export function PersonalizationSettings() {
  const { t } = useSaaSPreferences();
  const saved = useSavedPreferences();
  const stored = saved.preferences?.personalization;
  const [draft, setDraft] = useState(stored);
  // A save elsewhere (another tab, a conflict reload) replaces an unchanged draft; an edited one stays.
  const [base, setBase] = useState(stored);
  useEffect(() => {
    if (!stored) return;
    setDraft(current => !current || (base && current.aboutMe === base.aboutMe && current.instructions === base.instructions && current.enabled === base.enabled) ? stored : current);
    setBase(stored);
  }, [stored]);
  const changed = Boolean(draft && stored && (draft.aboutMe !== stored.aboutMe || draft.instructions !== stored.instructions || draft.enabled !== stored.enabled));
  const tooLong = Boolean(draft && (runes(draft.aboutMe) > ABOUT_ME_LIMIT || runes(draft.instructions) > INSTRUCTIONS_LIMIT));
  return <>
    <SettingsIntro title={t('个性化', 'Personalization')} intro={t('告诉 AwwO 你是谁、希望怎样回答。打开后，你每次让画布助手规划画布，它都会参考这些内容。', 'Tell AwwO who you are and how you like answers. When it is on, the canvas assistant reads it every time you ask it to plan a canvas.')} />
    <SettingsCard title={t('自定义指令', 'Custom instructions')}
      description={t('只用于你自己发起的规划，不会带进别人的规划。但它会写进每次规划的记录，同一工作区里能看运行记录的成员看得到；之后改掉或关闭，已有的记录也不会变。不要写密码、密钥或别人的隐私。节点自己运行时不读它。', 'It is used only in plans you ask for, never in anyone else’s. It is written into each plan’s record, which members of the workspace who can read run records can see, and records already made keep it after you change it or turn it off. Leave out passwords, keys and other people’s private details. Nodes do not read it when they run.')}>
      {saved.status}
      {draft && <form className="saas-settings-form" onSubmit={async event => {
        event.preventDefault();
        if (!saved.preferences || tooLong) return;
        await saved.save({ ...saved.preferences, personalization: draft });
      }}>
        <label className="saas-settings-toggle">
          <input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
          <span>{t('规划画布时参考这些内容', 'Use these when planning canvases')}</span>
        </label>
        <label>{t('关于你', 'About you')}
          <textarea rows={4} value={draft.aboutMe} onChange={event => setDraft({ ...draft, aboutMe: event.target.value })}
            placeholder={t('例如：我是独立开发者，主要做面向海外的 SaaS 小产品。', 'For example: I am an indie developer building small SaaS products for overseas users.')} aria-describedby="settings-about-count" />
        </label>
        <small id="settings-about-count" className={runes(draft.aboutMe) > ABOUT_ME_LIMIT ? 'saas-error' : undefined}>{runes(draft.aboutMe)} / {ABOUT_ME_LIMIT}</small>
        <label>{t('希望怎样回答', 'How you want answers')}
          <textarea rows={6} value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })}
            placeholder={t('例如：方案先给结论；交付物用英文；每张画布最多 6 个节点。', 'For example: lead with the conclusion; write deliverables in English; keep each canvas to six nodes at most.')} aria-describedby="settings-instructions-count" />
        </label>
        <small id="settings-instructions-count" className={runes(draft.instructions) > INSTRUCTIONS_LIMIT ? 'saas-error' : undefined}>{runes(draft.instructions)} / {INSTRUCTIONS_LIMIT}</small>
        <div className="saas-connection-actions">
          <button className="saas-primary" disabled={!changed || tooLong || saved.saving}>{saved.saving ? t('正在保存…', 'Saving…') : t('保存', 'Save')}</button>
          {changed && <button type="button" disabled={saved.saving} onClick={() => setDraft(stored)}>{t('放弃修改', 'Discard changes')}</button>}
        </div>
        {saved.feedback}
      </form>}
    </SettingsCard>
  </>;
}
