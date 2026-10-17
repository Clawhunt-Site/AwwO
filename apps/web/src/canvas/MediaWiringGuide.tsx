// How to wire an image, video or 3D node, shown in the node until it has generated: what each of its ports takes, in
// one sentence that fits an opened card (each port's guide, TilePorts → mediaPortGuide, says the rest on hover). The
// ports are the facts `portsFor` holds: `context` (text, any number of wires) on every media node, `reference` (one
// picture) on image and 3D nodes, `result` out. Simple mode hides the ports, so there it says how to wire without
// them instead: ask the canvas assistant, whose plans can connect nodes, or switch to Developer mode.

import { useCanvasI18n } from './i18n';
import type { MediaKind } from './mediaCatalog';

export interface MediaWiringGuideProps {
  kind: MediaKind;
  /** Simple mode: the ports are hidden, so the guide does not point at them. */
  simple: boolean;
}

export function MediaWiringGuide({ kind, simple }: MediaWiringGuideProps) {
  const { t, locale } = useCanvasI18n();
  const title = t('media.wireTitle');
  return (
    <section className="awwo-media-wiring" aria-label={title}>
      <p><span className="awwo-media-wiring-title">{title}{locale === 'en' ? ': ' : '：'}</span>
        {t(simple ? 'media.wireSimple' : kind === 'video' || kind === 'audio' ? 'media.wireDeveloperVideo' : 'media.wireDeveloper')}</p>
    </section>
  );
}
