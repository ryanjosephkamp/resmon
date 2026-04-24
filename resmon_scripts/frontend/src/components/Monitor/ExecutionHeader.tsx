import React from 'react';
import { ActiveExecution, useExecution } from '../../context/ExecutionContext';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatElapsedHMS(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function typeLabel(t: string): string {
  if (t === 'deep_dive') return 'Deep Dive';
  if (t === 'deep_sweep') return 'Deep Sweep';
  if (t === 'automated_sweep') return 'Automated Sweep';
  return t;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'running':
      return 'mon-badge mon-badge--running';
    case 'completed':
      return 'mon-badge mon-badge--completed';
    case 'failed':
      return 'mon-badge mon-badge--failed';
    case 'cancelled':
      return 'mon-badge mon-badge--cancelled';
    default:
      return 'mon-badge';
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface ExecutionHeaderProps {
  exec: ActiveExecution;
}

const ExecutionHeader: React.FC<ExecutionHeaderProps> = ({ exec }) => {
  const { cancelExecution } = useExecution();

  return (
    <div className="mon-header">
      <div className="mon-header-top">
        <h2 className="mon-header-title">
          Execution #{exec.executionId} — {typeLabel(exec.executionType)}
        </h2>
        <span className="mon-header-clock">
          ⏱ {formatElapsedHMS(exec.elapsedSeconds)}
        </span>
      </div>

      <div className="mon-header-meta">
        <span className={statusBadgeClass(exec.status)}>
          {exec.status === 'running' && '● '}
          {exec.status.charAt(0).toUpperCase() + exec.status.slice(1)}
        </span>

        {exec.status === 'running' && (
          <button
            className="btn btn-sm btn-danger"
            onClick={() => cancelExecution(exec.executionId)}
          >
            Cancel
          </button>
        )}
      </div>

      {/* Post-completion summary */}
      {exec.status !== 'running' && (
        <div className="mon-header-summary">
          <span>Results: <strong>{exec.resultCount}</strong></span>
          <span>New: <strong>{exec.newCount}</strong></span>
          <span>
            Elapsed: <strong>{formatElapsedHMS(exec.elapsedSeconds)}</strong>
          </span>
          <a className="btn btn-sm" href={`#/results?exec=${exec.executionId}`}>
            View Report
          </a>
        </div>
      )}
    </div>
  );
};

export default ExecutionHeader;
