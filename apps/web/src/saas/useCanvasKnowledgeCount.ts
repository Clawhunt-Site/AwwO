import { useEffect, useState } from 'react';
import { canvasKnowledgeRevisionIds, subscribeCanvasKnowledge } from './canvasBridge';

/** How many knowledge revisions the canvas's next tasks cite, as the bridge holds them. The knowledge map (developer
 *  mode) and 从网址读取 (simple mode) both set them, so each shows the one selection, whichever mode set it. */
export function useCanvasKnowledgeCount(): number {
  const [count, setCount] = useState(() => canvasKnowledgeRevisionIds().length);
  useEffect(() => {
    setCount(canvasKnowledgeRevisionIds().length);
    return subscribeCanvasKnowledge(() => setCount(canvasKnowledgeRevisionIds().length));
  }, []);
  return count;
}
