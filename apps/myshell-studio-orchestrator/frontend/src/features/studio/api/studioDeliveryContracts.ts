import type { StudioApi } from './studioDispatchLinks';
import type {
  StudioAgentCapability,
  StudioAuthStatus,
  StudioEvidence,
  StudioExecutor,
  StudioHealth,
  StudioPageAdapter,
  StudioStatus,
} from './studioBaseContracts';
import type { StudioExecutionRequest, StudioJob, StudioProject } from './studioProjectContracts';

export interface StudioReadinessGate {
  id: string;
  label: string;
  status: 'ready' | 'degraded' | 'blocked' | 'auth_missing' | 'unavailable' | string;
  required: boolean;
  message?: string;
  evidence?: Record<string, unknown>;
}

export interface StudioReadiness {
  status: 'ready' | 'degraded' | 'blocked' | string;
  checkedAt: string;
  summary: {
    ready: number;
    degraded: number;
    blocked: number;
    total: number;
  };
  gates: StudioReadinessGate[];
  health?: StudioHealth;
}

export interface StudioDeliveryAction {
  action: string;
  status: StudioStatus | string;
  message?: string;
  segmentId?: string;
  jobId?: string;
  pageId?: string;
  botName?: string;
}

export interface StudioDeliverySegment {
  segmentId: string;
  jobId?: string;
  pageId?: string;
  pageName?: string;
  agentId?: string;
  status: StudioStatus | string;
  botName?: string;
  mediaUrl?: string;
  posterUrl?: string;
  taskId?: string;
  authStatus?: StudioAuthStatus;
  evidence?: StudioEvidence;
  evidenceTrail?: StudioEvidence[];
  updatedAt?: string;
}

export interface StudioProjectDeliveryReport {
  projectId: string;
  conversationId: string;
  checkedAt: string;
  handoffStatus: 'ready' | 'in_progress' | 'needs_attention' | string;
  readyForHandoff: boolean;
  summary: {
    totalSegments: number;
    totalJobs: number;
    acceptedEvidence: number;
    pendingEvidence: number;
    issueCount: number;
    unresolvedActionCount: number;
  };
  statusCounts: Record<StudioStatus | string, number>;
  segments: StudioDeliverySegment[];
  jobs: StudioJob[];
  unresolvedActions: StudioDeliveryAction[];
}

export interface StudioDispatchMatrixEntry {
  pageId: StudioApi | string;
  pageName: string;
  kind: string;
  executor: StudioExecutor;
  agentId: string;
  recommendedAction: 'navigate' | 'execute-client' | 'execute-server' | string;
  dispatchReady: boolean;
  dispatchStatus: string;
  dispatchMessage?: string;
  authStatus: StudioAuthStatus;
  clientAction?: 'navigate' | string;
  navigationPath?: string;
  studioReturnPath?: string;
  routeParams: string[];
  missingRouteParams: string[];
  capabilities: string[];
  registrySource?: string;
}

export interface StudioDispatchMatrix {
  checkedAt: string;
  projectId?: string | null;
  sourceSegmentId?: string | null;
  sourceMediaUrl?: string;
  summary: {
    total: number;
    ready: number;
    blocked: number;
    missingParams: number;
    navigation: number;
    client: number;
    server: number;
  };
  entries: StudioDispatchMatrixEntry[];
}


export type StudioStatusCounts = Record<StudioStatus | string, number>;

export interface StudioOverviewPage extends StudioPageAdapter {
  agentIds: string[];
  jobCounts: StudioStatusCounts;
  latestJob?: StudioJob | null;
}

export interface StudioOverviewAgent extends StudioAgentCapability {
  jobCounts: StudioStatusCounts;
  latestJob?: StudioJob | null;
}

export interface StudioOverview {
  checkedAt: string;
  totals: {
    pages: number;
    agents: number;
    jobs: number;
    issues: number;
    [status: string]: number;
  };
  pages: StudioOverviewPage[];
  agents: StudioOverviewAgent[];
  latestJobs: StudioJob[];
}

export type StudioCoverageStatus = 'covered' | 'pending' | 'ready_unverified' | 'blocked' | string;

export interface StudioCoveragePage extends StudioDispatchMatrixEntry {
  coverageStatus: StudioCoverageStatus;
  jobCount: number;
  acceptedEvidence: number;
  latestJob?: StudioJob | null;
  latestEvidence?: StudioEvidence;
}

export interface StudioCoverageReport {
  status: 'ready' | 'ready_with_gaps' | 'blocked' | string;
  checkedAt: string;
  projectId?: string | null;
  sourceSegmentId?: string | null;
  sourceMediaUrl?: string;
  summary: StudioDispatchMatrix['summary'] & {
    covered: number;
    pending: number;
    readyUnverified: number;
    acceptedEvidence: number;
    issues: number;
    pendingJobs: number;
    withJobs: number;
  };
  pages: StudioCoveragePage[];
}

export interface StudioCoverageVerifyResult {
  status: 'verified' | 'no_verifiable_pages' | string;
  checkedAt: string;
  project: StudioProject;
  projectId: string;
  sourceSegmentId?: string | null;
  sourceMediaUrl?: string;
  matchedCount: number;
  createdCount: number;
  skippedCount: number;
  jobs: StudioJob[];
  skippedPages: Array<{
    pageId: StudioApi | string;
    pageName: string;
    executor: StudioExecutor | string;
    dispatchStatus: string;
    coverageStatus: StudioCoverageStatus;
    reason: string;
    message?: string;
    missingRouteParams?: string[];
  }>;
  coverage: StudioCoverageReport;
}

export interface StudioHandoffGate {
  id: string;
  label: string;
  status: 'ready' | 'needs_attention' | 'blocked' | string;
  required: boolean;
  message?: string;
}

export interface StudioHandoffGap {
  id: string;
  kind: 'page' | 'job' | string;
  pageId?: StudioApi | string;
  pageName?: string;
  sessionId?: string;
  targetId?: string;
  status: StudioCoverageStatus | StudioStatus | string;
  reason: string;
  message?: string;
  missingRouteParams?: string[];
}

export interface StudioOperatorActionNext {
  label?: string;
  message?: string;
  env?: string;
  command?: string;
  endpoint?: string;
  url?: string;
  retryEndpoint?: string;
  retryUrl?: string;
  cancelEndpoint?: string;
  cancelUrl?: string;
  uiUrl?: string;
  query?: Record<string, unknown>;
  targetId?: string;
  sessionId?: string;
}

export interface StudioHandoffAction {
  id: string;
  action: string;
  kind: 'page' | 'job' | string;
  targetId?: string;
  targetName?: string;
  status?: StudioCoverageStatus | StudioStatus | string;
  reason?: string;
  message?: string;
  pageId?: StudioApi | string;
  segmentId?: string;
  jobId?: string;
  sessionId?: string;
  uiUrl?: string;
  url?: string;
  retryUrl?: string;
  cancelUrl?: string;
  next?: StudioOperatorActionNext;
}

export interface StudioHandoffArtifact {
  id: string;
  label: string;
  endpoint: string;
  url: string;
  uiUrl?: string;
  projectId?: string;
  sessionId?: string;
  targetId?: string;
  query?: Record<string, unknown>;
  filename?: string;
}

export interface StudioHandoffSnapshot {
  status: 'ready' | 'needs_attention' | 'blocked' | string;
  readyForDelivery: boolean;
  checkedAt: string;
  projectId?: string | null;
  sourceSegmentId?: string | null;
  sourceMediaUrl?: string;
  summary: {
    pages: number;
    covered: number;
    pending: number;
    readyUnverified: number;
    blocked: number;
    acceptedEvidence: number;
    jobs: number;
    issues: number;
    deliveryAcceptedEvidence: number;
    deliveryPendingEvidence: number;
    unresolvedActions: number;
    gaps: number;
  };
  gates: StudioHandoffGate[];
  gaps: StudioHandoffGap[];
  actions: StudioHandoffAction[];
  artifacts: StudioHandoffArtifact[];
  reports: {
    health: StudioHealth;
    readiness: StudioReadiness;
    overview: StudioOverview;
    dispatchMatrix: StudioDispatchMatrix;
    coverage: StudioCoverageReport;
    deliveryReport?: StudioProjectDeliveryReport | null;
  };
}

export interface StudioDeliveryBundle {
  status: 'ready' | 'needs_attention' | 'blocked' | string;
  readyForDelivery: boolean;
  checkedAt: string;
  projectId: string;
  conversationId: string;
  sourceSegmentId?: string | null;
  sourceMediaUrl?: string;
  summary: {
    pages: number;
    covered: number;
    readyUnverified: number;
    blockedPages: number;
    jobs: number;
    acceptedJobs: number;
    dispatchSessions: number;
    dispatchTargets: number;
    remainingTargets: number;
    pendingTargets: number;
    visitedTargets: number;
    completedTargets: number;
    skippedTargets: number;
    errorTargets: number;
    cancelledTargets: number;
    blockedTargets: number;
    gaps: number;
    actions: number;
    artifacts: number;
  };
  targetStatusCounts: Record<string, number>;
  artifacts: StudioHandoffArtifact[];
  dispatchSessions: StudioDispatchSession[];
  acceptedJobs: StudioJob[];
  remainingTargets: StudioDispatchSessionTarget[];
  skippedTargets: Array<StudioDispatchBatchSkip | StudioDispatchSessionTarget>;
  errorTargets: StudioDispatchSessionTarget[];
  cancelledTargets: StudioDispatchSessionTarget[];
  reports: {
    deliveryReport: StudioProjectDeliveryReport;
    coverage: StudioCoverageReport;
    handoffSnapshot: StudioHandoffSnapshot;
  };
}

export interface StudioDeliveryAuditRequirement {
  id: string;
  label: string;
  status: 'ready' | 'degraded' | 'blocked' | 'needs_attention' | 'auth_missing' | string;
  required: boolean;
  message?: string;
  evidence?: Record<string, unknown>;
}

export interface StudioDeliveryAudit {
  status: 'ready' | 'degraded' | 'blocked' | string;
  checkedAt: string;
  projectId?: string | null;
  sourceSegmentId?: string | null;
  sourceMediaUrl?: string;
  summary: {
    pages: number;
    agents: number;
    readyTargets: number;
    missingParams: number;
    missingCorePages: number;
    missingCoreAgents: number;
    readinessGates: number;
    readinessReady: number;
    jobs: number;
    artifacts: number;
    actions: number;
  };
  requirements: StudioDeliveryAuditRequirement[];
  actions: StudioHandoffAction[];
  artifacts: StudioHandoffArtifact[];
  reports: {
    health: StudioHealth;
    readiness: StudioReadiness;
    overview: StudioOverview;
    dispatchMatrix: StudioDispatchMatrix;
    coverage: StudioCoverageReport;
    deliveryReport?: StudioProjectDeliveryReport | null;
    handoffSnapshot?: StudioHandoffSnapshot | null;
  };
}

export interface StudioActionResolveResult {
  status: 'executed' | 'skipped' | 'manual_required' | string;
  checkedAt: string;
  action: string;
  targetId: string;
  sessionId?: string | null;
  projectId?: string | null;
  sourceSegmentId?: string | null;
  resultType: 'coverage-verify' | 'operator-instruction' | string;
  message?: string;
  next?: StudioOperatorActionNext;
  result?: StudioCoverageVerifyResult | StudioDispatchSessionTargetRunResult | StudioDispatchSessionRetryResult;
  audit: StudioDeliveryAudit;
}

export interface StudioActionResolveBatchResult {
  status: 'executed' | 'executed_with_manual' | 'executed_with_skips' | 'manual_required' | 'skipped' | string;
  checkedAt: string;
  projectId?: string | null;
  sourceSegmentId?: string | null;
  summary: {
    requested: number;
    executed: number;
    manualRequired: number;
    skipped: number;
    createdJobs: number;
  };
  executedActions: Array<{
    status: string;
    action: string;
    targetId: string;
    sessionId?: string | null;
    resultType: string;
    jobId?: string;
    message?: string;
    result?: StudioCoverageVerifyResult | StudioDispatchSessionTargetRunResult | StudioDispatchSessionRetryResult;
  }>;
  manualActions: Array<{
    status: string;
    action: string;
    targetId: string;
    sessionId?: string | null;
    resultType: string;
    message?: string;
    next?: StudioActionResolveResult['next'];
  }>;
  skippedActions: Array<{
    status: string;
    action: string;
    targetId: string;
    resultType: string;
    reason?: string;
    message?: string;
  }>;
  result?: StudioCoverageVerifyResult | null;
  audit: StudioDeliveryAudit;
}

export interface StudioDispatchBatchTarget {
  id: string;
  pageId: StudioApi | string;
  pageName: string;
  kind: string;
  executor: StudioExecutor | string;
  agentId: string;
  recommendedAction: 'navigate' | 'execute-client' | 'execute-server' | string;
  dispatchStatus: string;
  dispatchMessage?: string;
  clientAction?: 'navigate' | string;
  navigationPath?: string;
  studioReturnPath?: string;
  routeParams: string[];
  missingRouteParams: string[];
  authStatus: StudioAuthStatus;
  capabilities: string[];
  projectId?: string | null;
  sourceSegmentId?: string | null;
  sourceMediaUrl?: string;
}

export interface StudioDispatchSessionRetryResult {
  session: StudioDispatchSession;
}

export interface StudioDispatchBatchSkip {
  id: string;
  pageId: StudioApi | string;
  pageName: string;
  kind: string;
  executor: StudioExecutor | string;
  agentId: string;
  recommendedAction: 'navigate' | 'execute-client' | 'execute-server' | string;
  dispatchStatus: string;
  reason: string;
  message?: string;
  navigationPath?: string;
  missingRouteParams: string[];
  authStatus: StudioAuthStatus;
}

export interface StudioDispatchBatchPlan {
  status: 'planned' | 'blocked' | string;
  readyForDispatch: boolean;
  checkedAt: string;
  projectId?: string | null;
  sourceSegmentId?: string | null;
  sourceMediaUrl?: string;
  summary: {
    total: number;
    planned: number;
    skipped: number;
    navigation: number;
    client: number;
    server: number;
    missingParams: number;
    blocked: number;
    coveredSkipped?: number;
  };
  excludeCovered?: boolean;
  targets: StudioDispatchBatchTarget[];
  skippedTargets: StudioDispatchBatchSkip[];
  matrix: StudioDispatchMatrix;
  handoffSnapshot: StudioHandoffSnapshot;
}

export type StudioDispatchSessionTargetStatus = 'pending' | 'visited' | 'completed' | 'skipped' | 'error' | 'cancelled' | string;

export interface StudioDispatchSessionTarget extends StudioDispatchBatchTarget {
  status: StudioDispatchSessionTargetStatus;
  evidence?: Record<string, unknown>;
  visitedAt?: string;
  completedAt?: string;
  skippedAt?: string;
  erroredAt?: string;
  retriedAt?: string;
  updatedAt?: string;
}

export interface StudioDispatchSession extends Omit<StudioDispatchBatchPlan, 'status' | 'readyForDispatch' | 'targets'> {
  sessionId: string;
  status: 'active' | 'needs_review' | 'done' | 'blocked' | 'cancelled' | string;
  readyForDispatch: boolean;
  createdAt: string;
  updatedAt: string;
  retryCount?: number;
  retriedAt?: string;
  planStatus?: string;
  summary: StudioDispatchBatchPlan['summary'] & {
    pending: number;
    visited: number;
    completed: number;
    targetSkipped: number;
    targetErrors: number;
    targetCancelled?: number;
  };
  targets: StudioDispatchSessionTarget[];
  nextTarget?: StudioDispatchSessionTarget | null;
  focusedTargetId?: string;
  focusedTargetIndex?: number;
  focusedTarget?: StudioDispatchSessionTarget | null;
}

export interface StudioDispatchSessionTargetRunResult {
  status: 'execution_required' | 'navigation_required' | string;
  checkedAt: string;
  session: StudioDispatchSession;
  target: StudioDispatchSessionTarget;
  job?: StudioJob;
  project?: StudioProject;
  executionRequest?: StudioExecutionRequest;
  navigationPath?: string;
}
