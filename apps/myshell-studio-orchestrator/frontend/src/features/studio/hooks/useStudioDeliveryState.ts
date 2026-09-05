import { useCallback, useMemo, useState } from 'react';

import {
  getStudioDispatchSelectionPageIds,
  getStudioDispatchTargetHref,
} from '../api';
import type {
  StudioCoverageReport,
  StudioDeliveryAudit,
  StudioDeliveryBundle,
  StudioDispatchBatchPlan,
  StudioDispatchMatrix,
  StudioDispatchMatrixEntry,
  StudioDispatchSession,
  StudioHandoffSnapshot,
  StudioHealth,
  StudioProject,
  StudioProjectDeliveryReport,
  StudioReadiness,
  StudioOverview,
} from '../api';
import { saveLastStudioProjectId } from '../session';
import {
  absoluteAppHref,
  copyTextToClipboard,
} from '../components/delivery';

interface StudioDeliveryStateOptions {
  project: StudioProject | null;
  selectedSegment: { id: string } | null;
}

export function useStudioDeliveryState({ project, selectedSegment }: StudioDeliveryStateOptions) {
  const [studioHealth, setStudioHealth] = useState<StudioHealth | null>(null);
  const [studioOverview, setStudioOverview] = useState<StudioOverview | null>(null);
  const [studioReadiness, setStudioReadiness] = useState<StudioReadiness | null>(null);
  const [deliveryAudit, setDeliveryAudit] = useState<StudioDeliveryAudit | null>(null);
  const [deliveryReport, setDeliveryReport] = useState<StudioProjectDeliveryReport | null>(null);
  const [dispatchMatrix, setDispatchMatrix] = useState<StudioDispatchMatrix | null>(null);
  const [selectedDispatchPageIds, setSelectedDispatchPageIds] = useState<string[]>([]);
  const [coverageReport, setCoverageReport] = useState<StudioCoverageReport | null>(null);
  const [handoffSnapshot, setHandoffSnapshot] = useState<StudioHandoffSnapshot | null>(null);
  const [deliveryBundle, setDeliveryBundle] = useState<StudioDeliveryBundle | null>(null);
  const [dispatchBatchPlan, setDispatchBatchPlan] = useState<StudioDispatchBatchPlan | null>(null);
  const [dispatchSession, setDispatchSession] = useState<StudioDispatchSession | null>(null);
  const [coverageVerifyRunning, setCoverageVerifyRunning] = useState(false);
  const [deliveryAuditRefreshing, setDeliveryAuditRefreshing] = useState(false);
  const [resolvingAuditActionId, setResolvingAuditActionId] = useState<string | null>(null);
  const [resolvingAuditBatch, setResolvingAuditBatch] = useState(false);
  const [handoffRefreshing, setHandoffRefreshing] = useState(false);
  const [deliveryBundleLoading, setDeliveryBundleLoading] = useState(false);
  const [dispatchBatchPlanning, setDispatchBatchPlanning] = useState(false);
  const [dispatchSessionRunning, setDispatchSessionRunning] = useState(false);

  const studioContextSourceSegmentId = useMemo(
    () =>
      selectedSegment?.id ||
      dispatchMatrix?.sourceSegmentId ||
      coverageReport?.sourceSegmentId ||
      handoffSnapshot?.sourceSegmentId ||
      project?.selectedSegmentId ||
      project?.segments?.[project.segments.length - 1]?.id,
    [
      coverageReport?.sourceSegmentId,
      dispatchMatrix?.sourceSegmentId,
      handoffSnapshot?.sourceSegmentId,
      project?.selectedSegmentId,
      project?.segments,
      selectedSegment?.id,
    ],
  );

  const selectedDispatchBatchPageIds = useMemo(
    () => getStudioDispatchSelectionPageIds(dispatchMatrix?.entries || [], selectedDispatchPageIds),
    [dispatchMatrix?.entries, selectedDispatchPageIds],
  );

  const applyHandoffSnapshot = useCallback((snapshot: StudioHandoffSnapshot) => {
    setHandoffSnapshot(snapshot);
    setStudioHealth(snapshot.reports.health);
    setStudioReadiness(snapshot.reports.readiness);
    setStudioOverview(snapshot.reports.overview);
    setDispatchMatrix(snapshot.reports.dispatchMatrix);
    setCoverageReport(snapshot.reports.coverage);
    setDeliveryReport(snapshot.reports.deliveryReport || null);
  }, []);

  const applyDispatchSession = useCallback(
    (session: StudioDispatchSession) => {
      setDispatchSession(session);
      setDispatchBatchPlan({
        status: session.planStatus || session.status,
        readyForDispatch: session.readyForDispatch,
        checkedAt: session.checkedAt,
        projectId: session.projectId,
        sourceSegmentId: session.sourceSegmentId,
        sourceMediaUrl: session.sourceMediaUrl,
        summary: session.summary,
        targets: session.targets,
        skippedTargets: session.skippedTargets,
        matrix: session.matrix,
        handoffSnapshot: session.handoffSnapshot,
      });
      if (session.projectId) saveLastStudioProjectId(session.projectId);
      if (session.handoffSnapshot) applyHandoffSnapshot(session.handoffSnapshot);
    },
    [applyHandoffSnapshot],
  );

  const applyDeliveryAudit = useCallback((audit: StudioDeliveryAudit) => {
    setDeliveryAudit(audit);
    setStudioHealth(audit.reports.health);
    setStudioReadiness(audit.reports.readiness);
    setStudioOverview(audit.reports.overview);
    setDispatchMatrix(audit.reports.dispatchMatrix);
    setCoverageReport(audit.reports.coverage);
    setDeliveryReport(audit.reports.deliveryReport || null);
    if (audit.reports.handoffSnapshot) {
      setHandoffSnapshot(audit.reports.handoffSnapshot);
    }
  }, []);

  const toggleDispatchBatchPage = useCallback((pageId: string) => {
    setSelectedDispatchPageIds((current) => {
      const id = String(pageId || '').trim();
      const selected = new Set(current.filter(Boolean));
      if (!id) return [...selected];
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return [...selected];
    });
  }, []);

  const selectDispatchBatchPages = useCallback((pageIds: string[]) => {
    setSelectedDispatchPageIds(Array.from(new Set(pageIds.filter(Boolean))));
  }, []);

  const clearDispatchBatchPages = useCallback(() => {
    setSelectedDispatchPageIds([]);
  }, []);

  const copyMatrixEntryLink = useCallback((entry: StudioDispatchMatrixEntry) => {
    const href = getStudioDispatchTargetHref(entry);
    if (!href) return;
    void copyTextToClipboard(absoluteAppHref(href));
  }, []);

  const resetDeliveryState = useCallback(() => {
    setDeliveryReport(null);
    setDeliveryAudit(null);
    setCoverageReport(null);
    setHandoffSnapshot(null);
    setDeliveryBundle(null);
    setDispatchBatchPlan(null);
    setDispatchSession(null);
    setSelectedDispatchPageIds([]);
  }, []);

  return {
    applyDeliveryAudit,
    applyDispatchSession,
    applyHandoffSnapshot,
    clearDispatchBatchPages,
    copyMatrixEntryLink,
    coverageReport,
    coverageVerifyRunning,
    deliveryAudit,
    deliveryAuditRefreshing,
    deliveryBundle,
    deliveryBundleLoading,
    deliveryReport,
    dispatchBatchPlan,
    dispatchBatchPlanning,
    dispatchMatrix,
    dispatchSession,
    dispatchSessionRunning,
    handoffRefreshing,
    handoffSnapshot,
    resetDeliveryState,
    resolvingAuditActionId,
    resolvingAuditBatch,
    selectDispatchBatchPages,
    selectedDispatchBatchPageIds,
    setCoverageReport,
    setCoverageVerifyRunning,
    setDeliveryAuditRefreshing,
    setDeliveryBundle,
    setDeliveryBundleLoading,
    setDeliveryReport,
    setDispatchBatchPlan,
    setDispatchBatchPlanning,
    setDispatchMatrix,
    setDispatchSessionRunning,
    setHandoffRefreshing,
    setResolvingAuditActionId,
    setResolvingAuditBatch,
    setStudioHealth,
    setStudioOverview,
    setStudioReadiness,
    studioContextSourceSegmentId,
    studioHealth,
    studioOverview,
    studioReadiness,
    toggleDispatchBatchPage,
  };
}
