// How 多人同屏's live lane moves (MOTION.md): a card carried by someone else's drag, the end of a wire they draw, and
// the camera of a person following someone glide (no overshoot) on the language's glide spring. Each starts from where
// it is with the speed it has, so a new place heard eight times a second bends its path instead of starting it again.
// Reduced motion moves nothing: a card is where it is put at once, and a followed screen is cut to once it rests.

/** Every number the lane's motion depends on, each with the token it comes from. */
export const TUNE = {
  // spring.glide (apps/motion-tokens.json): "cameras and large containers, no overshoot"; zeta 1, within 2 % in 0.6 s.
  glide: { stiffness: 95, damping: 19.5 },
  // Under reduced motion a followed screen is cut to once it has rested this long. Not a token: a quiet that must outlast
  // the 125 ms between a page's presence posts (canvasLive.ts PRESENCE_EVERY_MS) and their jitter, so a screen still
  // moving is never cut to mid-pan (a decision, 2026-11-09).
  restMs: 200,
};

/** The longest step a frame takes (a tab that slept wakes without a leap), and the steps it is cut into. */
const MAX_STEP_S = 0.1;
const SUBSTEP_S = 1 / 120;

/** One spring-driven value: where it is and how fast it moves. */
export interface Glide { at: number; speed: number }

/** Moves a glide `dt` seconds toward `to` on the glide spring (semi-implicit Euler, in small steps). */
export function glideToward(value: Glide, to: number, dt: number): Glide {
  let { at, speed } = value;
  let left = Math.min(MAX_STEP_S, Math.max(0, dt));
  while (left > 0) {
    const step = Math.min(SUBSTEP_S, left);
    speed += (-TUNE.glide.stiffness * (at - to) - TUNE.glide.damping * speed) * step;
    at += speed * step;
    left -= step;
  }
  return { at, speed };
}

/** Whether a glide has come to rest at `to`, within `near`. */
export function glideArrived(value: Glide, to: number, near: number): boolean {
  return Math.abs(value.at - to) <= near && Math.abs(value.speed) <= near * 4;
}

/** Whether the person asked for reduced motion, read as it changes (MOTION.md: scripts follow the query): one live
 *  query, asked again only if the page's matchMedia is another (a test's). */
let reducedQuery: { of: unknown; query: MediaQueryList | null } | null = null;
export function reducedMotion(): boolean {
  const matchMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia : null;
  if (!reducedQuery || reducedQuery.of !== matchMedia) {
    reducedQuery = { of: matchMedia, query: matchMedia ? matchMedia.call(window, '(prefers-reduced-motion: reduce)') : null };
  }
  return Boolean(reducedQuery.query?.matches);
}
