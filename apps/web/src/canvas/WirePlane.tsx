// The wire layer: every committed edge plus the live drag preview, drawn in WORLD coordinates.
//
// Ported from the previous canvas's edge rendering (since-deleted apps/web/src/studio/StudioCanvas.tsx): a
// zero-box, overflow-visible SVG sitting inside the transformed world, so the world transform
// scales the strokes with everything else and no separate projection can drift from the tiles.
//
// Two rules carried over unchanged:
//  - A wire whose endpoint port cannot be resolved is NOT drawn. `portAnchorWorld` returns null
//    when the node no longer exposes that port (e.g. an image session's 'reference' input after
//    the tile was switched to LLM); falling back to a made-up point would render a connection
//    that does not exist. (`reconcileEdges` removes such edges from the document; a null here
//    means the caller is drawing from unreconciled state.)
//  - Disconnect is a DOUBLE-click on a wide invisible hit path, never a single click: an
//    accidental brush across a line must not sever a wiring. The hit path also stops its own
//    pointerdown, because the viewport's setPointerCapture would otherwise retarget the derived
//    dblclick to the background (real-browser UI Events behavior) — the disconnect would never
//    fire and the background's own double-click gesture would run instead.

import type { CanvasEdge, CanvasNode } from './canvasDoc';
import { edgeBezierPath, portAnchorWorld } from './ports';
import type { WireDrag } from './TilePorts';

export interface WirePlaneProps {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  /** The in-flight drag-to-wire gesture (from `useWiring`), or null. */
  preview?: WireDrag | null;
  /** Omitted → wires render without a disconnect affordance. */
  onDisconnect?: (edge: CanvasEdge) => void;
}

export function WirePlane({ nodes, edges, preview = null, onDisconnect }: WirePlaneProps) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return (
    <svg
      className="canvas-wires"
      width={1}
      height={1}
      style={{ position: 'absolute', overflow: 'visible' }}
      aria-hidden="true"
    >
      {edges.map((e) => {
        const from = nodeById.get(e.fromNode);
        const to = nodeById.get(e.toNode);
        if (!from || !to) return null;
        const a = portAnchorWorld(from, e.fromPort);
        const b = portAnchorWorld(to, e.toPort);
        if (!a || !b) return null; // unresolvable endpoint → draw nothing, invent nothing
        const d = edgeBezierPath(a, b);
        return (
          <g key={e.id}>
            <path className={`canvas-wire canvas-wire--${e.dataType}`} d={d} data-testid={`canvas-wire-${e.id}`} />
            {onDisconnect ? (
              <path
                className="canvas-wire-hit"
                d={d}
                data-testid={`canvas-wire-hit-${e.id}`}
                onPointerDown={(ev) => ev.stopPropagation()}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  onDisconnect(e);
                }}
              />
            ) : null}
          </g>
        );
      })}
      {preview
        ? (() => {
            const n = nodeById.get(preview.from.nodeId);
            if (!n) return null;
            const a = portAnchorWorld(n, preview.from.portId);
            if (!a) return null;
            // The preview runs FROM the anchor when the gesture started on an output, and INTO it
            // when it started on an input, so the curve's handles read the same direction the
            // committed wire will.
            const d = preview.side === 'output' ? edgeBezierPath(a, preview.world) : edgeBezierPath(preview.world, a);
            return <path className="canvas-wire canvas-wire-preview" d={d} data-testid="canvas-wire-preview" />;
          })()
        : null}
    </svg>
  );
}
