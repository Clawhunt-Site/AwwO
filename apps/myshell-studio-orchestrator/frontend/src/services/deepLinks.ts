export const MINIAPP_PAGE_DEEP_LINKS = {
  explore: { route: '/explore' },
  'ai-picks': { route: '/ai-picks' },
  'bot-detail': { route: '/bot' },
  upload: { route: '/upload' },
  'tag-generator': { route: '/tag-generator' },
  library: { route: '/library' },
  'library-detail': { route: '/library/:id' },
  'energy-store': { route: '/energy' },
  'energy-history': { route: '/energy-history' },
  earn: { route: '/earn' },
  'share-invite': { route: '/share-invite' },
  settings: { route: '/settings' },
  profile: { route: '/profile' },
  checkin: { route: '/checkin-demo' },
  dreamy: { route: '/dreamy' },
} as const;

const PAGE_ALIASES: Record<string, keyof typeof MINIAPP_PAGE_DEEP_LINKS | 'self-director'> = {
  home: 'explore',
  index: 'explore',
  energy: 'energy-store',
  store: 'energy-store',
  'energy-history': 'energy-history',
  invite: 'share-invite',
  'checkin-demo': 'checkin',
  'check-in': 'checkin',
  'self-director': 'self-director',
};

const DEFAULT_BOT_SLUG = 'ai-porn-generator';
const DEFAULT_LIBRARY_DETAIL_ID = 'studio-preview';

function firstParam(params: URLSearchParams, keys: string[]): string {
  for (const key of keys) {
    const value = params.get(key);
    if (value) return value;
  }
  return '';
}

function withQuery(route: string, values: Record<string, string>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const text = query.toString();
  return text ? `${route}?${text}` : route;
}

export function normalizeMiniappPageKey(page: string | null): keyof typeof MINIAPP_PAGE_DEEP_LINKS | 'self-director' | '' {
  const normalized = (page || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized in MINIAPP_PAGE_DEEP_LINKS) {
    return normalized as keyof typeof MINIAPP_PAGE_DEEP_LINKS;
  }
  return PAGE_ALIASES[normalized] || '';
}

export function resolveMiniappPageDeepLink(params: URLSearchParams): string | null {
  const page = normalizeMiniappPageKey(params.get('page'));
  if (!page) return null;
  if (page === 'self-director') return '/upload?mode=tag-generator';

  if (page === 'bot-detail') {
    const slug = firstParam(params, ['slug_id', 'slug', 'bot', 'bot_slug']) || DEFAULT_BOT_SLUG;
    return withQuery(MINIAPP_PAGE_DEEP_LINKS[page].route, { slug_id: slug });
  }

  if (page === 'upload') {
    const slug = firstParam(params, ['slug_id', 'slug', 'bot', 'bot_slug']);
    return withQuery(MINIAPP_PAGE_DEEP_LINKS[page].route, { slug_id: slug });
  }

  if (page === 'tag-generator') {
    const slug = firstParam(params, ['slug_id', 'slug', 'bot', 'bot_slug']) || DEFAULT_BOT_SLUG;
    const img = firstParam(params, ['img', 'image', 'image_url']);
    return withQuery(MINIAPP_PAGE_DEEP_LINKS[page].route, { slug_id: slug, img });
  }

  if (page === 'library-detail') {
    const id = firstParam(params, ['id', 'task_id', 'taskId', 'media_id']) || DEFAULT_LIBRARY_DETAIL_ID;
    return `/library/${encodeURIComponent(id)}`;
  }

  return MINIAPP_PAGE_DEEP_LINKS[page].route;
}

function normalizeStartParamQuery(value: string): URLSearchParams | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutQuestion = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
  const decoded = (() => {
    try {
      return decodeURIComponent(withoutQuestion);
    } catch {
      return withoutQuestion;
    }
  })();
  if (!/[=&]/.test(decoded)) return null;
  const params = new URLSearchParams(decoded);
  return [...params.keys()].length ? params : null;
}

function resolveQueryStartParamDeepLink(params: URLSearchParams): string | null {
  const pageLink = resolveMiniappPageDeepLink(params);
  if (pageLink) return pageLink;

  const taskId = firstParam(params, ['id', 'task_id', 'taskId', 'media_id']);
  if (taskId) return `/library/${encodeURIComponent(taskId)}`;

  const slug = firstParam(params, ['slug_id', 'slug', 'bot', 'bot_slug']);
  if (slug) return withQuery(MINIAPP_PAGE_DEEP_LINKS['bot-detail'].route, { slug_id: slug });

  return null;
}

function resolvePageKeyDeepLink(page: keyof typeof MINIAPP_PAGE_DEEP_LINKS | 'self-director'): string | null {
  if (page === 'self-director') return '/upload?mode=tag-generator';
  if (page === 'bot-detail') {
    return withQuery(MINIAPP_PAGE_DEEP_LINKS[page].route, { slug_id: DEFAULT_BOT_SLUG });
  }
  if (page === 'upload') {
    return withQuery(MINIAPP_PAGE_DEEP_LINKS[page].route, { slug_id: DEFAULT_BOT_SLUG });
  }
  if (page === 'tag-generator') {
    return withQuery(MINIAPP_PAGE_DEEP_LINKS[page].route, { slug_id: DEFAULT_BOT_SLUG });
  }
  if (page === 'library-detail') {
    return `/library/${encodeURIComponent(DEFAULT_LIBRARY_DETAIL_ID)}`;
  }
  return MINIAPP_PAGE_DEEP_LINKS[page].route;
}

export function resolveStartParamDeepLink(startParam: string | null | undefined): string | null {
  const value = (startParam || '').trim();
  if (!value) return null;

  const queryParams = normalizeStartParamQuery(value);
  if (queryParams) {
    const pageLink = resolveQueryStartParamDeepLink(queryParams);
    if (pageLink) return pageLink;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'earn') return MINIAPP_PAGE_DEEP_LINKS['share-invite'].route;
  if (normalized === 'buy') return `${MINIAPP_PAGE_DEEP_LINKS['energy-store'].route}?oos=1`;
  if (normalized.startsWith('share_')) return MINIAPP_PAGE_DEEP_LINKS.library.route;

  const page = normalizeMiniappPageKey(normalized);
  if (page) return resolvePageKeyDeepLink(page);

  return `/bot?slug_id=${encodeURIComponent(value)}`;
}
