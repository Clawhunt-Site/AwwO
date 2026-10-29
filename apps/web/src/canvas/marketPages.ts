// The pages that hold a market Agent's words: a page of a node set to a market Agent, and of every node downstream of
// one, whose inputs carry the Agent's text (the server hands it on as a third party's, graph_contracts.go
// marketQuoted). They run with pictures and media by URL off, but for the CDNs (liveDocument.ts MARKET_PAGE_CSP).
import { createContext, useContext } from 'react';
import { isMarketReference, type CanvasEdge, type CanvasNode } from './canvasDoc';

/** The nodes set to a market Agent and every node their outputs reach, and every node marked as having been one of
 *  them (marketFed), whatever it is wired to now: what it delivered then may still be what it shows. */
export function marketPageNodes(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<Pick<CanvasEdge, 'fromNode' | 'toNode'>>): ReadonlySet<string> {
  // A marked node's output may still hold the market text it took in, so the walk starts from it as well.
  const queue = nodes.filter(node => node.marketFed || (node.kind === 'session' && isMarketReference(node.agentRef))).map(node => node.id);
  const reached = new Set<string>(queue);
  while (queue.length) {
    const from = queue.shift()!;
    for (const edge of edges) {
      if (edge.fromNode !== from || reached.has(edge.toNode)) continue;
      reached.add(edge.toNode);
      queue.push(edge.toNode);
    }
  }
  return reached;
}

/** A node as an undo or redo brings it back, marked if it is marked now: the step it goes back to may still show what
 *  it delivered since (CanvasSurface's restoreDoc). */
export function keepMarketMark<T extends CanvasNode>(restored: T, live: CanvasNode | undefined): T {
  return live?.marketFed && !restored.marketFed ? { ...restored, marketFed: true as const } : restored;
}

/** The nodes of `reached` (marketPageNodes) not marked yet, for the canvas to mark (CanvasSurface). */
export const unmarkedMarketNodes = (nodes: ReadonlyArray<CanvasNode>, reached: ReadonlySet<string>): string[] =>
  nodes.filter(node => reached.has(node.id) && !node.marketFed).map(node => node.id);

const NONE: ReadonlySet<string> = new Set();
/** The canvas's marketPageNodes, for the views that show a node's page (CanvasSurface provides it). */
export const MarketPagesContext = createContext<ReadonlySet<string>>(NONE);

/** Whether the pages a node published hold a market Agent's words. */
export function useMarketPage(nodeId: string | null | undefined): boolean {
  const nodes = useContext(MarketPagesContext);
  return Boolean(nodeId && nodes.has(nodeId));
}
