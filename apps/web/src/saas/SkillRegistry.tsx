// Finding a skill on skills.sh, the open agent-skills directory, and importing it into this workspace's library
// (skill_registry.go). The server asks skills.sh and keeps only SKILL.md's text, through the checks an uploaded file
// gets. Before importing, a member sees the text itself, its license, the security reviews skills.sh publishes, and
// what stays behind: the files that come with the skill and the commands it expects to run. A skill whose license is
// not a permissive one is imported only once the member confirms they may use it (skill_registry_license.go).
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Search, ShieldAlert, ShieldCheck, Star, TriangleAlert } from 'lucide-react';
import { SaaSApiError, saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';
import {
  importRegistrySkill, previewRegistrySkill, searchSkillRegistry, SKILL_CATEGORIES, SKILL_NAME, SKILL_TAGS, skillCategoryName,
  type RegistryHit, type RegistryPreview, type Skill,
} from './skillsApi';

type Translate = (zh: string, en: string) => string;
type Locale = 'zh' | 'en';
interface Draft { name: string; title: string; description: string; category: string; applies: string[] }
/** onBusy says when an import is running, so the library keeps its own ways out closed meanwhile. */
interface Props { tenantId: string; onClose: () => void; onImported: (skill: Skill) => void; onBusy?: (importing: boolean) => void }

const length = (value: string) => [...value].length;
const oneDecimal = (value: number) => String(Math.round(value * 10) / 10);

/** 185000 → 「18.5 万次安装」 or "185K installs". */
export function formatInstalls(count: number, locale: Locale): string {
  if (locale === 'zh') return count >= 1e8 ? `${oneDecimal(count / 1e8)} 亿次安装` : count >= 1e4 ? `${oneDecimal(count / 1e4)} 万次安装` : `${count} 次安装`;
  return count >= 1e6 ? `${oneDecimal(count / 1e6)}M installs` : count >= 1e3 ? `${oneDecimal(count / 1e3)}K installs` : `${count} install${count === 1 ? '' : 's'}`;
}

const draftReady = (draft: Draft) => SKILL_NAME.test(draft.name) && draft.name.length <= 64 && draft.title.trim() !== '' && length(draft.title.trim()) <= 120
  && draft.description.trim() !== '' && length(draft.description.trim()) <= 1024 && (SKILL_CATEGORIES as readonly string[]).includes(draft.category);

export function SkillRegistry({ tenantId, onClose, onImported, onBusy }: Props) {
  const { t, locale } = useSaaSPreferences();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ query: string; items: RegistryHit[] } | null>(null);
  const [selected, setSelected] = useState<RegistryHit | null>(null);
  const [preview, setPreview] = useState<RegistryPreview | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'search' | 'preview' | 'import' | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The one request in flight: a newer search or pick replaces it.
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { onBusy?.(busy === 'import'); }, [busy, onBusy]);
  useEffect(() => () => onBusy?.(false), [onBusy]);

  const run = async <T,>(kind: 'search' | 'preview' | 'import', call: (signal: AbortSignal) => Promise<T>, done: (value: T) => void, failed?: (cause: unknown) => void) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind); setError(null);
    try {
      const value = await call(controller.signal);
      if (!controller.signal.aborted) done(value);
    } catch (cause) {
      if (!controller.signal.aborted) { setError(cause); failed?.(cause); }
    } finally {
      if (request.current === controller) { request.current = null; setBusy(null); }
    }
  };
  const search = () => {
    const words = query.trim().replace(/\s+/g, ' ');
    if (length(words) < 2 || busy === 'import') return;
    void run('search', signal => searchSkillRegistry(tenantId, words, signal), items => { setResults({ query: words, items }); setSelected(null); setPreview(null); setDraft(null); });
  };
  const open = (item: RegistryHit) => {
    if (busy === 'import') return;
    setSelected(item); setPreview(null); setDraft(null); setConfirmed(false);
    void run('preview', signal => previewRegistrySkill(tenantId, item.id, signal), value => { setPreview(value); setDraft({ ...value.skill, applies: [...value.skill.applies] }); });
  };
  // Read the skill again when the server judged it differently from the preview (it changed on skills.sh, or its license
  // could not be confirmed open this time), keeping the member's fields and the reason.
  const reread = (item: RegistryHit, cause: unknown) => {
    void run('preview', signal => previewRegistrySkill(tenantId, item.id, signal), value => { setPreview(value); setConfirmed(false); setError(cause); });
  };
  const importSkill = () => {
    if (!preview || !draft || !draftReady(draft) || preview.problem?.blocking || !selected) return;
    const licenseConfirmed = preview.license.status !== 'open' && confirmed;
    if (preview.license.status !== 'open' && !licenseConfirmed) return;
    const item = selected;
    void run('import', signal => importRegistrySkill(tenantId, { id: preview.id, hash: preview.hash, ...draft, title: draft.title.trim(), description: draft.description.trim(), licenseConfirmed }, signal), onImported,
      cause => { if (cause instanceof SaaSApiError && (cause.code === 'skill_registry_changed' || cause.code === 'skill_registry_license_unconfirmed')) reread(item, cause); });
  };

  return <div className="awwo-library-body has-editor awwo-registry">
    <div className="awwo-library-list-column">
      <button type="button" className="awwo-registry-back" disabled={busy === 'import'} onClick={onClose}><ArrowLeft size={14} aria-hidden="true" />{t('返回技能库', 'Back to the library')}</button>
      <form className="awwo-library-filters" role="search" onSubmit={event => { event.preventDefault(); search(); }}>
        <label className="awwo-library-search"><Search size={15} aria-hidden="true" />
          <input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} aria-label={t('在 skills.sh 搜索技能', 'Search skills.sh')}
            placeholder={t('要做的事，例如：代码审查、PDF、视频剪辑', 'What to do, e.g. code review, PDF, video editing')} /></label>
        <button type="submit" className="awwo-library-primary" disabled={busy === 'search' || busy === 'import' || length(query.trim()) < 2}>{busy === 'search' ? t('搜索中…', 'Searching…') : t('搜索', 'Search')}</button>
      </form>
      <p className="awwo-library-help">{t('skills.sh 是 Vercel 运营的公开技能目录，收录各家开源的智能体技能。搜索词会发给 skills.sh。', 'skills.sh is the open directory of agent skills run by Vercel. Your search is sent to skills.sh.')}</p>
      {results === null ? <p className="awwo-library-empty">{t('写下要做的事，找别人已经写好的技能。', 'Describe the task to find a skill someone has already written.')}</p>
        : results.items.length === 0 ? <p className="awwo-library-empty" role="status">{t(`skills.sh 上没有找到与「${results.query}」相关的技能。换个说法再试，或者在技能库里自己写一个。`, `No skills on skills.sh match “${results.query}”. Try other words, or write one in the library.`)}</p>
        : <ul className="awwo-library-list is-compact" aria-label={t('skills.sh 搜索结果', 'skills.sh results')}>{results.items.map(item => <li key={item.id} className={item.id === selected?.id ? 'is-active' : undefined}>
          <button type="button" className="awwo-library-pick" aria-pressed={item.id === selected?.id} disabled={busy === 'import'} onClick={() => open(item)}>
            <strong>{item.name}</strong>
            <span>{item.source}</span>
            <small>{formatInstalls(item.installs, locale)}</small>
          </button>
        </li>)}</ul>}
    </div>
    <div className="awwo-library-editor" role="region" aria-label={t('技能预览', 'Skill preview')}>
      {error !== null && <p className="awwo-library-alert" role="alert">{saasErrorMessage(error, locale)}</p>}
      {busy === 'preview' ? <p className="awwo-library-empty" role="status">{t('正在从 skills.sh 读取这个技能…', 'Reading this skill from skills.sh…')}</p>
        : preview && draft && selected ? <RegistryPreviewPanel preview={preview} hit={selected} draft={draft} confirmed={confirmed} busy={busy === 'import'} t={t} locale={locale}
          onChange={setDraft} onConfirm={setConfirmed} onImport={importSkill} />
        : <p className="awwo-library-empty">{t('选一个结果，查看它的全文、许可证和安全审计，再决定要不要导入。', 'Choose a result to read its text, license and security reviews before you decide to import it.')}</p>}
    </div>
  </div>;
}

interface PanelProps {
  preview: RegistryPreview; hit: RegistryHit; draft: Draft; confirmed: boolean; busy: boolean; t: Translate; locale: Locale;
  onChange: (draft: Draft) => void; onConfirm: (confirmed: boolean) => void; onImport: () => void;
}

function RegistryPreviewPanel({ preview, hit, draft, confirmed, busy, t, locale, onChange, onConfirm, onImport }: PanelProps) {
  const blocked = preview.problem?.blocking === true;
  const open = preview.license.status === 'open';
  const problem = preview.problem && (preview.problem.code === 'skill_registry_too_large'
    ? t(`这个技能的正文约 ${(preview.bytes / 1024).toFixed(1)} KiB，超过了工作区技能 12 KiB 的上限，无法导入。`, `This skill’s text is about ${(preview.bytes / 1024).toFixed(1)} KiB, more than the 12 KiB a workspace skill holds, so it cannot be imported.`)
    : saasErrorMessage(new SaaSApiError(422, preview.problem.code, preview.problem.message), locale) + (blocked ? '' : t(' 请修改下面的内容后再导入。', ' Change the fields below, then import.')));
  return <>
    <h3>{hit.name}</h3>
    <p className="awwo-library-meta"><code>{preview.id}</code> · {formatInstalls(hit.installs, locale)}
      {' · '}<a href={preview.url} target="_blank" rel="noreferrer">skills.sh<ExternalLink size={11} aria-hidden="true" /></a>
      {' · '}<a href={preview.repoUrl} target="_blank" rel="noreferrer">GitHub<ExternalLink size={11} aria-hidden="true" /></a></p>
    <ul className="awwo-registry-facts">
      <LicenseLines preview={preview} t={t} locale={locale} />
      <AuditLines preview={preview} t={t} />
      {preview.notes.includes('extra_files') && <li className="is-note"><TriangleAlert size={14} aria-hidden="true" /><span>{t(
        `它还带有 ${preview.filesTotal} 个附带文件（${preview.files.slice(0, 3).map(file => file.path).join('、')}${preview.filesTotal > 3 ? ' 等' : ''}）。AwwO 只导入 SKILL.md 的文字，附带文件不会保存，也不会运行。`,
        `It comes with ${preview.filesTotal} more file${preview.filesTotal === 1 ? '' : 's'} (${preview.files.slice(0, 3).map(file => file.path).join(', ')}${preview.filesTotal > 3 ? ', …' : ''}). AwwO imports only SKILL.md’s text; the other files are neither kept nor run.`)}</span></li>}
      {preview.notes.includes('runs_commands') && <li className="is-note"><TriangleAlert size={14} aria-hidden="true" /><span>{t(
        '它是写给能运行命令的智能体的。AwwO 的节点只读它的文字，不会因此能运行命令；正文里要运行命令的步骤，节点只能当作参考。',
        'It is written for an agent that runs commands. An AwwO node only reads its text and gains no way to run them; steps that run commands are guidance only.')}</span></li>}
    </ul>
    {preview.license.files.map(file => <details key={file.path} className="awwo-registry-text">
      <summary>{file.readme ? t(`说明文件里的许可条款（${file.path}）`, `License terms in the skill’s README (${file.path})`)
        : file.notice ? t(`技能自带的版权声明（${file.path}）`, `The skill’s own notice (${file.path})`) : t(`技能自带的许可证（${file.path}）`, `The skill’s own license (${file.path})`)}</summary>
      <pre className="awwo-library-preview">{file.text}{file.truncated ? t('\n…（只显示了前 16 KiB）', '\n… (only the first 16 KiB are shown)') : ''}</pre>
    </details>)}
    {problem && <p className={blocked ? 'awwo-library-alert' : 'awwo-registry-warning'} role={blocked ? 'alert' : 'status'}>{problem}</p>}
    {!blocked && <form className="awwo-registry-form" onSubmit={event => { event.preventDefault(); onImport(); }}>
      <label>{t('名称（引用标识）', 'Name (its reference)')}<input required value={draft.name} maxLength={64} onChange={event => onChange({ ...draft, name: event.target.value.toLowerCase() })} />
        <small>{t('小写字母、数字和单个连字符；导入后不能更改。', 'Lowercase letters, digits and single hyphens; it cannot change after importing.')}</small></label>
      <label>{t('标题', 'Title')}<input required value={draft.title} maxLength={120} onChange={event => onChange({ ...draft, title: event.target.value.replace(/[\r\n\t]+/g, ' ') })} /></label>
      <label>{t('一句话说明（显示在技能列表里）', 'One-line description (shown in the skill list)')}<input required value={draft.description} maxLength={1024} onChange={event => onChange({ ...draft, description: event.target.value.replace(/[\r\n]+/g, ' ') })} /></label>
      <label>{t('类别', 'Category')}<select value={draft.category} onChange={event => onChange({ ...draft, category: event.target.value })}>
        {SKILL_CATEGORIES.map(category => <option key={category} value={category}>{skillCategoryName(category, t)}</option>)}</select></label>
      <fieldset><legend>{t('适用于', 'Applies to')}</legend><div className="awwo-library-tags">{SKILL_TAGS.map(tag => <label key={tag} className="awwo-library-check">
        <input type="checkbox" checked={draft.applies.includes(tag)} onChange={event => onChange({ ...draft, applies: event.target.checked ? [...draft.applies, tag] : draft.applies.filter(item => item !== tag) })} />{tag}</label>)}</div></fieldset>
      {!open && <div className="awwo-registry-license">
        <p className="awwo-registry-warning">{preview.license.status === 'restricted'
          ? t('作者对这份技能的使用设了限制（例如专有许可、禁止商用或保留所有权利），通常不允许拿到别的服务里使用。除非你确认自己有权这样用，否则不要导入。', 'Its author restricts its use (a proprietary license, no commercial use or all rights reserved, for example), which usually rules out using it in another service. Do not import it unless you know you may.')
          : t('没能确认它用的是宽松的开源许可：它可能没有许可证，可能自带要你自己读的许可文件或版权声明，许可证可能带有附加条件（例如 GPL、CC BY-SA），也可能暂时查不到。导入前请先读一下它的许可条款。', 'It could not be confirmed to be under a permissive open-source license: it may have none, come with license or notice files of its own for you to read, carry conditions of its own (GPL or CC BY-SA, for example), or not be checkable right now. Read its license before importing.')}</p>
        <label className="awwo-library-check"><input type="checkbox" checked={confirmed} onChange={event => onConfirm(event.target.checked)} />
          {t('我已读过它的许可条款，确认有权在本工作区使用这份技能的文字', 'I have read its license and may use this skill’s text in this workspace')}</label>
      </div>}
      <div className="awwo-library-editor-actions">
        <button type="submit" className="awwo-library-primary" disabled={busy || !draftReady(draft) || (!open && !confirmed)}>{busy ? t('导入中…', 'Importing…') : t('导入到本工作区', 'Import to this workspace')}</button>
      </div>
    </form>}
    <p className="awwo-library-help">{t('技能的版权归原作者，按它的许可条款使用。导入后它是本工作区的一份副本，可以编辑；之后 skills.sh 上的更新不会自动同步。',
      'A skill belongs to its author and is used under its license terms. Once imported it is this workspace’s copy, which you can edit; later changes on skills.sh are not synced.')}</p>
    <details className="awwo-registry-text" open={!blocked}>
      <summary>{t('SKILL.md 全文：导入的就是这些文字', 'SKILL.md in full: this is the text that is imported')}</summary>
      <pre className="awwo-library-preview">{preview.markdown}{preview.truncated ? t('\n…（只显示了前 64 KiB）', '\n… (only the first 64 KiB are shown)') : ''}</pre>
    </details>
  </>;
}

function LicenseLines({ preview, t, locale }: { preview: RegistryPreview; t: Translate; locale: Locale }) {
  const { repository: repo, declaredLicense: declared, license } = preview;
  const stars = repo.checked && repo.found ? <span className="awwo-library-badge"><Star size={11} aria-hidden="true" />{locale === 'zh'
    ? (repo.stars >= 1e4 ? `${oneDecimal(repo.stars / 1e4)} 万` : String(repo.stars)) : (repo.stars >= 1e3 ? `${oneDecimal(repo.stars / 1e3)}K` : String(repo.stars))}</span> : null;
  const archived = repo.checked && repo.archived ? <span className="awwo-library-badge">{t('仓库已归档', 'Archived repository')}</span> : null;
  const repository = !repo.checked ? t('来源仓库：暂时无法向 GitHub 查询。', 'Source repository: GitHub could not be asked right now.')
    : !repo.found ? t('来源仓库：GitHub 上找不到（可能已改名或删除）。', 'Source repository: not on GitHub (it may have been renamed or deleted).')
    : repo.license === 'NOASSERTION' ? t('来源仓库：有许可证文件，但 GitHub 识别不出是哪种许可。', 'Source repository: a license file GitHub cannot classify.')
    : repo.license ? t(`来源仓库的许可证：${repo.license}`, `Source repository’s license: ${repo.license}`)
    : t('来源仓库：没有许可证文件。', 'Source repository: no license file.');
  return <>
    {license.status === 'open' && <li className="awwo-registry-audit is-pass"><ShieldCheck size={14} aria-hidden="true" />
      <span>{t(`许可证：${license.spdx}（宽松的开源许可）`, `License: ${license.spdx} (a permissive open-source license)`)}</span></li>}
    {declared && license.status !== 'open' && <li><span>{t(`SKILL.md 声明的许可证：${declared}`, `License declared in SKILL.md: ${declared}`)}</span></li>}
    {license.files.length > 0 && <li><span>{t(`技能自带的许可与声明文件：${license.files.map(file => file.path).join('、')}（全文见下）`,
      `The skill’s own license and notice files: ${license.files.map(file => file.path).join(', ')} (in full below)`)}</span></li>}
    <li><span>{repository}</span>{stars}{archived}</li>
  </>;
}

function AuditLines({ preview, t }: { preview: RegistryPreview; t: Translate }) {
  if (preview.audits === null) return <li>{t('暂时读不到 skills.sh 的安全审计。', 'skills.sh’s security reviews could not be read right now.')}</li>;
  if (preview.audits.length === 0) return <li>{t('skills.sh 还没有发布这个技能的安全审计。', 'skills.sh has published no security review of this skill yet.')}</li>;
  const status = (value: string) => value === 'pass' ? t('通过', 'passed') : value === 'warn' ? t('有提醒', 'warnings') : t('未通过', 'failed');
  // A review that warns or fails says why, in the line itself, not only in a pointer's tooltip.
  return <>{preview.audits.map((audit, index) => <li key={`${index}-${audit.provider}`} className={`awwo-registry-audit is-${audit.status}`} title={audit.summary}>
    {audit.status === 'pass' ? <ShieldCheck size={14} aria-hidden="true" /> : <ShieldAlert size={14} aria-hidden="true" />}
    <span>{t(`安全审计 · ${audit.provider}：${status(audit.status)}`, `Security review · ${audit.provider}: ${status(audit.status)}`)}{audit.riskLevel ? t(`（风险 ${audit.riskLevel}）`, ` (risk ${audit.riskLevel})`) : ''}</span>
    {audit.status !== 'pass' && audit.summary && <small className="awwo-registry-audit-summary">{audit.summary}</small>}
  </li>)}</>;
}
