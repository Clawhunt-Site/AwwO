import { expect, it, vi } from 'vitest';
import { withCanvasRunOwnership } from '../src/canvas/runOwnership';

it('refuses a second execution until the original owner finishes', async () => {
  let release!: () => void;
  const running = new Promise<void>(resolve => { release = resolve; });
  const first = vi.fn(() => running);
  const duplicate = vi.fn(async () => {});
  const refused = vi.fn();
  const firstRequest = withCanvasRunOwnership(first, refused);
  await withCanvasRunOwnership(duplicate, refused);
  expect(first).toHaveBeenCalledOnce();
  expect(duplicate).not.toHaveBeenCalled();
  expect(refused).toHaveBeenCalledOnce();
  release(); await firstRequest;
  await withCanvasRunOwnership(duplicate, refused);
  expect(duplicate).toHaveBeenCalledOnce();
});

it('never starts native work when cross-tab ownership is unavailable', async () => {
  const work = vi.fn(async () => {}); const refused = vi.fn();
  // Explicitly exercise a browser without the API rather than relying on jsdom's default.
  const old = navigator.locks;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  work.mockClear(); refused.mockClear();
  try { await withCanvasRunOwnership(work, refused); }
  finally { Object.defineProperty(navigator, 'locks', { configurable: true, value: old }); }
  expect(work).not.toHaveBeenCalled(); expect(refused).toHaveBeenCalledOnce();
});
