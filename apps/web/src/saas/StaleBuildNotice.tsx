import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSaaSPreferences } from './preferences';
import { onStaleBuild, reloadAfterSaving, SAVE_DEADLINE_MS, saveOpenCanvas, staleBuildFailures, type CanvasSaveOutcome } from './staleBuild';

type Save = CanvasSaveOutcome | { readonly kind: 'saving' };

/** What a page whose own build is gone says once a part of it failed to load (staleBuild.ts): AwwO was updated, so reload.
 * It saves the open canvas first, offers the reload only once nothing would be lost, and never reloads by itself;
 * "Not now" leaves the page as it is (a reload still waiting for its save included) until another part fails to load. */
export function StaleBuildNotice() {
  const { t } = useSaaSPreferences();
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
  return <div className="saas-stale-build" role="alert">
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
}
