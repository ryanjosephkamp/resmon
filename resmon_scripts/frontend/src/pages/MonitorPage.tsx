import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useExecution, ActiveExecution } from '../context/ExecutionContext';
import { apiClient } from '../api/client';
import ExecutionHeader from '../components/Monitor/ExecutionHeader';
import PipelineStages from '../components/Monitor/PipelineStages';
import RepoProgressGrid from '../components/Monitor/RepoProgressGrid';
import StatsCounters from '../components/Monitor/StatsCounters';
import LiveActivityLog from '../components/Monitor/LiveActivityLog';
import PageHelp from '../components/Help/PageHelp';

interface RoutineLite {
  id: number;
  name: string;
}

function typeLabel(t: string): string {
  if (t === 'deep_dive') return 'Deep Dive';
  if (t === 'deep_sweep') return 'Deep Sweep';
  if (t === 'automated_sweep') return 'Automated Sweep';
  return t;
}

function statusDotClass(status: ActiveExecution['status']): string {
  switch (status) {
    case 'running': return 'mon-tab-dot mon-tab-dot-running';
    case 'cancelling': return 'mon-tab-dot mon-tab-dot-cancelling';
    case 'completed': return 'mon-tab-dot mon-tab-dot-completed';
    case 'failed': return 'mon-tab-dot mon-tab-dot-failed';
    case 'cancelled': return 'mon-tab-dot mon-tab-dot-cancelled';
    default: return 'mon-tab-dot';
  }
}

function isTerminal(status: ActiveExecution['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const MonitorPage: React.FC = () => {
  const {
    activeExecutions,
    executionOrder,
    focusedExecutionId,
    focusExecution,
    clearExecution,
    verboseLogging,
    setVerboseLogging,
  } = useExecution();
  const navigate = useNavigate();

  const [routines, setRoutines] = useState<RoutineLite[]>([]);
  const [execRoutineId, setExecRoutineId] = useState<Record<number, number | null>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiClient.get<RoutineLite[]>('/api/routines');
        if (!cancelled && Array.isArray(data)) setRoutines(data);
      } catch { /* endpoint may not be ready */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const missing = executionOrder.filter((id) => !(id in execRoutineId));
    if (missing.length === 0) return;
    (async () => {
      for (const execId of missing) {
        try {
          const row = await apiClient.get<any>(`/api/executions/${execId}`);
          if (cancelled) return;
          setExecRoutineId((prev) => ({
            ...prev,
            [execId]: row?.routine_id ?? null,
          }));
        } catch {
          if (cancelled) return;
          setExecRoutineId((prev) => ({ ...prev, [execId]: null }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [executionOrder, execRoutineId]);

  const routineNameById = useMemo(() => {
    const map: Record<number, string> = {};
    for (const r of routines) map[r.id] = r.name;
    return map;
  }, [routines]);

  const focusedExec: ActiveExecution | null =
    focusedExecutionId !== null ? activeExecutions[focusedExecutionId] ?? null : null;

  if (executionOrder.length === 0) {
    return (
      <div className="mon-page">
        <PageHelp
          storageKey="monitor"
          title="Monitor"
          summary="Real-time view of every execution in progress on this device."
          sections={[
            {
              heading: 'What this page shows',
              body: (
                <ul>
                  <li>One tab per active execution (manual dive, manual sweep, or routine-fired sweep).</li>
                  <li>The focused execution displays its pipeline stages, per-repository progress grid, aggregate counters, and a live activity log.</li>
                  <li>Completed, failed, and cancelled executions remain on the page until you dismiss them with the <strong>✕</strong> on their tab.</li>
                </ul>
              ),
            },
            {
              heading: 'Controls',
              body: (
                <ul>
                  <li><strong>Cancel</strong> (on the execution header) requests a graceful stop — the run finishes its current batch, flushes partial results, and marks itself <em>cancelled</em>.</li>
                  <li><strong>Verbose logging</strong> toggles INFO-level lines in the activity log; WARN / ERROR always show.</li>
                </ul>
              ),
            },
          ]}
        />
        <div className="mon-empty">
          <h2>No active executions.</h2>
          <p>
            Start a Deep Dive or Deep Sweep, or wait for a scheduled routine to fire.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mon-page">
      <PageHelp
        storageKey="monitor"
        title="Monitor"
        summary="Real-time view of every execution in progress on this device."
        sections={[
          {
            heading: 'What this page shows',
            body: (
              <ul>
                <li>One tab per active execution (manual dive, manual sweep, or routine-fired sweep).</li>
                <li>The focused execution displays its pipeline stages, per-repository progress grid, aggregate counters, and a live activity log.</li>
                <li>Completed, failed, and cancelled executions remain on the page until you dismiss them with the <strong>✕</strong> on their tab.</li>
              </ul>
            ),
          },
          {
            heading: 'Controls',
            body: (
              <ul>
                <li><strong>Cancel</strong> (on the execution header) requests a graceful stop — the run finishes its current batch, flushes partial results, and marks itself <em>cancelled</em>.</li>
                <li><strong>Verbose logging</strong> toggles INFO-level lines in the activity log; WARN / ERROR always show.</li>
              </ul>
            ),
          },
        ]}
      />
      <div className="mon-tabs" role="tablist" aria-label="Active executions">
        {executionOrder.map((id) => {
          const exec = activeExecutions[id];
          if (!exec) return null;
          const routineId = execRoutineId[id] ?? null;
          const routineName = routineId !== null ? routineNameById[routineId] : undefined;
          const focused = id === focusedExecutionId;
          const terminal = isTerminal(exec.status);
          return (
            <div
              key={id}
              role="tab"
              aria-selected={focused}
              tabIndex={0}
              className={`mon-tab${focused ? ' mon-tab-active' : ''}`}
              onClick={() => focusExecution(id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  focusExecution(id);
                }
              }}
              data-testid={`mon-tab-${id}`}
            >
              <span className={statusDotClass(exec.status)} aria-hidden="true" />
              <span className="mon-tab-id">#{id}</span>
              <span className="mon-tab-type">{typeLabel(exec.executionType)}</span>
              {routineName && (
                <span className="mon-tab-routine" title={routineName}>
                  {routineName}
                </span>
              )}
              <span className="mon-tab-clock">{formatClock(exec.elapsedSeconds)}</span>
              <button
                type="button"
                className="mon-tab-close"
                disabled={!terminal}
                title={terminal ? 'Dismiss this execution' : 'Execution is still active'}
                aria-label={`Dismiss execution ${id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (terminal) clearExecution(id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {focusedExec ? (
        <>
          <div className="mon-toolbar">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={verboseLogging}
                onChange={(e) => setVerboseLogging(e.target.checked)}
              />
              <span>Verbose activity log</span>
            </label>
            <div className="mon-toolbar-spacer" />
            {isTerminal(focusedExec.status) && (
              <>
                <button
                  className="btn btn-sm"
                  onClick={() => navigate(`/results?exec=${focusedExec.executionId}`)}
                >
                  View Report
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => clearExecution(focusedExec.executionId)}
                  title="Clear monitor display"
                >
                  Clear Page
                </button>
              </>
            )}
          </div>
          <ExecutionHeader exec={focusedExec} />
          <PipelineStages exec={focusedExec} />
          <div className="mon-two-col">
            <RepoProgressGrid exec={focusedExec} />
            <StatsCounters exec={focusedExec} />
          </div>
          <LiveActivityLog events={focusedExec.events} verbose={verboseLogging} />
        </>
      ) : (
        <div className="mon-empty">
          <p>Select an execution above to view its live progress.</p>
        </div>
      )}
    </div>
  );
};

export default MonitorPage;
