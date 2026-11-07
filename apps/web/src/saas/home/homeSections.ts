// The workspace home's sections (owner 2026-11-07: the cases, the recent canvases and the canvases were one long page
// with nothing sorted). 首页 is the default; the others are named in the address, `?section=canvases|cases|market`, so a
// reload or a link opens the same one, and the browser's back and forward move between them.
import { CASE_PARAM } from '../caseLink';

export type HomeSection = 'overview' | 'canvases' | 'cases' | 'market';
export const HOME_SECTION_PARAM = 'section';

/** A member's sections; a reader, who puts no Agent on a canvas, has no Agent market. */
export const MEMBER_SECTIONS: ReadonlyArray<HomeSection> = ['overview', 'canvases', 'cases', 'market'];
export const READER_SECTIONS: ReadonlyArray<HomeSection> = ['overview', 'canvases', 'cases'];

/** The section an address opens among this person's: a case link (`?case=`) opens 制作案例, where its case opens;
 *  otherwise `?section=`, and 首页 for anything else. */
export function sectionFrom(search: string, sections: ReadonlyArray<HomeSection>): HomeSection {
  const params = new URLSearchParams(search);
  if (params.has(CASE_PARAM) && sections.includes('cases')) return 'cases';
  const named = params.get(HOME_SECTION_PARAM);
  return named && named !== 'overview' && sections.includes(named as HomeSection) ? named as HomeSection : 'overview';
}

/** The address (path, query and hash) with this section in it: 首页 takes the parameter out, and every other parameter
 *  (`tenant`, …) stays as it was. With a case id, the case goes in too, for the case library to take once it shows. */
export function sectionAddress(section: HomeSection, href: string, caseId?: string): string {
  const url = new URL(href);
  if (section === 'overview') url.searchParams.delete(HOME_SECTION_PARAM);
  else url.searchParams.set(HOME_SECTION_PARAM, section);
  if (caseId) url.searchParams.set(CASE_PARAM, caseId);
  return url.pathname + url.search + url.hash;
}
