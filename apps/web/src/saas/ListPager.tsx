import { useEffect, useState } from 'react';
import { listPage, type ListPage } from './listPage';
import { useSaaSPreferences } from './preferences';

export function usePagedList<T>(path: string) {
  const [position, setPosition] = useState({ path, cursors: [null] as Array<string | null>, revision: 0 });
  const [result, setResult] = useState<{ path: string; cursor: string | null; revision: number; page?: ListPage<T>; error?: unknown }>();
  const cursors = position.path === path ? position.cursors : [null];
  const cursor = cursors[cursors.length - 1];
  const revision = position.revision;
  useEffect(() => {
    const controller = new AbortController();
    listPage<T>(path, cursor, controller.signal).then(page => {
      if (!controller.signal.aborted) setResult({ path, cursor, revision, page });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ path, cursor, revision, error });
    });
    return () => controller.abort();
  }, [path, cursor, revision]);
  const current = result?.path === path && result.cursor === cursor && result.revision === revision ? result : undefined;
  const change = (values: Array<string | null>) => setPosition(value => ({ path, cursors: values, revision: value.revision + 1 }));
  return {
    page: current?.page, error: current?.error, loading: !current,
    pageNumber: cursors.length,
    previous: cursors.length > 1 ? () => change(cursors.slice(0, -1)) : undefined,
    next: current?.page?.nextCursor ? () => change([...cursors, current.page!.nextCursor!]) : undefined,
    refresh: () => change([null]),
  };
}

export function ListPager({ label, page, busy, previous, next, refresh }: {
  label: string; page: number; busy: boolean; previous?: () => void; next?: () => void; refresh: () => void;
}) {
  const { t } = useSaaSPreferences();
  return <nav className="saas-list-pager" aria-label={label}>
    <button disabled={busy || !previous} onClick={previous}>{t('上一页', 'Previous')}</button>
    <span>{t(`第 ${page} 页`, `Page ${page}`)}</span>
    <button disabled={busy || !next} onClick={next}>{t('下一页', 'Next')}</button>
    <button disabled={busy} onClick={refresh}>{t('刷新列表', 'Refresh list')}</button>
  </nav>;
}
