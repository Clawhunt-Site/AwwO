// One delivered page, running (liveDocument.ts) in an opaque-origin sandbox. Used by the studio and by enlarged cards.
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useCanvasI18n } from '../i18n';
import { buildLiveDocument, LIVE_LINK_MESSAGE, LIVE_PAGE_ALLOW, LIVE_PAGE_SANDBOX, type AssetResolver } from './liveDocument';

export type LiveDevice = 'desktop' | 'tablet' | 'mobile';
export const DEVICE_WIDTH: Record<LiveDevice, number | null> = { desktop: null, tablet: 820, mobile: 390 };

export interface LivePageProps {
  html: string;
  title: string;
  path?: string;
  resolve?: AssetResolver;
  device?: LiveDevice;
  /** Bump to restart the page from scratch. */
  reloadKey?: number;
  /** A link the page asked to follow (its own navigation is stopped). */
  onLink?: (href: string) => void;
  /** The built document, for 「在新标签页打开」. */
  onDocument?: (document: string) => void;
  /** Cards on the board: no focus ring while the board is panned, no tab stop. */
  passive?: boolean;
  className?: string;
}

export function LivePage({ html, title, path, resolve, device = 'desktop', reloadKey = 0, onLink, onDocument, passive = false, className }: LivePageProps) {
  const { t } = useCanvasI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const [built, setBuilt] = useState<{ source: string; document: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const linkRef = useRef(onLink); linkRef.current = onLink;
  const documentRef = useRef(onDocument); documentRef.current = onDocument;
  useEffect(() => {
    let live = true;
    setFailed(false);
    void buildLiveDocument(html, { path, resolve }).then(document => {
      if (!live) return;
      setBuilt({ source: html, document });
      documentRef.current?.(document);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [html, path, resolve]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (data?.type === LIVE_LINK_MESSAGE && typeof data.href === 'string' && /^https?:\/\//i.test(data.href)) linkRef.current?.(data.href);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const width = DEVICE_WIDTH[device];
  const ready = built?.source === html;
  return <div className={`awwo-live-page is-${device}${className ? ` ${className}` : ''}`}>
    <div className="awwo-live-page-viewport" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
      {ready ? <iframe ref={frame} key={reloadKey} className="awwo-live-page-frame" title={t('studio.pageFrame', { title })}
        sandbox={LIVE_PAGE_SANDBOX} allow={LIVE_PAGE_ALLOW} referrerPolicy="no-referrer" srcDoc={built.document}
        {...passive ? { tabIndex: -1 } : {}} />
        : <div className="awwo-live-page-loading" role={failed ? 'alert' : 'status'}>
          {failed ? t('studio.pageFailed') : <><Loader2 size={18} aria-hidden="true" />{t('studio.pageLoading')}</>}
        </div>}
    </div>
  </div>;
}
