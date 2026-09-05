import type {
  StudioAgentCapability,
  StudioBotPreviewsResponse,
  StudioHealth,
  StudioOverview,
  StudioPageAdapter,
  StudioReadiness,
} from './studioContracts';
import { getStudioHealthEndpoint, getStudioRootEndpoint } from './endpointPaths';

export async function fetchStudioPages(): Promise<StudioPageAdapter[]> {
  const response = await fetch(getStudioRootEndpoint('/api/pages'));
  if (!response.ok) throw new Error(`Studio pages ${response.status}: ${response.statusText}`);
  const body = await response.json();
  return body.pages || [];
}

export async function fetchStudioOverview(limit = 50): Promise<StudioOverview> {
  const response = await fetch(getStudioRootEndpoint(`/api/studio/overview?limit=${encodeURIComponent(String(limit))}`));
  if (!response.ok) throw new Error(`Studio overview ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchStudioReadiness(): Promise<StudioReadiness> {
  const response = await fetch(getStudioRootEndpoint('/api/studio/readiness'));
  if (!response.ok) throw new Error(`Studio readiness ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchStudioAgents(): Promise<StudioAgentCapability[]> {
  const response = await fetch(getStudioRootEndpoint('/api/agents'));
  if (!response.ok) throw new Error(`Studio agents ${response.status}: ${response.statusText}`);
  const body = await response.json();
  return body.agents || [];
}

export async function fetchStudioBotPreviews(): Promise<StudioBotPreviewsResponse> {
  const response = await fetch(getStudioRootEndpoint('/api/studio/bot-previews'));
  if (!response.ok) throw new Error(`Studio bot previews ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchStudioHealth(): Promise<StudioHealth> {
  const response = await fetch(getStudioHealthEndpoint());
  if (!response.ok) throw new Error(`Studio health ${response.status}: ${response.statusText}`);
  return response.json();
}
