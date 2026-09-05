export const KNOWN_STUDIO_PAGE_IDS = [
  'dreamy-miniapp',
  'myshell-art',
  'explore',
  'ai-picks',
  'bot-detail',
  'upload',
  'tag-generator',
  'library',
  'library-detail',
  'energy-store',
  'energy-history',
  'earn',
  'share-invite',
  'settings',
  'profile',
  'checkin',
] as const;

export type KnownStudioApi = (typeof KNOWN_STUDIO_PAGE_IDS)[number];
export type StudioApi = KnownStudioApi | (string & {});
export interface StudioDispatchLinkTarget {
  navigationPath?: string;
}

export function getStudioDispatchTargetHref(target: StudioDispatchLinkTarget): string {
  const path = (target.navigationPath || '').trim();
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith('/') ? path : `/${path}`;
}

export function toggleStudioDispatchPageSelection(
  selectedPageIds: readonly string[],
  pageId: StudioApi | string,
  force?: boolean,
): string[] {
  const id = String(pageId || '').trim();
  const current = selectedPageIds.filter((item) => item.trim());
  if (!id) return [...current];
  const selected = new Set(current);
  const shouldSelect = force ?? !selected.has(id);
  if (shouldSelect) {
    selected.add(id);
    return current.includes(id) ? [...current] : [...current, id];
  }
  selected.delete(id);
  return current.filter((item) => selected.has(item));
}

export function getStudioDispatchSelectionPageIds(
  entries: readonly { pageId: StudioApi | string }[],
  selectedPageIds: readonly string[],
): string[] {
  const selected = new Set(selectedPageIds.map((pageId) => pageId.trim()).filter(Boolean));
  if (!selected.size) return [];
  return entries.map((entry) => String(entry.pageId)).filter((pageId) => selected.has(pageId));
}
