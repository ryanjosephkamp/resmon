import React, { useState, useEffect, useRef } from 'react';
import { getBaseUrl, apiClient } from '../../api/client';
import { useExecution, ProgressEvent } from '../../context/ExecutionContext';

/* ------------------------------------------------------------------ */
/* Progress helpers                                                    */
/* ------------------------------------------------------------------ */

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return '--:--:--';
  }
}

function eventIcon(type: string): string {
  switch (type) {
    case 'repo_done':
    case 'complete':
      return '✓';
    case 'repo_error':
    case 'error':
      return '✕';
    case 'repo_start':
      return '⟳';
    case 'stage':
      return '▸';
    case 'cancelled':
      return '⊘';
    default:
      return '·';
  }
}

function eventSeverity(type: string): string {
  switch (type) {
    case 'repo_done':
    case 'complete':
      return 'pv-success';
    case 'repo_error':
    case 'error':
      return 'pv-error';
    case 'cancelled':
      return 'pv-warning';
    case 'stage':
      return 'pv-stage';
    default:
      return 'pv-info';
  }
}

function eventText(ev: ProgressEvent): string {
  switch (ev.type) {
    case 'execution_start':
      return `Execution started — ${ev.execution_type ?? 'search'} across ${ev.total_repos ?? '?'} repositories`;
    case 'stage':
      return ev.message ?? `Stage: ${ev.stage}`;
    case 'repo_start':
      return `Querying: ${ev.repository} (${ev.index}/${ev.total_repos})`;
    case 'repo_done':
      return `${ev.repository}: ${ev.result_count ?? 0} results`;
    case 'repo_error':
      return `${ev.repository}: error — ${ev.error ?? 'unknown'}`;
    case 'dedup_stats':
      return `Dedup: ${ev.total ?? 0} total, ${ev.new ?? 0} new, ${ev.duplicates ?? 0} dupes, ${ev.invalid ?? 0} invalid`;
    case 'complete':
      return `Completed — ${ev.result_count ?? 0} results in ${ev.elapsed?.toFixed(1) ?? '?'}s`;
    case 'cancelled':
      return 'Cancelled by user';
    case 'error':
      return `Failed: ${ev.message ?? 'unknown error'}`;
    default:
      return ev.message ?? ev.type;
  }
}

/* ------------------------------------------------------------------ */
/* ProgressTimeline sub-component                                      */
/* ------------------------------------------------------------------ */

const ProgressTimeline: React.FC<{ events: ProgressEvent[] }> = ({ events }) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  if (events.length === 0) {
    return <p className="text-muted">No progress events recorded.</p>;
  }

  // Drop the trailing ``complete`` event emitted alongside ``cancelled``
  // so the Results & Logs → Progress tab stops after "Cancelled by user"
  // instead of showing a misleading "Completed — 0 results" green line.
  const filteredEvents = events.filter(
    (ev) => !(ev.type === 'complete' && ev.status === 'cancelled'),
  );

  return (
    <div className="pv-timeline">
      {filteredEvents.map((ev, i) => (
        <div key={i} className={`pv-entry ${eventSeverity(ev.type)}`}>
          <span className="pv-icon">{eventIcon(ev.type)}</span>
          <span className="pv-time">{formatTime(ev.timestamp)}</span>
          <span className="pv-text">{eventText(ev)}</span>
          {ev.type === 'stage' && (
            <span className="pv-pill">{ev.stage}</span>
          )}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

interface Props {
  executionId: number;
  onClose: () => void;
  initialTab?: 'report' | 'log' | 'meta' | 'progress';
}

const ReportViewer: React.FC<Props> = ({ executionId, onClose, initialTab }) => {
  const [tab, setTab] = useState<'report' | 'log' | 'meta' | 'progress'>(initialTab ?? 'report');
  const [report, setReport] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [meta, setMeta] = useState<Record<string, any> | null>(null);
  const [progressEvents, setProgressEvents] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState('');
  const [exportPath, setExportPath] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);

  const { activeExecution } = useExecution();
  const isLive =
    activeExecution?.executionId === executionId &&
    activeExecution?.status === 'running';

  /* Fetch core data */
  useEffect(() => {
    /* Reset stale data from previous execution before fetching */
    setReport(null);
    setLog(null);
    setMeta(null);
    setProgressEvents([]);
    setError('');

    apiClient.get(`/api/executions/${executionId}`)
      .then(setMeta)
      .catch(() => setMeta(null));
    apiClient.get<{ report_text: string }>(`/api/executions/${executionId}/report`)
      .then((r) => setReport(r.report_text))
      .catch(() => setReport(null));
    apiClient.get<{ log_text: string }>(`/api/executions/${executionId}/log`)
      .then((r) => setLog(r.log_text))
      .catch(() => setLog(null));
  }, [executionId]);

  /* Progress: historical fetch or live SSE */
  useEffect(() => {
    if (isLive) {
      /* Live: mirror events from context */
      return;
    }
    /* Historical: fetch persisted events */
    apiClient
      .get<ProgressEvent[]>(
        `/api/executions/${executionId}/progress/events`,
      )
      .then((r) => setProgressEvents(Array.isArray(r) ? r : []))
      .catch(() => setProgressEvents([]));
  }, [executionId, isLive]);

  /* Derive events source: live from context or historical */
  const displayEvents = isLive
    ? activeExecution?.events ?? []
    : progressEvents;

  const handleExport = async () => {
    setExportError('');
    setExportPath('');
    setExporting(true);
    try {
      const resp = await apiClient.post<{ path: string }>('/api/executions/export', {
        ids: [executionId],
      });
      setExportPath(resp.path);
      setTimeout(() => setExportPath(''), 10000);
    } catch (err: any) {
      setExportError(err?.message ?? 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleReveal = () => {
    if (exportPath && window.resmonAPI?.revealPath) {
      window.resmonAPI.revealPath(exportPath);
    }
  };

  const revealLabel = window.resmonAPI?.platform === 'darwin'
    ? 'Reveal in Finder'
    : 'Reveal in File Explorer';

  return (
    <div className="report-viewer">
      <div className="report-viewer-header">
        <h3>Execution #{executionId}</h3>
        <div className="form-actions">
          <button className="btn btn-sm btn-secondary" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export'}
          </button>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      {exportError && <div className="form-error">{exportError}</div>}
      {exportPath && (
        <div className="form-success" style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
          <span>Export saved to: {exportPath}</span>
          {window.resmonAPI?.revealPath && (
            <button className="btn btn-secondary" onClick={handleReveal} style={{ padding: '4px 10px', fontSize: 12 }}>
              {revealLabel}
            </button>
          )}
        </div>
      )}
      <div className="tab-bar">
        <button className={`tab-btn ${tab === 'report' ? 'tab-active' : ''}`} onClick={() => setTab('report')}>Report</button>
        <button className={`tab-btn ${tab === 'log' ? 'tab-active' : ''}`} onClick={() => setTab('log')}>Log</button>
        <button className={`tab-btn ${tab === 'meta' ? 'tab-active' : ''}`} onClick={() => setTab('meta')}>Metadata</button>
        <button className={`tab-btn ${tab === 'progress' ? 'tab-active' : ''}`} onClick={() => setTab('progress')}>
          Progress{isLive && <span className="sidebar-pulse" style={{ marginLeft: 6 }} />}
        </button>
      </div>
      <div className="report-viewer-body">
        {tab === 'report' && (
          report !== null
            ? <pre className="report-text">{report}</pre>
            : <p className="text-muted">No report available.</p>
        )}
        {tab === 'log' && (
          log !== null
            ? <pre className="log-text">{log}</pre>
            : <p className="text-muted">No log available.</p>
        )}
        {tab === 'meta' && meta && (
          <div className="meta-grid">
            {Object.entries(meta).map(([k, v]) => (
              <div key={k} className="meta-row">
                <span className="meta-key">{k}</span>
                <span className="meta-value">{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</span>
              </div>
            ))}
          </div>
        )}
        {tab === 'progress' && (
          <ProgressTimeline events={displayEvents} />
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
    </div>
  );
};

export default ReportViewer;
