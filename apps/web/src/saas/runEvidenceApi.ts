import { API_BASE, api, SaaSApiError, tenantPath } from './api';

export interface RunEvidenceSummary {
  runId: string;
  status: string;
  outputPresent: boolean;
  outputBytes: number;
  artifactCount: number;
  contract: { declared: boolean; validated: boolean };
  taskFrame?: unknown;
  manualAcceptance: { required: boolean; verified: false };
  evidenceSources: string[];
  observational: true;
  preview: string;
  previewTruncated: boolean;
}

const runPath = (tenantId: string, runId: string) => tenantPath(tenantId, `/runs/${encodeURIComponent(runId)}`);

export async function readRunEvidence(tenantId: string, runId: string, signal: AbortSignal): Promise<RunEvidenceSummary> {
  const value = await api<RunEvidenceSummary>(`${runPath(tenantId, runId)}/evidence`, { signal });
  if (!value || value.runId !== runId || !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status)
    || typeof value.outputPresent !== 'boolean' || !Number.isSafeInteger(value.outputBytes) || value.outputBytes < 0
    || !Number.isSafeInteger(value.artifactCount) || value.artifactCount < 0
    || typeof value.contract?.declared !== 'boolean' || typeof value.contract?.validated !== 'boolean'
    || typeof value.manualAcceptance?.required !== 'boolean' || value.manualAcceptance.verified !== false || value.observational !== true
    || !Array.isArray(value.evidenceSources) || !value.evidenceSources.every(source => typeof source === 'string')
    || typeof value.preview !== 'string' || typeof value.previewTruncated !== 'boolean') {
    throw new SaaSApiError(502, 'invalid_run_evidence', 'Invalid run evidence response.');
  }
  return value;
}

/** Fetch through the same cookie-authenticated API as the observer before offering a file. */
export async function downloadRunArchive(tenantId: string, runId: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${API_BASE}${runPath(tenantId, runId)}/archive`, {
    credentials: 'include', signal, headers: { Accept: 'application/x-ndjson' },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new SaaSApiError(response.status, payload?.error?.code || 'request_failed', payload?.error?.message || `Download failed (${response.status}).`);
  }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson') {
    throw new SaaSApiError(502, 'invalid_run_archive', 'Invalid run archive response.');
  }
  const blob = await response.blob();
  if (signal.aborted) return;
  const suggested = /filename="([^"\r\n]+)"/i.exec(response.headers.get('content-disposition') || '')?.[1];
  const filename = (suggested || `run-${runId}-redacted.ndjson`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.hidden = true;
  document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => revokeObjectURL(url), 1000); }
}
