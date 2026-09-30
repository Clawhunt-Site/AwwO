import { useId, useState } from 'react';
import { CanvasThumbnail } from './CanvasThumbnail';
import { useSaaSPreferences } from './preferences';
import { CASE_CATEGORIES, STARTER_CASES, type CaseCategory, type StarterCase } from './starterCases';

/** Example requests grouped by kind of work. Picking one hands it to the prompt box; it never
 * creates a canvas or starts planning by itself. */
export function CaseGallery({ onPick, disabled = false }: { onPick: (item: StarterCase) => void; disabled?: boolean }) {
  const { locale, t } = useSaaSPreferences();
  const [category, setCategory] = useState<CaseCategory | 'all'>('all');
  const titleId = useId();
  const cardId = useId();
  const cases = category === 'all' ? STARTER_CASES : STARTER_CASES.filter(item => item.category === category);
  const categoryLabel = (id: CaseCategory) => CASE_CATEGORIES.find(item => item.id === id)?.label[locale] ?? '';
  return <section className="saas-home-section saas-home-cases" aria-labelledby={titleId}>
    <div className="saas-home-section-header">
      <div className="saas-home-section-title">
        <h2 id={titleId}>{t('从案例开始', 'Start from an example')}</h2>
        <p>{t('选一个案例填入输入框，按你的情况修改后再生成。', 'Pick an example to fill the prompt box, adapt it to your situation, then generate.')}</p>
      </div>
    </div>
    <div className="saas-case-chips" role="group" aria-label={t('案例分类', 'Example categories')}>
      <button type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>{t('全部', 'All')}</button>
      {CASE_CATEGORIES.map(item => <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label[locale]}</button>)}
    </div>
    <ul className="saas-case-grid">
      {cases.map(item => {
        const summaryId = `${cardId}-${item.id}`;
        return <li key={item.id} className="saas-case-card">
          <button type="button" className="saas-case-pick" aria-describedby={summaryId} disabled={disabled} onClick={() => onPick(item)}>
            <CanvasThumbnail document={item.sketch} />
            <span className="saas-case-title">{item.title[locale]}</span>
          </button>
          <span className="saas-case-category">{categoryLabel(item.category)}</span>
          <p id={summaryId} className="saas-case-summary">{item.summary[locale]}</p>
        </li>;
      })}
    </ul>
  </section>;
}
