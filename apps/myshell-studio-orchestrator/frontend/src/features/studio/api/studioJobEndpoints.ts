import type { StudioApi, StudioExecutionRequest, StudioJob, StudioProject, StudioStatus } from './studioContracts';
import { getStudioJobEndpoint, getStudioRootEndpoint } from './endpointPaths';

export async function fetchStudioJob(jobId: string): Promise<StudioJob> {
  const response = await fetch(getStudioJobEndpoint(jobId));
  if (!response.ok) throw new Error(`Studio job ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchStudioJobs(
  options: {
    projectId?: string;
    status?: StudioStatus | string;
    pageId?: StudioApi | string;
    agentId?: string;
    limit?: number;
  } = {},
): Promise<StudioJob[]> {
  const params = new URLSearchParams();
  if (options.projectId) params.set('project_id', options.projectId);
  if (options.status) params.set('status', options.status);
  if (options.pageId) params.set('page_id', options.pageId);
  if (options.agentId) params.set('agent_id', options.agentId);
  params.set('limit', String(options.limit || 100));
  const query = params.toString();
  const response = await fetch(getStudioRootEndpoint(`/api/studio/jobs${query ? `?${query}` : ''}`));
  if (!response.ok) throw new Error(`Studio jobs ${response.status}: ${response.statusText}`);
  const body = await response.json();
  return body.jobs || [];
}

export async function cancelStudioJob(jobId: string): Promise<{ project?: StudioProject | null; job: StudioJob }> {
  const response = await fetch(`${getStudioJobEndpoint(jobId)}/cancel`, { method: 'POST' });
  if (!response.ok) throw new Error(`Studio cancel ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function retryStudioJob(jobId: string): Promise<{ project?: StudioProject | null; job: StudioJob; executionRequest?: StudioExecutionRequest | null }> {
  const response = await fetch(`${getStudioJobEndpoint(jobId)}/retry`, { method: 'POST' });
  if (!response.ok) throw new Error(`Studio retry ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function pollStudioJob(jobId: string): Promise<{ project?: StudioProject | null; job: StudioJob }> {
  const response = await fetch(`${getStudioJobEndpoint(jobId)}/poll`, { method: 'POST' });
  if (!response.ok) throw new Error(`Studio poll ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function bulkStudioJobs(options: {
  action: 'cancel' | 'retry';
  projectId?: string;
  status?: StudioStatus | string;
  pageId?: StudioApi | string;
  agentId?: string;
  includeTerminal?: boolean;
  limit?: number;
}): Promise<{
  action: 'cancel' | 'retry';
  matchedCount: number;
  skippedCount?: number;
  jobs: StudioJob[];
  skippedJobs?: StudioJob[];
  projects?: StudioProject[];
  executionRequests?: StudioExecutionRequest[];
}> {
  const response = await fetch(getStudioRootEndpoint('/api/studio/jobs/bulk'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: options.action,
      project_id: options.projectId,
      status: options.status,
      page_id: options.pageId,
      agent_id: options.agentId,
      include_terminal: options.includeTerminal,
      limit: options.limit || 100,
    }),
  });
  if (!response.ok) throw new Error(`Studio bulk ${options.action} ${response.status}: ${response.statusText}`);
  return response.json();
}
