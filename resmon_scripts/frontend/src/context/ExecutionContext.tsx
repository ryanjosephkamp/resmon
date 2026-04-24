import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apiClient } from '../api/client';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ProgressEvent {
  type: string;
  timestamp: string;
  [key: string]: any;
}

export interface ActiveExecution {
  executionId: number;
  executionType: 'deep_dive' | 'deep_sweep' | 'automated_sweep';
  repositories: string[];
  startTime: string;
  events: ProgressEvent[];
  status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  currentRepo?: string;
  currentRepoIndex?: number;
  totalRepos?: number;
  resultCount: number;
  newCount: number;
  repoStatuses: Record<string, 'pending' | 'querying' | 'done' | 'error'>;
  currentStage?: string;
  elapsedSeconds: number;
  /**
   * Originating routine id for automated_sweep executions. Enriched
   * asynchronously from GET /api/executions/{id} after startExecution.
   * Always `null` / absent for manual dive and sweep runs.
   */
  routine_id?: number | null;
}

interface ExecutionContextValue {
  activeExecutions: Record<number, ActiveExecution>;
  executionOrder: number[];
  focusedExecutionId: number | null;
  focusExecution: (id: number) => void;
  /** Backward-compatible accessor pointing at the focused execution. */
  activeExecution: ActiveExecution | null;
  startExecution: (
    execId: number,
    type: string,
    repos: string[],
    backendStartTime?: string,
  ) => void;
  cancelExecution: (execId: number) => Promise<void>;
  /** Remove an execution from the store. Defaults to the focused id. */
  clearExecution: (id?: number) => void;
  completionCounter: number;
  isMonitorVisible: boolean;
  setMonitorVisible: (v: boolean) => void;
  isWidgetMinimized: boolean;
  setWidgetMinimized: (v: boolean) => void;
  isWidgetPulsing: boolean;
  stopWidgetPulse: () => void;
  verboseLogging: boolean;
  setVerboseLogging: (v: boolean) => void;
  hasAnyRunning: boolean;
}

/* ------------------------------------------------------------------ */
/* State reducer                                                       */
/* ------------------------------------------------------------------ */

function updateExecutionState(
  prev: ActiveExecution,
  event: ProgressEvent,
): ActiveExecution {
  const next: ActiveExecution = {
    ...prev,
    events: [...prev.events, event],
  };

  switch (event.type) {
    case 'repo_start':
      next.repoStatuses = { ...next.repoStatuses, [event.repository]: 'querying' };
      next.currentRepo = event.repository;
      next.currentRepoIndex = event.index;
      next.totalRepos = event.total_repos;
      break;
    case 'repo_done':
      next.repoStatuses = { ...next.repoStatuses, [event.repository]: 'done' };
      next.resultCount += event.result_count ?? 0;
      break;
    case 'repo_error':
      next.repoStatuses = { ...next.repoStatuses, [event.repository]: 'error' };
      break;
    case 'dedup_stats':
      next.resultCount = (event.total ?? 0) - (event.invalid ?? 0);
      next.newCount = event.new ?? 0;
      break;
    case 'stage':
      next.currentStage = event.stage;
      break;
    case 'complete':
      next.status = event.status ?? 'completed';
      next.resultCount = event.result_count ?? next.resultCount;
      next.newCount = event.new_count ?? next.newCount;
      break;
    case 'cancelled':
      next.status = 'cancelled';
      break;
    case 'error':
      next.status = 'failed';
      break;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

async function fetchNotificationSettings(): Promise<{
  notify_manual: boolean;
  notify_automatic_mode: 'all' | 'selected' | 'none';
}> {
  try {
    const s = await apiClient.get<any>('/api/settings/notifications');
    return {
      notify_manual: s?.notify_manual !== false,
      notify_automatic_mode: (s?.notify_automatic_mode as any) || 'none',
    };
  } catch {
    return { notify_manual: true, notify_automatic_mode: 'none' };
  }
}

async function maybeNotifyCompletion(exec: ActiveExecution): Promise<void> {
  try {
    if (typeof Notification === 'undefined') return;
    const settings = await fetchNotificationSettings();
    const isManual = exec.executionType === 'deep_dive' || exec.executionType === 'deep_sweep';

    if (isManual && !settings.notify_manual) return;
    if (!isManual) {
      // Per-routine ``notify_on_complete`` always fires, regardless of
      // the global automatic mode. Otherwise fall back to the global
      // mode: ``all`` fires for every routine run, ``none`` suppresses,
      // ``selected`` defers to the per-routine flag.
      let perRoutineOptIn = false;
      try {
        const row = await apiClient.get<any>(`/api/executions/${exec.executionId}`);
        const routineId = row?.routine_id;
        if (routineId) {
          const routine = await apiClient.get<any>(`/api/routines/${routineId}`);
          perRoutineOptIn = !!routine?.notify_on_complete;
        }
      } catch {
        /* fall through to global-mode logic */
      }
      if (!perRoutineOptIn) {
        if (settings.notify_automatic_mode === 'none') return;
        if (settings.notify_automatic_mode === 'selected') return;
      }
    }

    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    if (Notification.permission !== 'granted') return;

    const success = exec.status === 'completed';
    const title = success ? 'resmon: Execution Completed' : `resmon: Execution ${exec.status}`;
    const typeLabel =
      exec.executionType === 'deep_dive' ? 'Deep Dive' :
      exec.executionType === 'deep_sweep' ? 'Deep Sweep' : 'Automated Sweep';
    const body = success
      ? `${typeLabel} finished — ${exec.resultCount} results (${exec.newCount} new).`
      : `${typeLabel} ended with status: ${exec.status}.`;
    new Notification(title, { body });
  } catch {
    /* never let notifications break the app */
  }
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

const ExecutionContext = createContext<ExecutionContextValue | null>(null);

const VERBOSE_KEY = 'resmon.verboseLogging';

export const ExecutionProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [activeExecutions, setActiveExecutions] = useState<Record<number, ActiveExecution>>({});
  const [executionOrder, setExecutionOrder] = useState<number[]>([]);
  const [focusedExecutionId, setFocusedExecutionId] = useState<number | null>(null);

  const [isMonitorVisible, setMonitorVisible] = useState(true);
  const [isWidgetMinimized, setWidgetMinimized] = useState(false);
  const [isWidgetPulsing, setIsWidgetPulsing] = useState(false);
  const [completionCounter, setCompletionCounter] = useState(0);
  const [verboseLogging, setVerboseLoggingState] = useState<boolean>(() => {
    try { return localStorage.getItem(VERBOSE_KEY) === 'true'; } catch { return false; }
  });

  const setVerboseLogging = useCallback((v: boolean) => {
    setVerboseLoggingState(v);
    try { localStorage.setItem(VERBOSE_KEY, v ? 'true' : 'false'); } catch { /* ignore */ }
  }, []);

  const stopWidgetPulse = useCallback(() => setIsWidgetPulsing(false), []);

  /**
   * Bump ``completionCounter`` and fire the ``resmon:execution-completed``
   * window event exactly once per execution id. Pages that don't pull
   * from the context directly (CalendarPage, DashboardPage, ResultsPage)
   * listen for this event so they refresh regardless of which code path
   * detected the completion.
   */
  const broadcastCompletion = useCallback(
    (
      execId: number,
      detail: { executionType?: string; status?: string; source: string },
    ) => {
      if (completionBroadcastRef.current.has(execId)) return;
      completionBroadcastRef.current.add(execId);
      setCompletionCounter((c) => c + 1);
      try {
        if (
          typeof window !== 'undefined' &&
          typeof CustomEvent !== 'undefined'
        ) {
          window.dispatchEvent(
            new CustomEvent('resmon:execution-completed', {
              detail: { executionId: execId, ...detail },
            }),
          );
        }
      } catch {
        /* CustomEvent unsupported — ignore */
      }
    },
    [],
  );

  /* Per-id poll + elapsed-timer intervals. Keyed by executionId. */
  const pollsRef = useRef<Record<number, number>>({});
  const timersRef = useRef<Record<number, number>>({});
  const startMsRef = useRef<Record<number, number>>({});
  const eventCursorRef = useRef<Record<number, number>>({});
  const completedIdsRef = useRef<Set<number>>(new Set());
  // Provider-scoped set of execution ids we've observed as active at
  // least once. Shared between the per-id progress poller and the
  // global ``/api/executions/active`` poller so the safety-net dropout
  // detection can cover both manually-dispatched and
  // background-attached runs.
  const trackedIdsRef = useRef<Set<number>>(new Set());
  // Ids we've already broadcast a completion signal for. Guards against
  // double-firing ``completionCounter`` / ``resmon:execution-completed``
  // when both the terminal-event path and the active-dropout path
  // observe the same execution.
  const completionBroadcastRef = useRef<Set<number>>(new Set());

  const stopPollingFor = useCallback((execId: number) => {
    const p = pollsRef.current[execId];
    if (p !== undefined) {
      window.clearInterval(p);
      delete pollsRef.current[execId];
    }
    const t = timersRef.current[execId];
    if (t !== undefined) {
      window.clearInterval(t);
      delete timersRef.current[execId];
    }
  }, []);

  const stopAllPolling = useCallback(() => {
    for (const id of Object.keys(pollsRef.current)) {
      window.clearInterval(pollsRef.current[Number(id)]);
    }
    for (const id of Object.keys(timersRef.current)) {
      window.clearInterval(timersRef.current[Number(id)]);
    }
    pollsRef.current = {};
    timersRef.current = {};
  }, []);

  const focusExecution = useCallback((id: number) => {
    setFocusedExecutionId(id);
  }, []);

  const clearExecution = useCallback((id?: number) => {
    setFocusedExecutionId((currentFocus) => {
      const targetId = id ?? currentFocus;
      if (targetId === null || targetId === undefined) return currentFocus;

      stopPollingFor(targetId);
      completedIdsRef.current.delete(targetId);
      delete startMsRef.current[targetId];
      delete eventCursorRef.current[targetId];

      setActiveExecutions((prev) => {
        if (!(targetId in prev)) return prev;
        const next = { ...prev };
        delete next[targetId];
        return next;
      });

      let nextFocus: number | null = currentFocus;
      setExecutionOrder((prev) => {
        const filtered = prev.filter((x) => x !== targetId);
        if (currentFocus === targetId) {
          nextFocus = filtered.length > 0 ? filtered[filtered.length - 1] : null;
        }
        return filtered;
      });

      return nextFocus;
    });
    setIsWidgetPulsing(false);
  }, [stopPollingFor]);

  /* Unmount safety */
  useEffect(() => {
    return () => {
      stopAllPolling();
    };
  }, [stopAllPolling]);

  /* Spawn / replace pollers for one execution id. */
  const spawnPollerFor = useCallback(
    (execId: number, backendStartTime?: string) => {
      stopPollingFor(execId);
      eventCursorRef.current[execId] = 0;
      startMsRef.current[execId] = backendStartTime
        ? new Date(backendStartTime).getTime()
        : Date.now();

      pollsRef.current[execId] = window.setInterval(async () => {
        try {
          const allEvents: ProgressEvent[] = await apiClient.get(
            `/api/executions/${execId}/progress/events?t=${Date.now()}`,
          );
          if (!Array.isArray(allEvents)) return;
          const cursor = eventCursorRef.current[execId] ?? 0;
          if (allEvents.length <= cursor) return;

          const newEvents = allEvents.slice(cursor);
          eventCursorRef.current[execId] = allEvents.length;

          let terminalSnapshot: ActiveExecution | null = null;
          setActiveExecutions((prev) => {
            const existing = prev[execId];
            if (!existing) return prev;
            let current = existing;
            let terminal = false;
            for (const ev of newEvents) {
              current = updateExecutionState(current, ev);
              if (ev.type === 'complete' || ev.type === 'cancelled' || ev.type === 'error') {
                terminal = true;
              }
            }
            if (terminal && !completedIdsRef.current.has(execId)) {
              completedIdsRef.current.add(execId);
              terminalSnapshot = current;
            }
            return { ...prev, [execId]: current };
          });

          if (terminalSnapshot !== null) {
            stopPollingFor(execId);
            setIsWidgetPulsing(true);
            broadcastCompletion(execId, {
              executionType: (terminalSnapshot as ActiveExecution).executionType,
              status: (terminalSnapshot as ActiveExecution).status,
              source: 'progress-poller',
            });
            maybeNotifyCompletion(terminalSnapshot);
          }
        } catch {
          /* endpoint not ready — retry next interval */
        }
      }, 1000);

      /* Elapsed-time ticker — only advances while status === 'running' */
      timersRef.current[execId] = window.setInterval(() => {
        setActiveExecutions((prev) => {
          const existing = prev[execId];
          if (!existing || existing.status !== 'running') return prev;
          return {
            ...prev,
            [execId]: {
              ...existing,
              elapsedSeconds: Math.floor(
                (Date.now() - (startMsRef.current[execId] ?? Date.now())) / 1000,
              ),
            },
          };
        });
      }, 1000);
    },
    [stopPollingFor],
  );

  /* Start tracking a new execution. */
  const startExecution = useCallback(
    (execId: number, type: string, repos: string[], backendStartTime?: string) => {
      const initial: ActiveExecution = {
        executionId: execId,
        executionType: type as ActiveExecution['executionType'],
        repositories: repos,
        startTime: backendStartTime || new Date().toISOString(),
        events: [],
        status: 'running',
        resultCount: 0,
        newCount: 0,
        repoStatuses: Object.fromEntries(repos.map((r) => [r, 'pending' as const])),
        elapsedSeconds: 0,
      };

      completedIdsRef.current.delete(execId);
      completionBroadcastRef.current.delete(execId);
      trackedIdsRef.current.add(execId);
      setIsWidgetPulsing(false);

      setActiveExecutions((prev) => ({ ...prev, [execId]: initial }));
      setExecutionOrder((prev) => {
        if (prev.includes(execId)) return prev;
        return [...prev, execId];
      });
      setFocusedExecutionId(execId);

      spawnPollerFor(execId, backendStartTime);

      /* Async-enrich with routine_id from the backend row. Fire-and-forget;
       * failures are silently ignored (manual runs have no routine_id). */
      (async () => {
        try {
          const row = await apiClient.get<any>(`/api/executions/${execId}`);
          const rid =
            typeof row?.routine_id === 'number' ? row.routine_id : null;
          if (rid === null) return;
          setActiveExecutions((prev) => {
            const cur = prev[execId];
            if (!cur) return prev;
            if (cur.routine_id === rid) return prev;
            return { ...prev, [execId]: { ...cur, routine_id: rid } };
          });
        } catch {
          /* ignore — manual runs won't have a routine_id */
        }
      })();

      try {
        if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('resmon:execution-started', {
              detail: { executionId: execId, executionType: type },
            }),
          );
        }
      } catch {
        /* CustomEvent not supported — ignore */
      }
    },
    [spawnPollerFor],
  );

  /* On mount, reconnect to every in-progress execution, then poll
   * ``/api/executions/active`` periodically so background-initiated
   * runs (e.g. APScheduler-fired routines) are attached as soon as they
   * start. Attaching spawns the progress poller, which in turn drives
   * table refreshes (``completionCounter``) and OS notifications. */
  useEffect(() => {
    let cancelled = false;
    const attachedThisMount = new Set<number>();

    const attachActiveIds = async (ids: number[]) => {
      for (const execId of ids) {
        if (cancelled) return;
        if (attachedThisMount.has(execId)) continue;
        if (trackedIdsRef.current.has(execId)) {
          attachedThisMount.add(execId);
          continue;
        }
        attachedThisMount.add(execId);
        try {
          const ex = await apiClient.get<any>(`/api/executions/${execId}`);
          if (cancelled) return;
          const repos: string[] = (() => {
            try {
              const params = JSON.parse(ex.parameters || '{}');
              if (params.repositories) return params.repositories;
              if (params.repository) return [params.repository];
            } catch { /* ignore */ }
            return [];
          })();
          startExecution(execId, ex.execution_type, repos, ex.start_time);
          // Bump the completion counter so any table bound to it
          // re-fetches and shows the newly running row.
          setCompletionCounter((c) => c + 1);
        } catch {
          // If the fetch fails, drop from attachedThisMount so the
          // next tick will retry rather than silently giving up.
          attachedThisMount.delete(execId);
        }
      }
    };

    // Safety-net completion detection: any id we've tracked that is no
    // longer in the backend's active set has finished. The per-id
    // progress poller normally fires the terminal-event path first,
    // but this covers manual runs where the progress poller's last
    // tick missed the ``complete`` event (e.g. the backend cleaned up
    // the live store between polls) and background-attached routine
    // runs alike. ``broadcastCompletion`` is idempotent per id.
    const handleActiveDropouts = (currentIds: number[]) => {
      const currentSet = new Set(currentIds);
      for (const id of Array.from(trackedIdsRef.current)) {
        if (currentSet.has(id)) continue;
        if (completionBroadcastRef.current.has(id)) continue;
        setIsWidgetPulsing(true);
        broadcastCompletion(id, { source: 'active-dropout' });
      }
    };

    const tick = async () => {
      try {
        const data = await apiClient.get<{ active_ids: number[] }>(
          '/api/executions/active',
        );
        if (cancelled || !data?.active_ids) return;
        await attachActiveIds(data.active_ids);
        handleActiveDropouts(data.active_ids);
      } catch {
        /* backend not ready — retry next interval */
      }
    };

    void tick();
    const interval = window.setInterval(() => { void tick(); }, 3000);
    return () => { cancelled = true; window.clearInterval(interval); };
  // `activeExecutions` intentionally omitted — we want this effect to
  // run exactly once per `startExecution` identity, with the interval
  // owning its own lifecycle. Including `activeExecutions` would
  // reinitialize the poller on every state change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startExecution, broadcastCompletion]);

  /* Cancel a specific execution. */
  const cancelExecution = useCallback(
    async (execId: number) => {
      setActiveExecutions((prev) => {
        const existing = prev[execId];
        if (!existing || existing.status !== 'running') return prev;
        return { ...prev, [execId]: { ...existing, status: 'cancelling' } };
      });
      try {
        await apiClient.post(`/api/executions/${execId}/cancel`);
      } catch {
        /* backend may have already finished */
      }
    },
    [],
  );

  const activeExecution = useMemo<ActiveExecution | null>(() => {
    if (focusedExecutionId === null) return null;
    return activeExecutions[focusedExecutionId] ?? null;
  }, [activeExecutions, focusedExecutionId]);

  const hasAnyRunning = useMemo<boolean>(() => {
    for (const id of executionOrder) {
      if (activeExecutions[id]?.status === 'running') return true;
    }
    return false;
  }, [activeExecutions, executionOrder]);

  return (
    <ExecutionContext.Provider
      value={{
        activeExecutions,
        executionOrder,
        focusedExecutionId,
        focusExecution,
        activeExecution,
        startExecution,
        cancelExecution,
        clearExecution,
        completionCounter,
        isMonitorVisible,
        setMonitorVisible,
        isWidgetMinimized,
        setWidgetMinimized,
        isWidgetPulsing,
        stopWidgetPulse,
        verboseLogging,
        setVerboseLogging,
        hasAnyRunning,
      }}
    >
      {children}
    </ExecutionContext.Provider>
  );
};

export function useExecution(): ExecutionContextValue {
  const ctx = useContext(ExecutionContext);
  if (!ctx) {
    throw new Error('useExecution must be used within an ExecutionProvider');
  }
  return ctx;
}
