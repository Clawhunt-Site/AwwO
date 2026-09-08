import { api } from './api';

export type AdminKind = 'tenants' | 'users' | 'runs' | 'audit';
export type AdminRow = Record<string, any>;
export type AdminPage = { items: AdminRow[]; nextCursor: string | null; snapshot?: string };
export function adminPage(kind: AdminKind, cursor: string | null, signal?: AbortSignal, limit = 50) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return api<AdminPage>(`/admin/${kind}?${query}`, { signal });
}

// The server's opaque cursor holds the first page's insertion boundary.
// A failed/cancelled traversal must never download a partial export as complete.
export async function collectAdminExport(kind: AdminKind, signal: AbortSignal, onProgress: (count: number) => void) {
  const items: AdminRow[] = [];
  const seen = new Set<string>();
  let snapshot: string | undefined;
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const page = await adminPage(kind, cursor, signal, 200);
    signal.throwIfAborted();
    if (snapshot && page.snapshot !== snapshot) throw new Error('Pagination snapshot changed');
    snapshot = page.snapshot;
    items.push(...page.items);
    onProgress(items.length);
    cursor = page.nextCursor;
    if (cursor) {
      if (seen.has(cursor)) throw new Error('Pagination did not advance');
      seen.add(cursor);
    }
  } while (cursor);
  return { resource: kind, insertionBoundary: snapshot, exportedAt: new Date().toISOString(), count: items.length, items };
}

export function downloadJSON(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
