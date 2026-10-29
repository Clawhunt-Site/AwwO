// Publishing an Agent to the market: from a canvas node's settings (its persona, skills and model filled in) or from
// 我的 Agent (new, or the next version of one). A draft is saved as it is; submitting sends it to the platform's review,
// and only an approved version lists. The server checks every field again and says which one it refuses.
import { useEffect, useRef, useState } from 'react';
import { Send, Store, X } from 'lucide-react';
import { api, saasErrorMessage, type Identity } from '../api';
import { WorkbenchOverlay } from '../CanvasKnowledgeDock';
import type { ModelPaletteSelection } from '../../canvas/modelPalette';
import { authorShare, createMarketAgent, MARKET_CATEGORIES, MARKET_LIMITS, readMarketDraft, saveMarketDraft, submitMarketAgent,
  type MarketCategory, type MarketSettings, type MarketVersionState } from '../marketApi';
import { ExamplesField, ModelField, SkillsField } from './PublishAgentFields';
import { emptyForm, formFromDraft, inputOf, refusalText, refusedField, validatePublish, type PublishErrors, type PublishField, type PublishForm } from './publishForm';
import { categoryName, creditsText, useMarketI18n, versionStateName } from './marketText';
import { forgetMarketAgent, useWorkspaceModels } from './useMarket';
import '../canvas-library.css';
import './market.css';

export interface PublishAgentDialogProps {
  /** The workspace whose skills and models the form offers (the canvas's, or the one picked in settings). */
  tenantId: string;
  settings: MarketSettings;
  /** An existing Agent: its latest draft is read and saved (the next version once the latest is past its draft). */
  agentId?: string;
  /** A new Agent's starting fields (a node's); absent, an empty form. */
  initial?: PublishForm;
  catalogue?: ReadonlyArray<ModelPaletteSelection>;
  onSaved?: (agentId: string) => void;
  onClose: () => void;
}

export function PublishAgentDialog(props: PublishAgentDialogProps) {
  const { t } = useMarketI18n();
  const [busy, setBusy] = useState(false);
  return <WorkbenchOverlay label={t('发布到 Agent 市场', 'Publish to the Agent market')} onClose={props.onClose} busy={busy}>
    <PublishView {...props} busy={busy} onBusy={setBusy} />
  </WorkbenchOverlay>;
}

function PublishView({ tenantId, settings, agentId: existing, initial, catalogue, onSaved, onClose, busy, onBusy }: PublishAgentDialogProps & { busy: boolean; onBusy: (busy: boolean) => void }) {
  const { locale, t } = useMarketI18n();
  const [agentId, setAgentId] = useState(existing ?? '');
  const [form, setForm] = useState<PublishForm | null>(existing ? null : initial ?? emptyForm());
  const [draftState, setDraftState] = useState<{ version: number; state: MarketVersionState; reviewNote: string } | null>(null);
  // The author's name the market shows now, which a version with another replaces once approved.
  const [listedAuthorName, setListedAuthorName] = useState('');
  const [loadError, setLoadError] = useState<unknown>(null);
  const [errors, setErrors] = useState<PublishErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const typedAuthor = useRef(false);
  const models = useWorkspaceModels(tenantId, catalogue);
  useEffect(() => {
    if (!existing) return;
    const controller = new AbortController();
    setLoadError(null);
    readMarketDraft(existing, controller.signal).then(draft => {
      if (controller.signal.aborted) return;
      setForm(formFromDraft(draft)); setDraftState({ version: draft.version, state: draft.state, reviewNote: draft.reviewNote });
      setListedAuthorName(draft.listedAuthorName);
    }, cause => { if (!controller.signal.aborted) setLoadError(cause); });
    return () => controller.abort();
  }, [existing, attempt]);
  // A new Agent is signed with the account's name unless the author writes another.
  useEffect(() => {
    if (existing || initial?.authorName) return;
    const controller = new AbortController();
    api<Identity>('/auth/me', { signal: controller.signal }).then(identity => {
      const name = [...(identity?.user?.name ?? '')].slice(0, MARKET_LIMITS.authorName).join('');
      if (!controller.signal.aborted && name && !typedAuthor.current) setForm(current => current && !current.authorName ? { ...current, authorName: name } : current);
    }, () => undefined);
    return () => controller.abort();
  }, [existing, initial?.authorName]);

  const edit = (patch: Partial<PublishForm>, field?: PublishField) => {
    setForm(current => current ? { ...current, ...patch } : current);
    if (field) setErrors(current => { const { [field]: _cleared, ...rest } = current; return rest; });
    setNotice('');
  };
  const run = async (submit: boolean) => {
    if (!form || busy) return;
    const problems = validatePublish(form, settings.maxPrice, t);
    setErrors(problems); setError(null); setNotice('');
    if (Object.keys(problems).length) return;
    onBusy(true);
    try {
      const input = inputOf(form);
      let id = agentId;
      if (id) await saveMarketDraft(id, input);
      else { id = (await createMarketAgent(input)).agentId; setAgentId(id); }
      if (submit) await submitMarketAgent(id);
      forgetMarketAgent(id);
      setNotice(submit ? t('已提交审核：平台管理员审核通过后才会上架。审核期间可以在「设置 → 我的 Agent」里撤回。', 'Submitted for review: it lists once a platform administrator approves it. You can withdraw it meanwhile in Settings → My Agents.')
        : t('草稿已保存。还没有提交审核，市场里看不到它。', 'Draft saved. It is not submitted yet, so the market does not show it.'));
      onSaved?.(id);
    } catch (cause) {
      const field = refusedField(cause);
      if (field) setErrors(current => ({ ...current, [field]: refusalText(cause, locale, t) }));
      else setError(cause);
    } finally { onBusy(false); }
  };

  const fieldError = (field: PublishField) => errors[field] ? <small className="awwo-market-field-error" role="alert">{errors[field]}</small> : null;
  const price = /^\d+$/.test(form?.price.trim() ?? '') ? Number(form!.price.trim()) : 0;
  const share = authorShare(price, settings.feeBps);
  return <section className="awwo-library awwo-market awwo-market-publish" aria-label={t('发布到 Agent 市场', 'Publish to the Agent market')}>
    <header className="awwo-library-header">
      <div className="awwo-library-heading"><span className="awwo-library-mark"><Store size={20} aria-hidden="true" /></span><div>
        <h2>{agentId ? t('编辑市场 Agent', 'Edit a market Agent') : t('发布到 Agent 市场', 'Publish to the Agent market')}</h2>
        <p>{t('别人在画布节点上用它时，指令和技能由服务器交给模型，不会出现在对方的画布里。每个版本都要经过平台审核才会上架。', 'When others use it on a canvas node, the server gives its instructions and skills to the model; they never enter the other person’s canvas. Each version lists only after the platform reviews it.')}</p>
      </div></div>
      <div className="awwo-library-actions"><button type="button" disabled={busy} onClick={onClose} aria-label={t('关闭', 'Close')}><X size={19} aria-hidden="true" /></button></div>
    </header>
    {error !== null && <p className="awwo-library-alert" role="alert">{saasErrorMessage(error, locale)}</p>}
    {notice && <p className="awwo-library-notice" role="status">{notice}</p>}
    {!form ? <p className="awwo-library-empty" role={loadError ? 'alert' : 'status'}>{loadError ? <>{saasErrorMessage(loadError, locale)} <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('重试', 'Retry')}</button></>
      : t('正在读取草稿…', 'Loading the draft…')}</p>
    : <form className="awwo-library-editor" onSubmit={event => { event.preventDefault(); void run(false); }}>
      {draftState && <p className="awwo-library-meta">{t(`版本 v${draftState.version} · ${versionStateName(draftState.state, t)}`, `Version v${draftState.version} · ${versionStateName(draftState.state, t)}`)}
        {draftState.state !== 'draft' ? t('：保存后会新建下一个版本的草稿，要重新审核。', ': saving starts the next version’s draft, which is reviewed again.') : ''}
        {draftState.reviewNote ? t(` · 审核意见：${draftState.reviewNote}`, ` · Review note: ${draftState.reviewNote}`) : ''}</p>}
      <label>{t('名称', 'Name')}<input value={form.name} aria-invalid={Boolean(errors.name)} disabled={busy} onChange={event => edit({ name: event.target.value }, 'name')} />{fieldError('name')}</label>
      <label>{t('一句话简介', 'Tagline')}<input value={form.tagline} aria-invalid={Boolean(errors.tagline)} disabled={busy} onChange={event => edit({ tagline: event.target.value }, 'tagline')} />{fieldError('tagline')}</label>
      <div className="awwo-market-row">
        <label>{t('类别', 'Category')}<select value={form.category} disabled={busy} onChange={event => edit({ category: event.target.value as MarketCategory }, 'category')}>
          {MARKET_CATEGORIES.map(value => <option key={value} value={value}>{categoryName(value, t)}</option>)}</select>{fieldError('category')}</label>
      </div>
      <small>{t('市场 Agent 目前是文字 Agent：在调用方的文字节点上运行，不能带沙箱电脑的文件、命令行和网络。', 'A market Agent is a text Agent for now: it runs on the caller’s text node, without a sandbox computer’s files, shell or network.')}</small>{fieldError('kind')}
      <label>{t('介绍（选填，支持 Markdown）', 'Description (optional, Markdown)')}<textarea rows={4} value={form.description} aria-invalid={Boolean(errors.description)} disabled={busy} onChange={event => edit({ description: event.target.value }, 'description')} />{fieldError('description')}</label>
      <label>{t('指令', 'Instructions')}<textarea rows={10} value={form.instructions} aria-invalid={Boolean(errors.instructions)} disabled={busy} onChange={event => edit({ instructions: event.target.value }, 'instructions')} />
        <small>{t(`${new TextEncoder().encode(form.instructions).byteLength} / ${MARKET_LIMITS.instructionsBytes} 字节`, `${new TextEncoder().encode(form.instructions).byteLength} / ${MARKET_LIMITS.instructionsBytes} bytes`)}</small>{fieldError('instructions')}</label>
      <label className="awwo-library-check"><input type="checkbox" checked={form.instructionsPublic} disabled={busy} onChange={event => edit({ instructionsPublic: event.target.checked })} />{t('公开指令（市场里所有人都能看到）', 'Make the instructions public (everyone in the market can read them)')}</label>
      <small>{t('作者须知：不公开时只有你和平台管理员能看到指令；但模型被诱导时仍可能复述它，这一点无法完全防住。', 'For authors: unpublished instructions are seen only by you and platform administrators, but a model can still be led to repeat them, which cannot be fully prevented.')}</small>
      <SkillsField tenantId={tenantId} skills={form.skills} error={errors.skills} disabled={busy} onChange={skills => edit({ skills }, 'skills')} />
      <ModelField model={form.model} models={models.models} disabled={busy} onChange={model => edit({ model }, 'model')} />{fieldError('model')}
      <label>{t(`每次调用的价格（点，0–${settings.maxPrice}，0 表示免费）`, `Price per call (credits, 0–${settings.maxPrice}; 0 is free)`)}
        <input inputMode="numeric" value={form.price} aria-invalid={Boolean(errors.price)} disabled={busy} onChange={event => edit({ price: event.target.value }, 'price')} />{fieldError('price')}
        <small>{price > 0 ? t(`每次扣费的调用，你获得约 ${creditsText(share, locale)} 点（平台抽成 ${settings.feeBps / 100}%），只计调用方买来的点数。运行完成时扣费；Agent 写出内容后运行被调用方停止、被调用方节点自己的输出格式拒收、被截断、中途拒答或超时的，也照常扣费；其余没完成的不扣。付费 Agent 只有调用方工作区的所有者和管理员能运行。`,
          `For each charged call you get about ${creditsText(share, locale)} credits (the platform keeps ${settings.feeBps / 100}%), counting only credits the caller bought. A call is charged when its run completes, and also when, once the Agent has written, the caller stops it, the caller’s node’s own output format rejects it, or it is cut off, refused part way or times out; any other run that does not complete is not charged. Only the owner or an administrator of the caller’s workspace runs a paid Agent.`)
          : t('免费 Agent 不需要套餐，任何人都能用。', 'A free Agent needs no plan; anyone can use it.')}</small></label>
      <ExamplesField examples={form.examples} error={errors.examples} disabled={busy} onChange={examples => edit({ examples }, 'examples')} />
      <label>{t('署名', 'Author name')}<input value={form.authorName} aria-invalid={Boolean(errors.authorName)} disabled={busy} onChange={event => { typedAuthor.current = true; edit({ authorName: event.target.value }, 'authorName'); }} />
        <small>{t('署名随版本一起审核，批准后才显示在市场上；不能用 AwwO、ClawHunt、阿呜的名字，也不能自称官方。', 'The author name is reviewed with the version and shows in the market once approved; it may not use the name of AwwO, ClawHunt or 阿呜, or claim to be official.')}
          {listedAuthorName && listedAuthorName !== form.authorName.trim() ? t(`市场上现在显示「${listedAuthorName}」。`, ` The market shows “${listedAuthorName}” now.`) : ''}</small>{fieldError('authorName')}</label>
      <div className="awwo-library-editor-actions">
        <button type="button" disabled={busy} onClick={onClose}>{t('关闭', 'Close')}</button>
        <button type="submit" disabled={busy}>{busy ? t('正在保存…', 'Saving…') : t('保存草稿', 'Save draft')}</button>
        <button type="button" className="awwo-library-primary" disabled={busy} onClick={() => void run(true)}><Send size={14} aria-hidden="true" />{t('提交审核', 'Submit for review')}</button>
      </div>
    </form>}
  </section>;
}
