import type {
  StudioClientResultInput,
  StudioDeliveryBundle,
  StudioJob,
  StudioProject,
  StudioProjectDeliveryReport,
  StudioSegment,
  StudioTimelineExport,
} from './studioContracts';
import { getStudioProjectEndpoint, getStudioRootEndpoint } from './endpointPaths';

export async function fetchStudioProject(projectId: string): Promise<StudioProject> {
  const response = await fetch(getStudioProjectEndpoint(projectId));
  if (!response.ok) {
    throw new Error(`Studio project ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function fetchStudioProjectDeliveryReport(projectId: string): Promise<StudioProjectDeliveryReport> {
  const response = await fetch(`${getStudioProjectEndpoint(projectId)}/delivery-report`);
  if (!response.ok) {
    throw new Error(`Studio delivery report ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function fetchStudioProjectDeliveryBundle(options: {
  projectId: string;
  sourceSegmentId?: string;
}): Promise<StudioDeliveryBundle> {
  const params = new URLSearchParams();
  if (options.sourceSegmentId) params.set('source_segment_id', options.sourceSegmentId);
  const query = params.toString();
  const response = await fetch(`${getStudioProjectEndpoint(options.projectId)}/delivery-bundle${query ? `?${query}` : ''}`);
  if (!response.ok) {
    throw new Error(`Studio delivery bundle ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function createStudioTimelineExport(options: {
  projectId: string;
  segmentIds?: string[];
}): Promise<StudioTimelineExport> {
  const response = await fetch(`${getStudioProjectEndpoint(options.projectId)}/timeline-export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segmentIds: options.segmentIds || undefined }),
  });
  if (!response.ok) {
    throw new Error(`Studio timeline export ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function fetchStudioTimelineExports(projectId: string): Promise<StudioTimelineExport[]> {
  const response = await fetch(`${getStudioProjectEndpoint(projectId)}/timeline-exports`);
  if (!response.ok) {
    throw new Error(`Studio timeline exports ${response.status}: ${response.statusText}`);
  }
  const body = await response.json();
  return body.exports || [];
}

export async function fetchStudioProjects(limit = 50): Promise<StudioProject[]> {
  const response = await fetch(getStudioRootEndpoint(`/api/studio/projects?limit=${encodeURIComponent(String(limit))}`));
  if (!response.ok) throw new Error(`Studio projects ${response.status}: ${response.statusText}`);
  const body = await response.json();
  return body.projects || [];
}

export async function fetchVerifiedDreamyWorkshopProject(): Promise<StudioProject> {
  const response = await fetch(getStudioRootEndpoint('/api/studio/dreamy-workshop-project'), { method: 'POST' });
  if (!response.ok) throw new Error(`Dreamy workshop project ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function postStudioClientResult(
  projectId: string,
  result: StudioClientResultInput,
): Promise<{ project: StudioProject; segment: StudioSegment; job?: StudioJob | null }> {
  const response = await fetch(`${getStudioProjectEndpoint(projectId)}/client-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  });
  if (!response.ok) {
    throw new Error(`Studio client result ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function resetStudioProject(projectId: string): Promise<void> {
  const response = await fetch(`${getStudioProjectEndpoint(projectId)}/reset`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Studio reset ${response.status}: ${response.statusText}`);
  }
}
