import { canvasStorageKey } from './canvasStorage';
/** Browser-wide exclusion. The durable journal separately covers reloads and lost transports. A run lane passes its
 *  own lock name (runLanes.ts); lane 0 and every older caller use the original one. */
export async function withCanvasRunOwnership(
  run: () => Promise<void>,
  refused: () => void,
  locks: Pick<LockManager, 'request'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.locks,
  waitForOwnership = false,
  name = 'awwo.canvas.execution.v1',
): Promise<void> {
  if (!locks) { refused(); return; }
  await locks.request(canvasStorageKey(name), { mode: 'exclusive', ...(!waitForOwnership ? { ifAvailable: true } : {}) }, async lock => {
    if (!lock) { refused(); return; }
    await run();
  });
}
