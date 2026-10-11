// The model a node's chat runs on, chosen where the conversation is: a compact picker in the composer, like a chat
// app's model switch. It changes only the node's own runtime/model through the host's ordinary configuration save,
// so a bound conversation forks exactly as the inspector would fork it (a model is fixed when the agent is hired).
import { useId } from 'react';
import { ChevronDown, Cpu } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import { mediaKindOf } from './mediaCatalog';
import type { SessionNode } from './canvasDoc';
import './node-model-picker.css';

/** The picker key of a node's current model: the media model id for an image/video/3D node, otherwise the palette's
 *  [runtime, model] selector. */
export function modelChoiceKey(node: Pick<SessionNode, 'agentKind' | 'runtime' | 'model'>): string {
  return mediaKindOf(node.agentKind) ? node.model : JSON.stringify([node.runtime, node.model]);
}

export interface NodeModelChoice {
  /** Stable selector identity, e.g. JSON.stringify([runtime, model]) for a chat model or the media model id. */
  key: string;
  label: string;
  /** Provider or family heading for the list. */
  group?: string;
  available: boolean;
  reason?: string;
}

export interface NodeModelPickerProps {
  choices: ReadonlyArray<NodeModelChoice>;
  /** Key of the node's current model, or '' when the node has none yet. */
  value: string;
  /** Shown when the current model is not among the choices (a model this workspace no longer offers). */
  currentLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (key: string) => void;
}

export function NodeModelPicker({ choices, value, currentLabel, disabled = false, disabledReason, onChange }: NodeModelPickerProps) {
  const { t } = useCanvasI18n();
  const id = useId();
  const known = choices.some(choice => choice.key === value);
  const groups = new Map<string, NodeModelChoice[]>();
  for (const choice of choices) {
    const group = choice.group || '';
    groups.set(group, [...(groups.get(group) ?? []), choice]);
  }
  const selected = choices.find(choice => choice.key === value);
  const shown = selected?.label || currentLabel || t('model.pickerNone');
  return <label className={`awwo-node-model-picker${disabled ? ' is-disabled' : ''}`} htmlFor={id} title={disabled ? disabledReason : t('model.pickerTitle', { model: shown })}>
    <Cpu size={13} aria-hidden="true" />
    <span className="awwo-node-model-picker-value" aria-hidden="true">{shown}</span>
    <ChevronDown size={13} aria-hidden="true" />
    <select id={id} aria-label={t('model.pickerLabel')} value={known ? value : ''} disabled={disabled || !choices.length}
      onChange={event => { if (event.target.value && event.target.value !== value) onChange(event.target.value); }}>
      {!known && <option value="" disabled>{currentLabel ? t('model.pickerCurrent', { model: currentLabel }) : t('model.pickerNone')}</option>}
      {[...groups.entries()].map(([group, items]) => group
        ? <optgroup key={group} label={group}>{items.map(choice => <option key={choice.key} value={choice.key} disabled={!choice.available}
          title={choice.available ? undefined : choice.reason}>{choice.available ? choice.label : `${choice.label} · ${t('model.pickerUnavailable')}`}</option>)}</optgroup>
        : items.map(choice => <option key={choice.key} value={choice.key} disabled={!choice.available}>{choice.available ? choice.label : `${choice.label} · ${t('model.pickerUnavailable')}`}</option>))}
    </select>
  </label>;
}
