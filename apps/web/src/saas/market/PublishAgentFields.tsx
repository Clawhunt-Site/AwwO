// The publish form's compound fields: the model the Agent suggests (or locks), the skills it carries (frozen into the
// version when the draft is saved), and up to three examples of what it does.
import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { automaticEntries } from '../../canvas/nodeRuntime';
import type { ModelPaletteSelection } from '../../canvas/modelPalette';
import { cachedSkillCatalog, skillTitle, type SkillSummary } from '../skillsApi';
import { MARKET_LIMITS, type MarketExample, type MarketModel } from '../marketApi';
import { skillTenant, type PublishSkill } from './publishForm';
import { useMarketI18n } from './marketText';

const choiceKey = (runtime: string, id: string) => JSON.stringify([runtime, id]);

export function ModelField({ model, models, disabled, onChange }: { model: MarketModel; models: ReadonlyArray<ModelPaletteSelection> | null; disabled: boolean; onChange: (model: MarketModel) => void }) {
  const { t } = useMarketI18n();
  const choices = useMemo(() => automaticEntries((models ?? []).filter(entry => entry.runtime !== 'sandbox')), [models]);
  const current = choices.find(entry => entry.model === model.id);
  const value = model.id ? current ? choiceKey(current.runtime, current.model) : choiceKey(model.runtime, model.id) : '';
  const efforts = current?.efforts ?? [];
  return <fieldset>
    <legend>{t('推荐模型', 'Suggested model')}</legend>
    <label>{t('模型', 'Model')}<select value={value} disabled={disabled} onChange={event => {
      if (!event.target.value) { onChange({ runtime: '', id: '', effort: '', locked: false }); return; }
      const [runtime, id] = JSON.parse(event.target.value) as [string, string];
      const entry = choices.find(item => item.runtime === runtime && item.model === id);
      onChange({ runtime, id, effort: entry?.efforts?.includes(model.effort) ? model.effort : '', locked: model.locked });
    }}>
      <option value="">{t('不指定（用节点自己的模型）', 'None (the node’s own model)')}</option>
      {model.id && !current && <option value={value}>{t(`当前：${model.id}`, `Current: ${model.id}`)}</option>}
      {choices.map(entry => <option key={entry.key} value={choiceKey(entry.runtime, entry.model)}>{entry.displayName || entry.label}</option>)}
    </select></label>
    {efforts.length > 0 && <label>{t('推理强度', 'Reasoning effort')}<select value={model.effort} disabled={disabled} onChange={event => onChange({ ...model, effort: event.target.value })}>
      <option value="">{t('模型默认', 'The model’s default')}</option>
      {efforts.map(level => <option key={level} value={level}>{level}</option>)}
    </select></label>}
    <label className="awwo-library-check"><input type="checkbox" checked={model.locked && Boolean(model.id)} disabled={disabled || !model.id}
      onChange={event => onChange({ ...model, locked: event.target.checked })} />{t('锁定模型：用这个 Agent 的节点只能用这个模型', 'Lock the model: nodes using this Agent run only this model')}</label>
    <small>{t('不锁定时，它只是推荐：调用方可以换成自己能用的模型。锁定后，调用方的模型清单里没有这个模型就用不了这个 Agent。', 'Unlocked, it is a suggestion: callers can switch to a model they can use. Locked, a caller whose model list lacks it cannot use the Agent.')}</small>
  </fieldset>;
}

export function SkillsField({ tenantId, skills, error, disabled, onChange }: { tenantId: string; skills: PublishSkill[]; error?: string; disabled: boolean; onChange: (skills: PublishSkill[]) => void }) {
  const { locale, t } = useMarketI18n();
  const [catalog, setCatalog] = useState<SkillSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    cachedSkillCatalog(tenantId).then(value => { if (live) setCatalog(value.items); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [tenantId]);
  // A built-in skill is the same in every workspace; a workspace's own is known only in its own catalog.
  const sameSkill = (skill: PublishSkill, item: SkillSummary) => skill.ref === item.ref && (item.source === 'builtin' || skill.tenantId === tenantId);
  const titleOf = (skill: PublishSkill) => {
    const known = catalog?.find(item => sameSkill(skill, item));
    return known ? skillTitle(known, locale) : skill.title || skill.ref;
  };
  const addable = (catalog ?? []).filter(item => !skills.some(skill => sameSkill(skill, item)));
  return <fieldset>
    <legend>{t('技能', 'Skills')}</legend>
    <small>{t(`最多 ${MARKET_LIMITS.skills} 个，合计不超过 20 KiB。保存草稿时冻结技能的全文：之后改动原技能，不影响这个版本。从 skills.sh 导入的技能，只有许可证明确宽松时才能带进来。`,
      `Up to ${MARKET_LIMITS.skills}, 20 KiB in all. Saving the draft freezes their full text: later changes to a skill do not reach this version. A skill imported from skills.sh comes along only under a clearly permissive license.`)}</small>
    {skills.length > 0 && <ul className="awwo-market-skill-list">{skills.map(skill => <li key={`${skill.tenantId}:${skill.ref}`}>
      <span>{titleOf(skill)}</span>
      <button type="button" disabled={disabled} aria-label={t(`移除技能 ${titleOf(skill)}`, `Remove the skill ${titleOf(skill)}`)}
        onClick={() => onChange(skills.filter(item => item !== skill))}><X size={12} aria-hidden="true" /></button>
    </li>)}</ul>}
    {failed ? <small className="awwo-market-field-error">{t('读不到这个工作区的技能库，暂时不能添加技能。', 'This workspace’s skill library cannot be read, so no skill can be added now.')}</small>
      : <label>{t('添加技能', 'Add a skill')}<select value="" disabled={disabled || !catalog || skills.length >= MARKET_LIMITS.skills || !addable.length} onChange={event => {
        const item = addable.find(candidate => candidate.ref === event.target.value);
        if (item) onChange([...skills, { tenantId: skillTenant(item.ref, tenantId), ref: item.ref, title: skillTitle(item, locale) }]);
      }}>
        <option value="">{!catalog ? t('正在读取技能库…', 'Loading skills…') : skills.length >= MARKET_LIMITS.skills ? t('已达上限', 'At the limit') : t('选择一个技能', 'Choose a skill')}</option>
        {addable.map(item => <option key={item.ref} value={item.ref}>{skillTitle(item, locale)}</option>)}
      </select></label>}
    {error && <small className="awwo-market-field-error" role="alert">{error}</small>}
  </fieldset>;
}

export function ExamplesField({ examples, error, disabled, onChange }: { examples: MarketExample[]; error?: string; disabled: boolean; onChange: (examples: MarketExample[]) => void }) {
  const { t } = useMarketI18n();
  const change = (index: number, patch: Partial<MarketExample>) => onChange(examples.map((example, at) => at === index ? { ...example, ...patch } : example));
  return <fieldset>
    <legend>{t('示例（选填）', 'Examples (optional)')}</legend>
    {examples.map((example, index) => <div key={index} className="awwo-market-example-edit">
      <label>{t(`示例 ${index + 1}：请求`, `Example ${index + 1}: request`)}<textarea rows={2} value={example.prompt} disabled={disabled} onChange={event => change(index, { prompt: event.target.value })} /></label>
      <label>{t(`示例 ${index + 1}：结果`, `Example ${index + 1}: result`)}<textarea rows={3} value={example.result} disabled={disabled} onChange={event => change(index, { result: event.target.value })} /></label>
      <button type="button" disabled={disabled} onClick={() => onChange(examples.filter((_, at) => at !== index))}>{t('删除这个示例', 'Remove this example')}</button>
    </div>)}
    {examples.length < MARKET_LIMITS.examples && <button type="button" disabled={disabled} onClick={() => onChange([...examples, { prompt: '', result: '' }])}><Plus size={14} aria-hidden="true" />{t('添加示例', 'Add an example')}</button>}
    {error && <small className="awwo-market-field-error" role="alert">{error}</small>}
  </fieldset>;
}
