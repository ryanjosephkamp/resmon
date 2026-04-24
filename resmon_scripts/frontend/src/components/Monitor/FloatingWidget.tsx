import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useExecution } from '../../context/ExecutionContext';

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function stageLabel(stage?: string): string {
  const map: Record<string, string> = {
    querying: 'Querying repositories',
    dedup: 'Deduplicating results',
    linking: 'Linking documents',
    reporting: 'Generating report',
    summarizing: 'AI summarization',
    finalizing: 'Finalizing',
  };
  return stage ? map[stage] ?? stage : 'Initializing…';
}

function typeLabel(t: string): string {
  if (t === 'deep_dive') return 'Deep Dive';
  if (t === 'deep_sweep') return 'Deep Sweep';
  if (t === 'automated_sweep') return 'Auto Sweep';
  return t;
}

function repoIcon(status: string): string {
  switch (status) {
    case 'done': return '✓';
    case 'querying': return '⟳';
    case 'error': return '✗';
    default: return '○';
  }
}

function statusLabel(status: string): string {
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'cancelling') return 'Stopping…';
  return 'Running';
}

const FloatingWidget: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    activeExecution: exec,
    activeExecutions,
    executionOrder,
    focusedExecutionId,
    focusExecution,
    cancelExecution,
    clearExecution,
    isMonitorVisible,
    isWidgetMinimized,
    setWidgetMinimized,
    isWidgetPulsing,
    stopWidgetPulse,
  } = useExecution();

  const [isStackPopoverOpen, setStackPopoverOpen] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!isStackPopoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setStackPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [isStackPopoverOpen]);

  // Auto-minimize the floating widget whenever the user navigates to a page
  // where the full execution/results context is already on-screen. Firing
  // on pathname change (not every render) preserves the user's ability to
  // re-expand manually while still on the same page.
  const lastPathRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const p = location.pathname;
    const prev = lastPathRef.current;
    lastPathRef.current = p;
    if (p === prev) return;
    if (p === '/monitor' || p.startsWith('/results') || p === '/calendar') {
      setWidgetMinimized(true);
    }
  }, [location.pathname, setWidgetMinimized]);

  if (!exec || !isMonitorVisible) return null;

  const isRunning = exec.status === 'running';
  const isCancelling = exec.status === 'cancelling';
  const isActive = isRunning || isCancelling;
  const isSuccess = exec.status === 'completed';
  const isFailure = exec.status === 'failed' || exec.status === 'cancelled';

  const pulseClass = isWidgetPulsing
    ? (isSuccess ? ' floating-widget--pulse-success' :
       isFailure ? ' floating-widget--pulse-error' : '')
    : '';

  const doneCount = Object.values(exec.repoStatuses).filter((s) => s === 'done').length;
  const total = exec.totalRepos ?? exec.repositories.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const others = executionOrder.filter((id) => id !== focusedExecutionId);
  const hasStack = executionOrder.length >= 2;
  const overflowCount = others.length;

  const handleWidgetClick = () => {
    if (isWidgetPulsing) stopWidgetPulse();
  };

  if (isWidgetMinimized) {
    return (
      <div
        className={`floating-widget floating-widget--minimized${pulseClass}`}
        onClick={(e) => {
          handleWidgetClick();
          e.stopPropagation();
          setWidgetMinimized(false);
        }}
        title="Expand monitor"
      >
        {isRunning && <span className="fw-pulse" />}
        <span className="fw-abbr">{typeLabel(exec.executionType)}</span>
        <span className="fw-time">{formatElapsed(exec.elapsedSeconds)}</span>
        {hasStack && (
          <span className="fw-stack-badge" title={`${executionOrder.length} active executions`}>
            +{executionOrder.length - 1}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`floating-widget floating-widget--expanded${pulseClass}`}
      onClick={handleWidgetClick}
    >
      <div className="fw-header">
        {isRunning && <span className="fw-pulse" />}
        <span className="fw-title">{typeLabel(exec.executionType)}</span>
        <span className={`fw-status fw-status--${exec.status}`}>
          {statusLabel(exec.status)}
        </span>
        <span className="fw-time">{formatElapsed(exec.elapsedSeconds)}</span>
        <button
          className="fw-minimize-btn"
          onClick={(e) => { e.stopPropagation(); setWidgetMinimized(true); }}
          title="Minimize"
        >─</button>
        {!isRunning && (
          <button
            className="fw-close-btn"
            onClick={(e) => { e.stopPropagation(); clearExecution(); }}
            title="Close"
          >×</button>
        )}
      </div>

      {hasStack && (
        <div className="fw-stack-strip" onClick={(e) => e.stopPropagation()}>
          <span className="fw-stack-label">Also running:</span>
          {overflowCount > 0 && (
            <div className="fw-stack-popover-wrap" ref={popoverRef}>
              <button
                type="button"
                className="fw-stack-more"
                onClick={(e) => {
                  e.stopPropagation();
                  setStackPopoverOpen((v) => !v);
                }}
                aria-expanded={isStackPopoverOpen}
                data-testid="fw-stack-more"
              >
                +{overflowCount} more
              </button>
              {isStackPopoverOpen && (
                <div className="fw-stack-popover" role="menu">
                  {others.map((id) => {
                    const other = activeExecutions[id];
                    if (!other) return null;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="menuitem"
                        className={`fw-stack-popover-item fw-stack-chip--${other.status}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          focusExecution(id);
                          setStackPopoverOpen(false);
                        }}
                        data-testid={`fw-stack-popover-chip-${id}`}
                      >
                        #{id} {typeLabel(other.executionType)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="fw-body" onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        navigate('/monitor');
      }}>
        <div className="fw-stage">{stageLabel(exec.currentStage)}</div>
        <div className="fw-progress-row">
          <div className="fw-progress-bar">
            <div className="fw-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="fw-progress-label">{doneCount}/{total} repos</span>
        </div>
        <div className="fw-repo-chips">
          {exec.repositories.map((r) => (
            <span
              key={r}
              className={`fw-chip fw-chip--${exec.repoStatuses[r] ?? 'pending'}`}
              title={r}
            >
              {repoIcon(exec.repoStatuses[r] ?? 'pending')} {r}
            </span>
          ))}
        </div>
        <div className="fw-results">
          Results: <strong>{exec.resultCount}</strong>
          {exec.newCount > 0 && <span className="fw-new"> ({exec.newCount} new)</span>}
        </div>
      </div>

      <div className="fw-footer">
        {isActive ? (
          <>
            <button
              className="btn btn-sm btn-danger"
              disabled={isCancelling}
              onClick={(e) => { e.stopPropagation(); cancelExecution(exec.executionId); }}
            >{isCancelling ? <><span className="fw-spinner" aria-hidden="true" /> Stopping…</> : 'Cancel'}</button>
            <button
              className="btn btn-sm"
              onClick={(e) => { e.stopPropagation(); navigate('/monitor'); }}
            >View Monitor</button>
          </>
        ) : (
          <>
            <button
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/results?exec=${exec.executionId}`);
              }}
            >View Report</button>
            <button
              className="btn btn-sm"
              onClick={(e) => { e.stopPropagation(); navigate('/monitor'); }}
            >View Monitor</button>
          </>
        )}
      </div>
    </div>
  );
};

export default FloatingWidget;
