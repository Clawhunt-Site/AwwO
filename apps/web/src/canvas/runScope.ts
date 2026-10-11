import type { CanvasNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';

/**
 * What a run of the canvas (`requested` undefined) or of some of its nodes executes. Image, video and 3D nodes generate
 * only from their own Send, each one a paid generation, so a run leaves them out and hands on what they made before,
 * as it does for any upstream outside its scope; the server refuses a run that names one. The request comes back
 * unchanged when it holds no media node, so a whole-canvas run stays one. `null` when it asked for media nodes only.
 */
export function runScopeWithoutMedia(nodes: ReadonlyArray<CanvasNode>, requested?: ReadonlyArray<string>): { scope: ReadonlyArray<string> | undefined } | null {
  const media = new Set(nodes.filter(node => node.kind === 'session' && mediaKindOf(node.agentKind)).map(node => node.id));
  const asked = requested ?? nodes.map(node => node.id);
  const runnable = asked.filter(id => !media.has(id));
  if (runnable.length === asked.length) return { scope: requested };
  return runnable.length ? { scope: runnable } : null;
}
