import { getStudioRootEndpoint } from './endpointPaths';
import { readSse } from './sse';
import type {
  SuperClawAutomation,
  SuperClawCanvasRunRequest,
  SuperClawCanvasRunResponse,
  SuperClawRunEvent,
  SuperClawRunSummary,
  SuperClawStatusResponse,
} from './superclawCanvasContracts';

const SUPERCLAW_ROOT = '/api/studio/superclaw';

function superclawEndpoint(path: string): string {
  return getStudioRootEndpoint(`${SUPERCLAW_ROOT}${path}`);
}

async function parseJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  let body: Record<string, any> = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    const detail = body?.detail;
    const message =
      typeof detail === 'string'
        ? detail
        : typeof detail?.message === 'string'
          ? detail.message
          : typeof body?.message === 'string'
            ? body.message
            : response.statusText;
    throw new Error(`${label} ${response.status}: ${message}`);
  }
  return body as T;
}

export async function fetchSuperClawStatus(): Promise<SuperClawStatusResponse> {
  const response = await fetch(superclawEndpoint('/status'));
  return parseJson<SuperClawStatusResponse>(response, 'SuperClaw status');
}

export async function runSuperClawCanvas(payload: SuperClawCanvasRunRequest): Promise<SuperClawCanvasRunResponse> {
  const response = await fetch(superclawEndpoint('/canvas/run'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJson<SuperClawCanvasRunResponse>(response, 'SuperClaw canvas run');
}

export async function fetchSuperClawRuns(): Promise<SuperClawRunSummary[]> {
  const response = await fetch(superclawEndpoint('/runs'));
  const body = await parseJson<{ runs?: SuperClawRunSummary[] } | SuperClawRunSummary[]>(response, 'SuperClaw runs');
  return Array.isArray(body) ? body : body.runs || [];
}

export async function fetchSuperClawRun(runId: string): Promise<SuperClawRunSummary> {
  const response = await fetch(superclawEndpoint(`/runs/${encodeURIComponent(runId)}`));
  return parseJson<SuperClawRunSummary>(response, 'SuperClaw run');
}

export async function streamSuperClawRunEvents(
  runId: string,
  onEvent: (event: SuperClawRunEvent, rawEventName: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(superclawEndpoint(`/runs/${encodeURIComponent(runId)}/events`), { signal });
  await readSse<SuperClawRunEvent>({ response, onEvent });
}

export async function cancelSuperClawRun(runId: string): Promise<SuperClawRunSummary> {
  const response = await fetch(superclawEndpoint(`/runs/${encodeURIComponent(runId)}/cancel`), { method: 'POST' });
  return parseJson<SuperClawRunSummary>(response, 'SuperClaw cancel');
}

export async function resumeSuperClawRun(runId: string): Promise<SuperClawRunSummary> {
  const response = await fetch(superclawEndpoint(`/runs/${encodeURIComponent(runId)}/resume`), { method: 'POST' });
  return parseJson<SuperClawRunSummary>(response, 'SuperClaw resume');
}

export async function createSuperClawAutomation(payload: {
  sessionIssueId: string;
  prompt: string;
  intervalSec: number;
  timezone?: string;
}): Promise<SuperClawAutomation> {
  const response = await fetch(superclawEndpoint('/automations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJson<SuperClawAutomation>(response, 'SuperClaw automation');
}

export async function fetchSuperClawAutomations(sessionIssueId?: string): Promise<SuperClawAutomation[]> {
  const params = new URLSearchParams();
  if (sessionIssueId) params.set('sessionIssueId', sessionIssueId);
  const query = params.toString();
  const response = await fetch(superclawEndpoint(`/automations${query ? `?${query}` : ''}`));
  const body = await parseJson<{ automations?: SuperClawAutomation[] }>(response, 'SuperClaw automations');
  return body.automations || [];
}

export async function approveSuperClawAutomation(automationId: string): Promise<SuperClawAutomation> {
  const response = await fetch(superclawEndpoint(`/automations/${encodeURIComponent(automationId)}/approve`), { method: 'POST' });
  return parseJson<SuperClawAutomation>(response, 'SuperClaw automation approve');
}

export async function deleteSuperClawAutomation(automationId: string): Promise<void> {
  const response = await fetch(superclawEndpoint(`/automations/${encodeURIComponent(automationId)}`), { method: 'DELETE' });
  await parseJson<Record<string, unknown>>(response, 'SuperClaw automation delete');
}
