import { useEffect, useMemo, useRef } from 'react';
import { htmlPreviewDocument } from '../../canvas/htmlDeliverable';
import orbit from './generated/orbitResult';
import training from './generated/trainingResult';
import flux from './generated/fluxResult';
import game from './generated/gameResult';
import { OFFICIAL_DEMO_STATE_MESSAGE, officialDemoSource, rememberOfficialDemoState } from './officialDemoState';

const RESULTS: Readonly<Record<string, string>> = { 'interaction-page': orbit, 'model-lab': training, 'grid-balance': flux, 'orbit-game': game };

export default function GeneratedOfficialDemo({ id, title }: { id: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const html = useMemo(() => htmlPreviewDocument(officialDemoSource(id, RESULTS[id]), true), [id]);
  useEffect(() => {
    if (id !== 'interaction-page') return;
    const receive = (event: MessageEvent) => {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (data && data.type === OFFICIAL_DEMO_STATE_MESSAGE && data.id === id) rememberOfficialDemoState(data.state);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [id]);
  return <iframe ref={frame} className="showcase-generated-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} />;
}
