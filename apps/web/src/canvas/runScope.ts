import type { CanvasNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';

/**
 * What a collaboration run of the canvas (`requested` undefined) or of some of its nodes executes. A collaboration's
 * agents discuss in text, so image, video and 3D nodes take no part: it leaves them out and hands on what they made
 * before, as it does for any upstream outside its scope (an ordinary canvas or component run generates them). The
 * request comes back unchanged when it holds no media node, so a whole-canvas run stays one. `null` when it asked for
 * media nodes only.
 */
export function runScopeWithoutMedia(nodes: ReadonlyArray<CanvasNode>, requested?: ReadonlyArray<string>): { scope: ReadonlyArray<string> | undefined } | null {
  const media = new Set(nodes.filter(node => node.kind === 'session' && mediaKindOf(node.agentKind)).map(node => node.id));
  const asked = requested ?? nodes.map(node => node.id);
  const runnable = asked.filter(id => !media.has(id));
  if (runnable.length === asked.length) return { scope: requested };
  return runnable.length ? { scope: runnable } : null;
}
