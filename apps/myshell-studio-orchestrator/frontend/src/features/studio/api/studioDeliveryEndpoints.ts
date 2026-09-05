import type {
  StudioAction,
  StudioActionResolveBatchResult,
  StudioActionResolveResult,
  StudioApi,
  StudioCoverageReport,
  StudioCoverageVerifyResult,
  StudioDeliveryAudit,
  StudioDispatchBatchPlan,
  StudioDispatchMatrix,
  StudioDispatchPreview,
  StudioDispatchSession,
  StudioDispatchSessionTargetRunResult,
  StudioDispatchSessionTargetStatus,
  StudioHandoffSnapshot,
} from './studioContracts';
import { getStudioRootEndpoint } from './endpointPaths';

export async function fetchStudioDeliveryAudit(options: {
  projectId?: string;
  sourceSegmentId?: string;
} = {}): Promise<StudioDeliveryAudit> {
  const params = new URLSearchParams();
  if (options.projectId) params.set('project_id', options.projectId);
  if (options.sourceSegmentId) params.set('source_segment_id', options.sourceSegmentId);
  const query = params.toString();
  const response = await fetch(getStudioRootEndpoint(`/api/studio/delivery-audit${query ? `?${query}` : ''}`));
  if (!response.ok) throw new Error(`Studio delivery audit ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchStudioDispatchMatrix(options: {
  projectId?: string;
  sourceSegmentId?: string;
} = {}): Promise<StudioDispatchMatrix> {
  const params = new URLSearchParams();
  if (options.projectId) params.set('project_id', options.projectId);
  if (options.sourceSegmentId) params.set('source_segment_id', options.sourceSegmentId);
  const query = params.toString();
  const response = await fetch(getStudioRootEndpoint(`/api/studio/dispatch-matrix${query ? `?${query}` : ''}`));
  if (!response.ok) throw new Error(`Studio dispatch matrix ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchStudioCoverage(options: {
  projectId?: string;
  sourceSegmentId?: string;
} = {}): Promise<StudioCoverageReport> {
  const params = new URLSearchParams();
  if (options.projectId) params.set('project_id', options.projectId);
  if (options.sourceSegmentId) params.set('source_segment_id', options.sourceSegmentId);
  const query = params.toString();
  const response = await fetch(getStudioRootEndpoint(`/api/studio/coverage${query ? `?${query}` : ''}`));
  if (!response.ok) throw new Error(`Studio coverage ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchStudioHandoffSnapshot(options: {
  projectId?: string;
  sourceSegmentId?: string;
} = {}): Promise<StudioHandoffSnapshot> {
  const params = new URLSearchParams();
  if (options.projectId) params.set('project_id', options.projectId);
  if (options.sourceSegmentId) params.set('source_segment_id', options.sourceSegmentId);
  const query = params.toString();
  const response = await fetch(getStudioRootEndpoint(`/api/studio/handoff-snapshot${query ? `?${query}` : ''}`));
  if (!response.ok) throw new Error(`Studio handoff snapshot ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function planStudioDispatchBatch(options: {
  projectId?: string;
  sourceSegmentId?: string;
  pageIds?: Array<StudioApi | string>;
  limit?: number;
  excludeCovered?: boolean;
} = {}): Promise<StudioDispatchBatchPlan> {
  const response = await fetch(getStudioRootEndpoint('/api/studio/dispatch-batch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: options.projectId,
      source_segment_id: options.sourceSegmentId,
      page_ids: options.pageIds,
      limit: options.limit || 50,
      exclude_covered: Boolean(options.excludeCovered),
    }),
  });
  if (!response.ok) throw new Error(`Studio dispatch batch ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function createStudioDispatchSession(options: {
  projectId?: string;
  sourceSegmentId?: string;
  pageIds?: Array<StudioApi | string>;
  limit?: number;
  excludeCovered?: boolean;
} = {}): Promise<StudioDispatchSession> {
  const response = await fetch(getStudioRootEndpoint('/api/studio/dispatch-sessions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: options.projectId,
      source_segment_id: options.sourceSegmentId,
      page_ids: options.pageIds,
      limit: options.limit || 50,
      exclude_covered: Boolean(options.excludeCovered),
    }),
  });
  if (!response.ok) throw new Error(`Studio dispatch session ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchStudioDispatchSessions(options: {
  projectId?: string;
  limit?: number;
} = {}): Promise<StudioDispatchSession[]> {
  const params = new URLSearchParams();
  if (options.projectId) params.set('project_id', options.projectId);
  params.set('limit', String(options.limit || 20));
  const response = await fetch(getStudioRootEndpoint(`/api/studio/dispatch-sessions?${params.toString()}`));
  if (!response.ok) throw new Error(`Studio dispatch sessions ${response.status}: ${response.statusText}`);
  const body = await response.json();
  return body.sessions || [];
}

export async function fetchStudioDispatchSession(
  sessionId: string,
  options: { targetId?: string } = {},
): Promise<StudioDispatchSession> {
  const params = new URLSearchParams();
  if (options.targetId) params.set('target_id', options.targetId);
  const query = params.toString();
  const response = await fetch(
    getStudioRootEndpoint(`/api/studio/dispatch-sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`),
  );
  if (!response.ok) throw new Error(`Studio dispatch session ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function cancelStudioDispatchSession(sessionId: string): Promise<StudioDispatchSession> {
  const response = await fetch(
    getStudioRootEndpoint(`/api/studio/dispatch-sessions/${encodeURIComponent(sessionId)}/cancel`),
    { method: 'POST' },
  );
  if (!response.ok) throw new Error(`Studio dispatch session cancel ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function retryStudioDispatchSession(sessionId: string): Promise<StudioDispatchSession> {
  const response = await fetch(
    getStudioRootEndpoint(`/api/studio/dispatch-sessions/${encodeURIComponent(sessionId)}/retry`),
    { method: 'POST' },
  );
  if (!response.ok) throw new Error(`Studio dispatch session retry ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function runStudioDispatchSessionTarget(options: {
  sessionId: string;
  targetId: string;
}): Promise<StudioDispatchSessionTargetRunResult> {
  const response = await fetch(
    getStudioRootEndpoint(
      `/api/studio/dispatch-sessions/${encodeURIComponent(options.sessionId)}/targets/${encodeURIComponent(options.targetId)}/run`,
    ),
    { method: 'POST' },
  );
  if (!response.ok) throw new Error(`Studio dispatch target run ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function updateStudioDispatchSessionTarget(options: {
  sessionId: string;
  targetId: string;
  status: StudioDispatchSessionTargetStatus;
  evidence?: Record<string, unknown>;
}): Promise<StudioDispatchSession> {
  const response = await fetch(
    getStudioRootEndpoint(
      `/api/studio/dispatch-sessions/${encodeURIComponent(options.sessionId)}/targets/${encodeURIComponent(options.targetId)}`,
    ),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: options.status,
        evidence: options.evidence || {},
      }),
    },
  );
  if (!response.ok) throw new Error(`Studio dispatch target ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function verifyStudioCoverage(options: {
  projectId?: string;
  sourceSegmentId?: string;
  pageIds?: Array<StudioApi | string>;
  limit?: number;
} = {}): Promise<StudioCoverageVerifyResult> {
  const response = await fetch(getStudioRootEndpoint('/api/studio/coverage/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: options.projectId,
      source_segment_id: options.sourceSegmentId,
      page_ids: options.pageIds,
      limit: options.limit || 50,
    }),
  });
  if (!response.ok) throw new Error(`Studio coverage verify ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function resolveStudioAction(options: {
  action: string;
  targetId: string;
  sessionId?: string;
  projectId?: string;
  sourceSegmentId?: string;
}): Promise<StudioActionResolveResult> {
  const response = await fetch(getStudioRootEndpoint('/api/studio/actions/resolve'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: options.action,
      target_id: options.targetId,
      session_id: options.sessionId,
      project_id: options.projectId,
      source_segment_id: options.sourceSegmentId,
    }),
  });
  if (!response.ok) throw new Error(`Studio action resolve ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function resolveStudioActionsBatch(options: {
  projectId?: string;
  sourceSegmentId?: string;
  actions?: Array<{ action: string; targetId?: string; target_id?: string; sessionId?: string; session_id?: string }>;
}): Promise<StudioActionResolveBatchResult> {
  const response = await fetch(getStudioRootEndpoint('/api/studio/actions/resolve-batch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: options.projectId,
      source_segment_id: options.sourceSegmentId,
      actions: options.actions?.map((action) => ({
        action: action.action,
        target_id: action.target_id || action.targetId,
        session_id: action.session_id || action.sessionId,
      })),
    }),
  });
  if (!response.ok) throw new Error(`Studio action resolve batch ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchStudioDispatchPreview(
  options: {
    message?: string;
    projectId?: string;
    action?: StudioAction;
    sourceSegmentId?: string;
    pageId?: StudioApi | string;
    agentId?: string;
    botId?: string;
    articleId?: string;
    botSlug?: string;
    botName?: string;
    botType?: string;
    hasImage?: boolean;
  } = {},
): Promise<StudioDispatchPreview> {
  const params = new URLSearchParams();
  if (options.message) params.set('message', options.message);
  if (options.projectId) params.set('project_id', options.projectId);
  if (options.action) params.set('action', options.action);
  if (options.sourceSegmentId) params.set('source_segment_id', options.sourceSegmentId);
  if (options.pageId) params.set('page_id', options.pageId);
  if (options.agentId) params.set('agent_id', options.agentId);
  if (options.botId) params.set('bot_id', options.botId);
  if (options.articleId) params.set('article_id', options.articleId);
  if (options.botSlug) params.set('bot_slug', options.botSlug);
  if (options.botName) params.set('bot_name', options.botName);
  if (options.botType) params.set('bot_type', options.botType);
  if (typeof options.hasImage === 'boolean') params.set('has_image', String(options.hasImage));
  const query = params.toString();
  const response = await fetch(getStudioRootEndpoint(`/api/studio/dispatch-preview${query ? `?${query}` : ''}`));
  if (!response.ok) throw new Error(`Studio dispatch preview ${response.status}: ${response.statusText}`);
  return response.json();
}
