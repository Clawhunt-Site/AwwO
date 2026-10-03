// The configuration of an image or video node: one catalog model and its closed parameters. Every
// choice comes from the server's media catalogue; a parameter the operator leaves alone shows the
// model's default and stays absent from the node.

import type { AgentKind, MediaParamValue, SessionNode } from './canvasDoc';
import { useCanvasI18n } from './i18n';
import './media.css';
import {
  invalidMediaParams,
  mediaKindOf,
  mediaModelsOf,
  mediaParamValue,
  mediaVendorLabel,
  withMediaParam,
  type MediaCatalogue,
  type MediaKind,
  type MediaModel,
  type MediaParam,
} from './mediaCatalog';

/** Host-fed catalogue state; a failed read is said out loud, never shown as an empty list. */
export type MediaCatalogueState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; catalogue: MediaCatalogue };

export const mediaCatalogueOf = (state: MediaCatalogueState | undefined): MediaCatalogue | null =>
  state?.status === 'ready' ? state.catalogue : null;

/**
 * Change a session node's kind. Entering a media kind keeps the model only when it is a catalog
 * model of that kind (otherwise the first one is shown, to be confirmed by saving) and drops what
 * a media node does not run: contract, template, team, task frame and effort. Leaving a media kind
 * clears its catalog model and parameters, which mean nothing to a text runtime.
 */
export function withAgentKind(node: SessionNode, kind: AgentKind, catalogue: MediaCatalogue | null): SessionNode {
  if (node.agentKind === kind) return node;
  const media = mediaKindOf(kind);
  if (!media) {
    if (!mediaKindOf(node.agentKind)) return { ...node, agentKind: kind };
    const { mediaParams: _params, ...rest } = node;
    return { ...rest, agentKind: kind, model: '' };
  }
  const models = mediaModelsOf(catalogue, media);
  const keep = models.some(model => model.id === node.model);
  const { contract: _contract, templateId: _template, templateVersion: _version, team: _team, taskFrame: _frame, mediaParams, ...rest } = node;
  return { ...rest, agentKind: kind, model: keep ? node.model : models[0]?.id ?? '', effort: '', ...(keep && mediaParams ? { mediaParams } : {}) };
}

/** Why a media node cannot be saved yet, or null when it can. */
export function mediaSetupProblem(node: SessionNode, catalogue: MediaCatalogue | null): 'unavailable' | 'model' | 'params' | null {
  const kind = mediaKindOf(node.agentKind);
  if (!kind) return null;
  const models = mediaModelsOf(catalogue, kind);
  if (!models.length) return 'unavailable';
  const model = models.find(entry => entry.id === node.model);
  if (!model) return 'model';
  return invalidMediaParams(model, node.mediaParams).length ? 'params' : null;
}

function vendorsOf(models: MediaModel[]): string[] {
  return [...new Set(models.map(model => model.vendor))];
}

export function MediaNodeSettings({ node, state, disabled, onChange, onRetry }: {
  node: SessionNode;
  state: MediaCatalogueState | undefined;
  disabled: boolean;
  onChange: (next: SessionNode) => void;
  onRetry?: () => void;
}) {
  const { locale, t } = useCanvasI18n();
  const kind: MediaKind = node.agentKind === 'video' ? 'video' : 'image';
  const kindLabel = t(kind === 'video' ? 'media.kindVideo' : 'media.kindImage');
  if (!state || state.status === 'loading') return <div className="canvas-inspector-hint" role="status">{t('media.loading')}</div>;
  if (state.status === 'error') return <div className="canvas-inspector-outcome canvas-inspector-outcome--err" role="alert">
    {t('media.loadFailed')}
    {onRetry ? <> <button type="button" className="canvas-inspector-link" onClick={onRetry}>{t('media.retry')}</button></> : null}
  </div>;
  const catalogue = state.catalogue;
  if (!catalogue.available) return <div className="canvas-inspector-hint" role="status">{t('media.unavailable')}</div>;
  const models = mediaModelsOf(catalogue, kind);
  if (!models.length) return <div className="canvas-inspector-hint" role="status">{t('media.noModels', { kind: kindLabel })}</div>;
  const model = models.find(entry => entry.id === node.model);
  const invalid = model ? invalidMediaParams(model, node.mediaParams) : [];
  const set = (param: MediaParam, value: MediaParamValue | undefined) => onChange({ ...node, mediaParams: withMediaParam(node.mediaParams, param, value) });
  return <div className="canvas-inspector-media" data-testid="media-node-settings">
    <label className="canvas-inspector-label" htmlFor="cv-media-model">{t('media.model')}</label>
    <select id="cv-media-model" className="canvas-inspector-input" value={model?.id ?? ''} disabled={disabled}
      onChange={event => {
        // Parameters belong to one model; a new model starts from its own defaults.
        const { mediaParams: _params, ...rest } = node;
        onChange({ ...rest, model: event.target.value });
      }}>
      {!model ? <option value="" disabled>{t('media.chooseModel')}</option> : null}
      {vendorsOf(models).map(vendor => <optgroup key={vendor} label={mediaVendorLabel(vendor, locale)}>
        {models.filter(entry => entry.vendor === vendor).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </optgroup>)}
    </select>
    {model ? <>
      {model.params.map(param => <MediaParamControl key={`${model.id}:${param.name}`} param={param} value={mediaParamValue(param, node.mediaParams)}
        invalid={invalid.includes(param.name)} disabled={disabled} onChange={value => set(param, value)} />)}
      {invalid.length ? <div className="canvas-inspector-outcome canvas-inspector-outcome--err" role="alert">
        {t('media.invalidParams', { names: invalid.map(name => model.params.find(param => param.name === name)?.label[locale === 'zh' ? 0 : 1] ?? name).join(locale === 'zh' ? '、' : ', ') })}
      </div> : null}
      <div className="canvas-inspector-hint">{t('media.promptHint', { kind: kindLabel, min: model.prompt.minLength, max: model.prompt.maxLength })}</div>
    </> : <div className="canvas-inspector-hint">{t('media.chooseModel')}</div>}
    {catalogue.runsPerDay > 0 ? <div className="canvas-inspector-hint">{t('media.dailyLimit', { count: catalogue.runsPerDay })}</div> : null}
  </div>;
}

function MediaParamControl({ param, value, invalid, disabled, onChange }: {
  param: MediaParam;
  value: MediaParamValue | undefined;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: MediaParamValue | undefined) => void;
}) {
  const { locale, t } = useCanvasI18n();
  const label = param.label[locale === 'zh' ? 0 : 1];
  const id = `cv-media-${param.name}`;
  const describe = (choice: string) => choice === param.default ? t('media.defaultValue', { value: choice }) : choice;
  if (param.type === 'boolean') {
    return <label className="canvas-inspector-check" htmlFor={id}>
      <input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>;
  }
  return <>
    <label className="canvas-inspector-label" htmlFor={id}>{label}</label>
    {param.type === 'enum' ? <select id={id} className="canvas-inspector-input" aria-invalid={invalid || undefined} disabled={disabled}
      value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value)}>
      {typeof value !== 'string' || !param.values?.includes(value) ? <option value="" disabled>{typeof value === 'string' ? value : ''}</option> : null}
      {param.values?.map(choice => <option key={choice} value={choice}>{describe(choice)}</option>)}
    </select> : param.type === 'text' ? <textarea id={id} className="canvas-inspector-persona" rows={2} aria-invalid={invalid || undefined}
      maxLength={param.maxLength} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value)} />
      : <input id={id} className="canvas-inspector-input" type="number" aria-invalid={invalid || undefined} disabled={disabled}
        min={param.min} max={param.max} step={param.type === 'integer' ? 1 : 'any'}
        placeholder={param.default !== undefined ? t('media.defaultValue', { value: String(param.default) }) : undefined}
        value={typeof value === 'number' ? value : ''}
        onChange={event => {
          const raw = event.target.value.trim();
          onChange(raw === '' ? undefined : Number(raw));
        }} />}
    {param.type === 'integer' || param.type === 'number'
      ? <div className="canvas-inspector-hint">{t('media.range', { min: param.min ?? '', max: param.max ?? '' })}
        {param.default !== undefined ? ` · ${t('media.defaultValue', { value: String(param.default) })}` : ''}</div> : null}
  </>;
}
