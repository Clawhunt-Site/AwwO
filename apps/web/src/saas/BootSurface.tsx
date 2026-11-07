// The AwwO boot surface, the same one saas.html paints before the bundle runs: while a page is still getting its
// content (the session, a canvas), it stays exactly as the browser first drew it, so the page grows out of it rather
// than flashing between a blank screen, a line of text and the page. In its middle, the boot head: a converged canvas's
// icon at work (ConvergedIcon: the flat head, the collar, the working eyes), with one arc going round the collar and the
// eyes following it and blinking. saas.html's inline style draws and moves it, before any script runs.
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { AVATAR_CRESCENT, AVATAR_FACES } from '../canvas/avatarFace';

/** The arc going round: a quarter of the collar (r 52 in the ring's -60…60 box), centred on 12 o'clock. */
export const BOOT_ARC = 'M -36.77 -36.77 A 52 52 0 0 1 36.77 -36.77';
const BOOT_LOOP = /^awwo-boot-/;
const MOTION = '(prefers-reduced-motion: no-preference)';

/** Starts each of the boot head's loops at the page's time zero, as saas.html's script does for its own: a boot head
 *  that takes another's place (saas.html's, or the app's for another load) carries on in the same phase, with no jump.
 *  BootHead runs it again when the reader turns motion on, which makes the loops anew at that moment. */
export function lockBootPhase(root: Element | null): void {
  if (!root || typeof root.getAnimations !== 'function') return;
  // A decoration: where a browser refuses (a polyfill, an animation on another timeline), the loops go on as they are.
  let animations: Animation[];
  try { animations = root.getAnimations({ subtree: true }); } catch { return; }
  for (const animation of animations) {
    try {
      if (BOOT_LOOP.test((animation as Partial<CSSAnimation>).animationName ?? '')) animation.startTime = 0;
    } catch { /* this loop keeps its own phase */ }
  }
}

/** The boot head, exactly as saas.html draws it (tests/saas-boot-head.test.tsx keeps the two the same). */
export function BootHead() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const lock = () => lockBootPhase(ref.current);
    lock();
    const query = typeof window !== 'undefined' ? window.matchMedia?.(MOTION) : undefined;
    query?.addEventListener?.('change', lock);
    return () => query?.removeEventListener?.('change', lock);
  }, []);
  return <div ref={ref} className="awwo-boot-head" aria-hidden="true">
    <span className="awwo-boot-plate" />
    <svg className="awwo-boot-ring" viewBox="-60 -60 120 120"><circle className="awwo-boot-collar" r="52" /></svg>
    <svg className="awwo-boot-orbit" viewBox="-60 -60 120 120"><path className="awwo-boot-arc" d={BOOT_ARC} /></svg>
    <span className="awwo-boot-face">
      <svg className="awwo-boot-crescent" viewBox="0 0 100 100"><path d={AVATAR_CRESCENT} /></svg>
      <span className="awwo-boot-rim" />
      <span className="awwo-boot-gaze"><span className="awwo-boot-blink"><svg viewBox="0 0 100 100">
        {AVATAR_FACES.working.map((eye, index) => eye.shape === 'capsule'
          ? <rect key={index} x={eye.cx - eye.w / 2} y={eye.cy - eye.h / 2} width={eye.w} height={eye.h} rx={Math.min(eye.w, eye.h) / 2} />
          : null)}
      </svg></span></span>
    </span>
  </div>;
}

export function BootSurface({ text, canvas = false, children }: { text?: string; canvas?: boolean; children?: ReactNode }) {
  return <div className={`awwo-boot${canvas ? ' is-canvas' : ''}`} role="status" aria-busy="true">
    <div className="awwo-boot-frame" aria-hidden="true"><i /><i /><i /></div>
    <div className="awwo-boot-center">
      <BootHead />
      {/* Always there, empty while there is nothing to say, as in saas.html: the head stays where the page drew it. */}
      <p className="awwo-boot-text">{text}</p>
    </div>
    {children}
  </div>;
}
