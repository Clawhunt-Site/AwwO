// Skills attached to one node (skills.go on the server): method guidance from the built-in library or the workspace's
// own, frozen into each run with the node's instructions. Shown only on a cloud canvas, where the library exists.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, Sparkles, X } from 'lucide-react';
import { useCanvasI18n, type CanvasTextKey } from './i18n';
import { MAX_NODE_SKILLS } from './canvasDoc';
import { currentSaaSCanvas } from '../saas/canvasBridge';
import { cachedSkillCatalog, skillDescription, skillTitle, type SkillCatalog, type SkillSummary } from '../saas/skillsApi';
import './node-skills.css';

interface Props { value: readonly string[] | undefined; disabled?: boolean; onChange: (skills: string[]) => void }

const CATEGORY_KEYS: Record<string, CanvasTextKey> = {
  video: 'skills.category.video', design: 'skills.category.design', research: 'skills.category.research', writing: 'skills.category.writing',
  engineering: 'skills.category.engineering', business: 'skills.category.business', data: 'skills.category.data',
};
/** The server's limit on the skill text one call carries (skills.go maxNodeSkillBytes), when the catalog has none. */
const DEFAULT_NODE_SKILL_BYTES = 20 << 10;

export function NodeSkillsEditor({ value, disabled = false, onChange }: Props) {
  const { t, locale } = useCanvasI18n();
  const tenantId = currentSaaSCanvas()?.tenant.id ?? null;
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!tenantId) return;
    let live = true;
    setFailed(false);
    cachedSkillCatalog(tenantId).then(result => { if (live) setCatalog(result); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [tenantId, attempt]);
  // The picker takes the focus when it opens and gives it back to its button when it closes (or to the section, when
  // the node is full and the button is disabled).
  useEffect(() => {
    if (open) searchRef.current?.focus();
    else if (wasOpen.current) (addRef.current && !addRef.current.disabled ? addRef.current : sectionRef.current)?.focus();
    wasOpen.current = open;
  }, [open]);
  const refs = value ?? [];
  // Two clicks before the parent re-renders must both count, so each change starts from the last list sent.
  const latest = useRef<readonly string[]>(refs);
  latest.current = refs;
  const max = catalog?.limits.maxNodeSkills ?? MAX_NODE_SKILLS;
  const maxBytes = catalog?.limits.maxNodeSkillBytes ?? DEFAULT_NODE_SKILL_BYTES;
  const byRef = useMemo(() => new Map((catalog?.items ?? []).map(item => [item.ref, item])), [catalog]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.items ?? []).filter(item => !needle || [item.name, item.title, item.titleZh ?? '', item.description, item.descriptionZh ?? '']
      .some(text => text.toLowerCase().includes(needle)));
  }, [catalog, query]);
  if (!tenantId) return null;
  const bytesOf = (list: readonly string[]) => list.reduce((sum, ref) => sum + (byRef.get(ref)?.bytes ?? 0), 0);
  const usedBytes = bytesOf(refs);
  // A skill fits when the node has room for one more and the texts together still fit in one call.
  const fits = (list: readonly string[], item: SkillSummary | undefined) => list.length < max && bytesOf(list) + (item?.bytes ?? 0) <= maxBytes;
  const toggle = (ref: string) => {
    const current = latest.current;
    const next = current.includes(ref) ? current.filter(entry => entry !== ref) : fits(current, byRef.get(ref)) ? [...current, ref] : null;
    if (!next) return;
    latest.current = next;
    onChange(next);
  };
  const label = (skill: SkillSummary | undefined, ref: string) => skill ? skillTitle(skill, locale) : ref;
  const groups: { title: string; items: SkillSummary[] }[] = [
    { title: t('skills.builtin'), items: visible.filter(item => item.source === 'builtin') },
    { title: t('skills.workspace'), items: visible.filter(item => item.source === 'workspace') },
  ].filter(group => group.items.length > 0);
  const kb = (bytes: number) => (bytes / 1024).toFixed(1);

  return <section ref={sectionRef} tabIndex={-1} className="awwo-node-skills" aria-label={t('skills.title')}>
    <div className="canvas-inspector-label">{t('skills.title')}</div>
    <div className="canvas-inspector-hint">{t('skills.hint', { max })}</div>
    {refs.length > 0 && <ul className="awwo-node-skills-chips">
      {refs.map(ref => {
        const skill = byRef.get(ref);
        const missing = Boolean(catalog) && !skill;
        return <li key={ref} className={missing ? 'is-missing' : undefined} title={missing ? t('skills.missing', { ref }) : skill ? skillDescription(skill, locale) : undefined}>
          <Sparkles size={13} aria-hidden="true" /><span>{label(skill, ref)}</span>
          <button type="button" disabled={disabled} aria-label={t('skills.remove', { name: label(skill, ref) })} onClick={() => toggle(ref)}><X size={12} aria-hidden="true" /></button>
        </li>;
      })}
    </ul>}
    {refs.some(ref => catalog && !byRef.has(ref)) && <p className="awwo-node-skills-warning" role="alert">{t('skills.missing', { ref: refs.filter(ref => !byRef.has(ref)).join(', ') })}</p>}
    {catalog && usedBytes > maxBytes && <p className="awwo-node-skills-warning" role="alert">{t('skills.overBudget', { used: kb(usedBytes), max: kb(maxBytes) })}</p>}
    {failed ? <p className="awwo-node-skills-warning" role="alert">{t('skills.loadFailed')} <button type="button" className="canvas-inspector-link" onClick={() => setAttempt(count => count + 1)}>{t('skills.retry')}</button></p>
      : !catalog ? <p className="canvas-inspector-hint" role="status">{t('skills.loading')}</p>
      : !open ? <button ref={addRef} type="button" className="awwo-node-skills-add" disabled={disabled || refs.length >= max} title={refs.length >= max ? t('skills.limit', { max }) : undefined} onClick={() => setOpen(true)}><Plus size={14} aria-hidden="true" />{t('skills.add')}</button>
      : <div className="awwo-node-skills-picker" role="group" aria-label={t('skills.pickerTitle')}>
        <label className="awwo-node-skills-search"><Search size={14} aria-hidden="true" />
          <input ref={searchRef} type="search" value={query} placeholder={t('skills.search')} aria-label={t('skills.search')} onChange={event => setQuery(event.target.value)} />
        </label>
        {groups.length === 0 && <p className="canvas-inspector-hint">{t('skills.empty')}</p>}
        {groups.map(group => <div key={group.title} className="awwo-node-skills-group">
          <h4>{group.title}</h4>
          <ul>{group.items.map(item => {
            const attached = refs.includes(item.ref);
            const room = attached || fits(refs, item);
            const tooLarge = !room && refs.length < max;
            return <li key={item.ref} className={attached ? 'is-attached' : undefined}>
              <div className="awwo-node-skills-item-text">
                <strong>{skillTitle(item, locale)}</strong>
                <span className="awwo-node-skills-category">{CATEGORY_KEYS[item.category] ? t(CATEGORY_KEYS[item.category]) : item.category} · {kb(item.bytes)} KB</span>
                <p>{skillDescription(item, locale)}</p>
              </div>
              <button type="button" disabled={disabled || !room} aria-pressed={attached}
                title={tooLarge ? t('skills.tooLarge', { max: kb(maxBytes) }) : undefined} onClick={() => toggle(item.ref)}>
                {attached ? t('skills.attached') : t('skills.attach')}
              </button>
            </li>;
          })}</ul>
        </div>)}
        {refs.length >= max && <p className="canvas-inspector-hint">{t('skills.limit', { max })}</p>}
        <button type="button" className="awwo-node-skills-done" onClick={() => { setOpen(false); setQuery(''); }}>{t('skills.done')}</button>
      </div>}
  </section>;
}
