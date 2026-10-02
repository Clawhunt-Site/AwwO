import { useMemo } from 'react';
import { htmlPreviewDocument } from '../../canvas/htmlDeliverable';
import orbit from './generated/orbitResult';
import training from './generated/trainingResult';
import flux from './generated/fluxResult';
import game from './generated/gameResult';

const RESULTS: Readonly<Record<string, string>> = { 'interaction-page': orbit, 'model-lab': training, 'grid-balance': flux, 'orbit-game': game };

export default function GeneratedOfficialDemo({ id, title }: { id: string; title: string }) {
  const html = useMemo(() => htmlPreviewDocument(RESULTS[id], true), [id]);
  return <iframe className="showcase-generated-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} />;
}
