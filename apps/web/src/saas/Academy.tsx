import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GraduationCap, X } from 'lucide-react';
import { localeHtmlLang } from '../locale';
import { useSaaSPreferences } from './preferences';
import { LazyBoundary } from './LazyBoundary';
import { page, reloadAfterSaving } from './staleBuild';
import { readAcademyLink, writeAcademyLink } from './academyLink';
import './academy.css';

/** The AwwO Academy, the tutorial videos (academyCatalog.ts), in a dialog any page can open: from the home page's top
 * bar, the More options menu, the signed-out landing page, or a link (academyLink.ts): `?academy` opens it,
 * `?academy=<video>` opens that video in it. The address follows it while it is open, so a reload keeps it and a link can
 * be shared. The dialog is its own part of the site, loaded when a launcher is pointed at or focused, or when it opens. */
type DialogModule = typeof import('./AcademyDialog');
let loaded: DialogModule | null = null;
let loading: Promise<DialogModule> | null = null;

/** Starts loading the dialog's part of the site, once; a failure lets the next call try again. */
export function preloadAcademy(): Promise<DialogModule> {
  loading ??= import('./AcademyDialog').then(module => (loaded = module), error => { loading = null; throw error; });
  return loading;
}

type Academy = { open: (video?: string) => void };
const Context = createContext<Academy | null>(null);

function CloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useSaaSPreferences();
  return <button type="button" className="academy-close" onClick={onClose} aria-label={t('关闭', 'Close')}><X size={18} aria-hidden="true" /></button>;
}

/** The dialog's frame while its part of the site loads: a modal at once, so nothing else opens first (the onboarding
 * tutorial waits while a dialog is open) and the page answers the click. */
function AcademyLoading({ onClose }: { onClose: () => void }) {
  const { locale, t } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="saas-native-dialog academy-dialog is-loading" lang={localeHtmlLang(locale)} aria-labelledby={titleId} aria-busy="true"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="academy-shell">
      <header className="academy-header"><div><span className="academy-eyebrow"><GraduationCap size={14} aria-hidden="true" />AwwO Academy</span>
        <h2 id={titleId}>{t('从真实画布学会 AwwO', 'Learn AwwO from real canvases')}</h2></div><CloseButton onClose={onClose} /></header>
      <div className="academy-body"><p className="academy-loading" role="status">{t('正在打开教程…', 'Opening the Academy…')}</p></div>
    </div>
  </dialog>;
}

/** Shown in place of the dialog when its part of the site fails to load (a deploy since the page opened, a dropped
 * request), or fails. The reload saves an open canvas first, and says so when that leaves something unsaved. */
function AcademyUnavailable({ onClose }: { onClose: () => void }) {
  const { t } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [kept, setKept] = useState<'failed' | 'editor' | null>(null);
  const [saving, setSaving] = useState(false);
  // Closed while the save runs: no reload when it ends.
  const shown = useRef(true);
  useLayoutEffect(() => { const element = dialog.current; shown.current = true; element?.showModal(); return () => { shown.current = false; element?.close(); }; }, []);
  const reload = async () => {
    if (kept) { page.reload(); return; }
    setSaving(true);
    const outcome = await reloadAfterSaving(() => shown.current);
    if (!shown.current) return;
    setSaving(false);
    setKept(outcome.kind === 'failed' || outcome.kind === 'editor' ? outcome.kind : null);
  };
  return <dialog ref={dialog} className="saas-native-dialog academy-unavailable" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="academy-unavailable-body">
      <h2 id={titleId}>{t('教程没能打开', 'The Academy could not open')}</h2>
      <p>{t('这部分网站没能加载，可能是 AwwO 刚刚更新过。重新加载页面后再试。', 'This part of the site did not load, perhaps because AwwO was just updated. Reload the page and try again.')}</p>
      {kept && <p role="alert">{kept === 'failed'
        ? t('画布有修改没能保存，现在刷新可能会丢失这些修改。', 'Your canvas has changes that could not be saved; reloading now may lose them.')
        : t('有一个打开的编辑面板里还有没保存的修改，现在刷新会丢失这些修改。', 'An editor you have open holds changes the canvas does not have yet; reloading now loses them.')}</p>}
      <div className="academy-unavailable-actions">
        <button type="button" onClick={onClose}><X size={15} aria-hidden="true" />{t('关闭', 'Close')}</button>
        <button type="button" className="saas-primary" disabled={saving} onClick={() => void reload()}>{kept ? t('仍然刷新', 'Reload anyway') : t('重新加载页面', 'Reload the page')}</button>
      </div>
    </div>
  </dialog>;
}

export function AcademyProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ video: string; chosen: boolean } | null>(() => {
    const link = readAcademyLink();
    return link === null ? null : { video: link, chosen: false };
  });
  const [module, setModule] = useState<DialogModule | null>(loaded);
  const [failed, setFailed] = useState(false);
  /** The loading frame showed for this opening: the dialog takes its place without coming in again. */
  const framed = useRef(false);
  const ready = module ?? loaded;
  useEffect(() => {
    if (!state || ready) return;
    let live = true;
    preloadAcademy().then(value => { if (live) setModule(value); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [state, ready]);
  // The address has it from the moment it opens, also while it loads (a reload or a copied link opens it again).
  const open = useCallback((video = '') => { writeAcademyLink(video); setState({ video, chosen: true }); }, []);
  // Its part of the address goes with it, also when the dialog never loaded.
  const close = useCallback(() => { writeAcademyLink(null); framed.current = false; setFailed(false); setState(null); }, []);
  const value = useMemo<Academy>(() => ({ open }), [open]);
  let shown: ReactNode = null;
  if (state && failed) shown = <AcademyUnavailable onClose={close} />;
  else if (state && ready) shown = <LazyBoundary fallback={<AcademyUnavailable onClose={close} />}>
    <ready.default initialVideo={state.video} fromLink={!state.chosen} replacing={framed.current} onClose={close} /></LazyBoundary>;
  else if (state) { framed.current = true; shown = <AcademyLoading onClose={close} />; }
  return <Context.Provider value={value}>{children}{shown}</Context.Provider>;
}

/** The Academy's button: `header` in the home page's top bar, `menu` as a row of More options, `landing` beside the
 * language and appearance buttons of the signed-out page. */
export function AcademyLauncher({ variant = 'header', onLaunch }: { variant?: 'header' | 'menu' | 'landing'; onLaunch?: () => void }) {
  const academy = useContext(Context);
  const { t } = useSaaSPreferences();
  if (!academy) return null;
  const label = t('教程', 'Academy');
  const preload = () => { void preloadAcademy().catch(() => { /* Opening it tries again and says so. */ }); };
  return <button type="button" className={`saas-academy-launch is-${variant}`} aria-haspopup="dialog" aria-label={label}
    title={t('AwwO Academy：在线上 AwwO 录制的教程视频', 'AwwO Academy: tutorial videos recorded on the live AwwO')}
    onPointerEnter={preload} onFocus={preload} onClick={() => { onLaunch?.(); academy.open(); }}>
    <GraduationCap size={16} aria-hidden="true" /><span>{label}</span>
  </button>;
}
