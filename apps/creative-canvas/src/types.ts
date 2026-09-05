export type CreativeNodeType = 'script-director' | 'storyboard' | 'director-3d' | 'vr360' | 'pose';
export type PortDataType = 'script' | 'scene3d' | 'image' | 'pose';

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface StoryboardFrame {
  id: string;
  description: string;
  referenceIndex: number | null;
  status: 'draft' | 'ready';
}

export interface StoryboardNodeData {
  globalPrompt: string;
  rows: number;
  cols: number;
  aspectRatio: '16:9' | '9:16' | '1:1' | '2.39:1';
  frames: StoryboardFrame[];
}

export interface ScriptBeat {
  id: string;
  act: '开场' | '推进' | '转折' | '收束';
  objective: string;
  conflict: string;
  visualHook: string;
  durationSec: number;
}

export interface ScriptShot {
  id: string;
  title: string;
  character: string;
  action: string;
  scene: string;
  shotSize: string;
  cameraMove: string;
  imagePrompt: string;
  videoPrompt: string;
}

export interface ScriptDirectorNodeData {
  premise: string;
  genre: '悬疑' | '动作' | '爱情' | '喜剧' | '科幻';
  tone: string;
  cast: string;
  targetDurationSec: number;
  beats: ScriptBeat[];
  aspectRatio: '16:9' | '9:16' | '1:1';
  shotCount: 4 | 8 | 12;
  pace: '舒缓节奏' | '标准节奏' | '快速节奏';
  visualStyle: string;
  maintainCharacterContinuity: boolean;
  generateVideoPrompts: boolean;
  characterReference: string;
  sceneReference: string;
  shots: ScriptShot[];
}

export interface Director3DNodeData {
  scenePreset: '摄影棚' | '雨夜街道' | '废弃剧院';
  shotSize: '远景' | '中景' | '近景';
  lensMm: 24 | 35 | 50 | 85;
  cameraYaw: number;
  cameraPitch: number;
  cameraDistance: number;
  actorX: number;
  actorZ: number;
  keyLightAngle: number;
  keyLightIntensity: number;
  directorNote: string;
  savedTake: string | null;
  previewDataUrl: string | null;
  backgroundName: string | null;
  backgroundDataUrl: string | null;
  selectedShotTemplate: string | null;
  characters: Array<{ id: string; name: string; color: string; x: number; z: number }>;
  props: string[];
  videoPrompt: string;
}

export interface Vr360NodeData {
  imageUrl: string | null;
  fileName: string | null;
  yaw: number;
  pitch: number;
  fov: number;
  referenceCount: 0 | 4 | 12;
}

export type PoseJointId =
  | 'head'
  | 'neck'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftElbow'
  | 'rightElbow'
  | 'leftWrist'
  | 'rightWrist'
  | 'pelvis'
  | 'leftKnee'
  | 'rightKnee'
  | 'leftAnkle'
  | 'rightAnkle';

export interface PoseJoint extends Point {
  id: PoseJointId;
}

export interface PoseNodeData {
  joints: PoseJoint[];
  previewDataUrl: string | null;
  lockHands: boolean;
  lockFacing: boolean;
  lockPose: boolean;
}

interface CreativeNodeBase {
  id: string;
  title: string;
  x: number;
  y: number;
}

export interface StoryboardNode extends CreativeNodeBase {
  type: 'storyboard';
  data: StoryboardNodeData;
}

export interface ScriptDirectorNode extends CreativeNodeBase {
  type: 'script-director';
  data: ScriptDirectorNodeData;
}

export interface Director3DNode extends CreativeNodeBase {
  type: 'director-3d';
  data: Director3DNodeData;
}

export interface Vr360Node extends CreativeNodeBase {
  type: 'vr360';
  data: Vr360NodeData;
}

export interface PoseNode extends CreativeNodeBase {
  type: 'pose';
  data: PoseNodeData;
}

export type CreativeNode = ScriptDirectorNode | StoryboardNode | Director3DNode | Vr360Node | PoseNode;

export interface CreativeEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  dataType: PortDataType;
}

export interface CreativeDocument {
  version: 1;
  id: string;
  title: string;
  updatedAt: number;
  nodes: CreativeNode[];
  edges: CreativeEdge[];
  viewport: Viewport;
}

export interface NodePort {
  id: string;
  label: string;
  dataType: PortDataType;
}

export interface NodePortDefinition {
  inputs: NodePort[];
  outputs: NodePort[];
}
