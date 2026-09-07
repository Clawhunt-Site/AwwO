import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { applyAppearance, createSerialQueue, isValidHex, resolveOverrides, type AppearancePayload } from '../appearance';
import { ColorSchemeDialog } from '../settings/SettingsSurface';
import { api, SaaSApiError, saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';

type SavedAppearance = AppearancePayload & { version: number };
type Change = (current: SavedAppearance) => Pick<SavedAppearance, 'active_preset' | 'custom'>;
type AppearanceContext = { appearance: SavedAppearance | null; error: unknown; busy: boolean; reload: () => void; save: (change: Change) => Promise<SavedAppearance> };
const Context = createContext<AppearanceContext | null>(null);

function checkedAppearance(value: unknown): SavedAppearance {
  const p = value as SavedAppearance | null;
  const colors = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(color => typeof color === 'string' && isValidHex(color));
  const palette = (v: SavedAppearance['custom'] | undefined) => !!v && colors(v.light) && colors(v.dark);
  if (!p || p.schema_version !== '0.1.0' || !Number.isInteger(p.version) || p.version < 0 || p.default_preset !== 'default' || p.custom_preset_id !== 'custom'
    || !Array.isArray(p.canvases) || !p.canvases.includes('light') || !p.canvases.includes('dark')
    || !Array.isArray(p.tokens) || !p.tokens.length || !p.tokens.every(token => token && typeof token.id === 'string' && typeof token.label === 'string' && /^--[a-z0-9-]+$/.test(token.css_var)
      && (token.soft_var === undefined || /^--[a-z0-9-]+$/.test(token.soft_var)))
    || !Array.isArray(p.presets) || !p.presets.length || !p.presets.every(preset => preset && typeof preset.id === 'string' && typeof preset.label === 'string' && typeof preset.swatch === 'string' && isValidHex(preset.swatch) && palette(preset.overrides))
    || !palette(p.custom) || !(p.active_preset === 'custom' || p.presets.some(preset => preset.id === p.active_preset))) {
    throw new SaaSApiError(502, 'invalid_appearance', 'Invalid color scheme response. Reload the color scheme.');
  }
  return p;
}

/** Only the signed-in account's server response owns SaaS colors. No global cache. */
export function AppearanceScope({ userId, children }: { userId: string; children: ReactNode }) {
  const { themePreference } = useSaaSPreferences();
  const [appearance, setAppearance] = useState<SavedAppearance | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const current = useRef<SavedAppearance | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const queue = useRef(createSerialQueue());
  const pending = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    current.current = null; setAppearance(null); setError(null); setBusy(false); pending.current = 0; queue.current = createSerialQueue();
    api<unknown>('/appearance', { signal: controller.signal }).then(checkedAppearance).then(value => {
      if (!controller.signal.aborted) { current.current = value; setAppearance(value); }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause); });
    return () => {
      controller.abort();
      const last = current.current;
      if (last) applyAppearance({ ...last, active_preset: last.default_preset, custom: { light: {}, dark: {} } }, 'light');
      current.current = null;
    };
  }, [userId, revision]);
  useEffect(() => { if (appearance) applyAppearance(appearance, themePreference); }, [appearance, themePreference]);
  async function save(change: Change) {
    const controller = lifetime.current;
    if (!current.current || !controller || controller.signal.aborted) throw new Error('Color scheme is not ready');
    pending.current++; setBusy(true); setError(null);
    return queue.current.run(async () => {
    const before = current.current;
    if (!before || controller.signal.aborted) throw new DOMException('Scope closed', 'AbortError');
    try {
      const next = checkedAppearance(await api<unknown>('/appearance', { method: 'PUT', body: JSON.stringify({ ...change(before), version: before.version }), signal: controller.signal }));
      if (!controller.signal.aborted) { current.current = next; setAppearance(next); }
      return next;
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
      throw cause;
    } finally {
      if (!controller.signal.aborted) { pending.current--; setBusy(pending.current > 0); }
    }
    });
  }
  return <Context.Provider value={{ appearance, error, busy, reload: () => setRevision(v => v + 1), save }}>{children}</Context.Provider>;
}

export function SaaSAppearanceControl({ standalone = false, onClose, onOpenDialog }: { standalone?: boolean; onClose?: () => void; onOpenDialog?: () => void } = {}) {
  const state = useContext(Context);
  const { themePreference, locale, t } = useSaaSPreferences();
  const [open, setOpen] = useState(standalone);
  const [clientError, setClientError] = useState<string | undefined>();
  const dialogRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = dialogRoot.current;
    const controls = () => Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || []).filter(el => el.getClientRects().length > 0 && !el.closest('details:not([open])'));
    root?.querySelector<HTMLButtonElement>('button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const list = controls(); if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (!root?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    };
    document.addEventListener('keydown', trap, true);
    return () => { document.removeEventListener('keydown', trap, true); if (previous?.isConnected) previous.focus(); };
  }, [open, !!state?.appearance]);
  if (!state) return null;
  const { appearance, error, busy, reload, save } = state;
  const appearanceErrorMessage = (cause: unknown) => cause instanceof SaaSApiError && cause.code === 'version_conflict'
    ? t('配色已在其他页面更新，请重新加载配色后重试。', 'The color scheme changed in another page. Reload the color scheme and try again.')
    : saasErrorMessage(cause, locale);
  const message = error ? appearanceErrorMessage(error) : undefined;
  const mutate = (change: Change) => { setClientError(undefined); void save(change).catch(() => { /* The dialog displays the preserved server error. */ }); };
  async function exportBundle() {
    if (!appearance) return;
    setClientError(undefined);
    try {
    // The confirmed server state is already in memory; do not export an unsaved preview.
    const bundle = { kind: 'superclaw.appearance', schema_version: appearance.schema_version, active_preset: appearance.active_preset, custom: appearance.custom };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'awwo-appearance.json';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setClientError(t('无法导出配色，请检查浏览器下载权限后重试。', 'Could not export the color scheme. Check browser download permissions and try again.'));
    }
  }
  return <>
    {!standalone && <button type="button" disabled={!appearance} onClick={() => onOpenDialog ? onOpenDialog() : setOpen(true)}>{t('配色设置', 'Color scheme settings')}</button>}
    {!appearance && <p role={error ? 'alert' : 'status'}>{error ? saasErrorMessage(error, locale) : t('正在加载配色…', 'Loading color scheme…')}</p>}
    {!appearance && error ? <button type="button" onClick={reload}>{t('重新加载配色', 'Reload color scheme')}</button> : null}
    {standalone && !appearance && <button type="button" onClick={onClose}>{t('返回运行设置', 'Back to runtime settings')}</button>}
    {appearance && <div ref={dialogRoot}><ColorSchemeDialog open={open} onClose={() => { setOpen(false); onClose?.(); }} appearance={appearance} activeCanvas={themePreference} t={t} busy={busy} serializeChanges
      serverError={clientError || message} onReload={() => { setClientError(undefined); reload(); }}
      selectPreset={id => mutate(current => ({ active_preset: id, custom: current.custom }))}
      setCustomColor={(canvas, token, hex) => mutate(current => ({ active_preset: 'custom', custom: {
        light: { ...resolveOverrides(current, 'light') }, dark: { ...resolveOverrides(current, 'dark') },
        [canvas]: { ...resolveOverrides(current, canvas), [token]: hex },
      } }))}
      resetAppearance={() => mutate(() => ({ active_preset: 'default', custom: { light: {}, dark: {} } }))}
      exportAppearance={exportBundle}
      importBundle={async bundle => {
        setClientError(undefined);
        if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error(t('配色文件无效。', 'Invalid color scheme file.'));
        const b = bundle as Record<string, unknown>;
        if (b.kind !== 'superclaw.appearance' || b.schema_version !== '0.1.0' || Object.keys(b).some(k => !['kind', 'schema_version', 'active_preset', 'custom'].includes(k))) {
          throw new Error(t('配色文件格式或版本不受支持。', 'Unsupported color scheme format or version.'));
        }
        try { return await save(() => ({ active_preset: b.active_preset as string, custom: b.custom as SavedAppearance['custom'] })); }
        catch (cause) { throw new Error(cause instanceof SaaSApiError ? appearanceErrorMessage(cause) : t('无法确认配色是否已保存，请重新加载配色核对。', 'The save could not be confirmed. Reload the color scheme to check it.')); }
      }} /></div>}
  </>;
}
