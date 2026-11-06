// The converged icon's face (收敛成一个图标, the whole canvas drawn as one bot avatar): the AwwO orb is the head, and its
// expression is the group's state, the one its words already say (groupStatus.ts), never more. Pure data, drawn by
// ConvergedIcon.tsx on a 100-unit face in the orb's white ink: two eyes, brows for a worry, a mouth. The idea of a bot
// whose face says what it is doing comes from OpenMausBot's mascots; the face and its shapes are AwwO's own.
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

/** One part of a face: an eye drawn as a filled oval, or an eye, a brow or the mouth drawn as a stroked line. */
export type FacePart =
  | { kind: 'eye'; shape: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'eye' | 'brow' | 'mouth'; shape: 'path'; d: string };

const eyes = (cy: number, rx: number, ry: number, dx = 0): FacePart[] => [35, 65].map(cx =>
  ({ kind: 'eye', shape: 'ellipse', cx: cx + dx, cy, rx, ry }));
const line = (kind: 'eye' | 'brow' | 'mouth', d: string): FacePart => ({ kind, shape: 'path', d });

/** Each expression's parts. Eyes sit on one line near 45 (a working face's look and blink move them as one); the mouth
 *  stays between 60 and 70, above the orb's rim light; nothing reaches the specular spot at the upper left. Each face
 *  reads in a still frame too (under reduced motion, in a screenshot, at the small size): working is never calm. */
export const AVATAR_FACES: Readonly<Record<AvatarExpression, ReadonlyArray<FacePart>>> = {
  // At rest (before a run, or holding earlier or partial results): round open eyes, a small smile.
  calm: [...eyes(45, 6, 8), line('mouth', 'M 42 63 Q 50 69 58 63')],
  // At work: eyes narrowed and turned aside (they look about and blink while it runs), a short set mouth, no smile.
  working: [...eyes(45, 6, 5.5, 3), line('mouth', 'M 45 65 H 55')],
  // Queued or waiting for recovery or a retry: looking up, a slanted, pondering mouth.
  thinking: [...eyes(39, 5.5, 7.5, 2), line('mouth', 'M 44 66 L 56 64')],
  // Every member has a result: eyes shut in a smile, a wide smile.
  happy: [line('eye', 'M 28.5 47 Q 35 38.5 41.5 47'), line('eye', 'M 58.5 47 Q 65 38.5 71.5 47'), line('mouth', 'M 37 60 Q 50 74 63 60')],
  // All of it reused from an earlier run: the same, quieter.
  content: [line('eye', 'M 29 46 Q 35 40.5 41 46'), line('eye', 'M 59 46 Q 65 40.5 71 46'), line('mouth', 'M 41 62 Q 50 69 59 62')],
  // A member failed and nothing runs: smaller eyes, brows raised at the middle, a frown.
  worried: [...eyes(47, 5.5, 7), line('brow', 'M 27 38 L 40 34'), line('brow', 'M 73 38 L 60 34'), line('mouth', 'M 41 69 Q 50 61 59 69')],
  // Blocked: a blank stare and a flat mouth.
  blank: [line('eye', 'M 29 46 H 41'), line('eye', 'M 59 46 H 71'), line('mouth', 'M 43 65 H 57')],
  // Stopped: eyes shut, a small flat mouth.
  asleep: [line('eye', 'M 29 45 Q 35 50 41 45'), line('eye', 'M 59 45 Q 65 50 71 45'), line('mouth', 'M 46 65 H 54')],
};
