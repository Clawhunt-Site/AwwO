// The model a hosted node runs, in its Configure panel: each model once (on the runtime AwwO runs it on, nodeRuntime.ts)
// and its reasoning effort where the model offers levels. The runtime is never shown or chosen (owner decision
// 2026-10-15). The workspace default is the server's: a node left on it is set up on the default runtime's default model.
import { useId } from 'react';
import type { SessionNode } from './canvasDoc';
import { useCanvasI18n, type CanvasTextKey, type CanvasTranslate } from './i18n';
import type { ModelPaletteGroup, ModelPaletteSelection } from './modelPalette';

const EFFORT_KEYS: Record<string, CanvasTextKey> = {
  none: 'effort.none', minimal: 'effort.minimal', low: 'effort.low', medium: 'effort.medium', high: 'effort.high',
  xhigh: 'effort.xhigh', max: 'effort.max',
};

/** A reasoning-effort level in the reader's words; an unknown level keeps its id. */
export function effortLabel(t: CanvasTranslate, level: string): string {
  const key = EFFORT_KEYS[level];
  return key ? t(key) : level;
}

export interface NodeModelValue { runtime: string; model: string; effort: string }

export interface NodeModelSettingsProps {
  node: Pick<SessionNode, 'runtime' | 'model' | 'effort'>;
  /** The workspace's chat models, each once (automaticGroups). */
  groups: ReadonlyArray<ModelPaletteGroup>;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  disabled?: boolean;
  onChange: (next: NodeModelValue) => void;
}

export function NodeModelSettings({ node, groups, loading = false, error = '', onRetry, disabled = false, onChange }: NodeModelSettingsProps) {
  const { t } = useCanvasI18n();
  const modelId = useId();
  const effortId = useId();
  const entries = groups.flatMap(group => group.models);
  const selected: ModelPaletteSelection | undefined = node.model ? entries.find(entry => entry.model === node.model) : undefined;
  const efforts = selected?.efforts ?? [];
  const pick = (model: string) => {
    if (!model) { onChange({ runtime: '', model: '', effort: '' }); return; }
    const entry = entries.find(item => item.model === model && item.available);
    if (entry) onChange({ runtime: entry.runtime, model: entry.model, effort: '' });
  };
  return <div className="canvas-inspector-model">
    <label className="canvas-inspector-label" htmlFor={modelId}>{t('inspector.model')}</label>
    <select id={modelId} className="canvas-inspector-input" aria-label={t('inspector.model')} value={node.model}
      disabled={disabled || loading} onChange={event => pick(event.target.value)}>
      <option value="">{t('inspector.modelDefault')}</option>
      {node.model && !selected ? <option value={node.model} disabled>{t('inspector.modelUnavailableSaved', { model: node.model })}</option> : null}
      {groups.filter(group => group.models.length).map(group => <optgroup key={group.id} label={group.label}>
        {group.models.map(entry => <option key={entry.key} value={entry.model} disabled={!entry.available} title={entry.available ? undefined : entry.reason}>
          {entry.available ? entry.displayName || entry.label : `${entry.displayName || entry.label} · ${t('model.pickerUnavailable')}`}
        </option>)}
      </optgroup>)}
    </select>
    {loading ? <div className="canvas-inspector-hint" role="status">{t('inspector.modelsLoading')}</div> : null}
    {error ? <div className="canvas-inspector-outcome canvas-inspector-outcome--err" role="alert">
      {t('inspector.modelsFailed')} {error}
      {onRetry ? <> <button type="button" className="canvas-inspector-link" onClick={onRetry}>{t('inspector.modelsRetry')}</button></> : null}
    </div> : null}
    {efforts.length ? <>
      <label className="canvas-inspector-label" htmlFor={effortId}>{t('inspector.effort')}</label>
      <select id={effortId} className="canvas-inspector-input" aria-label={t('inspector.effort')} value={efforts.includes(node.effort) ? node.effort : ''}
        disabled={disabled} onChange={event => onChange({ runtime: node.runtime, model: node.model, effort: event.target.value })}>
        <option value="">{selected?.defaultEffort ? t('inspector.effortDefaultIs', { level: effortLabel(t, selected.defaultEffort) }) : t('inspector.effortDefault')}</option>
        {efforts.map(level => <option key={level} value={level}>{effortLabel(t, level)}</option>)}
      </select>
      <div className="canvas-inspector-hint">{t('inspector.effortHint')}</div>
    </> : null}
    <div className="canvas-inspector-hint">{t('inspector.modelAutomatic')}</div>
  </div>;
}
