import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { localeHtmlLang } from '../locale';
import { useSaaSPreferences } from './preferences';
import { onStaleBuild, reloadAfterSaving, SAVE_DEADLINE_MS, saveOpenCanvas, staleBuildFailures, type CanvasSaveOutcome } from './staleBuild';

type Save = CanvasSaveOutcome | { readonly kind: 'saving' };

const isModal = (dialog: HTMLDialogElement) => {
  try { return dialog.open && dialog.matches(':modal'); } catch { return false; }
};

/** A change that can open, close or remove a dialog: an open attribute, or a dialog among the nodes added or removed. */
const touchesDialogs = (records: MutationRecord[]) => records.some(record => record.type === 'attributes'
  || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.localName === 'dialog' || node.querySelector('dialog') !== null)));

type TopModal = { readonly dialog: HTMLDialogElement | null; readonly raised: number };

/** The open modal dialog on top, while `active`. Such a dialog makes the rest of the page inert (even a popover shown
 * above it), so the notice must sit inside it to be clicked. The top one holds the focus, as only it can; failing that,
 * it is the one opened last (document order does not tell). `raised` counts the times the top dialog opened again (a
 * dialog can reopen itself in one step, as the forced tutorial does), which puts it back above a popover shown in it. */
function useTopModalDialog(active: boolean): TopModal {
  const [top, setTop] = useState<TopModal>({ dialog: null, raised: 0 });
  useEffect(() => {
    if (!active) { setTop(current => current.dialog ? { dialog: null, raised: current.raised } : current); return; }
    const opened = new Map<HTMLDialogElement, number>();
    let count = 0;
    let current: HTMLDialogElement | null = null;
    const update = (records: MutationRecord[] = []) => {
      const open = [...document.querySelectorAll('dialog')].filter(isModal);
      for (const dialog of [...opened.keys()]) if (!open.includes(dialog)) opened.delete(dialog);
      for (const dialog of open) if (!opened.has(dialog)) opened.set(dialog, ++count);
      const focused = document.activeElement instanceof Element ? document.activeElement.closest('dialog') : null;
      let next: HTMLDialogElement | null = focused && open.includes(focused) ? focused : null;
      if (!next) for (const [dialog, order] of opened) if (!next || order > (opened.get(next) ?? 0)) next = dialog;
      const reopened = next !== null && next === current && records.some(record => record.type === 'attributes' && record.target === next);
      current = next;
      setTop(previous => previous.dialog === next && !reopened ? previous : { dialog: next, raised: previous.raised + (reopened ? 1 : 0) });
    };
    update();
    const observer = new MutationObserver(records => { if (touchesDialogs(records)) update(records); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, [active]);
  return top;
}

/** What a page whose own build is gone says once a part of it failed to load (staleBuild.ts): AwwO was updated, so reload.
 * It saves the open canvas first, offers the reload only once nothing would be lost, and never reloads by itself;
 * "Not now" leaves the page as it is (a reload still waiting for its save included) until another part fails to load. */
export function StaleBuildNotice() {
  const { t, locale } = useSaaSPreferences();
  const failures = useSyncExternalStore(onStaleBuild, staleBuildFailures, () => 0);
  const [dismissed, setDismissed] = useState(0);
  const [save, setSave] = useState<Save>({ kind: 'saving' });
  const live = useRef(true);
  // Bumped by each Reload and by "Not now": a reload goes ahead only while its own click is the latest wish.
  const wish = useRef(0);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const run = (action: () => Promise<CanvasSaveOutcome>) => {
    setSave({ kind: 'saving' });
    void action().then(outcome => { if (live.current) setSave(outcome); });
  };
  const shown = failures > dismissed;
  // Each time the notice comes up, the canvas is saved before a reload is offered.
  useEffect(() => { if (shown) run(saveOpenCanvas); }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a modal dialog is open, the notice is inside it, and in the top layer above its content (the dialog's scroll
  // and transform would move a fixed box). A new node each time it moves, so it is shown again; out of the dialog, it is
  // the page's own box again. A browser without popovers keeps it a fixed box inside the dialog.
  const { dialog: host, raised } = useTopModalDialog(shown);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!host || !element || typeof element.showPopover !== 'function') return;
    let open = false;
    try { open = element.matches(':popover-open'); } catch { /* a browser that cannot tell shows it anew */ }
    // Shown again after its dialog reopened, it goes back above it.
    try { if (open) element.hidePopover(); element.showPopover(); } catch { element.removeAttribute('popover'); }
  }, [host, raised, shown]);
  if (!shown) return null;
  const reload = () => { const mine = ++wish.current; run(() => reloadAfterSaving(() => wish.current === mine)); };
  const notNow = () => { wish.current += 1; setDismissed(failures); setSave({ kind: 'saving' }); };
  const seconds = Math.round(SAVE_DEADLINE_MS / 1000);
  const lead = t('AwwO 在这个页面打开后更新过，页面的一部分没能加载。', 'AwwO was updated after this page was opened, so part of the page could not load.');
  const text = save.kind === 'saving' ? t('正在先保存画布…', 'Saving your canvas first…')
    : save.kind === 'saved' ? t('画布已保存，重新加载即可使用新版本。', 'Your canvas is saved: reload to use the new version.')
    : save.kind === 'nothing' ? t('重新加载即可使用新版本。', 'Reload to use the new version.')
    : save.kind === 'editor' ? t('有一个打开的编辑面板里还有没保存的修改：先保存或关闭它，再重新加载，以免丢失修改。', 'An editor you have open holds changes the canvas does not have yet: save or close it, then reload, so no change is lost.')
    : save.timedOut ? t(`画布还没保存好：保存超过 ${seconds} 秒还没有完成。等它保存好再重新加载，以免丢失修改。`, `Your canvas is not saved yet: saving has taken more than ${seconds} seconds. Reload once it is saved, so no change is lost.`)
    : t('画布有没能保存的修改，见画布上方的提示：先导出本地副本，再重新加载。', 'Your canvas has changes that could not be saved: see the message above the canvas, and export a local copy before reloading.');
  // A dialog can be in another language than the interface (the cases are in English).
  const notice = <div ref={box} className="saas-stale-build" role="alert" lang={localeHtmlLang(locale)} popover={host ? 'manual' : undefined}>
    <p>{lead} {text}</p>
    <div className="saas-stale-build-actions">
      {(save.kind === 'saved' || save.kind === 'nothing') && <button type="button" className="saas-primary" onClick={reload}>{t('重新加载', 'Reload')}</button>}
      {/* A failed save stays failed until the page reloads (the canvas's own message says how to keep the edits); a slow
          one may still finish, and an editor may have been saved since. */}
      {save.kind === 'failed' && save.timedOut && <button type="button" onClick={() => run(saveOpenCanvas)}>{t('再保存一次', 'Try saving again')}</button>}
      {save.kind === 'editor' && <button type="button" onClick={() => run(saveOpenCanvas)}>{t('已处理，再检查一次', 'Done, check again')}</button>}
      {/* Coming back, the notice saves again before it offers the reload. */}
      <button type="button" className="saas-link" onClick={notNow}>{t('暂不', 'Not now')}</button>
    </div>
  </div>;
  return host ? createPortal(notice, host) : notice;
}
