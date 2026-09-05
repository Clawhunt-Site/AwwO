/** Browser-wide exclusion. The durable journal separately covers reloads and lost transports. */
export async function withCanvasRunOwnership(
  run: () => Promise<void>,
  refused: () => void,
  locks: Pick<LockManager, 'request'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.locks,
  waitForOwnership = false,
): Promise<void> {
  if (!locks) { refused(); return; }
  await locks.request('awwo.canvas.execution.v1', { mode: 'exclusive', ...(!waitForOwnership ? { ifAvailable: true } : {}) }, async lock => {
    if (!lock) { refused(); return; }
    await run();
  });
}
