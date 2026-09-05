import type { StudioAction } from './studioContracts';

export interface SuperClawEndpointStatus {
  baseUrl: string;
  reachable: boolean;
  message?: string;
  status?: number;
  payload?: Record<string, unknown>;
}

export interface SuperClawStatusResponse {
  configured: {
    apiBase: boolean;
    controlToken: boolean;
    gatewayBase: boolean;
    gatewayToken: boolean;
    remoteAllowed: boolean;
  };
  api: SuperClawEndpointStatus;
  gateway: SuperClawEndpointStatus;
}

export interface SuperClawCanvasNode {
  id: string;
  kind?: string;
  title?: string;
  subtitle?: string;
  status?: string;
  action?: StudioAction | string;
  prompt?: string;
  segmentId?: string;
  agentId?: string;
  outputText?: string;
  botSlug?: string;
  botName?: string;
  sourceType?: string;
  fileName?: string;
  mediaUrl?: string;
  boardId?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface SuperClawCanvasConnection {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface SuperClawCanvasRunOptions {
  dryRun?: boolean;
  backendPolicy?: string;
  model?: string | null;
  effort?: string | null;
  harnessPolicy?: string;
  concurrency?: number;
  repoPath?: string;
  budgetSeconds?: number;
  verificationPolicy?: string;
  permissionPreset?: string;
  chatSessionId?: string | null;
}

export interface SuperClawCanvasRunRequest {
  projectId?: string | null;
  action: StudioAction | string;
  prompt: string;
  selectedNodeId?: string | null;
  selectedNodeIds?: string[];
  viewport?: {
    zoom: number;
    pan: { x: number; y: number };
  };
  nodes: SuperClawCanvasNode[];
  connections: SuperClawCanvasConnection[];
  run?: SuperClawCanvasRunOptions;
}

export interface SuperClawCanvasContext {
  projectId?: string;
  action?: string;
  selectedNodeId?: string;
  selectedNodeIds?: string[];
  selectedNode?: SuperClawCanvasNode | null;
  nodes?: SuperClawCanvasNode[];
  connections?: SuperClawCanvasConnection[];
}

export interface SuperClawCanvasRunResponse {
  mode: 'goal-run' | string;
  goal: Record<string, unknown>;
  run: SuperClawRunSummary;
  context: SuperClawCanvasContext;
  execution: {
    goalId: string;
    runId: string;
    eventsUrl: string;
  };
}

export interface SuperClawRunSummary {
  id?: string;
  run_id?: string;
  goal_id?: string;
  status?: string;
  title?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
  [key: string]: unknown;
}

export interface SuperClawRunEvent {
  type?: string;
  event?: string;
  message?: string;
  detail?: string;
  status?: string;
  run_id?: string;
  runId?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface SuperClawAutomation {
  id: string;
  sessionIssueId?: string;
  prompt?: string;
  intervalSec?: number;
  timezone?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}
