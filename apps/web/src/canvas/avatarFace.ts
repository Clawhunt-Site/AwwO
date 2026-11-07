// The converged icon's face (收敛成一个图标, the whole canvas drawn as one bot avatar): a flat head with two eyes and
// nothing else, whose expression is the group's state, the one its words already say (groupStatus.ts), never more. Pure
// data, drawn by ConvergedIcon.tsx on a 100-unit face over the head, in the head's eye ink. The eyes look at the part of
// the ring the icon names (eyeGaze), level or down, never up. The idea of a bot whose face says what it is doing comes from
// OpenMausBot's mascots; the face and its shapes are AwwO's own.
import type { GroupState } from './groupStatus';

export type AvatarExpression = 'calm' | 'working' | 'thinking' | 'happy' | 'content' | 'worried' | 'blank' | 'asleep';

/** The group's state as a face. A failure while the rest still run keeps the face at work (the badge and the words say
 *  the failure at once, as the ring does): the face says what the group is doing, as the state does. */
export const AVATAR_EXPRESSION: Readonly<Record<GroupState, AvatarExpression>> = {
  idle: 'calm',
  delivered: 'calm',
  running: 'working',
  waiting: 'thinking',
  done: 'happy',
  cached: 'content',
  failed: 'worried',
  blocked: 'blank',
  cancelled: 'asleep',
};

/** One eye: an upright capsule (a pill, filled), a line (stroked, `width` face units wide), or a filled shape. */
export type FacePart =
  | { shape: 'capsule'; cx: number; cy: number; w: number; h: number }
  | { shape: 'stroke'; d: string; width: number }
  | { shape: 'fill'; d: string };

const capsule = (cx: number, cy: number, w: number, h: number): FacePart => ({ shape: 'capsule', cx, cy, w, h });
const stroke = (d: string, width = 5): FacePart => ({ shape: 'stroke', d, width });
const fill = (d: string): FacePart => ({ shape: 'fill', d });

/** Each expression's two eyes, centred near x 35 and 65 on one line near y 46 (a blink squashes them as one, the gaze
 *  moves them as one). Each face reads in a still frame too (under reduced motion, in a screenshot): working is never
 *  calm. Upright and level: never a pair leaning up and to one side. */
export const AVATAR_FACES: Readonly<Record<AvatarExpression, readonly [FacePart, FacePart]>> = {
  // At rest (before a run, or holding earlier or partial results): tall eyes, straight ahead, still.
  calm: [capsule(35, 46, 10, 16), capsule(65, 46, 10, 16)],
  // At work: round eyes, looking at the part of the ring at work, blinking.
  working: [capsule(35, 46, 10, 10), capsule(65, 46, 10, 10)],
  // Queued or waiting for recovery or a retry: one eye half shut, straight ahead (it is not work yet).
  thinking: [capsule(35, 46, 9, 14), capsule(65, 49.5, 9, 7)],
  // Every member has a result: eyes shut in a smile.
  happy: [stroke('M 28 49 Q 35 38 42 49'), stroke('M 58 49 Q 65 38 72 49')],
  // All of it reused from an earlier run: the same, quieter, still a curve at the small size.
  content: [stroke('M 29 48 Q 35 41 41 48', 4), stroke('M 59 48 Q 65 41 71 48', 4)],
  // A member failed and nothing runs or waits: eyes sloping down to the sides, looking at the first failure.
  worried: [fill('M 40 41 L 30 47 L 30 50 A 5 5 0 0 0 40 50 Z'), fill('M 60 41 L 70 47 L 70 50 A 5 5 0 0 1 60 50 Z')],
  // Blocked: a blank stare, straight ahead (flat eyes turned aside would read as a side-eye).
  blank: [stroke('M 28 47 H 42'), stroke('M 58 47 H 72')],
  // Stopped: eyes shut.
  asleep: [stroke('M 28 44 Q 35 54 42 44', 4), stroke('M 58 44 Q 65 54 72 44', 4)],
};

/** The light at the chin, in the head's 100-unit box, as the head clips it (converged-icon.css): the head (r 50 about
 *  50, 50) less the same circle 8 units higher, 8 deep at the chin and nothing at the eyes' line (y 46). Its outer arc is
 *  drawn on r 52, past the head, so the head's clip draws the chin's edge however the SVG is rounded; its inner arc is
 *  that higher circle's. The boot surface's head has it too (saas/BootSurface.tsx). */
export const AVATAR_CRESCENT = 'M 0.7716 33.25 A 52 52 0 1 0 99.2284 33.25 A 50 50 0 1 1 0.7716 33.25 Z';

/** The faces whose eyes look at the ring: at work (at the member the icon names now, a streaming reply or the frontier)
 *  and worried (at the first failure). The others look straight ahead. */
export const AVATAR_LOOKS: Readonly<Record<AvatarExpression, boolean>> = {
  calm: false, working: true, thinking: false, happy: false, content: false, worried: true, blank: false, asleep: false,
};

/** Toward a point of the ring (a share of the circle, 0 = 12 o'clock, clockwise), in face units: up to 7 across and 6
 *  down, never up (eyes raised and turned aside would be another mark's look). */
export function eyeGaze(share: number): [number, number] {
  const angle = share * 2 * Math.PI;
  return [7 * Math.sin(angle), Math.max(0, -6 * Math.cos(angle))];
}
