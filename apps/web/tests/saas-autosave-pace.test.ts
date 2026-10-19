import { describe, expect, it } from 'vitest';
import { AUTOSAVE_BURST_GAP_MS, AUTOSAVE_HOLD_MS, AUTOSAVE_MAX_DEFER_MS, AUTOSAVE_MAX_QUIET_MS, AUTOSAVE_MS_PER_MILLION_CHARS, AUTOSAVE_PACED_SIZE, AUTOSAVE_QUIET_MS, autosavePace } from '../src/saas/autosavePace';

// The pace on its own: a clock the test moves and a window stand-in whose pointer events the test sends.
function setup() {
  let time = 1_000_000;
  const target = new EventTarget();
  const pace = autosavePace(target as unknown as Window, () => time);
  const pointer = (type: string, pointerId = 1) => target.dispatchEvent(Object.assign(new Event(type), { pointerId }));
  return { pace, pointer, target, at: (ms: number) => { time += ms; } };
}
const BIG = 6_300_000; // the 142-node canvas of the report, in characters

describe('autosave pace', () => {
  it('waits the plain quiet spell after a write, and no longer once it has passed', () => {
    const { pace, at } = setup();
    expect(pace.wait()).toBe(0);
    expect(pace.wrote(20_000)).toBe(AUTOSAVE_QUIET_MS);
    expect(pace.wait()).toBe(AUTOSAVE_QUIET_MS);
    at(AUTOSAVE_QUIET_MS - 1);
    expect(pace.wait()).toBe(1);
    at(1);
    expect(pace.wait()).toBe(0);
  });

  it('keeps the plain wait for a canvas below the paced size, however its writes come', () => {
    const { pace, at } = setup();
    pace.wrote(AUTOSAVE_PACED_SIZE - 1);
    at(1500); expect(pace.wrote(AUTOSAVE_PACED_SIZE - 1)).toBe(AUTOSAVE_QUIET_MS);
    at(700); expect(pace.wrote(20_000)).toBe(AUTOSAVE_QUIET_MS);
  });

  it('waits longer for a big canvas, from its first write, and follows its slow writes\' pace', () => {
    const { pace, at } = setup();
    expect(pace.wrote(BIG)).toBe(AUTOSAVE_QUIET_MS + Math.round(6.3 * AUTOSAVE_MS_PER_MILLION_CHARS));
    // Whichever is longer: the document's wait or twice the gap between its last two writes.
    at(1000); expect(pace.wrote(BIG)).toBe(2000);
    at(600); expect(pace.wrote(BIG)).toBe(AUTOSAVE_QUIET_MS + Math.round(6.3 * AUTOSAVE_MS_PER_MILLION_CHARS));
    at(1709); expect(pace.wait()).toBe(1);
    at(1); expect(pace.wait()).toBe(0);
    // A long gap starts a new burst; nothing waits past the longest quiet spell.
    at(AUTOSAVE_BURST_GAP_MS); expect(pace.wrote(BIG)).toBe(AUTOSAVE_QUIET_MS + Math.round(6.3 * AUTOSAVE_MS_PER_MILLION_CHARS));
    at(AUTOSAVE_BURST_GAP_MS - 1); expect(pace.wrote(BIG)).toBe(Math.min(AUTOSAVE_MAX_QUIET_MS, 2 * (AUTOSAVE_BURST_GAP_MS - 1)));
    at(1000); expect(pace.wrote(100_000_000)).toBe(AUTOSAVE_MAX_QUIET_MS);
    expect(2 * AUTOSAVE_BURST_GAP_MS).toBeLessThanOrEqual(AUTOSAVE_MAX_QUIET_MS);
  });

  it('holds while a pointer is down, looking again shortly, until the last pointer lifts', () => {
    const { pace, pointer, at } = setup();
    pace.wrote(); at(AUTOSAVE_QUIET_MS);
    expect(pace.wait()).toBe(0);
    pointer('pointerdown', 1);
    expect(pace.wait()).toBeGreaterThan(0);
    expect(pace.wait()).toBeLessThanOrEqual(200);
    pointer('pointerdown', 2);
    pointer('pointerup', 1);
    expect(pace.wait()).toBeGreaterThan(0);
    pointer('pointercancel', 2);
    expect(pace.wait()).toBe(0);
  });

  it('lets a press held past the limit, or a window losing focus mid-press, stop holding', () => {
    const { pace, pointer, target, at } = setup();
    pointer('pointerdown');
    at(AUTOSAVE_HOLD_MS - 100); expect(pace.wait()).toBe(100);
    at(100); expect(pace.wait()).toBe(0);
    pointer('pointerup');
    pointer('pointerdown');
    expect(pace.wait()).toBeGreaterThan(0);
    target.dispatchEvent(new Event('blur'));
    expect(pace.wait()).toBe(0);
  });

  it('holds again when a pointer whose release it never saw presses again', () => {
    const { pace, pointer, at } = setup();
    pointer('pointerdown');
    at(AUTOSAVE_HOLD_MS + 5000); expect(pace.wait()).toBe(0);
    // The release went elsewhere (a native menu); the same mouse starts a drag.
    pointer('pointerdown');
    expect(pace.wait()).toBeGreaterThan(0);
  });

  it('sends an edit at last however long its burst or a press lasts, and counts afresh once it went', () => {
    const { pace, pointer, at } = setup();
    pointer('pointerdown');
    pace.wrote(BIG);
    for (let index = 0; index < 25; index++) {
      at(700); pace.wrote(BIG);
      if ((index + 1) * 700 < AUTOSAVE_MAX_DEFER_MS) {
        expect(pace.wait()).toBeGreaterThan(0);
        expect(pace.wait()).toBeLessThanOrEqual(AUTOSAVE_MAX_DEFER_MS - (index + 1) * 700);
      } else expect(pace.wait()).toBe(0);
    }
    pace.sent();
    expect(pace.wait()).toBeGreaterThan(0);
    pointer('pointerup');
    at(AUTOSAVE_MAX_QUIET_MS); expect(pace.wait()).toBe(0);
  });

  it('stops listening once disposed', () => {
    const { pace, pointer } = setup();
    pace.dispose();
    pointer('pointerdown');
    expect(pace.wait()).toBe(0);
  });
});
