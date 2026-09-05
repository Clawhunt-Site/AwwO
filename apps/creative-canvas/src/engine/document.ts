import type {
  CreativeDocument,
  CreativeEdge,
  CreativeNode,
  CreativeNodeType,
  Director3DNode,
  NodePortDefinition,
  Point,
  PoseJoint,
  PoseNode,
  PortDataType,
  ScriptBeat,
  ScriptDirectorNode,
  ScriptShot,
  StoryboardFrame,
  StoryboardNode,
  Viewport,
  Vr360Node,
} from '../types';
import { buildSeedanceDirectPrompt } from './seedancePrompt';

export const CREATIVE_DOCUMENT_STORAGE_KEY = 'superclaw.creative-canvas.document.v1';

export const NODE_PORTS: Record<CreativeNodeType, NodePortDefinition> = {
  'script-director': {
    inputs: [],
    outputs: [{ id: 'script-plan', label: '剧本方案', dataType: 'script' }],
  },
  pose: {
    inputs: [],
    outputs: [{ id: 'pose', label: '骨架', dataType: 'pose' }],
  },
  storyboard: {
    inputs: [
      { id: 'script-plan', label: '剧本方案', dataType: 'script' },
      { id: 'pose-reference', label: '姿势参考', dataType: 'pose' },
      { id: 'image-reference', label: '画面参考', dataType: 'image' },
    ],
    outputs: [{ id: 'storyboard-image', label: '分镜图', dataType: 'image' }],
  },
  'director-3d': {
    inputs: [
      { id: 'script-plan', label: '剧本方案', dataType: 'script' },
      { id: 'pose-reference', label: '人物姿势', dataType: 'pose' },
      { id: 'image-reference', label: '画面参考', dataType: 'image' },
    ],
    outputs: [
      { id: 'scene-layout', label: '3D 场景', dataType: 'scene3d' },
      { id: 'shot-preview', label: '镜头预览', dataType: 'image' },
    ],
  },
  vr360: {
    inputs: [{ id: 'panorama', label: '全景图', dataType: 'image' }],
    outputs: [{ id: 'view-reference', label: '视角图', dataType: 'image' }],
  },
};

const DEFAULT_POSE_JOINTS: PoseJoint[] = [
  { id: 'head', x: 240, y: 74 },
  { id: 'neck', x: 240, y: 132 },
  { id: 'leftShoulder', x: 176, y: 158 },
  { id: 'rightShoulder', x: 304, y: 158 },
  { id: 'leftElbow', x: 144, y: 246 },
  { id: 'rightElbow', x: 336, y: 246 },
  { id: 'leftWrist', x: 126, y: 334 },
  { id: 'rightWrist', x: 354, y: 334 },
  { id: 'pelvis', x: 240, y: 330 },
  { id: 'leftKnee', x: 202, y: 458 },
  { id: 'rightKnee', x: 278, y: 458 },
  { id: 'leftAnkle', x: 190, y: 590 },
  { id: 'rightAnkle', x: 290, y: 590 },
];

let idCounter = 0;

export function creativeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function frame(id: number, description: string): StoryboardFrame {
  return { id: `frame-${id}`, description, referenceIndex: null, status: 'draft' };
}

export function createNode(type: 'storyboard', at: Point): StoryboardNode;
export function createNode(type: 'vr360', at: Point): Vr360Node;
export function createNode(type: 'pose', at: Point): PoseNode;
export function createNode(type: 'script-director', at: Point): ScriptDirectorNode;
export function createNode(type: 'director-3d', at: Point): Director3DNode;
export function createNode(type: CreativeNodeType, at: Point): CreativeNode {
  if (type === 'script-director') {
    const premise = '一名调查员在雨夜进入废弃剧院，发现舞台灯突然亮起。';
    return {
      id: creativeId('script-director'),
      type,
      title: 'AI 剧本导演台',
      x: at.x,
      y: at.y,
      data: {
        premise,
        genre: '悬疑',
        tone: '克制、潮湿、逐步压迫',
        cast: '调查员林岚；失踪的舞台监督',
        targetDurationSec: 60,
        beats: buildScriptBeats(premise, 60),
        aspectRatio: '9:16',
        shotCount: 8,
        pace: '标准节奏',
        visualStyle: '真人电影感',
        maintainCharacterContinuity: true,
        generateVideoPrompts: true,
        characterReference: '',
        sceneReference: '',
        shots: [],
      },
    };
  }
  if (type === 'storyboard') {
    return {
      id: creativeId('storyboard'),
      type,
      title: '分镜生成',
      x: at.x,
      y: at.y,
      data: {
        globalPrompt: '一名调查员在雨夜进入废弃剧院，发现舞台灯突然亮起。',
        rows: 2,
        cols: 2,
        aspectRatio: '16:9',
        frames: [
          frame(1, '远景：雨夜中的废弃剧院外观'),
          frame(2, '中景：调查员推开生锈的侧门'),
          frame(3, '近景：鞋底踏过积水与旧票根'),
          frame(4, '大全景：黑暗舞台的灯骤然亮起'),
        ],
      },
    };
  }
  if (type === 'vr360') {
    return {
      id: creativeId('vr360'),
      type,
      title: 'VR360 全景',
      x: at.x,
      y: at.y,
      data: { imageUrl: null, fileName: null, yaw: 0, pitch: 0, fov: 90, referenceCount: 0 },
    };
  }
  if (type === 'director-3d') {
    return {
      id: creativeId('director-3d'),
      type,
      title: '3D 导演台',
      x: at.x,
      y: at.y,
      data: {
        scenePreset: '废弃剧院',
        shotSize: '中景',
        lensMm: 50,
        cameraYaw: -24,
        cameraPitch: 12,
        cameraDistance: 8,
        actorX: 0,
        actorZ: 0,
        keyLightAngle: 42,
        keyLightIntensity: 72,
        directorNote: '镜头从舞台侧后方缓慢靠近，保持人物与亮起的顶灯同框。',
        savedTake: null,
        previewDataUrl: null,
        backgroundName: null,
        backgroundDataUrl: null,
        selectedShotTemplate: null,
        characters: [
          { id: 'actor-1', name: '#1 站立', color: '#ef4c43', x: -1.6, z: 0 },
          { id: 'actor-2', name: '#2 站立', color: '#16c768', x: 1.6, z: 0 },
        ],
        props: [],
        videoPrompt: '',
      },
    };
  }
  return {
    id: creativeId('pose'),
    type,
    title: '姿势编辑器',
    x: at.x,
    y: at.y,
    data: {
      joints: DEFAULT_POSE_JOINTS.map((joint) => ({ ...joint })),
      previewDataUrl: null,
      lockHands: true,
      lockFacing: true,
      lockPose: true,
    },
  };
}

export function createDefaultDocument(): CreativeDocument {
  const scriptDirector = createNode('script-director', { x: 70, y: 70 });
  const storyboard = createNode('storyboard', { x: 560, y: 70 });
  const director3d = createNode('director-3d', { x: 1140, y: 70 });
  const vr360 = createNode('vr360', { x: 1640, y: 100 });
  const pose = createNode('pose', { x: 560, y: 760 });
  return {
    version: 1,
    id: 'creative-canvas-default',
    title: 'AI 影像导演实验室',
    updatedAt: Date.now(),
    nodes: [scriptDirector, storyboard, director3d, vr360, pose],
    edges: [
      {
        id: `edge-${scriptDirector.id}-${storyboard.id}`,
        sourceNodeId: scriptDirector.id,
        sourcePort: 'script-plan',
        targetNodeId: storyboard.id,
        targetPort: 'script-plan',
        dataType: 'script',
      },
      {
        id: `edge-${pose.id}-${storyboard.id}`,
        sourceNodeId: pose.id,
        sourcePort: 'pose',
        targetNodeId: storyboard.id,
        targetPort: 'pose-reference',
        dataType: 'pose',
      },
      {
        id: `edge-${storyboard.id}-${director3d.id}`,
        sourceNodeId: storyboard.id,
        sourcePort: 'storyboard-image',
        targetNodeId: director3d.id,
        targetPort: 'image-reference',
        dataType: 'image',
      },
      {
        id: `edge-${scriptDirector.id}-${director3d.id}`,
        sourceNodeId: scriptDirector.id,
        sourcePort: 'script-plan',
        targetNodeId: director3d.id,
        targetPort: 'script-plan',
        dataType: 'script',
      },
      {
        id: `edge-${pose.id}-${director3d.id}`,
        sourceNodeId: pose.id,
        sourcePort: 'pose',
        targetNodeId: director3d.id,
        targetPort: 'pose-reference',
        dataType: 'pose',
      },
      {
        id: `edge-${director3d.id}-${vr360.id}`,
        sourceNodeId: director3d.id,
        sourcePort: 'shot-preview',
        targetNodeId: vr360.id,
        targetPort: 'panorama',
        dataType: 'image',
      },
    ],
    viewport: { x: 36, y: 62, scale: 0.58 },
  };
}

export function buildScriptBeats(premise: string, targetDurationSec: number): ScriptBeat[] {
  const fragments = premise
    .split(/[。！？!?；;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const story = fragments.length > 0 ? fragments : ['人物进入未知空间', '目标受阻', '真相出现', '留下新的悬念'];
  const acts: ScriptBeat['act'][] = ['开场', '推进', '转折', '收束'];
  const conflicts = ['异常征兆打破日常', '人物的目标遭到阻拦', '新信息改变原有判断', '选择带来代价与余波'];
  const visuals = ['用环境细节建立规则', '让动作在空间里产生阻力', '用光线或构图完成信息反转', '停在可继续发展的视觉悬念'];
  const duration = Math.max(4, Math.round(Math.max(16, targetDurationSec) / acts.length));
  return acts.map((act, index) => ({
    id: creativeId('beat'),
    act,
    objective: story[index % story.length],
    conflict: conflicts[index],
    visualHook: visuals[index],
    durationSec: duration,
  }));
}

export function buildScriptShots(
  premise: string,
  count: number,
  cast: string,
  visualStyle: string,
  references?: { subject?: string; scene?: string },
): ScriptShot[] {
  const beats = buildScriptBeats(premise, Math.max(20, count * 6));
  const shotSizes = ['远景', '中景', '近景', '特写', '俯拍', '侧面双人景'];
  const moves = ['固定机位', '缓慢推进', '横向跟拍', '轻微环绕', '手持靠近', '拉远揭示空间'];
  const characters = cast.split(/[；;,，]/).map((item) => item.trim()).filter(Boolean).join('、') || '主要人物';
  return Array.from({ length: Math.max(1, count) }, (_, index) => {
    const beat = beats[index % beats.length];
    const shotSize = shotSizes[index % shotSizes.length];
    const cameraMove = moves[index % moves.length];
    const title = `镜头 ${String(index + 1).padStart(2, '0')} · ${beat.act}`;
    const lensMm = shotSize === '远景' || shotSize === '俯拍' ? 35 : shotSize === '中景' || shotSize === '侧面双人景' ? 50 : 85;
    const imagePrompt = `${visualStyle}，${shotSize}，${characters}，${beat.objective}，${beat.visualHook}`;
    const videoPrompt = buildSeedanceDirectPrompt({
      subjectReference: references?.subject,
      subjectChange: `${characters}参与本镜头；保持人物身份、服装和上一镜头结束时的站位连续`,
      sceneReference: references?.scene,
      sceneRelation: `${beat.visualHook}；人物与关键物体的相对位置在动作过程中保持清楚`,
      shots: [{
        title,
        transition: index === 0 ? '硬切开场' : '动作匹配剪切',
        shotSize,
        lensMm,
        composition: shotSize.includes('双人') ? '双人关系构图，人物分居画面两侧' : '主体位于画面三分线，动作方向留出空间',
        cameraMove,
        focus: '焦点跟随当前动作主体，主要动作完成后停稳',
        finalComposition: `${shotSize}落幅，主体动作和关键空间关系同时清楚`,
        visibleAction: `起手时${characters}位于动作起点；镜头运动过程中${beat.objective}；落幅时动作完成，${beat.visualHook}`,
        sound: `延续场景环境底噪，人物动作对应的脚步、衣料摩擦和呼吸声；冲突发生时加入对应动作声`,
      }],
    });
    return {
      id: creativeId('shot'),
      title,
      character: characters,
      action: beat.objective,
      scene: beat.visualHook,
      shotSize,
      cameraMove,
      imagePrompt,
      videoPrompt,
    };
  });
}

export function buildFramesFromPrompt(prompt: string, count: number): StoryboardFrame[] {
  const beats = prompt
    .split(/[。！？!?；;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const safeBeats = beats.length > 0 ? beats : ['建立场景', '人物行动', '冲突出现', '结果与悬念'];
  const shots = ['远景', '中景', '近景', '特写', '俯拍', '侧面跟拍'];
  return Array.from({ length: Math.max(1, count) }, (_, index) => ({
    id: creativeId('frame'),
    description: `${shots[index % shots.length]}：${safeBeats[index % safeBeats.length]}`,
    referenceIndex: null,
    status: 'ready',
  }));
}

export function updateNode<T extends CreativeNode>(
  document: CreativeDocument,
  nodeId: string,
  updater: (node: T) => T,
): CreativeDocument {
  return {
    ...document,
    updatedAt: Date.now(),
    nodes: document.nodes.map((node) => (node.id === nodeId ? updater(node as T) : node)),
  };
}

export function moveNode(document: CreativeDocument, nodeId: string, at: Point): CreativeDocument {
  return updateNode(document, nodeId, (node) => ({ ...node, ...at }));
}

export function addNode(document: CreativeDocument, type: CreativeNodeType, at: Point): CreativeDocument {
  return { ...document, updatedAt: Date.now(), nodes: [...document.nodes, createNode(type as never, at) as CreativeNode] };
}

export function removeNode(document: CreativeDocument, nodeId: string): CreativeDocument {
  return {
    ...document,
    updatedAt: Date.now(),
    nodes: document.nodes.filter((node) => node.id !== nodeId),
    edges: document.edges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId),
  };
}

export function updateViewport(document: CreativeDocument, viewport: Viewport): CreativeDocument {
  return { ...document, updatedAt: Date.now(), viewport };
}

export function canConnect(
  document: CreativeDocument,
  sourceNodeId: string,
  sourcePort: string,
  targetNodeId: string,
  targetPort: string,
): PortDataType | null {
  if (sourceNodeId === targetNodeId) return null;
  const source = document.nodes.find((node) => node.id === sourceNodeId);
  const target = document.nodes.find((node) => node.id === targetNodeId);
  if (!source || !target) return null;
  const output = NODE_PORTS[source.type].outputs.find((port) => port.id === sourcePort);
  const input = NODE_PORTS[target.type].inputs.find((port) => port.id === targetPort);
  return output && input && output.dataType === input.dataType ? output.dataType : null;
}

export function connectNodes(
  document: CreativeDocument,
  sourceNodeId: string,
  sourcePort: string,
  targetNodeId: string,
  targetPort: string,
): CreativeDocument {
  const dataType = canConnect(document, sourceNodeId, sourcePort, targetNodeId, targetPort);
  if (!dataType) return document;
  const id = `edge-${sourceNodeId}-${sourcePort}-${targetNodeId}-${targetPort}`;
  if (document.edges.some((edge) =>
    edge.sourceNodeId === sourceNodeId
    && edge.sourcePort === sourcePort
    && edge.targetNodeId === targetNodeId
    && edge.targetPort === targetPort,
  )) return document;
  const edge: CreativeEdge = { id, sourceNodeId, sourcePort, targetNodeId, targetPort, dataType };
  const retained = document.edges.filter((candidate) =>
    candidate.targetNodeId !== targetNodeId || candidate.targetPort !== targetPort,
  );
  return { ...document, updatedAt: Date.now(), edges: [...retained, edge] };
}

const CREATIVE_NODE_TYPES = new Set<CreativeNodeType>([
  'script-director',
  'storyboard',
  'director-3d',
  'vr360',
  'pose',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function hasSafeNodeData(type: CreativeNodeType, data: Record<string, unknown>): boolean {
  if (type === 'storyboard') {
    return typeof data.globalPrompt === 'string'
      && isFiniteNumber(data.rows) && data.rows > 0
      && Number.isInteger(data.rows) && data.rows <= 12
      && isFiniteNumber(data.cols) && data.cols > 0
      && Number.isInteger(data.cols) && data.cols <= 12
      && typeof data.aspectRatio === 'string'
      && Array.isArray(data.frames)
      && data.frames.every((frame) => isRecord(frame)
        && typeof frame.id === 'string'
        && typeof frame.description === 'string'
        && (frame.referenceIndex === null || isFiniteNumber(frame.referenceIndex))
        && ['draft', 'ready'].includes(frame.status as string));
  }
  if (type === 'script-director') {
    return typeof data.premise === 'string'
      && typeof data.genre === 'string'
      && typeof data.tone === 'string'
      && typeof data.cast === 'string'
      && isFiniteNumber(data.targetDurationSec) && data.targetDurationSec > 0
      && Array.isArray(data.beats)
      && data.beats.every((beat) => isRecord(beat)
        && typeof beat.id === 'string'
        && typeof beat.act === 'string'
        && typeof beat.objective === 'string'
        && typeof beat.conflict === 'string'
        && typeof beat.visualHook === 'string'
        && isFiniteNumber(beat.durationSec)
        && beat.durationSec > 0)
      && typeof data.aspectRatio === 'string'
      && [4, 8, 12].includes(data.shotCount as number)
      && typeof data.pace === 'string'
      && typeof data.visualStyle === 'string'
      && typeof data.maintainCharacterContinuity === 'boolean'
      && typeof data.generateVideoPrompts === 'boolean'
      && typeof data.characterReference === 'string'
      && typeof data.sceneReference === 'string'
      && Array.isArray(data.shots)
      && data.shots.every((shot) => isRecord(shot)
        && ['id', 'title', 'character', 'action', 'scene', 'shotSize', 'cameraMove', 'imagePrompt', 'videoPrompt']
          .every((field) => typeof shot[field] === 'string'));
  }
  if (type === 'director-3d') {
    const numericFields = [
      data.lensMm,
      data.cameraYaw,
      data.cameraPitch,
      data.cameraDistance,
      data.actorX,
      data.actorZ,
      data.keyLightAngle,
      data.keyLightIntensity,
    ];
    return typeof data.scenePreset === 'string'
      && typeof data.shotSize === 'string'
      && numericFields.every(isFiniteNumber)
      && typeof data.directorNote === 'string'
      && isNullableString(data.savedTake)
      && isNullableString(data.previewDataUrl)
      && isNullableString(data.backgroundName)
      && isNullableString(data.backgroundDataUrl)
      && isNullableString(data.selectedShotTemplate)
      && Array.isArray(data.characters)
      && data.characters.every((character) => isRecord(character)
        && typeof character.id === 'string'
        && typeof character.name === 'string'
        && typeof character.color === 'string'
        && isFiniteNumber(character.x)
        && isFiniteNumber(character.z))
      && Array.isArray(data.props)
      && data.props.every((prop) => typeof prop === 'string')
      && typeof data.videoPrompt === 'string';
  }
  if (type === 'vr360') {
    return isNullableString(data.imageUrl)
      && isNullableString(data.fileName)
      && isFiniteNumber(data.yaw)
      && isFiniteNumber(data.pitch)
      && isFiniteNumber(data.fov)
      && data.fov > 0
      && [0, 4, 12].includes(data.referenceCount as number);
  }
  return Array.isArray(data.joints)
    && data.joints.every((joint) => isRecord(joint)
      && typeof joint.id === 'string'
      && isFiniteNumber(joint.x)
      && isFiniteNumber(joint.y))
    && typeof data.lockHands === 'boolean'
    && typeof data.lockFacing === 'boolean'
    && typeof data.lockPose === 'boolean'
    && isNullableString(data.previewDataUrl);
}

function normalizeNode(value: unknown): CreativeNode | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || value.id.trim().length === 0
    || typeof value.title !== 'string'
    || typeof value.type !== 'string'
    || !CREATIVE_NODE_TYPES.has(value.type as CreativeNodeType)
    || !isFiniteNumber(value.x)
    || !isFiniteNumber(value.y)
    || !isRecord(value.data)) return null;
  const type = value.type as CreativeNodeType;
  const fallback = createNode(type as never, { x: value.x, y: value.y }) as CreativeNode;
  const candidateData = { ...fallback.data, ...value.data } as Record<string, unknown>;
  return {
    ...fallback,
    id: value.id,
    title: value.title,
    x: value.x,
    y: value.y,
    data: hasSafeNodeData(type, candidateData) ? candidateData : fallback.data,
  } as CreativeNode;
}

function normalizeDocument(value: unknown): CreativeDocument | null {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || !isFiniteNumber(value.updatedAt)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !isRecord(value.viewport)
    || !isFiniteNumber(value.viewport.x)
    || !isFiniteNumber(value.viewport.y)
    || !isFiniteNumber(value.viewport.scale)
    || value.viewport.scale <= 0) return null;

  const nodes = value.nodes.map(normalizeNode);
  if (nodes.some((node) => node === null)) return null;
  const safeNodes = nodes as CreativeNode[];
  const nodeIds = new Set(safeNodes.map((node) => node.id));
  if (nodeIds.size !== safeNodes.length) return null;

  const base: CreativeDocument = {
    version: 1,
    id: value.id,
    title: value.title,
    updatedAt: value.updatedAt,
    nodes: safeNodes,
    edges: [],
    viewport: {
      x: value.viewport.x as number,
      y: value.viewport.y as number,
      scale: value.viewport.scale as number,
    },
  };
  const byInput = new Map<string, CreativeEdge>();
  for (const candidate of value.edges) {
    if (!isRecord(candidate)
      || typeof candidate.id !== 'string'
      || typeof candidate.sourceNodeId !== 'string'
      || typeof candidate.sourcePort !== 'string'
      || typeof candidate.targetNodeId !== 'string'
      || typeof candidate.targetPort !== 'string') continue;
    const dataType = canConnect(
      base,
      candidate.sourceNodeId,
      candidate.sourcePort,
      candidate.targetNodeId,
      candidate.targetPort,
    );
    if (!dataType) continue;
    byInput.set(`${candidate.targetNodeId}:${candidate.targetPort}`, {
      id: candidate.id,
      sourceNodeId: candidate.sourceNodeId,
      sourcePort: candidate.sourcePort,
      targetNodeId: candidate.targetNodeId,
      targetPort: candidate.targetPort,
      dataType,
    });
  }
  return { ...base, edges: [...byInput.values()] };
}

export function saveDocument(document: CreativeDocument, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(CREATIVE_DOCUMENT_STORAGE_KEY, JSON.stringify(document));
  } catch {
    // Storage can be disabled or full; the current session stays usable.
  }
}

export function loadDocument(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): CreativeDocument {
  try {
    const raw = storage?.getItem(CREATIVE_DOCUMENT_STORAGE_KEY);
    if (!raw) return createDefaultDocument();
    const parsed: unknown = JSON.parse(raw);
    return normalizeDocument(parsed) ?? createDefaultDocument();
  } catch {
    return createDefaultDocument();
  }
}
