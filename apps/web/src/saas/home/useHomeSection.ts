import { useCallback, useEffect, useRef, useState } from 'react';
import { CASE_PARAM, registerCaseOpener } from '../caseLink';
import { PRODUCTION_CASES } from '../productionCatalog';
import { sectionAddress, sectionFrom, type HomeSection } from './homeSections';

/** The section the page opens on. A case link's 制作案例 goes into the address at once (the case library takes the case's
 *  own part out once it shows it), so a reload after the case closes stays there. Writing the same address twice, as a
 *  strict render may, changes nothing. */
function initialSection(sections: ReadonlyArray<HomeSection>): HomeSection {
  const section = sectionFrom(window.location.search, sections);
  if (section === 'cases' && new URLSearchParams(window.location.search).has(CASE_PARAM)) {
    history.replaceState(history.state, '', sectionAddress('cases', window.location.href));
  }
  return section;
}

/** The home section shown, and `go` to show another: each move to another section is a history entry (the browser's back
 *  and forward walk them) that keeps the address's other parameters, and every move, the current section's too, counts
 *  in `moves`, which the frame follows to bring the page to the top and the focus to the section's heading. On every
 *  section but 制作案例, a case opened from elsewhere (the Academy's "Open the case") moves there with its id in the
 *  address, where the case library takes it and opens the case, so a case opens from any section. */
export function useHomeSection(sections: ReadonlyArray<HomeSection>) {
  const [section, setSection] = useState(() => initialSection(sections));
  const [moves, setMoves] = useState(0);
  const current = useRef(section);
  current.current = section;
  useEffect(() => {
    const walked = () => { setSection(sectionFrom(window.location.search, sections)); setMoves(value => value + 1); };
    window.addEventListener('popstate', walked);
    return () => window.removeEventListener('popstate', walked);
  }, [sections]);
  const go = useCallback((next: HomeSection, caseId?: string) => {
    if (next !== current.current || caseId) history.pushState(history.state, '', sectionAddress(next, window.location.href, caseId));
    setSection(next);
    setMoves(value => value + 1);
  }, []);
  useEffect(() => {
    if (section === 'cases' || !sections.includes('cases')) return undefined;
    return registerCaseOpener(id => {
      if (!PRODUCTION_CASES.some(item => item.id === id)) return false;
      go('cases', id);
      return true;
    });
  }, [section, sections, go]);
  return { section, go, moves };
}
