import type {
  StudioAction,
  StudioActionResolveResult,
  StudioAgentNode,
  StudioDeliveryAudit,
  StudioDeliveryBundle,
  StudioMode,
  StudioPageAdapter,
  StudioProject,
  StudioSegment,
  StudioStatus,
} from '../api';
import {
  DEFAULT_DREAMY_SLUG,
  DEFAULT_STUDIO_AGENT_ID,
  DREAMY_VIDEO_SLUG,
  LOCAL_POSTERS,
  VERIFIED_WORKSHOP_PROJECT_ID,
  VERIFIED_WORKSHOP_SEGMENTS,
} from './dreamyPresets';

export const QUEUE_STATUS_OPTIONS: Array<StudioStatus | 'all'> = [
  'all',
  'queued',
  'running',
  'done',
  'timeout',
  'auth_missing',
  'error',
  'cancelled',
];

export const EMPTY_GRAPH: StudioAgentNode[] = [
  { id: 'intent-router', label: 'Intent Router', status: 'idle', detail: 'Waiting for prompt' },
  { id: 'asset-planner', label: 'Asset Planner', status: 'idle', detail: 'No source selected' },
  { id: 'dreamy-executor', label: 'Dreamy Executor', status: 'idle', detail: 'Standing by' },
  { id: 'timeline', label: 'Timeline', status: 'idle', detail: 'No segments yet' },
];

export function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createVerifiedWorkshopFallbackProject(): StudioProject {
  const checkedAt = nowIso();
  return {
    projectId: VERIFIED_WORKSHOP_PROJECT_ID,
    conversationId: 'conversation_verified_workshop',
    mode: 'player',
    messages: [
      {
        id: 'verified-workshop-user',
        role: 'user',
        content: 'Stage two completed Dreamy workshop bot results into a timeline.',
        createdAt: '2026-06-03T09:10:00Z',
        action: 'generate',
      },
      {
        id: 'verified-workshop-assistant',
        role: 'assistant',
        content: 'Two real Dreamy workshop outputs are staged. Add another segment or export the timeline.',
        createdAt: checkedAt,
        action: 'extend',
        segmentId: VERIFIED_WORKSHOP_SEGMENTS[1].id,
      },
    ],
    segments: VERIFIED_WORKSHOP_SEGMENTS.map((segment) => {
      const clone: StudioSegment = { ...segment };
      if (segment.evidence) clone.evidence = { ...segment.evidence };
      return clone;
    }),
    selectedSegmentId: VERIFIED_WORKSHOP_SEGMENTS[1].id,
    agentGraph: [
      { id: 'intent-router', label: 'Intent Router', status: 'done', detail: 'Verified workshop route' },
      { id: 'dreamy-bot-1', label: '3D Anime Porn', status: 'done', detail: 'Real media accepted' },
      { id: 'dreamy-bot-2', label: '3D Futa Porn', status: 'done', detail: 'Second segment accepted' },
      { id: 'timeline', label: 'Timeline', status: 'done', detail: 'Two clips ready for export' },
    ],
    jobs: [],
    timelineExports: [],
    updatedAt: checkedAt,
  };
}

export function downloadJsonText(jsonText: string, filename: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadJsonPayload(payload: unknown, filename: string): void {
  downloadJsonText(JSON.stringify(payload, null, 2), filename);
}

export function deliveryBundleFilename(bundle: StudioDeliveryBundle): string {
  return `myshell-studio-delivery-${bundle.projectId}.json`;
}

export function deliveryAuditFilename(audit: StudioDeliveryAudit): string {
  return `myshell-studio-audit-${audit.projectId || 'current'}.json`;
}

export function isMissingStudioProjectError(error: unknown): boolean {
  return error instanceof Error && /\b404\b/.test(error.message);
}

export function formatStudioActionNext(next?: StudioActionResolveResult['next']): string {
  if (!next) return '';
  const details = [
    next.label,
    next.message,
    next.uiUrl ? `Open Studio ${next.uiUrl}` : '',
    next.url ? `Open ${next.url}` : '',
    next.retryUrl ? `Retry ${next.retryUrl}` : '',
    next.cancelUrl ? `Cancel ${next.cancelUrl}` : '',
    next.env ? `Env ${next.env}` : '',
    next.command ? `Command ${next.command}` : '',
  ].filter(Boolean);
  return details.length ? ` ${details.join(' ')}` : '';
}

export function statusTone(status?: string): string {
  if (status === 'done') return 'text-Cr-text-success-default-v2';
  if (status === 'error' || status === 'timeout' || status === 'auth_missing') return 'text-Cr-text-critical-default-v2';
  if (status === 'running' || status === 'queued') return 'text-dreamy-brand-hot-v2';
  return 'text-Cr-text-subtler-v2';
}

export function statusPillTone(status?: string): 'default' | 'hot' | 'success' | 'danger' {
  if (status === 'done') return 'success';
  if (status === 'error' || status === 'timeout' || status === 'auth_missing') return 'danger';
  if (status === 'running' || status === 'queued') return 'hot';
  return 'default';
}

export function healthPillTone(status?: string): 'default' | 'hot' | 'success' | 'danger' {
  if (status === 'ok' || status === 'ready' || status === 'client_delegated') return 'success';
  if (status === 'auth_missing' || status === 'unavailable' || status === 'degraded' || status === 'needs_configuration') return 'hot';
  if (status === 'error' || status === 'blocked') return 'danger';
  return 'default';
}

export function liveGenerationLabel(status?: string): string {
  if (!status) return 'Checking generation';
  if (status === 'ok' || status === 'ready' || status === 'client_delegated') return 'Generation ready';
  if (status === 'auth_missing' || status === 'needs_configuration') return 'Login needed';
  if (status === 'unavailable') return 'Generation offline';
  if (status === 'degraded') return 'Generation limited';
  if (status === 'error' || status === 'blocked') return 'Generation issue';
  return 'Generation active';
}

export function handoffPillTone(status?: string): 'default' | 'hot' | 'success' | 'danger' {
  if (status === 'ready') return 'success';
  if (status === 'needs_attention' || status === 'blocked') return 'danger';
  if (status === 'in_progress') return 'hot';
  return 'default';
}

export function handoffItemPriority(item: { kind?: string; status?: string; reason?: string; action?: string }): number {
  if (item.kind === 'dispatch_target') return 0;
  if (item.status === 'error' || item.reason === 'error' || item.action === 'inspect-gap') return 1;
  if (item.status === 'blocked' || item.reason === 'auth_missing') return 2;
  return 3;
}

export function actionLabel(action: StudioAction): string {
  return {
    generate: 'Generate',
    extend: 'Extend',
    restyle: 'Restyle',
    'retry-agent': 'Try agent',
  }[action];
}

export function defaultAgentIdForPage(page?: StudioPageAdapter | null): string {
  if (page?.executor === 'navigation') return 'miniapp-page-navigator';
  if (page?.id === 'myshell-art') return 'myshell-art-cdp-executor';
  return DEFAULT_STUDIO_AGENT_ID;
}

export function createLocalProject(
  mode: StudioMode,
  message: string,
  action: StudioAction,
  parent?: StudioSegment,
  existing?: StudioProject | null,
): StudioProject {
  const projectId = existing?.projectId || makeId('local_project');
  const conversationId = existing?.conversationId || makeId('conversation');
  const segment: StudioSegment = {
    id: makeId('segment'),
    type: action === 'extend' ? 'video' : 'image',
    url: '',
    posterUrl: LOCAL_POSTERS[Math.floor(Math.random() * LOCAL_POSTERS.length)],
    prompt: message,
    botSlug: action === 'extend' ? DREAMY_VIDEO_SLUG : DEFAULT_DREAMY_SLUG,
    botName: action === 'extend' ? '3D Futa Porn' : '3D Anime Porn',
    action,
    parentSegmentId: parent?.id,
    status: 'draft',
    evidence: {
      status: 'draft',
      source: 'local-fallback',
      accepted: false,
      message: 'Local draft only; not accepted as delivery evidence.',
      checkedAt: nowIso(),
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const fallbackAgentGraph: StudioAgentNode[] = [
    { id: 'intent-router', label: 'Intent Router', status: 'done', detail: 'Local route fallback' },
    { id: 'asset-planner', label: 'Asset Planner', status: parent ? 'done' : 'queued', detail: parent?.botName || 'Prompt only' },
    { id: 'dreamy-executor', label: 'Dreamy Executor', status: 'queued', detail: 'Waiting for Studio backend' },
    { id: 'timeline', label: 'Timeline', status: 'queued', detail: 'Draft segment added' },
  ];
  const agentGraph: StudioAgentNode[] = existing?.agentGraph?.length ? existing.agentGraph : fallbackAgentGraph;
  return {
    ...(existing || {}),
    projectId,
    conversationId,
    mode,
    messages: existing?.messages || [],
    segments: [...(existing?.segments || []), segment],
    selectedSegmentId: segment.id,
    agentGraph,
    jobs: existing?.jobs || [],
    updatedAt: nowIso(),
  };
}

export function mergeStudioProjectState(current: StudioProject | null, incoming: StudioProject): StudioProject {
  if (!current || current.projectId !== incoming.projectId) return incoming;
  const incomingSegments = new Map(incoming.segments.map((segment) => [segment.id, segment]));
  const incomingJobs = new Map((incoming.jobs || []).map((job) => [job.jobId, job]));
  const incomingExports = new Map((incoming.timelineExports || []).map((item) => [item.exportId, item]));
  return {
    ...current,
    ...incoming,
    messages: incoming.messages?.length ? incoming.messages : current.messages,
    segments: [
      ...current.segments.map((segment) => incomingSegments.get(segment.id) || segment),
      ...incoming.segments.filter((segment) => !current.segments.some((currentSegment) => currentSegment.id === segment.id)),
    ],
    jobs: [
      ...(current.jobs || []).map((job) => incomingJobs.get(job.jobId) || job),
      ...(incoming.jobs || []).filter((job) => !(current.jobs || []).some((currentJob) => currentJob.jobId === job.jobId)),
    ],
    timelineExports: [
      ...(incoming.timelineExports || []),
      ...((current.timelineExports || []).filter((item) => !incomingExports.has(item.exportId))),
    ],
    selectedSegmentId: incoming.selectedSegmentId || current.selectedSegmentId,
    updatedAt: incoming.updatedAt || current.updatedAt,
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
