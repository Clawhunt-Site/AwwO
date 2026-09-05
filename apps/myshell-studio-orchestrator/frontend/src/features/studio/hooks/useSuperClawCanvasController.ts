import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelSuperClawRun,
  fetchSuperClawRun,
  fetchSuperClawRuns,
  fetchSuperClawStatus,
  resumeSuperClawRun,
  runSuperClawCanvas,
  streamSuperClawRunEvents,
  type SuperClawCanvasRunRequest,
  type SuperClawCanvasRunResponse,
  type SuperClawRunEvent,
  type SuperClawRunSummary,
  type SuperClawStatusResponse,
} from '../api';

const TERMINAL_RUN_STATUSES = new Set([
  'done',
  'completed',
  'complete',
  'succeeded',
  'success',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'timeout',
  'timed_out',
]);

function runIdOf(run: SuperClawRunSummary | null | undefined): string {
  const id = run?.run_id || run?.id;
  return typeof id === 'string' ? id : '';
}

function runStatusOf(run: SuperClawRunSummary | null | undefined): string {
  const status = run?.status;
  return typeof status === 'string' ? status : '';
}

function eventStatusOf(event: SuperClawRunEvent): string {
  if (typeof event.status === 'string') return event.status;
  const nested = event.run;
  if (nested && typeof nested === 'object' && 'status' in nested) {
    const status = (nested as { status?: unknown }).status;
    return typeof status === 'string' ? status : '';
  }
  return '';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function useSuperClawCanvasController() {
  const streamAbortRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<SuperClawStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [runs, setRuns] = useState<SuperClawRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [activeRun, setActiveRun] = useState<SuperClawRunSummary | null>(null);
  const [activeRunEvents, setActiveRunEvents] = useState<SuperClawRunEvent[]>([]);
  const [lastResult, setLastResult] = useState<SuperClawCanvasRunResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [watchingRunId, setWatchingRunId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const stopWatching = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setWatchingRunId('');
  }, []);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const nextStatus = await fetchSuperClawStatus();
      setStatus(nextStatus);
      return nextStatus;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const nextRuns = await fetchSuperClawRuns();
      setRuns(nextRuns);
      return nextRuns;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const watchRun = useCallback(
    async (runId: string) => {
      if (!runId) return;
      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;
      setWatchingRunId(runId);
      try {
        await streamSuperClawRunEvents(
          runId,
          (event, rawEventName) => {
            const nextEvent = { ...event, type: event.type || event.event || rawEventName };
            setActiveRunEvents((prev) => [...prev, nextEvent].slice(-80));
            const nextStatus = eventStatusOf(nextEvent);
            if (nextStatus) {
              setActiveRun((prev) => ({ ...(prev || {}), run_id: runId, status: nextStatus }));
            }
          },
          controller.signal,
        );
        const latestRun = await fetchSuperClawRun(runId).catch(() => null);
        if (latestRun) setActiveRun(latestRun);
        await refreshRuns();
      } catch (err) {
        if (!isAbortError(err)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
          setWatchingRunId('');
        }
      }
    },
    [refreshRuns],
  );

  const runCanvas = useCallback(
    async (payload: SuperClawCanvasRunRequest) => {
      setSubmitting(true);
      setError(null);
      setActiveRunEvents([]);
      try {
        const result = await runSuperClawCanvas(payload);
        setLastResult(result);
        setActiveRun(result.run);
        void refreshRuns();
        void watchRun(result.execution.runId);
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [refreshRuns, watchRun],
  );

  const cancelActiveRun = useCallback(async () => {
    const runId = runIdOf(activeRun);
    if (!runId) return null;
    setError(null);
    try {
      const nextRun = await cancelSuperClawRun(runId);
      setActiveRun(nextRun);
      await refreshRuns();
      return nextRun;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [activeRun, refreshRuns]);

  const resumeActiveRun = useCallback(async () => {
    const runId = runIdOf(activeRun);
    if (!runId) return null;
    setError(null);
    try {
      const nextRun = await resumeSuperClawRun(runId);
      setActiveRun(nextRun);
      void watchRun(runId);
      await refreshRuns();
      return nextRun;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [activeRun, refreshRuns, watchRun]);

  useEffect(() => {
    void refreshStatus();
    void refreshRuns();
    return stopWatching;
  }, [refreshRuns, refreshStatus, stopWatching]);

  const activeRunStatus = runStatusOf(activeRun);
  const activeRunId = runIdOf(activeRun);
  const activeRunInFlight = Boolean(activeRunId && activeRunStatus && !TERMINAL_RUN_STATUSES.has(activeRunStatus));
  const statusLabel = useMemo(() => {
    if (statusLoading) return 'checking';
    if (!status) return 'unknown';
    if (status.api.reachable) return status.gateway.reachable ? 'ready' : 'api-only';
    return status.configured.apiBase ? 'offline' : 'default-local';
  }, [status, statusLoading]);

  return {
    status,
    statusLabel,
    statusLoading,
    runs,
    runsLoading,
    activeRun,
    activeRunId,
    activeRunStatus,
    activeRunEvents,
    lastResult,
    submitting,
    watchingRunId,
    activeRunInFlight,
    busy: submitting || activeRunInFlight,
    error,
    refreshStatus,
    refreshRuns,
    runCanvas,
    watchRun,
    cancelActiveRun,
    resumeActiveRun,
    stopWatching,
  };
}
