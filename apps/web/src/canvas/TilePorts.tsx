// Port handles on a tile + the wiring gesture that connects them.
//
// The gesture is ported from the previous canvas (since-deleted apps/web/src/studio/StudioCanvas.tsx) VERBATIM
// in behavior — it is the wiring that ships today and must not regress:
//
//   - click-click wiring: click an OUTPUT port to arm it, then a compatible INPUT port completes;
//     a background press disarms.
//   - drag-to-wire: press a port and drag (>4px Manhattan) — a live preview bezier follows the
//     cursor in WORLD space; release over a port of the opposite polarity connects.
//   - leak-proof teardown: every move/up/cancel listener is attached to the PORT BUTTON itself
//     with pointer capture (no window listeners to leak), `pointercancel` aborts the gesture, and
//     the current teardown is held in a ref so component unmount tears it down too. A leaked
//     listener would trail a ghost preview and could fire a phantom connection.
//   - `canConnect` (./ports) is the ONLY authority on validity — self-node, occupied input, type
//     mismatch. This file never re-implements that judgement.
//   - `onConnect` carries the SOURCE port's REAL dataType, read from `portsFor` at connect time.
//     It is never guessed and never defaulted: if the source spec cannot be resolved, no edge is
//     reported at all. (The old canvas fell back to a wildcard 'any'; this canvas's type set is
//     closed, so a fallback could only smuggle in a mistyped wire.)
//
// Port handles render at EVERY level of detail. Wires are the graph's structure, not a detail of
// one zoom tier: hiding the handles when zoomed out would hide the only affordance for reading
// and repairing that structure.

import { Fragment, useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { CanvasEdge, CanvasNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';
import type { MediaComposerInfo } from './TileComposer';
import {
  type DataType,
  type PortRef,
  type PortSide,
  type PortSpec,
  canConnect,
  portAnchorWorld,
  portsFor,
} from './ports';
import type { ViewportState } from './viewport';
import { useCanvasI18n, type CanvasTextKey } from './i18n';

export interface WireDrag {
  from: PortRef;
  /** Polarity of the port the gesture STARTED on (a drag may run either direction). */
  side: PortSide;
  /** Cursor position in world coords, for the preview bezier. */
  world: { x: number; y: number };
}

export interface WiringApi {
  /** The armed output port of a click-click wiring, if any. */
  pendingPort: PortRef | null;
  /** The in-flight drag-to-wire gesture, if any (drives the preview bezier). */
  wireDrag: WireDrag | null;
  /** True when ports should render as interactive (an onConnect handler exists). */
  interactive: boolean;
  /** How many wires currently land on (or leave) a given port. Drives the connected state and
   *  the fan-in count badge — with a multi input you have to be able to SEE that three things
   *  feed this node, not discover it when the prompt comes out wrong. */
  wireCount: (nodeId: string, portId: string, side: PortSide) => number;
  /** Disarm the click-click flow — wire this to the viewport's background pointer-down. */
  clearPending: () => void;
  onPortPointerDown: (nodeId: string, port: PortSpec, e: React.PointerEvent) => void;
  onPortClick: (nodeId: string, port: PortSpec, e: React.MouseEvent) => void;
}

export interface UseWiringOptions {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  /** Omitted → ports render inert (still visible: they are the graph's structure). */
  onConnect?: (from: PortRef, to: PortRef, dataType: DataType) => void;
  /** The `.canvas-root` element — used to locate `.canvas-viewport` for client→world math. */
  rootRef: RefObject<HTMLElement | null>;
  /** Current viewport (read through a ref inside the gesture, so mid-drag zoom stays correct). */
  view: ViewportState;
}

export function useWiring({ nodes, edges, onConnect, rootRef, view }: UseWiringOptions): WiringApi {
  const [pendingPort, setPendingPort] = useState<PortRef | null>(null);
  const [wireDrag, setWireDrag] = useState<WireDrag | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  // Read through refs inside the gesture so a mid-drag prop change dispatches against the CURRENT
  // graph and handler, not the ones captured at pointerdown.
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // Teardown of the CURRENT wire gesture, if any. Held in a ref so pointercancel AND component
  // unmount can both tear it down — the gesture must never outlive the pointer or the component.
  const wireTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => wireTeardownRef.current?.(), []);

  const clearPending = useCallback(() => setPendingPort(null), []);

  /** Resolve the SOURCE port's real dataType and report the edge. Never guesses a type. */
  const emit = useCallback((from: PortRef, to: PortRef) => {
    const fromNode = nodesRef.current.find((n) => n.id === from.nodeId);
    if (!fromNode) return;
    const spec = portsFor(fromNode).find((p) => p.side === 'output' && p.id === from.portId);
    if (!spec) return; // unresolvable source → no edge, rather than an invented type
    onConnectRef.current?.(from, to, spec.dataType);
  }, []);

  const onPortClick = useCallback(
    (nodeId: string, port: PortSpec, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!onConnectRef.current) return;
      if (port.side === 'output') {
        setPendingPort({ nodeId, portId: port.id });
        return;
      }
      if (pendingPort) {
        const to: PortRef = { nodeId, portId: port.id };
        if (canConnect(nodesRef.current, edgesRef.current, pendingPort, to)) emit(pendingPort, to);
        setPendingPort(null);
      }
    },
    [pendingPort, emit],
  );

  const onPortPointerDown = useCallback(
    (nodeId: string, p: PortSpec, e: React.PointerEvent) => {
      // Never let a port press start a tile drag or a background pan.
      e.stopPropagation();
      if (!onConnectRef.current || e.button !== 0) return;
      wireTeardownRef.current?.(); // never run two wire gestures at once
      const toWorld = (cx: number, cy: number) => {
        const vp = rootRef.current?.querySelector('.canvas-viewport');
        const r = vp?.getBoundingClientRect();
        const v = viewRef.current;
        return r ? { x: (cx - r.left - v.x) / v.scale, y: (cy - r.top - v.y) / v.scale } : { x: 0, y: 0 };
      };
      // Capture the pointer to THIS port button so every subsequent move/up/cancel is delivered to
      // it even if the cursor leaves the window — no window listeners to leak.
      const btn = e.currentTarget as HTMLElement;
      btn.setPointerCapture?.(e.pointerId);
      let moved = false;
      let done = false;
      const sx = e.clientX;
      const sy = e.clientY;
      const teardown = () => {
        if (done) return;
        done = true;
        btn.removeEventListener('pointermove', move);
        btn.removeEventListener('pointerup', up);
        btn.removeEventListener('pointercancel', cancel);
        btn.releasePointerCapture?.(e.pointerId);
        wireTeardownRef.current = null;
        setWireDrag(null);
      };
      const move = (pe: PointerEvent) => {
        if (pe.pointerId !== e.pointerId) return;
        if (Math.abs(pe.clientX - sx) + Math.abs(pe.clientY - sy) > 4) moved = true;
        if (moved) setWireDrag({ from: { nodeId, portId: p.id }, side: p.side, world: toWorld(pe.clientX, pe.clientY) });
      };
      const cancel = (pe: PointerEvent) => {
        if (pe.pointerId !== e.pointerId) return;
        teardown(); // gesture aborted (palm/scroll takeover) → no connect, no ghost wire
      };
      const up = (pe: PointerEvent) => {
        if (pe.pointerId !== e.pointerId) return;
        const wasMoved = moved;
        const px = pe.clientX;
        const py = pe.clientY;
        teardown();
        if (!wasMoved) return; // plain click → the click-click flow owns it
        const portEl = (document.elementFromPoint(px, py) as HTMLElement | null)?.closest?.('.canvas-port') as HTMLElement | null;
        if (!portEl) return;
        const tNode = portEl.getAttribute('data-node-id');
        const tPort = portEl.getAttribute('data-port-id');
        const tSide = portEl.getAttribute('data-port-side');
        // Opposite polarity only; dropping back on a same-side port is a no-op.
        if (!tNode || !tPort || tSide === p.side) return;
        const from = p.side === 'output' ? { nodeId, portId: p.id } : { nodeId: tNode, portId: tPort };
        const to = p.side === 'output' ? { nodeId: tNode, portId: tPort } : { nodeId, portId: p.id };
        // canConnect is the authority (self-node, occupied input, type mismatch).
        if (canConnect(nodesRef.current, edgesRef.current, from, to)) emit(from, to);
      };
      btn.addEventListener('pointermove', move);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', cancel);
      wireTeardownRef.current = teardown;
    },
    [rootRef, emit],
  );

  const wireCount = useCallback(
    (nodeId: string, portId: string, side: PortSide) =>
      side === 'input'
        ? edgesRef.current.filter((e) => e.toNode === nodeId && e.toPort === portId).length
        : edgesRef.current.filter((e) => e.fromNode === nodeId && e.fromPort === portId).length,
    [],
  );

  return {
    pendingPort,
    wireDrag,
    interactive: Boolean(onConnect),
    wireCount,
    clearPending,
    onPortPointerDown,
    onPortClick,
  };
}

const TYPE_LABEL: Record<DataType, CanvasTextKey> = {
  text: 'contract.text', image: 'contract.image', video: 'contract.video', number: 'contract.number', boolean: 'contract.boolean', file: 'contract.file',
};

export interface TilePortsProps {
  node: CanvasNode;
  /** Omitted → handles still render (structure is never hidden) but are inert. */
  wiring?: WiringApi;
  /** An image, video or 3D node's generator (from `mediaComposerInfo`): whether its model uses the reference picture
   *  wired in, which the reference port's guide says. Omitted → the guide says it in general terms. */
  media?: MediaComposerInfo;
  /** The canvas view's scale. A port guide is text to read, so it keeps its on-screen size at any zoom (the handles,
   *  part of the graph, zoom with it). Omitted → 1. */
  scale?: number;
}

type Translate = ReturnType<typeof useCanvasI18n>['t'];

/**
 * What a media node's port takes or gives, in a sentence or two: shown beside the port while it is hovered or
 * focused, so the wiring is learnt where it is done. The facts are the ones `portsFor` and the run engine hold:
 * `context` takes any number of text wires, which a canvas run puts after the node's own prompt; `reference` takes
 * one picture, used only where the node's model takes one (image edit, image-to-3D); `result` carries the files to
 * an input of the same type. Null for every other node and port: those keep their plain label.
 */
export function mediaPortGuide(t: Translate, locale: string, node: CanvasNode, port: PortSpec, media?: MediaComposerInfo): string | null {
  if (node.kind !== 'session' || node.contract) return null;
  const kind = mediaKindOf(node.agentKind ?? '');
  if (!kind) return null;
  if (port.side === 'input' && port.id === 'context') return t('media.guideContext');
  if (port.side === 'input' && port.id === 'reference') {
    if (!media) return t('media.guideReference');
    if (media.references > 0) return t(kind === 'model3d' ? 'media.guideReference3d' : 'media.guideReferenceImage');
    return media.referenceModels.length
      ? t('media.guideReferenceUnused', { models: media.referenceModels.join(locale === 'en' ? ', ' : '、') })
      : t('media.guideReferenceNone');
  }
  if (port.side === 'output' && port.id === 'result') {
    return t(kind === 'video' ? 'media.guideResultVideo' : kind === 'model3d' ? 'media.guideResultModel3d' : 'media.guideResultImage');
  }
  return null;
}

/**
 * The node's typed port handles, positioned on the tile from the SAME anchor math the wires use
 * (`portAnchorWorld` minus the node origin) so a handle can never sit off the line that leaves it.
 */
export function TilePorts({ node, wiring, media, scale = 1 }: TilePortsProps) {
  const { t, locale } = useCanvasI18n();
  const interactive = wiring?.interactive ?? false;
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  const guideIds = useId();
  // Counter-scale about the port's anchor: the guide's top-left sits on the anchor (transform-origin 0 0), is moved
  // beside the port in its own pixels, then scaled by 1/scale, so on screen it is always the same size and distance.
  const unzoom = 1 / (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const hasContract = node.kind === 'session' && Boolean(node.contract);
  const mediaPorts = node.kind === 'session' && !hasContract && Boolean(mediaKindOf(node.agentKind ?? ''));
  return (
    <>
      {portsFor(node).map((p) => {
        const anchor = portAnchorWorld(node, p.id);
        if (!anchor) return null; // node does not expose this port — draw nothing, invent nothing
        const armed = wiring?.pendingPort?.nodeId === node.id && wiring?.pendingPort?.portId === p.id;
        const wires = wiring?.wireCount(node.id, p.id, p.side) ?? 0;
        // A port that carries wires must LOOK different from an empty one, and a multi input
        // carrying several must say how many — otherwise fan-in is invisible until the prompt
        // comes out wrong.
        const countLabel = p.multi && wires > 1 ? String(wires) : '';
        // Display names belong to the form; stable IDs remain exclusively in the wire payload.
        const sideLabel = t(p.side === 'input' ? 'ports.input' : 'ports.output');
        const typeLabel = t(TYPE_LABEL[p.dataType]);
        const portLabel = hasContract ? p.label?.trim() || t('ports.unnamed', { side: sideLabel })
          : p.id === 'reference' ? t('ports.reference')
            : mediaPorts && p.id === 'context' ? t('media.portContext')
              : mediaPorts && p.id === 'result' ? t('media.portResult') : p.id;
        const portKey = `${p.side}:${p.id}`;
        const expanded = expandedLabel === portKey;
        const headline = `${portLabel} · ${typeLabel}${p.multi ? ` · ${t('ports.multi')}`
          : mediaPorts && p.side === 'input' ? ` · ${t('media.portSingle')}` : ''}${wires ? ` · ${t('ports.connected', { count: wires })}` : ''}`;
        // A media port that can be wired explains itself where the wiring happens. Inert ports (read-only, simple
        // mode, a run in progress) do not: nothing can be wired there.
        const guide = interactive ? mediaPortGuide(t, locale, node, p, media) : null;
        const guideId = guide ? `${guideIds}-${p.side}-${p.id}` : undefined;
        return (
          <Fragment key={portKey}>
          <button
            type="button"
            className={`canvas-port canvas-port--${p.side} canvas-port--${p.dataType}${
              interactive ? ' canvas-port--interactive' : ''
            }${armed ? ' is-pending' : ''}${wires > 0 ? ' is-connected' : ''}${
              countLabel ? ' has-count' : ''
            }`}
            style={{ left: anchor.x - node.x, top: anchor.y - node.y }}
            data-wires={wires || undefined}
            // The guide already shows this headline; a native tooltip on top of it would say it twice.
            title={guide ? undefined : `${portLabel} · ${typeLabel}${p.multi ? ` · ${t('ports.multi')}` : ''}${wires ? ` · ${t('ports.wireCount', { count: wires })}` : ''}`}
            aria-label={t('ports.port', { side: sideLabel, label: portLabel, type: typeLabel,
              connection: wires ? t('ports.connected', { count: wires }) : t('ports.disconnected') })}
            aria-describedby={guideId}
            aria-pressed={armed ? true : undefined}
            data-port-id={p.id}
            data-node-id={node.id}
            data-port-side={p.side}
            data-data-type={p.dataType}
            disabled={!interactive}
            onMouseEnter={() => setExpandedLabel(portKey)}
            onMouseLeave={(event) => {
              if (document.activeElement !== event.currentTarget) setExpandedLabel(null);
            }}
            onFocus={() => setExpandedLabel(portKey)}
            onBlur={() => setExpandedLabel(null)}
            onPointerDown={(e) => wiring?.onPortPointerDown(node.id, p, e)}
            onClick={(e) => wiring?.onPortClick(node.id, p, e)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {hasContract ? <span className="canvas-port-field-label" aria-hidden="true" style={{
              // Absolutely positioned OUTSIDE the handle: no card layout or hit-target changes.
              position: 'absolute', top: '50%', transform: 'translateY(-50%)',
              ...(p.side === 'input' ? { right: 18 } : { left: 18 }),
              maxWidth: expanded ? 220 : 72, width: 'max-content', boxSizing: 'border-box',
              whiteSpace: expanded ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              overflowWrap: 'anywhere', pointerEvents: 'none', textAlign: 'left',
              fontSize: 11, fontWeight: 500, lineHeight: 1.4, padding: '2px 5px', borderRadius: 4,
              color: 'var(--awwo-muted, var(--muted))', background: 'var(--awwo-card, var(--card))',
              border: '1px solid var(--awwo-line, var(--line))',
            }}>{portLabel}</span> : null}
            {countLabel ? <span className="canvas-port-count">{countLabel}</span> : null}
          </button>
          {/* A sibling of the handle, not a child: a button's content is its name, and this is its description.
              It sits beside the port on the tile's side and takes no pointer events, so it never covers a wire's
              target or changes the gesture. Kept in the document while hidden, so aria-describedby always resolves. */}
          {guide ? <div id={guideId} role="tooltip" className={`canvas-port-guide canvas-port-guide--${p.side}`}
            hidden={!expanded} style={{ left: anchor.x - node.x, top: anchor.y - node.y, transformOrigin: '0 0',
              transform: `scale(${unzoom}) translate(${p.side === 'input' ? '14px' : 'calc(-100% - 14px)'}, -50%)` }}>
            <span className="canvas-port-guide-title">{headline}</span>
            <span className="canvas-port-guide-body">{guide}</span>
          </div> : null}
          </Fragment>
        );
      })}
    </>
  );
}
