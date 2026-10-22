import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { saasErrorMessage, type Identity } from '../api';
import { useSaaSPreferences } from '../preferences';
import { importAccountExport, readAccountExport, type AccountExport, type ExportProblem, type ImportProgress } from './accountImport';
import { SettingsCard } from './general';

/** The export a person imported last on this device, by its export time: importing it again makes a second copy. */
const importedKey = (userID: string) => `awwo.import.v1:${encodeURIComponent(userID)}`;
function importedBefore(userID: string, exportedAt: string): boolean {
  try { return Boolean(exportedAt) && localStorage.getItem(importedKey(userID)) === exportedAt; } catch { return false; }
}
function rememberImport(userID: string, exportedAt: string) {
  try { if (exportedAt) localStorage.setItem(importedKey(userID), exportedAt); } catch { /* Not remembered. */ }
}

/** Past this a browser cannot hold the file's text and its parsed form at once (a string is at most about 512 MB). */
export const MAX_EXPORT_BYTES = 400 * 1024 * 1024;
type Problem = ExportProblem | 'unreadable' | 'too_large';

function ProblemNote({ problem }: { problem: Problem }) {
  const { t } = useSaaSPreferences();
  const text = {
    too_large: t('这个导出文件太大（超过 400 MB），浏览器一次读不了。', 'This export is too large (over 400 MB) for the browser to read at once.'),
    not_export: t('这不是 AwwO 导出的数据文件。请选择在线版「数据管理 → 导出我的数据」下载的 JSON 文件。', 'This is not an AwwO data export. Choose the JSON file that Data management → Export my data downloaded on the online AwwO.'),
    incomplete: t('这个导出文件不完整（导出时被中断）。请在在线版重新导出一次。', 'This export is incomplete (it was cut short). Export again on the online AwwO.'),
    newer: t('这个文件来自更新版本的 AwwO，这台电脑上的 AwwO 本地版还读不了。请先更新本地版。', 'This file comes from a newer AwwO than the one on this computer. Update AwwO Local first.'),
    empty: t('这个文件里没有正常状态的工作区，没有可导入的内容。', 'This file has no active workspace, so there is nothing to import.'),
    unreadable: t('读不了这个文件。', 'This file could not be read.'),
  }[problem];
  return <p role="alert" className="saas-error">{text}</p>;
}

function ImportPlan({ plan, again, onStart }: { plan: AccountExport; again: boolean; onStart: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const when = plan.exportedAt ? new Date(plan.exportedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en') : t('未知时间', 'an unknown time');
  const spaces = plan.workspaces.length, canvases = plan.canvasCount;
  return <div className="saas-settings-pending">
    <p role="status">{t(`导出于 ${when}：${spaces} 个工作区，${canvases} 张画布。`, `Exported ${when}: ${spaces} ${spaces === 1 ? 'workspace' : 'workspaces'}, ${canvases} ${canvases === 1 ? 'canvas' : 'canvases'}.`)}</p>
    <p>{t('将新建：', 'Creates: ')}{plan.workspaces.map(item => item.name).join(locale === 'zh' ? '、' : ', ')}</p>
    {again && <p>{t('这个文件已经在这台电脑上导入过一次，再导入会多出一份同样的工作区。', 'This file was imported on this computer before; importing it again makes a second copy of these workspaces.')}</p>}
    <button type="button" className="saas-primary" onClick={onStart}>{t('开始导入', 'Import')}</button>
  </div>;
}

function ImportReport({ progress, running, stopped, onStop }: { progress: ImportProgress; running: boolean; stopped: boolean; onStop: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const { done, total, imported, workspaces, failed } = progress;
  const canvases = (count: number) => count === 1 ? 'canvas' : 'canvases';
  const spaces = (count: number) => count === 1 ? 'workspace' : 'workspaces';
  // Ended before the last canvas without a stop: the reason is said below the card (ImportCard's error).
  const complete = done === total;
  return <>
    <p role="status">{running ? t(`正在导入画布 ${done} / ${total}…`, `Importing canvas ${done} of ${total}…`)
      : stopped ? t(`导入已停止：已导入 ${imported} 张画布。`, `The import stopped: ${imported} ${canvases(imported)} imported.`)
        : !complete ? t(`导入没有完成：已导入 ${imported} 张画布，新建 ${workspaces} 个工作区。`, `The import did not finish: ${imported} ${canvases(imported)} imported into ${workspaces} new ${spaces(workspaces)}.`)
          : t(`已导入 ${imported} 张画布，新建 ${workspaces} 个工作区。`, `Imported ${imported} ${canvases(imported)} into ${workspaces} new ${spaces(workspaces)}.`)}</p>
    {running && <button type="button" onClick={onStop}>{t('停止导入', 'Stop the import')}</button>}
    {failed.length > 0 && <div className="saas-settings-pending">
      <p><strong>{t(`${failed.length} 项没有导入`, `${failed.length} ${failed.length === 1 ? 'item was' : 'items were'} not imported`)}</strong></p>
      <ul>{failed.map((item, index) => <li key={index}>{item.canvas ? `${item.workspace} / ${item.canvas}` : item.workspace}{t('：', ': ')}{saasErrorMessage(item.error, locale)}</li>)}</ul>
    </div>}
    {!running && !stopped && complete && <a className="saas-buy-link" href="/">{t('返回工作区查看', 'Back to your workspaces')}</a>}
  </>;
}

/** The local edition's 从在线版导入: choose the file the hosted site's 导出我的数据 saved, see what it holds, then import. */
export function ImportCard({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const [plan, setPlan] = useState<AccountExport | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const picker = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  // Each choice of a file; a slower read of an earlier choice no longer counts once another is made.
  const choice = useRef(0);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!running) return;
    // A page closed halfway leaves the rest of the file out: the browser asks first.
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [running]);
  const choose = async (file: File | undefined) => {
    const current = ++choice.current;
    setPlan(null); setProblem(null); setProgress(null); setStopped(false); setError(null);
    if (!file) return;
    if (typeof file.size === 'number' && file.size > MAX_EXPORT_BYTES) { setProblem('too_large'); return; }
    let text: string;
    try { text = await file.text(); } catch { if (current === choice.current) setProblem('unreadable'); return; }
    if (current !== choice.current) return;
    const read = readAccountExport(text);
    if (typeof read === 'string') setProblem(read); else setPlan(read);
  };
  const start = async () => {
    if (!plan || running) return;
    const current = new AbortController();
    controller.current = current;
    setRunning(true);
    // Remembered once a first workspace exists: importing the file again from then on makes a second copy of it.
    const report = (next: ImportProgress) => { setProgress(next); if (next.workspaces > 0) rememberImport(identity.user.id, plan.exportedAt); };
    try { await importAccountExport(plan, report, { signal: current.signal }); }
    catch (cause) { if (current.signal.aborted) setStopped(true); else setError(cause); }
    finally { setRunning(false); controller.current = null; }
  };
  return <SettingsCard title={t('从 AwwO 在线版导入', 'Import from the online AwwO')}
    description={t('在在线版的「设置 → 数据管理」导出 JSON 文件，再在这里选择它。每个工作区会在本机新建一个同名工作区，画布逐一放进去；本机已有的内容不受影响。画布的节点、连线、设置、文字结果和未发送的草稿会带过来；节点的对话记录，以及在线版生成的图片、视频、3D、配音和上传的文件不在导出文件里，节点在本机第一次运行时重新建立。已经用自己的「发送」生成过的图片、视频、3D 和配音节点，提示词在线上的对话里，需要重新填写。节点挂的个人技能需要重新添加；节点选的线上模型本机没有时，需要重新选择。设置和配色不会导入。',
      'Export the JSON file in Settings → Data management on the online AwwO, then choose it here. Each of its workspaces becomes a new workspace of the same name on this computer, with its canvases; nothing already here changes. The canvases’ nodes, wires, settings, text results and unsent drafts come along; the nodes’ conversations, and the pictures, videos, 3D, voice and uploaded files of the online AwwO, are not in the export, and each node is set up again on its first run here. A picture, video, 3D or voice node already generated with its own Send has its prompt in that online conversation, so type it again. A node’s personal skills have to be added again, and a model this computer does not offer has to be chosen again. Settings and colour schemes are not imported.')}>
    <input ref={picker} className="saas-visually-hidden" type="file" accept="application/json,.json" tabIndex={-1} aria-hidden="true"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void choose(file); }} />
    <button type="button" disabled={running} onClick={() => picker.current?.click()}><FileUp size={16} aria-hidden="true" />{t('选择导出文件', 'Choose the export file')}</button>
    {problem && <ProblemNote problem={problem} />}
    {plan && !progress && !running && <ImportPlan plan={plan} again={importedBefore(identity.user.id, plan.exportedAt)} onStart={() => void start()} />}
    {running && !progress && <p role="status">{t('正在导入…', 'Importing…')}</p>}
    {progress && <ImportReport progress={progress} running={running} stopped={stopped} onStop={() => controller.current?.abort()} />}
    {error !== null && <p role="alert" className="saas-error">{t('导入没有完成：', 'The import did not finish: ')}{saasErrorMessage(error, locale)}</p>}
  </SettingsCard>;
}
