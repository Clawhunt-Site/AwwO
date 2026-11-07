import { useEffect, useRef } from 'react';
import { Clapperboard, House, LayoutGrid, Store, type LucideIcon } from 'lucide-react';
import { AcademyLauncher } from '../Academy';
import { useSaaSPreferences } from '../preferences';
import type { HomeSection } from './homeSections';

const ITEMS: Record<HomeSection, { icon: LucideIcon; name: readonly [string, string] }> = {
  overview: { icon: House, name: ['首页', 'Home'] },
  canvases: { icon: LayoutGrid, name: ['我的画布', 'My canvases'] },
  cases: { icon: Clapperboard, name: ['制作案例', 'Production cases'] },
  market: { icon: Store, name: ['Agent 市场', 'Agent market'] },
};

/** The home's left rail of sections. Its items are buttons, not links: the page's navigation feedback takes a same-site
 *  link for a page load, and a section is shown in place. The Academy is the last item, opened as the top bar's button
 *  opens it (it is a dialog, not a section). On a phone the rail is one scrolling row: the open section's button is
 *  brought to its middle by scrolling the row alone, never the page (a reload keeps where the browser left the page). */
export function HomeNav({ sections, section, onSection }: { sections: ReadonlyArray<HomeSection>; section: HomeSection; onSection: (section: HomeSection) => void }) {
  const { t } = useSaaSPreferences();
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = nav.current?.querySelector<HTMLElement>('ul');
    const open = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !open || row.scrollWidth <= row.clientWidth) return;
    const box = row.getBoundingClientRect(), item = open.getBoundingClientRect();
    row.scrollLeft += item.left - box.left - (box.width - item.width) / 2;
  }, [section]);
  return <nav ref={nav} className="saas-home-nav" aria-label={t('首页分区', 'Home sections')}>
    <ul>
      {sections.map(id => {
        const { icon: Icon, name } = ITEMS[id];
        return <li key={id}><button type="button" className="saas-home-nav-item" aria-current={id === section ? 'page' : undefined} onClick={() => onSection(id)}>
          <Icon size={17} aria-hidden="true" /><span>{t(...name)}</span></button></li>;
      })}
      <li className="saas-home-nav-academy"><AcademyLauncher variant="menu" /></li>
    </ul>
  </nav>;
}
