// Whether an opened node's chat column is too short to read a conversation in. On a laptop's window beside the
// assistant the heading, the task card and the message box left a reply a line or two (customer report 2026-10-18:
// 「这里面的文字根本看不全」); such a column draws its message box and task card compact (awwo-node.css `.is-short`).
// The column's height is the node's, never its content's, so drawing compact cannot change the answer.
import { useLayoutEffect, useState, type RefObject } from 'react';

/** A chat column under this height is short: 1280 × 720 beside the assistant gives 408 px, 1366 × 768 gives 456 px. */
export const SHORT_COLUMN_PX = 440;

export function useShortColumn(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [short, setShort] = useState(false);
  useLayoutEffect(() => {
    const column = ref.current;
    if (!active || !column) {
      setShort(false);
      return;
    }
    // A column not laid out yet (0 px, a hidden tile) is not short.
    const measure = () => setShort(column.clientHeight > 0 && column.clientHeight < SHORT_COLUMN_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [ref, active]);
  return short;
}
