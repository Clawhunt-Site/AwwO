import { api } from './api';

export type ListPage<T> = { items: T[]; nextCursor?: string | null; snapshot?: string };

/** Fetch one bounded page. Filters stay on the URL for every cursor request. */
export function listPage<T>(path: string, cursor?: string | null, signal?: AbortSignal, limit = 50): Promise<ListPage<T>> {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor); else params.delete('cursor');
  return api<ListPage<T>>(`${pathname}?${params}`, { signal });
}
