import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Download, Palette, RotateCcw, Upload, X } from 'lucide-react';
import { useCanvasI18n, type CanvasTextKey } from './i18n';
import {
  DEFAULT_NODE_VIEW, NODE_VIEW_DENSITIES, NODE_VIEW_FONTS, NODE_VIEW_LAYOUTS, NODE_VIEW_RADII, NODE_VIEW_SIZES, NODE_VIEW_STYLES,
  NODE_VIEW_WIDTHS, PRESET_KNOBS, exportNodeViewPreference, importNodeViewPreference, useNodeViewPreference,
  type NodeViewKnobs, type NodeViewPreference, type NodeViewStyleId,
} from './nodeViewStyle';

const STYLE_TEXT: Record<NodeViewStyleId, readonly [CanvasTextKey, CanvasTextKey]> = {
  default: ['nodeView.default', 'nodeView.defaultDetail'],
  codex: ['nodeView.codex', 'nodeView.codexDetail'],
  workbuddy: ['nodeView.workbuddy', 'nodeView.workbuddyDetail'],
  'claude-code': ['nodeView.claudeCode', 'nodeView.claudeCodeDetail'],
  custom: ['nodeView.custom', 'nodeView.customDetail'],
};
const PANEL_WIDTH = 300;
const PANEL_HEIGHT = 440;

/** The panel's size inside the tile: the tile's overflow and the canvas stage clip anything
 *  wider or taller, so a narrow or short opened node gets a smaller panel that scrolls. Sizes are
 *  in the tile's own (unscaled) pixels and whole numbers, as the transformed canvas needs. */
export function panelSizeIn(button: HTMLElement | null): { width: number; maxHeight: number } | undefined {
  const tile = button?.closest('.canvas-tile') as HTMLElement | null;
  const anchor = button?.parentElement;
  if (!tile || !anchor || !tile.offsetWidth) return undefined;
  const tileBox = tile.getBoundingClientRect(), anchorBox = anchor.getBoundingClientRect();
  const scale = tileBox.width / tile.offsetWidth || 1;
  // The panel opens below the tools and is right-aligned to them, so its room is the space from
  // the tile's left edge to the tools' right edge, and from the tools' bottom to the tile's bottom.
  const width = Math.floor((anchorBox.right - tileBox.left) / scale) - 12;
  const height = Math.floor((tileBox.bottom - anchorBox.bottom) / scale) - 18;
  return { width: Math.max(200, Math.min(PANEL_WIDTH, width)), maxHeight: Math.max(160, Math.min(PANEL_HEIGHT, height)) };
}

/** Chooses the look of opened nodes. The preference is shared by every node, so this one control
 *  in an opened node's header changes them all; nothing about the node itself is saved. */
export function NodeViewStylePicker() {
  const { t } = useCanvasI18n();
  const [preference, setPreference] = useNodeViewPreference();
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<{ width: number; maxHeight: number }>();
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusChosenStyle = () => panelRef.current?.querySelector<HTMLInputElement>('.awwo-node-view-styles input:checked')?.focus();
  useEffect(() => {
    if (!open) return;
    // Keyboard users land on the current style, where arrow keys move between styles.
    focusChosenStyle();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per opening
  }, [open]);
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  // Escape belongs to this dialog while it is open, wherever focus sits (the toggle or the panel):
  // the canvas would otherwise close the node, or an open settings panel with unsaved edits.
  const escape = (event: KeyboardEvent) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
    close();
  };
  const toggle = () => {
    if (!open) setSize(panelSizeIn(buttonRef.current));
    setOpen(!open);
  };
  return <>
    <button ref={buttonRef} type="button" className="awwo-node-view-toggle" aria-label={t('nodeView.button')} title={t('nodeView.button')}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} onClick={toggle} onKeyDown={escape}>
      <Palette size={15} aria-hidden="true" />
    </button>
    {open ? <div ref={panelRef} id={`${id}-panel`} className="awwo-node-view-panel" role="dialog" aria-label={t('nodeView.title')}
      style={size ? { width: size.width, maxHeight: size.maxHeight } : undefined}
      // The panel lives inside the tile: its presses and wheel turns are the panel's, never a drag or zoom.
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={escape}>
      <header>
        <strong>{t('nodeView.title')}</strong>
        <button type="button" aria-label={t('nodeView.close')} onClick={close}><X size={14} aria-hidden="true" /></button>
      </header>
      <p className="awwo-node-view-hint">{t('nodeView.hint')}</p>
      <fieldset className="awwo-node-view-styles">
        <legend>{t('nodeView.title')}</legend>
        {NODE_VIEW_STYLES.map(style => <label key={style} className={`awwo-node-view-style${preference.style === style ? ' is-selected' : ''}`}>
          <input type="radio" name={`${id}-style`} value={style} checked={preference.style === style}
            onChange={() => setPreference({ ...preference, style })} />
          <span className={`awwo-node-view-swatch is-${style}`} aria-hidden="true"><i /><i /><i /></span>
          <span className="awwo-node-view-style-text"><strong>{t(STYLE_TEXT[style][0])}</strong><small>{t(STYLE_TEXT[style][1])}</small></span>
        </label>)}
      </fieldset>
      {preference.style === 'custom' ? <CustomStyleEditor preference={preference} onChange={setPreference}
        // Reset returns to the AwwO default look itself; the editor closes, so focus moves to that choice.
        onReset={() => { setPreference({ ...DEFAULT_NODE_VIEW, custom: { ...PRESET_KNOBS.default } }); setTimeout(focusChosenStyle, 0); }} /> : null}
    </div> : null}
  </>;
}

function Choice<K extends keyof NodeViewKnobs>({ name, knob, values, labelKey, valueKey, knobs, onChange }: {
  name: string; knob: K; values: readonly NodeViewKnobs[K][]; labelKey: CanvasTextKey;
  valueKey: (value: NodeViewKnobs[K]) => CanvasTextKey; knobs: NodeViewKnobs; onChange: (knobs: NodeViewKnobs) => void;
}) {
  const { t } = useCanvasI18n();
  return <fieldset className="awwo-node-view-choice">
    <legend>{t(labelKey)}</legend>
    <div>{values.map(value => <label key={String(value)} className={knobs[knob] === value ? 'is-selected' : ''}>
      <input type="radio" name={`${name}-${String(knob)}`} checked={knobs[knob] === value} onChange={() => onChange({ ...knobs, [knob]: value })} />
      <span>{t(valueKey(value))}</span>
    </label>)}</div>
  </fieldset>;
}

function CustomStyleEditor({ preference, onChange, onReset }: { preference: NodeViewPreference; onChange: (next: NodeViewPreference) => void; onReset: () => void }) {
  const { t } = useCanvasI18n();
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importFailed, setImportFailed] = useState(false);
  const knobs = preference.custom;
  const update = (next: NodeViewKnobs) => { setImportFailed(false); onChange({ ...preference, custom: next }); };
  const exportFile = () => {
    if (typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(new Blob([exportNodeViewPreference(preference)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'awwo-node-style.json';
    link.click();
    URL.revokeObjectURL(url);
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    // A style file is a few hundred bytes; anything far larger is not one.
    const imported = file.size <= 16 * 1024 ? importNodeViewPreference(await file.text()) : null;
    if (!imported) { setImportFailed(true); return; }
    setImportFailed(false);
    onChange({ ...imported, style: 'custom' });
  };
  return <section className="awwo-node-view-custom" aria-label={t('nodeView.custom')}>
    <div className="awwo-node-view-presets" role="group" aria-label={t('nodeView.startFrom')}>
      <span>{t('nodeView.startFrom')}</span>
      {(['default', 'codex', 'workbuddy', 'claude-code'] as const).map(style => <button key={style} type="button"
        onClick={() => update({ ...PRESET_KNOBS[style] })}>{t(STYLE_TEXT[style][0])}</button>)}
    </div>
    <Choice name={id} knob="layout" values={NODE_VIEW_LAYOUTS} labelKey="nodeView.layout" valueKey={value => `nodeView.layout.${value}` as CanvasTextKey} knobs={knobs} onChange={update} />
    <div className="awwo-node-view-row">
      <label>{t('nodeView.font')}
        <select value={knobs.font} onChange={event => update({ ...knobs, font: event.target.value as NodeViewKnobs['font'] })}>
          {NODE_VIEW_FONTS.map(font => <option key={font} value={font}>{t(`nodeView.font.${font}` as CanvasTextKey)}</option>)}
        </select>
      </label>
      <label>{t('nodeView.size')}
        <select value={knobs.size} onChange={event => update({ ...knobs, size: Number(event.target.value) as NodeViewKnobs['size'] })}>
          {NODE_VIEW_SIZES.map(size => <option key={size} value={size}>{size}px</option>)}
        </select>
      </label>
    </div>
    <Choice name={id} knob="density" values={NODE_VIEW_DENSITIES} labelKey="nodeView.density" valueKey={value => `nodeView.density.${value}` as CanvasTextKey} knobs={knobs} onChange={update} />
    <Choice name={id} knob="radius" values={NODE_VIEW_RADII} labelKey="nodeView.radius" valueKey={value => `nodeView.radius.${value}` as CanvasTextKey} knobs={knobs} onChange={update} />
    <Choice name={id} knob="width" values={NODE_VIEW_WIDTHS} labelKey="nodeView.width" valueKey={value => `nodeView.width.${value}` as CanvasTextKey} knobs={knobs} onChange={update} />
    <div className="awwo-node-view-row">
      <label>{t('nodeView.accent')}
        <input type="color" value={knobs.accent} onChange={event => update({ ...knobs, accent: event.target.value })} />
      </label>
      {/* A terminal line has no bubble, so its colour controls would do nothing there. */}
      {knobs.layout === 'terminal' ? null : <>
        <label>{t('nodeView.userBubble')}
          <input type="color" value={knobs.userBubble || knobs.accent} disabled={!knobs.userBubble}
            onChange={event => update({ ...knobs, userBubble: event.target.value })} />
        </label>
        <label className="awwo-node-view-check">
          <input type="checkbox" checked={!knobs.userBubble} onChange={event => update({ ...knobs, userBubble: event.target.checked ? '' : knobs.accent })} />
          {t('nodeView.userBubbleAuto')}
        </label>
      </>}
    </div>
    <p className="awwo-node-view-hint">{t('nodeView.contrast')}</p>
    <div className="awwo-node-view-actions">
      <button type="button" onClick={exportFile}><Download size={13} aria-hidden="true" />{t('nodeView.export')}</button>
      <button type="button" onClick={() => fileRef.current?.click()}><Upload size={13} aria-hidden="true" />{t('nodeView.import')}</button>
      <button type="button" onClick={() => { setImportFailed(false); onReset(); }}>
        <RotateCcw size={13} aria-hidden="true" />{t('nodeView.reset')}
      </button>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label={t('nodeView.import')} onChange={importFile} />
    </div>
    {importFailed ? <p className="awwo-node-view-error" role="alert">{t('nodeView.importFailed')}</p> : null}
  </section>;
}
