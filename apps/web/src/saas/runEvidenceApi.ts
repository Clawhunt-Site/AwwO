import { API_BASE, api, SaaSApiError, sessionFetch, tenantPath } from './api';

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

export interface RunInvocation {
  id: string;
  runId: string;
  runtime: string;
  provider: string;
  modelId: string;
  providerModel: string;
  status: string;
  usageStatus: 'reported' | 'partial' | 'unavailable' | 'invalid' | 'unknown';
  usage: {
    inputTokens: string | null;
    outputTokens: string | null;
    cachedInputTokens: string | null;
    cacheWriteTokens: string | null;
    reasoningTokens: string | null;
    providerTotalTokens: string | null;
    computedTotalTokens: string | null;
  };
}

export interface RunInvocationsPage {
  items: RunInvocation[];
  page: { nextCursor: string | null };
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

const decimalOrNull = (value: unknown): value is string | null => value === null
  || (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)));
const validInvocation = (value: unknown, runId: string): value is RunInvocation => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (!item.usage || typeof item.usage !== 'object') return false;
  const usage = item.usage as Record<string, unknown>;
  const reportedFields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'providerTotalTokens'] as const;
  return typeof item.id === 'string' && item.id.length > 0 && item.runId === runId
    && ['runtime', 'provider', 'modelId', 'providerModel', 'status'].every(key => typeof item[key] === 'string')
    && ['reported', 'partial', 'unavailable', 'invalid', 'unknown'].includes(String(item.usageStatus))
    && [...reportedFields, 'computedTotalTokens'].every(key => decimalOrNull(usage[key]))
    && (item.usageStatus !== 'reported' || (usage.inputTokens !== null && usage.outputTokens !== null))
    && (item.usageStatus !== 'partial' || reportedFields.some(key => usage[key] !== null))
    && (!['unavailable', 'invalid', 'unknown'].includes(String(item.usageStatus))
      || [...reportedFields, 'computedTotalTokens'].every(key => usage[key] === null));
};

/** The ledger contains observations from this run only; token counts remain decimal strings. */
export async function readRunInvocations(tenantId: string, runId: string, signal: AbortSignal, cursor?: string): Promise<RunInvocationsPage> {
  const query = new URLSearchParams({ pageSize: '100' });
  if (cursor) query.set('cursor', cursor);
  const value = await api<RunInvocationsPage>(`${runPath(tenantId, runId)}/invocations?${query}`, { signal });
  if (!value || !Array.isArray(value.items) || value.items.length > 100 || !value.items.every(item => validInvocation(item, runId))
    || new Set(value.items.map(item => item.id)).size !== value.items.length
    || !value.page || (value.page.nextCursor !== null && (typeof value.page.nextCursor !== 'string' || !value.page.nextCursor || value.items.length === 0))) {
    throw new SaaSApiError(502, 'invalid_run_invocations', 'Invalid model invocation response.');
  }
  return value;
}

/** Fetch through the same cookie-authenticated API as the observer before offering a file. */
export async function downloadRunArchive(tenantId: string, runId: string, signal: AbortSignal): Promise<void> {
  const response = await sessionFetch(`${API_BASE}${runPath(tenantId, runId)}/archive`, {
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
