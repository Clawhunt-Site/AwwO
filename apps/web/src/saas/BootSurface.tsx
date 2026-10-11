// The AwwO boot surface, the same one saas.html paints before the bundle runs: while a page is still getting its
// content (the session, a canvas), it stays exactly as the browser first drew it, so the page grows out of it rather
// than flashing between a blank screen, a line of text and the page.
import type { ReactNode } from 'react';

export function BootSurface({ text, canvas = false, children }: { text?: string; canvas?: boolean; children?: ReactNode }) {
  return <div className={`awwo-boot${canvas ? ' is-canvas' : ''}`} role="status" aria-busy="true">
    <div className="awwo-boot-frame" aria-hidden="true"><i /><i /><i /></div>
    <div className="awwo-boot-center">
      <div className="awwo-boot-orb" aria-hidden="true" />
      <div className="awwo-boot-line" aria-hidden="true" />
      {text ? <p className="awwo-boot-text">{text}</p> : null}
    </div>
    {children}
  </div>;
}
