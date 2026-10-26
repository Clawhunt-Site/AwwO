import { useEffect, useState } from 'react';
import { api, saasErrorMessage } from '../api';
import { inLocalWindow } from '../edition';
import { useSaaSPreferences } from '../preferences';
import { SettingsCard, SettingsIntro } from './general';

/** What GET /local tells the local edition's person (edition.go localComputer). */
export type LocalComputer = {
  dataFolder: string; providersFile: string; media: boolean; managedExecution: boolean; render: boolean;
  webReader: boolean; skillRegistry: boolean; revision: string;
  /** The proxy on this computer that 从网址读取 and the skill registry read through (AWWO_WEB_READER_PROXY); '' for none. */
  webReaderProxy: string;
  /** The window that started it ('windows' or 'macos', edition.ts inLocalWindow); '' from a checkout. */
  shell: string;
};

function readLocalComputer(value: unknown): LocalComputer | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const text = (key: string) => typeof item[key] === 'string' ? item[key] as string : '';
  return { dataFolder: text('dataFolder'), providersFile: text('providersFile'), media: item.media === true,
    managedExecution: item.managedExecution === true, render: item.render === true, webReader: item.webReader === true,
    skillRegistry: item.skillRegistry === true, revision: text('revision'), webReaderProxy: text('webReaderProxy'), shell: text('shell') };
}

function Path({ value }: { value: string }) {
  const { t } = useSaaSPreferences();
  const [copied, setCopied] = useState(false);
  if (!value) return <p className="saas-field-hint">{t('这次启动没有告诉 AwwO 它的位置。', 'This start did not tell AwwO where it is.')}</p>;
  return <p className="saas-local-path"><code>{value}</code>
    <button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the path stays on screen */ }
    }}>{copied ? t('已复制', 'Copied') : t('复制', 'Copy')}</button></p>;
}

/** One optional service: on or off, what it needs while off, and how it runs while on (a proxy it reads through). */
function Service({ on, name, when, how }: { on: boolean; name: string; when: string; how?: string }) {
  const { t } = useSaaSPreferences();
  return <li><strong>{name}</strong><span>{on ? t('已开启', 'On') : t('未开启', 'Off')}</span>{on ? how && <small>{how}</small> : <small>{when}</small>}</li>;
}

/**
 * 设置 → 本机: the local edition's page in the place of 用量与计费. There is nothing to buy: models run on the keys the
 * person saved in 我的引擎 and their provider bills them directly. It names the data folder (and how to back it up), the
 * file that holds the media services' keys, and which of this computer's optional services run.
 */
export function LocalComputerSettings() {
  const { t, locale } = useSaaSPreferences();
  const [computer, setComputer] = useState<LocalComputer | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    api('/local', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setComputer(readLocalComputer(value)); },
      cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, []);
  const readsThrough = computer?.webReaderProxy ? t(`经本机代理 ${computer.webReaderProxy} 访问网站。`, `Reads sites through the proxy at ${computer.webReaderProxy}.`) : undefined;
  // In AwwO Local's window: its menu restarts AwwO, and a program put on PATH meanwhile is seen once the window itself
  // starts again (it starts AwwO with the environment it was opened with). It cannot build the workspace image.
  const windowed = inLocalWindow(computer);
  const restart = windowed ? t('然后用菜单「AwwO → 重新启动」。', 'then use AwwO → Restart.') : t('然后重启。', 'then restart.');
  return <>
    <SettingsIntro title={t('本机', 'This computer')} intro={t('AwwO 本地版在这台电脑上运行：账号、画布和运行记录都保存在本机。模型使用你在「我的引擎」中保存的 Key，费用由模型服务直接结算，这里没有套餐、点数或每日额度。', 'AwwO Local runs on this computer: your account, canvases and runs are kept here. Models run on the keys you saved in My engines and their provider bills you directly; there are no plans, credits or daily allowances here.')} />
    {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {computer === undefined && error === null && <p role="status">{t('正在读取…', 'Loading…')}</p>}
    {computer && <div className="saas-settings-stack">
      <SettingsCard title={t('数据目录', 'Data folder')} description={t('备份时先停止 AwwO 本地版，再复制整个目录。其中的 local.env 存着加密已保存 Key 的主密钥：它必须和数据库一起备份、一起恢复，丢失后已保存的 Key 就无法解密。', 'To back up, stop AwwO Local first, then copy the whole folder. Its local.env holds the key that encrypts your saved API keys: back it up and restore it together with the database, or the saved keys can no longer be decrypted.')}>
        <Path value={computer.dataFolder} />
      </SettingsCard>
      <SettingsCard title={t('媒体服务', 'Media services')} description={windowed
        ? t('图片、视频、3D 和配音节点使用 providers.env 中填写的服务密钥。填写或修改后用菜单「AwwO → 重新启动」即可生效；留空的服务保持关闭。', 'Picture, video, 3D and voice nodes use the service keys in providers.env. After filling one in or changing it, use AwwO → Restart; a service left empty stays off.')
        : t('图片、视频、3D 和配音节点使用 providers.env 中填写的服务密钥。填写或修改后重启 AwwO 本地版即可生效；留空的服务保持关闭。', 'Picture, video, 3D and voice nodes use the service keys in providers.env. Restart AwwO Local after filling one in or changing it; a service left empty stays off.')}>
        <p role="status">{computer.media ? t('已开启：至少一项媒体服务已配置。', 'On: at least one media service is set up.') : t('未开启：providers.env 中还没有媒体服务密钥。', 'Off: providers.env has no media service key yet.')}</p>
        <Path value={computer.providersFile} />
      </SettingsCard>
      <SettingsCard title={t('本机服务', 'Services on this computer')} description={t('这台电脑运行不了的服务会保持关闭，应用中对应的功能显示为未就绪。', 'A service this computer cannot run stays off, and the app shows its features as not ready.')}>
        <ul className="saas-local-services">
          <Service on={computer.managedExecution} name={t('直接执行', 'Direct execution')} when={windowed
            ? t('安装版暂不提供：它的工作区镜像只能在代码库中构建（Docker 运行时执行 npm run setup:local）。', 'Not in the installed app yet: its workspace image is built from a checkout only (npm run setup:local while Docker runs).')
            : t('需要运行 Docker Desktop，并在 Docker 运行时执行一次 npm run setup:local 构建工作区镜像，然后重启。', 'Needs Docker Desktop running, and npm run setup:local run once while it runs to build the workspace image; then restart.')} />
          {/* The Mac app's window gives AwwO a fixed PATH: the system's folders, then Homebrew's (apps/macos/AwwOLocal.swift). */}
          <Service on={computer.render} name={t('渲染视频与剪辑', 'Video rendering and edits')} when={computer.shell === 'macos'
            ? t('需要 Chrome 或 Edge，以及 ffmpeg 和 ffprobe（例如用 Homebrew 安装：brew install ffmpeg）；装好后退出 AwwO（菜单「AwwO → 退出 AwwO」）再重新打开。', 'Needs Chrome or Edge, and ffmpeg and ffprobe (with Homebrew, for one: brew install ffmpeg); once they are there, quit AwwO (AwwO → Quit AwwO) and open it again.')
            : windowed
            ? t('需要 Chrome 或 Edge，以及 PATH 上的 ffmpeg 和 ffprobe；装好后退出 AwwO 本地版（菜单「AwwO → 退出」）再重新打开。', 'Needs Chrome or Edge, and ffmpeg and ffprobe on PATH; once they are there, quit AwwO Local (AwwO → Quit) and open it again.')
            : t('需要 Chrome 或 Edge，以及 PATH 上的 ffmpeg 和 ffprobe，然后重启。', 'Needs Chrome or Edge, and ffmpeg and ffprobe on PATH; then restart.')} />
          <Service on={computer.webReader} name={t('从网址读取', 'Read from a web address')} when={t('这次启动没有开启。', 'This start did not turn it on.')} how={readsThrough} />
          <Service on={computer.skillRegistry} name={t('技能库（skills.sh）', 'Skill registry (skills.sh)')} when={t('这次启动没有开启。', 'This start did not turn it on.')} how={readsThrough} />
        </ul>
        <p className="saas-field-hint">{t('打不开的网站可以经本机代理读取：在 providers.env 填写 AWWO_WEB_READER_PROXY（例如 http://127.0.0.1:7897），', 'To reach sites this computer cannot open directly, set AWWO_WEB_READER_PROXY in providers.env (for example http://127.0.0.1:7897), ')}{restart}</p>
      </SettingsCard>
      {computer.revision && computer.revision !== 'unknown' && <SettingsCard title={t('版本', 'Version')}><p><code>{computer.revision.slice(0, 12)}</code></p></SettingsCard>}
    </div>}
  </>;
}
