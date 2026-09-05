import { useEffect, useMemo, useRef, useState } from 'react';

import { CreativeCanvas, NODE_SIZE } from './canvas/CreativeCanvas';
import { Director3DModal } from './components/Director3DModal';
import { PoseEditorModal } from './components/PoseEditorModal';
import { ScriptDirectorModal } from './components/ScriptDirectorModal';
import { TimelinePanel } from './components/TimelinePanel';
import {
  addNode,
  connectNodes,
  createDefaultDocument,
  loadDocument,
  moveNode,
  removeNode,
  saveDocument,
  updateNode,
  updateViewport,
} from './engine/document';
import { loadTimelineDocument, saveTimelineDocument } from './engine/timelineStorage';
import type {
  CreativeDocument,
  CreativeNode,
  CreativeNodeType,
  Director3DNode,
  PoseNode,
  ScriptDirectorNode,
  StoryboardNode,
} from './types';

const TYPE_LABEL: Record<CreativeNodeType, string> = {
  'script-director': 'AI 剧本导演台',
  storyboard: '分镜生成',
  'director-3d': '3D 导演台',
  vr360: 'VR360 全景',
  pose: '姿势编辑器',
};

const TYPE_MARK: Record<CreativeNodeType, string> = {
  'script-director': '导',
  storyboard: '镜',
  'director-3d': '3D',
  vr360: '360',
  pose: '姿',
};

function findOpenNodePosition(
  document: CreativeDocument,
  type: CreativeNodeType,
  preferred: { x: number; y: number },
): { x: number; y: number } {
  const size = NODE_SIZE[type];
  const occupied = document.nodes.map((node) => ({ ...NODE_SIZE[node.type], x: node.x, y: node.y }));
  const candidates = [
    preferred,
    ...Array.from({ length: 20 }, (_, row) => [20, 560, 920, 1460, 2000].map((x) => ({ x, y: 70 + row * 720 }))).flat(),
  ];
  const padding = 30;
  const available = candidates.find((candidate) => occupied.every((box) => (
    candidate.x + size.width + padding <= box.x
    || candidate.x >= box.x + box.width + padding
    || candidate.y + size.height + padding <= box.y
    || candidate.y >= box.y + box.height + padding
  )));
  if (available) return available;
  const bottom = occupied.reduce((maximum, box) => Math.max(maximum, box.y + box.height), 0);
  return { x: 70, y: bottom + padding };
}

export function App() {
  const shellRef = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<CreativeDocument>(() => loadDocument());
  const [initialTimeline] = useState(() => loadTimelineDocument());
  const [past, setPast] = useState<CreativeDocument[]>([]);
  const [future, setFuture] = useState<CreativeDocument[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(document.nodes[1]?.id ?? null);
  const [poseEditorNodeId, setPoseEditorNodeId] = useState<string | null>(null);
  const [scriptDirectorNodeId, setScriptDirectorNodeId] = useState<string | null>(null);
  const [director3dNodeId, setDirector3dNodeId] = useState<string | null>(null);
  const selectedNode = useMemo(
    () => document.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [document.nodes, selectedNodeId],
  );
  const poseEditorNode = poseEditorNodeId
    ? document.nodes.find((node): node is PoseNode => node.id === poseEditorNodeId && node.type === 'pose') ?? null
    : null;
  const scriptDirectorNode = scriptDirectorNodeId
    ? document.nodes.find((node): node is ScriptDirectorNode => node.id === scriptDirectorNodeId && node.type === 'script-director') ?? null
    : null;
  const director3dNode = director3dNodeId
    ? document.nodes.find((node): node is Director3DNode => node.id === director3dNodeId && node.type === 'director-3d') ?? null
    : null;
  const hasOpenModal = Boolean(poseEditorNode || scriptDirectorNode || director3dNode);

  useEffect(() => saveDocument(document), [document]);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (hasOpenModal) shell.setAttribute('inert', '');
    else shell.removeAttribute('inert');
  }, [hasOpenModal]);

  const commit = (next: CreativeDocument) => {
    if (next === document) return;
    setPast((items) => [...items.slice(-59), document]);
    setDocument(next);
    setFuture([]);
  };

  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [document, ...items].slice(0, 60));
    setDocument(previous);
    setSelectedNodeId(null);
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture((items) => items.slice(1));
    setPast((items) => [...items.slice(-59), document]);
    setDocument(next);
    setSelectedNodeId(null);
  };

  const appendNode = (type: CreativeNodeType) => {
    const index = document.nodes.length;
    const position = findOpenNodePosition(document, type, { x: 180 + index * 72, y: 150 + index * 48 });
    const next = addNode(document, type, position);
    commit(next);
    setSelectedNodeId(next.nodes.at(-1)?.id ?? null);
  };

  const reset = () => {
    const next = createDefaultDocument();
    commit(next);
    setSelectedNodeId(next.nodes[1]?.id ?? null);
    setScriptDirectorNodeId(null);
    setDirector3dNodeId(null);
    setPoseEditorNodeId(null);
  };

  const createStoryboardFromScript = (scriptNode: ScriptDirectorNode) => {
    const rows = scriptNode.data.shotCount === 4 ? 2 : 3;
    const cols = scriptNode.data.shotCount === 12 ? 4 : scriptNode.data.shotCount === 4 ? 2 : 3;
    const position = findOpenNodePosition(document, 'storyboard', { x: scriptNode.x + 500, y: scriptNode.y + 30 });
    let next = addNode(document, 'storyboard', position);
    const storyboard = next.nodes.at(-1) as StoryboardNode;
    next = updateNode<StoryboardNode>(next, storyboard.id, (node) => ({
      ...node,
      title: 'AI 生图分镜',
      data: {
        ...node.data,
        globalPrompt: scriptNode.data.premise,
        aspectRatio: scriptNode.data.aspectRatio,
        rows,
        cols,
        frames: scriptNode.data.shots.map((shot, index) => ({
          id: shot.id,
          description: `${shot.shotSize} · ${shot.cameraMove}：${shot.action}`,
          referenceIndex: index,
          status: 'ready',
        })),
      },
    }));
    next = connectNodes(next, scriptNode.id, 'script-plan', storyboard.id, 'script-plan');
    commit(next);
    setSelectedNodeId(storyboard.id);
    setScriptDirectorNodeId(null);
  };

  const createFirstFrameFrom3D = (directorNode: Director3DNode) => {
    const position = findOpenNodePosition(document, 'storyboard', { x: directorNode.x + 500, y: directorNode.y + 40 });
    let next = addNode(document, 'storyboard', position);
    const storyboard = next.nodes.at(-1) as StoryboardNode;
    next = updateNode<StoryboardNode>(next, storyboard.id, (node) => ({
      ...node,
      title: '3D 首帧方案',
      data: {
        ...node.data,
        globalPrompt: directorNode.data.directorNote,
        rows: 2,
        cols: 2,
        frames: ['主视角', '动作延续', '反打视角', '空间揭示'].map((label, index) => ({
          id: `${directorNode.id}-take-${index}`,
          description: `${label} · ${directorNode.data.scenePreset} · ${directorNode.data.lensMm}mm · ${directorNode.data.directorNote}`,
          referenceIndex: index,
          status: 'ready',
        })),
      },
    }));
    next = connectNodes(next, directorNode.id, 'shot-preview', storyboard.id, 'image-reference');
    commit(next);
    setSelectedNodeId(storyboard.id);
    setDirector3dNodeId(null);
  };

  return (
    <div className="creative-app">
      <div
        ref={shellRef}
        className="creative-app-shell"
        aria-hidden={hasOpenModal ? true : undefined}
      >
      <header className="creative-topbar">
        <div className="creative-brand">
          <span className="creative-brand__mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <strong>SuperClaw · Creative Canvas</strong>
            <span>剧本到 3D 镜头 · 本地安全模式</span>
          </div>
        </div>
        <div className="creative-topbar__status">
          <span className="creative-save-dot" />
          自动保存
          <time>{new Date(document.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
        <div className="creative-topbar__actions">
          <button type="button" onClick={undo} disabled={past.length === 0}>撤销</button>
          <button type="button" onClick={redo} disabled={future.length === 0}>重做</button>
          <button type="button" onClick={reset}>恢复示例</button>
        </div>
      </header>

      <div className="creative-layout">
        <aside className="creative-toolrail" aria-label="创意节点">
          <span className="creative-toolrail__label">节点</span>
          {(['script-director', 'storyboard', 'director-3d', 'vr360', 'pose'] as CreativeNodeType[]).map((type) => (
            <button key={type} type="button" onClick={() => appendNode(type)}>
              <span>{TYPE_MARK[type]}</span>
              <strong>{TYPE_LABEL[type]}</strong>
            </button>
          ))}
          <div className="creative-toolrail__note">
            <span>安全模式</span>
            <p>当前只编排和导出本地资产，不会提交付费生成。</p>
          </div>
        </aside>

        <main className="creative-stage">
          <div className="creative-stage__heading">
            <div>
              <span>PROJECT / 01</span>
              <h1>{document.title}</h1>
            </div>
            <p>拖动画布和节点；点击输出端口，再点击兼容输入端口完成连线。</p>
          </div>
          <CreativeCanvas
            document={document}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onChangeNode={(node) => commit(updateNode(document, node.id, () => node))}
            onMoveNode={(nodeId, at) => setDocument((current) => moveNode(current, nodeId, at))}
            onMoveNodeEnd={(_, from, to) => {
              if (from.x === to.x && from.y === to.y) return;
              setPast((items) => [...items.slice(-59), document]);
              setFuture([]);
            }}
            onViewport={(viewport) => setDocument((current) => updateViewport(current, viewport))}
            onConnect={(sourceNodeId, sourcePort, targetNodeId, targetPort) =>
              commit(connectNodes(document, sourceNodeId, sourcePort, targetNodeId, targetPort))
            }
            onOpenPose={setPoseEditorNodeId}
            onOpenScript={setScriptDirectorNodeId}
            onOpenDirector3D={setDirector3dNodeId}
          />
          <TimelinePanel
            className="creative-stage__timeline"
            initialDoc={initialTimeline}
            onChange={saveTimelineDocument}
          />
        </main>

        <aside className="creative-inspector" aria-label="节点检查器">
          <span className="creative-inspector__eyebrow">INSPECTOR</span>
          {selectedNode ? (
            <>
              <h2>{selectedNode.title}</h2>
              <div className="creative-inspector__type">{selectedNode.type}</div>
              <dl>
                <div><dt>节点 ID</dt><dd>{selectedNode.id.slice(-10)}</dd></div>
                <div><dt>位置</dt><dd>{Math.round(selectedNode.x)}, {Math.round(selectedNode.y)}</dd></div>
                <div><dt>输入连接</dt><dd>{document.edges.filter((edge) => edge.targetNodeId === selectedNode.id).length}</dd></div>
                <div><dt>输出连接</dt><dd>{document.edges.filter((edge) => edge.sourceNodeId === selectedNode.id).length}</dd></div>
              </dl>
              <div className="creative-inspector__tip">
                <strong>可追溯工作流</strong>
                <p>节点参数、连线、视口与历史记录保存在同一版本化文档中。</p>
              </div>
              <button
                className="cc-button cc-button--danger cc-button--wide"
                type="button"
                onClick={() => {
                  commit(removeNode(document, selectedNode.id));
                  setSelectedNodeId(null);
                }}
              >
                删除节点
              </button>
            </>
          ) : (
            <div className="creative-inspector__empty">
              <strong>选择一个节点</strong>
              <p>这里会显示位置、连接与资产状态。</p>
            </div>
          )}
          <div className="creative-legend">
            <span><i className="is-script" />剧本数据</span>
            <span><i className="is-scene3d" />3D 场景</span>
            <span><i className="is-pose" />姿势数据</span>
            <span><i className="is-image" />图像数据</span>
          </div>
        </aside>
      </div>
      </div>

      {poseEditorNode ? (
        <PoseEditorModal
          data={poseEditorNode.data}
          onCancel={() => setPoseEditorNodeId(null)}
          onSave={(data) => {
            commit(updateNode<PoseNode>(document, poseEditorNode.id, (node) => ({ ...node, data })));
            setPoseEditorNodeId(null);
          }}
        />
      ) : null}

      {scriptDirectorNode ? (
        <ScriptDirectorModal
          data={scriptDirectorNode.data}
          onChange={(data) => commit(updateNode<ScriptDirectorNode>(document, scriptDirectorNode.id, (node) => ({ ...node, data })))}
          onClose={() => setScriptDirectorNodeId(null)}
          onCreateStoryboard={() => createStoryboardFromScript(scriptDirectorNode)}
        />
      ) : null}

      {director3dNode ? (
        <Director3DModal
          data={director3dNode.data}
          onChange={(data) => commit(updateNode<Director3DNode>(document, director3dNode.id, (node) => ({ ...node, data })))}
          onClose={() => setDirector3dNodeId(null)}
          onCreateFirstFrame={() => createFirstFrameFrom3D(director3dNode)}
        />
      ) : null}
    </div>
  );
}
