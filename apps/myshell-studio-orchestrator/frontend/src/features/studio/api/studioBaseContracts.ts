import type { GenerateResponse } from '../../../types';
import type { StudioApi } from './studioDispatchLinks';

export type UnifiedMode = 'orchestrator' | 'miniapp' | 'monitor';
export type StudioMode = 'player' | 'canvas';
export type StudioAction = 'generate' | 'extend' | 'restyle' | 'retry-agent';
export type StudioStatus = 'draft' | 'queued' | 'running' | 'done' | 'timeout' | 'auth_missing' | 'error' | 'cancelled';
export type StudioExecutor = 'client' | 'server' | 'navigation';

export interface OrchestratorBotRef {
  id?: string;
  name?: string;
  type?: string;
  rating?: number;
  description?: string;
  page_url?: string;
}

export interface OrchestratorEvent {
  type?: string;
  step?: string;
  message?: string;
  detail?: string;
  progress?: number;
  conversation_id?: string;
  bot?: OrchestratorBotRef;
  bot_used?: OrchestratorBotRef;
  image_url?: string;
  video_url?: string;
  prompt_used?: string;
  source?: string;
  bot_page_url?: string;
  needs_image_hint?: string;
  status?: string;
}

export interface StreamOrchestratorOptions {
  message: string;
  imageFile?: File | null;
  conversationId?: string | null;
  signal?: AbortSignal;
  onEvent: (event: OrchestratorEvent, rawEventName: string) => void;
}

export interface DreamyMiniappJobInput {
  slugId?: string;
  botId?: string;
  articleId?: string;
  prompt: string;
  imageFile?: File | null;
  imageUrl?: string;
}

export interface DreamyMiniappJobResult {
  uploadedImageUrl?: string;
  botId: string;
  articleId: string;
  response: GenerateResponse;
}

export interface MonitorSnapshot {
  running: boolean;
  libraryCount: number;
  latestTaskId?: string;
  latestStatus?: string;
  latestBotName?: string;
  latestPreview?: string;
}

export interface StudioAgentNode {
  id: string;
  label: string;
  status: 'idle' | StudioStatus;
  detail?: string;
}

export interface StudioEvidence {
  status: StudioStatus | string;
  source: string;
  accepted: boolean;
  mediaUrl?: string;
  taskId?: string;
  pageId?: string;
  agentId?: string;
  navigationPath?: string;
  missingRouteParams?: string[];
  message?: string;
  checkedAt?: string;
}

export interface StudioAuthStatus {
  status: 'ready' | 'client_delegated' | 'auth_missing' | 'unavailable' | string;
  mode?: string;
  message?: string;
}

export interface StudioHealthComponent {
  status: 'ok' | 'ready' | 'client_delegated' | 'auth_missing' | 'unavailable' | 'error' | string;
  message?: string;
  mode?: string;
  path?: string;
  url?: string;
  bindings?: Array<{
    env: string;
    secret: string;
    purpose?: string;
    configured?: boolean;
    status?: string;
  }>;
  checks?: Record<
    string,
    {
      status?: string;
      message?: string;
      required?: boolean;
    }
  >;
  blockedChecks?: string[];
  missingEnv?: string[];
}

export interface StudioHealth {
  status: 'ok' | 'degraded' | string;
  version?: string;
  checkedAt?: string;
  components: Record<string, StudioHealthComponent>;
}

export interface StudioPageAdapter {
  id: StudioApi;
  name: string;
  kind: string;
  baseUrl: string;
  appRoute?: string;
  executor: StudioExecutor;
  authMode: string;
  status: string;
  dispatchMode?: string;
  dispatchReady?: boolean;
  dispatchStatus?: string;
  dispatchMessage?: string;
  authStatus?: StudioAuthStatus;
  routeParams?: string[];
  routeDefaults?: Record<string, string>;
  intentKeywords?: string[];
  registrySource?: 'code' | 'manifest' | string;
  manifestVersion?: string;
  botCount?: number;
  capabilities: string[];
}

export interface StudioAgentCapability {
  id: string;
  label: string;
  pageId: string;
  role: string;
  capabilities: string[];
}
