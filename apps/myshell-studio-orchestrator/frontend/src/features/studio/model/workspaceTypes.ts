import type {
  StudioAction,
  StudioExecutor,
  StudioMode,
  StudioProgressEvent,
  StudioRouteEvent,
  StudioApi,
} from '../api';

export type TabKey = 'chat' | 'preview';
export type CanvasTool = 'select' | 'pan' | 'connect';
export type CanvasNodeKind =
  | 'prompt'
  | 'agent'
  | 'segment'
  | 'output'
  | 'source-text'
  | 'source-image'
  | 'source-video'
  | 'source-audio'
  | 'ai-text'
  | 'ai-image'
  | 'ai-video'
  | 'ai-audio'
  | 'annotation';
export type CanvasSourceType = 'text' | 'image' | 'video' | 'audio' | 'json';
export type CanvasBoardId = 'story' | 'media' | 'timeline';

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status?: string;
  action?: StudioAction;
  prompt?: string;
  segmentId?: string;
  agentId?: string;
  botSlug?: string;
  botName?: string;
  mediaUrl?: string;
  sourceType?: CanvasSourceType;
  fileName?: string;
  outputText?: string;
  boardId?: CanvasBoardId;
}

export interface CanvasConnection {
  id: string;
  from: string;
  to: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface CanvasSnapshot {
  customNodes: CanvasNode[];
  customConnections: CanvasConnection[];
  positionOverrides: Record<string, { x: number; y: number }>;
}

export interface CanvasContextMenuState {
  screenX: number;
  screenY: number;
  canvasX: number;
  canvasY: number;
}

export interface ChatItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  action?: StudioAction;
  pending?: boolean;
  error?: string;
  route?: StudioRouteEvent;
  steps?: StudioProgressEvent[];
  segmentId?: string;
}

export interface StudioDispatchRunOverride {
  pageId: StudioApi | string;
  agentId?: string;
  pageName?: string;
  executor?: StudioExecutor;
  mode?: StudioMode;
  botId?: string;
  articleId?: string;
  botSlug?: string;
  botName?: string;
  botType?: string;
  botSequence?: ManualBotEntry[];
}

export interface ManualBotEntry {
  id: string;
  botId: string;
  botSlug: string;
  botName: string;
  botType: string;
  articleId: string;
  action: StudioAction;
}

export interface StudioStarterPreset {
  id: string;
  title: string;
  prompt: string;
  pageId: StudioApi | string;
  pageName: string;
  agentId: string;
  botId?: string;
  articleId?: string;
  botSlug: string;
  recommendation: string;
  visualUrl: string;
  fallbackVisualUrl: string;
  previewStatus: string;
  previewAccepted: boolean;
  previewSource: string;
  previewLabel: string;
  workflow: string;
  steps: string[];
  estimatedWaitSeconds: number;
}

export interface CanvasFlowPreset {
  id: string;
  title: string;
  summary: string;
  action: StudioAction;
  prompt: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
}
