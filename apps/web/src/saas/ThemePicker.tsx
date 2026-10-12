import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Palette } from 'lucide-react';
import { Popover } from '../ui/Popover';
import { useSaaSPreferences } from './preferences';
import { useAccountColorScheme } from './SaaSAppearance';
import { AUTO_THEMES, AWWO_THEMES, themeById, type ThemeChoice, type ThemeDefinition } from './themes';
import './theme-picker.css';

/** A small, real rendering of a style: its page, header, canvas, two cards on a wire, the accent and live work. */
export function ThemePreview({ theme }: { theme: ThemeDefinition }) {
  return <span className="awwo-theme-preview" data-awwo-theme={theme.id} data-scheme={theme.scheme} aria-hidden="true">
    <span className="awwo-theme-preview-bar"><i /><i /><b /></span>
    <span className="awwo-theme-preview-canvas">
      <span className="awwo-theme-preview-node is-first"><i /><i /><em /></span>
      <span className="awwo-theme-preview-wire" />
      <span className="awwo-theme-preview-node is-second"><i /><i /><u /></span>
    </span>
  </span>;
}

const CHOICES: readonly ThemeChoice[] = ['auto', ...AWWO_THEMES.map(theme => theme.id)];
type Handback = 'idle' | 'saving' | 'done' | 'failed';

/**
 * The 外观 button for the header, and the style picker it opens. A choice applies at once and stays on this browser.
 * When the signed-in account still paints an older colour scheme over every style (运行设置 → 配色设置), choosing a
 * style hands the colours back to the style: the account returns to its default scheme, its custom colours kept.
 */
export function ThemePicker() {
  const { themeChoice, setThemeChoice, theme, locale, t } = useSaaSPreferences();
  const account = useAccountColorScheme();
  const [open, setOpen] = useState(false);
  const [handback, setHandback] = useState<Handback>('idle');
  const anchor = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const current = themeChoice === 'auto' ? t(`跟随系统（${theme.name.zh}）`, `Follow system (${theme.name.en})`) : theme.name[locale];
  useEffect(() => {
    if (!open) return;
    // After the popover has taken focus for its own Escape handling, hand it to the checked style.
    const focusChecked = () => group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    if (typeof window.requestAnimationFrame !== 'function') { const timer = window.setTimeout(focusChecked, 0); return () => window.clearTimeout(timer); }
    const frame = window.requestAnimationFrame(focusChecked);
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  const handing = useRef(false);
  const handBack = () => {
    if (!account?.overriding || handing.current) return;
    handing.current = true; setHandback('saving');
    account.restoreDefault().then(() => setHandback('done'), () => setHandback('failed')).finally(() => { handing.current = false; });
  };
  const choose = (choice: ThemeChoice) => { setThemeChoice(choice); handBack(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = CHOICES.indexOf(themeChoice);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % CHOICES.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + CHOICES.length) % CHOICES.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? CHOICES.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    choose(CHOICES[next]);
    group.current?.querySelector<HTMLElement>(`[data-choice="${CHOICES[next]}"]`)?.focus({ preventScroll: true });
  };
  const option = (definition: ThemeDefinition) => {
    const checked = themeChoice === definition.id;
    return <button key={definition.id} type="button" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1} data-choice={definition.id}
      className={`saas-theme-option${themeChoice === 'auto' && theme.id === definition.id ? ' is-shown' : ''}`}
      aria-labelledby={`saas-theme-${definition.id}-name`} aria-describedby={`saas-theme-${definition.id}-note`} onClick={() => choose(definition.id)}>
      <ThemePreview theme={definition} />
      <span className="saas-theme-option-text"><strong id={`saas-theme-${definition.id}-name`}>{definition.name[locale]}</strong>
        <small id={`saas-theme-${definition.id}-note`}><span className="saas-visually-hidden">{definition.scheme === 'light' ? t('浅色。', 'Light. ') : t('深色。', 'Dark. ')}</span>{definition.description[locale]}</small></span>
      {checked && <span className="saas-theme-option-check" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>}
    </button>;
  };
  const autoChecked = themeChoice === 'auto';
  const light = themeById(AUTO_THEMES.light), dark = themeById(AUTO_THEMES.dark);
  const scheme = account?.label ? t(`「${account.label}」`, `“${account.label}”`) : t('自定义', 'custom');
  return <>
    <button ref={anchor} type="button" className="saas-theme-trigger" aria-haspopup="dialog" aria-expanded={open}
      aria-label={t(`外观风格：${current}`, `Appearance: ${current}`)} title={t(`外观风格：${current}`, `Appearance: ${current}`)} onClick={() => setOpen(value => !value)}>
      <Palette size={16} aria-hidden="true" /><span className="saas-theme-trigger-label">{t('外观', 'Appearance')}</span><span className="saas-theme-trigger-swatch" aria-hidden="true" />
    </button>
    <Popover containKeyboard open={open} anchorRef={anchor} ariaLabel={t('外观风格', 'Appearance')} className="saas-theme-panel" onClose={() => setOpen(false)}>
      <div className="saas-theme-panel-head">
        <h2>{t('外观风格', 'Appearance')}</h2>
        <p>{t('选一套预设风格，整个 AwwO 立刻换上。只记在这个浏览器里。', 'Pick a preset style and all of AwwO switches to it at once. Kept in this browser only.')}</p>
      </div>
      <div ref={group} role="radiogroup" aria-label={t('外观风格', 'Appearance')} className="saas-theme-choices" onKeyDown={onKeyDown}>
        <button type="button" role="radio" aria-checked={autoChecked} tabIndex={autoChecked ? 0 : -1} data-choice="auto" className="saas-theme-auto"
          aria-labelledby="saas-theme-auto-name" aria-describedby="saas-theme-auto-note" onClick={() => choose('auto')}>
          <span className="saas-theme-auto-pair"><ThemePreview theme={light} /><ThemePreview theme={dark} /></span>
          <span className="saas-theme-option-text"><strong id="saas-theme-auto-name">{t('跟随系统', 'Follow system')}</strong>
            <small id="saas-theme-auto-note">{t(`系统浅色时用${light.name.zh}，深色时用${dark.name.zh}`, `${light.name.en} when the system is light, ${dark.name.en} when it is dark`)}</small></span>
          {autoChecked && <span className="saas-theme-option-check" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>}
        </button>
        {(['light', 'dark'] as const).map(side => <div key={side} className="saas-theme-group">
          <span className="saas-theme-group-label" aria-hidden="true">{side === 'light' ? t('浅色', 'Light') : t('深色', 'Dark')}</span>
          <div className="saas-theme-grid">{AWWO_THEMES.filter(definition => definition.scheme === side).map(option)}</div>
        </div>)}
      </div>
      {account?.overriding && handback !== 'done' && <div className="saas-theme-note" role="status">
        <span>{t(`你的账号保存过${scheme}配色，它会盖住风格里的部分颜色。选择任一风格，就会改用风格自带的配色。`, `Your account has a saved ${scheme} color scheme that covers some of each style’s colors. Choosing a style switches back to the style’s own colors.`)}</span>
        <button type="button" disabled={handback === 'saving'} onClick={handBack}>{handback === 'saving' ? t('正在改用…', 'Switching…') : t('现在就改用', 'Switch now')}</button>
        {handback === 'failed' && <span role="alert">{t('没能保存，请稍后重试。', 'Could not save. Please try again.')}</span>}
      </div>}
      {handback === 'done' && <p className="saas-theme-note is-done" role="status">{t('已改用风格自带的配色。账号里原来的配色仍保存在运行设置里。', 'Now using the style’s own colors. Your earlier color scheme is still saved in runtime settings.')}</p>}
    </Popover>
  </>;
}
