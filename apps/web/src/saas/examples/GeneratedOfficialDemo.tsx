import { useEffect, useState } from 'react';
import { useSaaSPreferences } from '../preferences';
import { showcaseDocument } from './showcaseDocument';

// One lazy chunk per example, written by .local/official-cases/publish.ts from its real run: the page exactly as its node
// delivered it (`<id>.ts`, whose SHA-256 is the record's sourceSHA256) and the generated files it names (`<id>.media.ts`).
const PAGES = import.meta.glob<string>(['./generated/official/*.ts', '!./generated/official/*.media.ts'], { import: 'default' });
const MEDIA = import.meta.glob<Readonly<Record<string, string>>>('./generated/official/*.media.ts', { import: 'default' });

/** Is there a published page for this example? */
export function hasGeneratedPage(id: string): boolean {
  return `./generated/official/${id}.ts` in PAGES;
}

type Shown = { id: string; html: string } | { id: string; failed: true } | null;

export default function GeneratedOfficialDemo({ id, title }: { id: string; title: string }) {
  const { t } = useSaaSPreferences();
  const [shown, setShown] = useState<Shown>(null);
  useEffect(() => {
    let live = true;
    const page = PAGES[`./generated/official/${id}.ts`];
    const media = MEDIA[`./generated/official/${id}.media.ts`];
    if (!page) {
      setShown({ id, failed: true });
      return;
    }
    Promise.all([page(), media ? media() : Promise.resolve({})])
      .then(([html, files]) => { if (live) setShown({ id, html: showcaseDocument(html, files) }); })
      .catch(() => { if (live) setShown({ id, failed: true }); });
    return () => { live = false; };
  }, [id]);
  if (!shown || shown.id !== id) return <p className="official-loading" role="status">{t('正在载入作品…', 'Loading demo…')}</p>;
  if ('failed' in shown) return <p className="official-loading" role="alert">{t('作品没有载入，请刷新重试。', 'The demo did not load. Refresh to retry.')}</p>;
  // allow-forms lets a page's own submit handler run; the preview's policy (form-action 'none') still stops any submission
  // from leaving the frame. clipboard-write lets its copy buttons work. Still an opaque origin: no AwwO account or storage.
  return <iframe className="showcase-generated-frame" title={title} sandbox="allow-scripts allow-forms" allow="clipboard-write" referrerPolicy="no-referrer" srcDoc={shown.html} />;
}
