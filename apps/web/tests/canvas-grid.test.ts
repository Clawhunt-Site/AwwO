// The grid moves with the world.
//
// It used to be painted on the non-transformed root, so it never panned and never scaled: zooming
// made tiles grow against a stationary field, which the eye reads as "the content resized" rather
// than "I moved closer". That single missing cue is most of why an infinite canvas stops feeling
// like a space — every reference the owner named (RunningHub, LibLib, ComfyUI, termcanvas) scales
// its grid with the world.
//
// Drawing it in screen space but STEPPING it by world-spacing × scale is deliberate: a background
// inside the transformed layer would rasterise its dots once and then blur them at every scale
// other than exactly 1.
import { describe, expect, it } from 'vitest';
import { gridStyle } from '../src/canvas/CanvasViewport';

describe('gridStyle', () => {
  it('steps with the zoom', () => {
    expect(gridStyle({ x: 0, y: 0, scale: 1 }).backgroundSize).toBe('24px 24px');
    expect(gridStyle({ x: 0, y: 0, scale: 2 }).backgroundSize).toBe('48px 48px');
    // The coarse layer is 8x the fine one, so it survives when the fine one has faded.
    expect(gridStyle({ x: 0, y: 0, scale: 1 }, 8).backgroundSize).toBe('192px 192px');
  });

  it('follows the pan, wrapped to one cell', () => {
    expect(gridStyle({ x: 100, y: 60, scale: 1 }).backgroundPosition).toBe(`${100 % 24}px ${60 % 24}px`);
    // A pan of exactly one cell is indistinguishable from no pan — that is what makes it tile.
    expect(gridStyle({ x: 24, y: 48, scale: 1 }).backgroundPosition).toBe('0px 0px');
  });

  it('fades the FINE layer out as the camera pulls back, instead of moireing', () => {
    const near = Number(gridStyle({ x: 0, y: 0, scale: 1 }).opacity);
    const mid = Number(gridStyle({ x: 0, y: 0, scale: 0.35 }).opacity);
    const far = Number(gridStyle({ x: 0, y: 0, scale: 0.18 }).opacity);
    expect(near).toBe(1);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(far).toBe(0);
  });

  it('keeps the COARSE layer fully drawn, so there is always something to read motion against', () => {
    expect(Number(gridStyle({ x: 0, y: 0, scale: 0.2 }, 8).opacity)).toBe(1);
  });

  it('stops drawing entirely once a cell is smaller than a few pixels', () => {
    const tiny = gridStyle({ x: 0, y: 0, scale: 0.05 });
    expect(tiny.opacity).toBe(0);
    expect(tiny.backgroundImage).toBeUndefined(); // nothing to paint at all
  });

  it('never emits a NaN size from a degenerate camera', () => {
    expect(gridStyle({ x: 0, y: 0, scale: Number.NaN }).opacity).toBe(0);
  });

  it('keeps the dot radius in SCREEN px so dots stay hairlines at high zoom', () => {
    const near = String(gridStyle({ x: 0, y: 0, scale: 4 }).backgroundImage);
    const far = String(gridStyle({ x: 0, y: 0, scale: 1 }).backgroundImage);
    expect(near).toContain('1px');
    expect(near).toBe(far); // the pattern itself never changes — only its step does
  });
});
