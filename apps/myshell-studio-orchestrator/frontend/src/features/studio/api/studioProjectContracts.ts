import type { StudioApi } from './studioDispatchLinks';
import type {
  StudioAction,
  StudioAgentNode,
  StudioAuthStatus,
  StudioEvidence,
  StudioExecutor,
  StudioMode,
  StudioPageAdapter,
  StudioStatus,
} from './studioBaseContracts';

export interface StudioJob {
  jobId: string;
  projectId: string;
  segmentId: string;
  pageId: StudioApi | string;
  pageName: string;
  agentId: string;
  executor: StudioExecutor;
  api: StudioApi | string;
  clientAction?: 'navigate' | string;
  navigationPath?: string;
  studioReturnPath?: string;
  status: StudioStatus;
  action: StudioAction;
  botSlug: string;
  botId?: string;
  articleId?: string;
  botName: string;
  botType?: string;
  prompt: string;
  taskId?: string;
  mediaUrl?: string;
  posterUrl?: string;
  authStatus?: StudioAuthStatus;
  evidence?: StudioEvidence;
  attempt?: number;
  createdAt?: string;
  updatedAt?: string;
  evidenceTrail?: StudioEvidence[];
}

export interface StudioSegment {
  id: string;
  type: 'image' | 'video';
  url?: string;
  posterUrl?: string;
  prompt: string;
  botSlug: string;
  botId?: string;
  articleId?: string;
  botName: string;
  action: StudioAction;
  parentSegmentId?: string;
  status: StudioStatus;
  taskId?: string;
  jobId?: string;
  authStatus?: StudioAuthStatus;
  evidence?: StudioEvidence;
  createdAt?: string;
  updatedAt?: string;
}

export interface StudioTimelineExportSegment {
  index: number;
  segmentId: string;
  type: 'image' | 'video' | string;
  status: StudioStatus | string;
  prompt?: string;
  action?: StudioAction | string;
  botId?: string;
  botName?: string;
  botSlug?: string;
  taskId?: string;
  mediaUrl?: string;
  posterUrl?: string;
  durationSeconds?: number;
  evidence?: StudioEvidence | Record<string, unknown>;
}

export interface StudioTimelineExportManifest {
  kind: 'dreamy-long-video-sequence' | string;
  projectId: string;
  conversationId: string;
  createdAt: string;
  segments: StudioTimelineExportSegment[];
  summary: {
    totalSegments: number;
    readySegments: number;
    videoSegments: number;
    estimatedDurationSeconds: number;
  };
}

export interface StudioTimelineExport {
  exportId: string;
  projectId: string;
  conversationId: string;
  status: 'ready' | 'manifest_ready' | 'needs_media' | string;
  checkedAt: string;
  mediaUrl?: string;
  manifest: StudioTimelineExportManifest;
  summary: StudioTimelineExportManifest['summary'];
  evidence: StudioEvidence;
}

export interface StudioMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  action?: StudioAction;
  segmentId?: string;
  hasImage?: boolean;
  route?: StudioRouteEvent;
}

export interface StudioProject {
  projectId: string;
  conversationId: string;
  mode: StudioMode;
  messages: StudioMessage[];
  segments: StudioSegment[];
  selectedSegmentId?: string | null;
  agentGraph: StudioAgentNode[];
  jobs?: StudioJob[];
  timelineExports?: StudioTimelineExport[];
  updatedAt: string;
}

export interface StudioRouteEvent {
  type?: 'route';
  intent: string;
  analysis: string;
  optimizedPrompt: string;
  reason: string;
  action: StudioAction;
  sourceSegmentId?: string;
  sourceSummary?: string;
  executor: StudioExecutor;
  api?: StudioApi;
  agentId?: string;
  clientAction?: 'navigate' | string;
  navigationPath?: string;
  studioReturnPath?: string;
  page?: StudioPageAdapter;
  bot: {
    id?: string;
    slug: string;
    name: string;
    type: string;
    articleId?: string;
    rating?: number;
    description?: string;
    pageUrl?: string;
  };
}

export interface StudioProgressEvent {
  type?: 'progress';
  step: string;
  message: string;
  progress?: number;
}

export interface StudioExecutionRequest {
  type?: 'execution_request';
  executor: StudioExecutor;
  api: StudioApi | string;
  page?: StudioPageAdapter;
  agentId?: string;
  clientAction?: 'navigate' | string;
  navigationPath?: string;
  studioReturnPath?: string;
  routeParams?: string[];
  missingRouteParams?: string[];
  jobId: string;
  segmentId: string;
  botSlug: string;
  botId?: string;
  articleId?: string;
  botName: string;
  botType: string;
  prompt: string;
  action: StudioAction;
  sourceSegment?: StudioSegment | null;
  agentGraph?: StudioAgentNode[];
  segment: StudioSegment;
  authStatus?: StudioAuthStatus;
  evidence?: StudioEvidence;
  dispatchSessionId?: string;
  dispatchTargetId?: string;
}

export interface StudioDispatchPreview {
  page: StudioPageAdapter;
  route: StudioRouteEvent;
  executor: StudioExecutor;
  agentId: string;
  authStatus: StudioAuthStatus;
  dispatchReady: boolean;
  dispatchStatus: string;
  dispatchMessage: string;
  clientAction?: 'navigate' | string;
  navigationPath?: string;
  studioReturnPath?: string;
  routeParams: string[];
  missingRouteParams: string[];
  prompt: string;
}

export interface StudioProjectEvent {
  type?: 'project';
  project: StudioProject;
}

export type StudioRunEvent =
  | ({ type?: 'meta'; projectId: string; conversationId: string; mode: StudioMode })
  | StudioRouteEvent
  | StudioProgressEvent
  | StudioExecutionRequest
  | StudioProjectEvent
  | ({ type?: 'job'; job: StudioJob })
  | ({ type?: 'done'; status: string; projectId: string; segmentId?: string; jobId?: string })
  | ({ type?: 'error'; message: string });

export interface StreamStudioRunOptions {
  message: string;
  mode: StudioMode;
  action: StudioAction;
  projectId?: string | null;
  sourceSegmentId?: string | null;
  pageId?: StudioApi | string;
  agentId?: string;
  botSlug?: string;
  botId?: string;
  articleId?: string;
  botName?: string;
  botType?: string;
  botSequence?: Array<{
    botId?: string;
    botSlug?: string;
    botName?: string;
    botType?: string;
    articleId?: string;
    action?: StudioAction;
    prompt?: string;
  }>;
  agentGraph?: StudioAgentNode[];
  imageFile?: File | null;
  signal?: AbortSignal;
  onEvent: (event: StudioRunEvent, rawEventName: string) => void | Promise<void>;
}

export interface StudioClientResultInput {
  segmentId: string;
  status: StudioSegment['status'];
  type?: StudioSegment['type'];
  url?: string;
  posterUrl?: string;
  prompt?: string;
  botId?: string;
  articleId?: string;
  botSlug?: string;
  botName?: string;
  action?: StudioAction;
  parentSegmentId?: string;
  taskId?: string;
  jobId?: string;
  source?: string;
  evidence?: StudioEvidence;
  authStatus?: StudioAuthStatus;
  dispatchSessionId?: string;
  dispatchTargetId?: string;
}
