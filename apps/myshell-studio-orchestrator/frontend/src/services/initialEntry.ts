import {
  MINIAPP_PAGE_DEEP_LINKS,
  resolveMiniappPageDeepLink,
  resolveStartParamDeepLink,
} from './deepLinks';

export interface InitialEntryInput {
  pathname?: string;
  search?: string;
  telegramStartParam?: string;
}

const DIRECT_EXACT_ROUTES = new Set<string>([
  ...Object.values(MINIAPP_PAGE_DEEP_LINKS).map((entry) => entry.route).filter((route) => !route.includes(':')),
  '/__test-customize-scene',
]);

function normalizeSearch(search: string | undefined): string {
  const trimmed = (search || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('?') ? trimmed : `?${trimmed}`;
}

function normalizePathname(pathname: string | undefined): string {
  const trimmed = (pathname || '').trim();
  if (!trimmed) return '/';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith('/')) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function withSearch(pathname: string, search: string): string {
  return `${pathname}${normalizeSearch(search)}`;
}

function isLibraryDetailPath(pathname: string): boolean {
  return /^\/library\/[^/?#]+$/.test(pathname);
}

export function resolveSpaPathEntry(input: InitialEntryInput): string {
  const pathname = normalizePathname(input.pathname);
  if (pathname === '/') return '';
  if (pathname === '/canvaspro') {
    const search = normalizeSearch(input.search);
    return `/dreamy?workspace=canvaspro${search ? `&${search.slice(1)}` : ''}`;
  }
  if (DIRECT_EXACT_ROUTES.has(pathname) || isLibraryDetailPath(pathname)) {
    return withSearch(pathname, input.search || '');
  }
  return '';
}

export function resolveInitialEntry(input: InitialEntryInput): string {
  const search = normalizeSearch(input.search);

  try {
    const params = new URLSearchParams(search);
    const testRoute = params.get('test_route');
    if (testRoute === 'customize-scene') {
      const state = params.get('state') || 'free-default';
      return `/__test-customize-scene?state=${encodeURIComponent(state)}`;
    }
    if (testRoute === 'tag-generator') {
      const img = params.get('img') || 'https://placehold.co/400x600/1a1a1a/ff195e?text=Photo';
      const slug = params.get('slug_id') || 'ai-porn-generator';
      return `/tag-generator?slug_id=${encodeURIComponent(slug)}&img=${encodeURIComponent(img)}`;
    }
    if (testRoute === 'dreamy') return '/dreamy';

    const pageLink = resolveMiniappPageDeepLink(params);
    if (pageLink) return pageLink;
  } catch {
    /* fallback to path/start parsing */
  }

  const spaPathEntry = resolveSpaPathEntry({ pathname: input.pathname, search });
  if (spaPathEntry) return spaPathEntry;

  try {
    const params = new URLSearchParams(search);
    const startParam = input.telegramStartParam || params.get('startapp') || params.get('tgWebAppStartParam');
    const startLink = resolveStartParamDeepLink(startParam);
    if (startLink) return startLink;

    const slugId = params.get('slug_id');
    if (slugId) return `/upload?slug_id=${encodeURIComponent(slugId)}`;
  } catch {
    /* fallback to root */
  }

  return '/';
}
