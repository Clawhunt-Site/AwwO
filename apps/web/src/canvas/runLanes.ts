// Run lanes: several independent runs on one canvas at once.
//
// A lane is one run (a node's chat turn, one component's task, or a graph) with its own durable journal, its own
// browser-wide execution lock and its own recovery observer. Lane 0 keeps the original journal key and lock, so a
// journal written before lanes existed is still lane 0's. Lanes never execute the same node: CanvasSurface admits a
// run only into a free lane whose scope is disjoint from every active lane's, and the server refuses overlapping
// graphs too. A review loop or a collaboration still runs alone, as does a whole-canvas run.
import { canvasStorage, canvasStorageKey } from './canvasStorage';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal, type CanvasRunJournal } from './runJournal';
import { withCanvasRunOwnership } from './runOwnership';

export const MAX_RUN_LANES = 4;
export const RUN_LANES: readonly number[] = Array.from({ length: MAX_RUN_LANES }, (_, index) => index);

export type CanvasStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<{ keys(): string[] }>;

/** The storage key of a lane's journal. */
export function laneJournalKey(lane: number): string {
  return lane === 0 ? CANVAS_RUN_JOURNAL_KEY : `${CANVAS_RUN_JOURNAL_KEY}.lane${lane}`;
}

/** The canvas storage, with the run journal key mapped to this lane's (every other key unchanged). */
export function laneStorage(lane: number, base: CanvasStore = canvasStorage()): CanvasStore {
  if (lane === 0) return base;
  const key = (name: string) => name === CANVAS_RUN_JOURNAL_KEY ? laneJournalKey(lane) : name;
  return {
    getItem: name => base.getItem(key(name)),
    setItem: (name, value) => base.setItem(key(name), value),
    removeItem: name => base.removeItem(key(name)),
    ...(base.keys ? { keys: () => base.keys!() } : {}),
  };
}

/** Every lane's durable journal, for discovering runs (another tab's, or before a reload). */
export function loadLaneJournals(base: CanvasStore = canvasStorage()): Array<{ lane: number; journal: CanvasRunJournal }> {
  return RUN_LANES.flatMap(lane => {
    const journal = loadRunJournal(laneStorage(lane, base));
    return journal ? [{ lane, journal }] : [];
  });
}

/** The lane whose durable journal this storage event changed, or null for another key. */
export function laneOfStorageKey(key: string | null): number | null {
  if (!key) return null;
  for (const lane of RUN_LANES) if (key === canvasStorageKey(laneJournalKey(lane))) return lane;
  return null;
}

/** Browser-wide exclusion per lane (lane 0 keeps the original lock name). */
export function withLaneOwnership(lane: number, run: () => Promise<void>, refused: () => void,
  locks?: Pick<LockManager, 'request'>, waitForOwnership = false): Promise<void> {
  return withCanvasRunOwnership(run, refused, locks ?? (typeof navigator === 'undefined' ? undefined : navigator.locks), waitForOwnership,
    lane === 0 ? undefined : `awwo.canvas.execution.v1:lane${lane}`);
}

/** A run that has to be the only one on the canvas: a review loop or a collaboration. */
export function exclusiveJournal(journal: CanvasRunJournal | null | undefined): boolean {
  return Boolean(journal && (journal.review || journal.collaboration));
}
