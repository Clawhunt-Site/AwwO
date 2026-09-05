import { useEffect, useMemo, useRef, useState } from 'react';

import { NODE_PORTS, canConnect } from '../engine/document';
import type {
  CreativeDocument,
  CreativeNode,
  Director3DNode,
  NodePort,
  Point,
  StoryboardNode,
  Viewport,
  Vr360Node,
  PoseNode,
  ScriptDirectorNode,
} from '../types';
import { Director3DNodeCard } from '../components/Director3DNode';
import { PoseEditorNodeCard } from '../components/PoseEditorNode';
import { ScriptDirectorNodeCard } from '../components/ScriptDirectorNode';
import { StoryboardNodeCard } from '../components/StoryboardNode';
import { Vr360NodeCard } from '../components/Vr360Node';

export const NODE_SIZE: Record<CreativeNode['type'], { width: number; height: number }> = {
  'script-director': { width: 430, height: 650 },
  pose: { width: 320, height: 430 },
  storyboard: { width: 510, height: 610 },
  'director-3d': { width: 450, height: 680 },
  vr360: { width: 420, height: 520 },
};

interface PendingConnection {
  nodeId: string;
  portId: string;
}

function edgePath(source: CreativeNode, target: CreativeNode): string {
  const sourceSize = NODE_SIZE[source.type];
  const targetSize = NODE_SIZE[target.type];
  const x1 = source.x + sourceSize.width;
  const y1 = source.y + sourceSize.height / 2;
  const x2 = target.x;
  const y2 = target.y + targetSize.height / 2;
  const bend = Math.max(80, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function NodePorts({
  node,
  side,
  pending,
  document,
  onOutput,
  onInput,
}: {
  node: CreativeNode;
  side: 'input' | 'output';
  pending: PendingConnection | null;
  document: CreativeDocument;
  onOutput: (port: NodePort) => void;
  onInput: (port: NodePort) => void;
}) {
  const ports = side === 'input' ? NODE_PORTS[node.type].inputs : NODE_PORTS[node.type].outputs;
  return (
    <div className={`cc-node-ports cc-node-ports--${side}`}>
      {ports.map((port) => {
        const compatible = side === 'input' && pending
          ? canConnect(document, pending.nodeId, pending.portId, node.id, port.id) !== null
          : false;
        return (
          <button
            key={port.id}
            className={`${compatible ? 'is-compatible' : ''}${pending?.nodeId === node.id && pending.portId === port.id ? ' is-pending' : ''}`}
            type="button"
            title={`${port.label} · ${port.dataType}`}
            aria-label={`${side === 'input' ? '输入' : '输出'}：${port.label}`}
            onClick={(event) => {
              event.stopPropagation();
              if (side === 'input') onInput(port);
              else onOutput(port);
            }}
          >
            <span />
            <em>{port.label}</em>
          </button>
        );
      })}
    </div>
  );
}

function NodeContent({
  node,
  onChange,
  onOpenPose,
  onOpenScript,
  onOpenDirector3D,
}: {
  node: CreativeNode;
  onChange: (node: CreativeNode) => void;
  onOpenPose: () => void;
  onOpenScript: () => void;
  onOpenDirector3D: () => void;
}) {
  if (node.type === 'script-director') {
    return <ScriptDirectorNodeCard data={node.data} onChange={(data) => onChange({ ...node, data } as ScriptDirectorNode)} onOpen={onOpenScript} />;
  }
  if (node.type === 'storyboard') {
    return <StoryboardNodeCard data={node.data} onChange={(data) => onChange({ ...node, data } as StoryboardNode)} />;
  }
  if (node.type === 'vr360') {
    return <Vr360NodeCard data={node.data} onChange={(data) => onChange({ ...node, data } as Vr360Node)} />;
  }
  if (node.type === 'director-3d') {
    return <Director3DNodeCard data={node.data} onChange={(data) => onChange({ ...node, data } as Director3DNode)} onOpen={onOpenDirector3D} />;
  }
  return <PoseEditorNodeCard data={node.data} onChange={(data) => onChange({ ...node, data } as PoseNode)} onOpen={onOpenPose} />;
}

export function CreativeCanvas({
  document,
  selectedNodeId,
  onSelectNode,
  onChangeNode,
  onMoveNode,
  onMoveNodeEnd,
  onViewport,
  onConnect,
  onOpenPose,
  onOpenScript,
  onOpenDirector3D,
}: {
  document: CreativeDocument;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onChangeNode: (node: CreativeNode) => void;
  onMoveNode: (nodeId: string, at: Point) => void;
  onMoveNodeEnd: (nodeId: string, from: Point, to: Point) => void;
  onViewport: (viewport: Viewport) => void;
  onConnect: (sourceNodeId: string, sourcePort: string, targetNodeId: string, targetPort: string) => void;
  onOpenPose: (nodeId: string) => void;
  onOpenScript: (nodeId: string) => void;
  onOpenDirector3D: (nodeId: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(document.viewport);
  const [pending, setPending] = useState<PendingConnection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const nodeById = useMemo(() => new Map(document.nodes.map((node) => [node.id, node])), [document.nodes]);
  viewRef.current = document.viewport;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const current = viewRef.current;
      const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
      const scale = Math.max(0.35, Math.min(1.6, current.scale * factor));
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const ratio = scale / current.scale;
      onViewport({ scale, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio });
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, [onViewport]);

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    onSelectNode(null);
    setPending(null);
    const origin = document.viewport;
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (pointerEvent: PointerEvent) => onViewport({
      ...origin,
      x: origin.x + pointerEvent.clientX - startX,
      y: origin.y + pointerEvent.clientY - startY,
    });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const startNodeDrag = (node: CreativeNode, event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    onSelectNode(node.id);
    const origin = { x: node.x, y: node.y };
    let latest = origin;
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (pointerEvent: PointerEvent) => {
      latest = {
        x: origin.x + (pointerEvent.clientX - startX) / viewRef.current.scale,
        y: origin.y + (pointerEvent.clientY - startY) / viewRef.current.scale,
      };
      onMoveNode(node.id, latest);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const up = () => {
      cleanup();
      onMoveNodeEnd(node.id, origin, latest);
    };
    const cancel = () => {
      cleanup();
      onMoveNode(node.id, origin);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const chooseInput = (targetNodeId: string, port: NodePort) => {
    if (!pending) {
      setMessage('请先选择一个输出端口');
      return;
    }
    if (!canConnect(document, pending.nodeId, pending.portId, targetNodeId, port.id)) {
      setMessage('端口类型不兼容');
      return;
    }
    onConnect(pending.nodeId, pending.portId, targetNodeId, port.id);
    setPending(null);
    setMessage('已连接工作流');
  };

  return (
    <div ref={viewportRef} className="creative-viewport" onPointerDown={startPan}>
      <div
        className="creative-world"
        style={{ transform: `translate(${document.viewport.x}px, ${document.viewport.y}px) scale(${document.viewport.scale})` }}
      >
        <div className="creative-grid" />
        <div className="creative-film-rail" aria-hidden="true" />
        <svg className="creative-edges" width="2600" height="1500" aria-hidden="true">
          {document.edges.map((edge) => {
            const source = nodeById.get(edge.sourceNodeId);
            const target = nodeById.get(edge.targetNodeId);
            if (!source || !target) return null;
            return <path key={edge.id} d={edgePath(source, target)} className={`creative-edge is-${edge.dataType}`} />;
          })}
        </svg>
        {document.nodes.map((node) => {
          const size = NODE_SIZE[node.type];
          return (
            <article
              key={node.id}
              className={`creative-node creative-node--${node.type}${selectedNodeId === node.id ? ' is-selected' : ''}`}
              style={{ left: node.x, top: node.y, width: size.width, minHeight: size.height }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onSelectNode(node.id)}
            >
              <NodePorts
                node={node}
                side="input"
                pending={pending}
                document={document}
                onOutput={() => undefined}
                onInput={(port) => chooseInput(node.id, port)}
              />
              <header className="creative-node__header" onPointerDown={(event) => startNodeDrag(node, event)}>
                <span className="creative-node__index">
                  {node.type === 'script-director'
                    ? 'SCRIPT'
                    : node.type === 'storyboard'
                      ? 'STORY'
                      : node.type === 'director-3d'
                        ? '3D STAGE'
                        : node.type === 'vr360'
                          ? 'VR360'
                          : 'POSE'}
                </span>
                <strong>{node.title}</strong>
                <span className="creative-node__drag">拖动</span>
              </header>
              <div className="creative-node__body">
                <NodeContent
                  node={node}
                  onChange={onChangeNode}
                  onOpenPose={() => onOpenPose(node.id)}
                  onOpenScript={() => onOpenScript(node.id)}
                  onOpenDirector3D={() => onOpenDirector3D(node.id)}
                />
              </div>
              <NodePorts
                node={node}
                side="output"
                pending={pending}
                document={document}
                onOutput={(port) => {
                  setPending({ nodeId: node.id, portId: port.id });
                  setMessage(`已选择输出：${port.label}`);
                }}
                onInput={() => undefined}
              />
            </article>
          );
        })}
      </div>
      <div className="creative-zoom" aria-label="画布缩放">
        <button type="button" onClick={() => onViewport({ ...document.viewport, scale: Math.min(1.6, document.viewport.scale * 1.12) })}>＋</button>
        <span>{Math.round(document.viewport.scale * 100)}%</span>
        <button type="button" onClick={() => onViewport({ ...document.viewport, scale: Math.max(0.35, document.viewport.scale / 1.12) })}>－</button>
      </div>
      {message ? <div className="creative-toast" role="status">{message}</div> : null}
    </div>
  );
}
