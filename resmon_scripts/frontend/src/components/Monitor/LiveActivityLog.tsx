import React, { useEffect, useRef, useState } from 'react';
import { ProgressEvent } from '../../context/ExecutionContext';

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return '--:--:--';
  }
}

function severityClass(type: string): string {
  switch (type) {
    case 'repo_done':
    case 'complete': return 'log-success';
    case 'repo_error':
    case 'error': return 'log-error';
    case 'cancelled': return 'log-warning';
    default: return 'log-info';
  }
}

/** Event types considered "verbose" — hidden unless user enables verbose mode. */
const VERBOSE_ONLY_TYPES = new Set<string>([
  'log_entry',
  'query_progress',
  'normalize_progress',
  'link_progress',
  'ai_progress',
  'report_saved',
  'ai_start',
  'ai_done',
]);

function eventMessage(ev: ProgressEvent): string {
  switch (ev.type) {
    case 'execution_start':
      return `Execution started — ${ev.execution_type ?? 'search'} across ${ev.total_repos ?? '?'} repositories`;
    case 'stage':
      return `Stage: ${ev.message ?? ev.stage}`;
    case 'repo_start':
      return `Querying repository: ${ev.repository} (${ev.index}/${ev.total_repos})`;
    case 'repo_done':
      return `${ev.repository}: ${ev.result_count ?? 0} results`;
    case 'repo_error':
      return `${ev.repository}: error — ${ev.error ?? 'unknown'}`;
    case 'query_progress':
      return `  ${ev.repository}: ${ev.message ?? 'progress update'}`;
    case 'normalize_progress':
      return `  Normalizing ${ev.processed ?? '?'}/${ev.total ?? '?'} results`;
    case 'link_progress':
      return `  Linked ${ev.processed ?? '?'}/${ev.total ?? '?'} documents`;
    case 'dedup_stats':
      return `Deduplication: ${ev.total ?? 0} total, ${ev.new ?? 0} new, ${ev.duplicates ?? 0} duplicates, ${ev.invalid ?? 0} invalid`;
    case 'report_saved':
      return `Report saved: ${ev.report_path ?? ''}`;
    case 'ai_start':
      return 'AI summarization started';
    case 'ai_progress':
      return `  ${ev.message ?? 'AI progress'}`;
    case 'ai_done':
      return `AI summarization completed (${ev.summary_length ?? 0} chars)`;
    case 'log_entry':
      return `  ${ev.message ?? ''}`;
    case 'complete':
      return `Execution completed — ${ev.result_count ?? 0} results in ${ev.elapsed?.toFixed(1) ?? '?'}s`;
    case 'cancelled':
      return 'Execution cancelled by user';
    case 'error':
      return `Execution failed: ${ev.message ?? ev.error ?? 'unknown error'}`;
    default:
      return ev.message ?? ev.type;
  }
}

interface LiveActivityLogProps {
  events: ProgressEvent[];
  verbose?: boolean;
}

const LiveActivityLog: React.FC<LiveActivityLogProps> = ({ events, verbose = false }) => {
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);

  const visible = verbose
    ? events
    : events.filter((ev) => !VERBOSE_ONLY_TYPES.has(ev.type));

  // When an execution is cancelled the backend emits both a ``cancelled``
  // event and a trailing ``complete`` event (with ``status: "cancelled"``)
  // so downstream lifecycle consumers can mark the stream finished. The
  // log should stop after "Execution cancelled by user" rather than also
  // rendering a misleading green "Execution completed" line — drop any
  // ``complete`` event whose status is ``cancelled``.
  const deduped = visible.filter(
    (ev) => !(ev.type === 'complete' && ev.status === 'cancelled'),
  );

  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [visible.length, autoScroll]);

  const filtered = filter
    ? deduped.filter((ev) => eventMessage(ev).toLowerCase().includes(filter.toLowerCase()))
    : deduped;

  return (
    <div className="mon-log">
      <div className="mon-log-toolbar">
        <h3 className="mon-section-title">
          Live Activity Log {verbose && <span className="mon-log-verbose-tag">verbose</span>}
        </h3>
        <div className="mon-log-controls">
          <input
            type="text"
            className="mon-log-filter"
            placeholder="Filter log…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="mon-log-autoscroll">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
        </div>
      </div>

      <div className="mon-log-body">
        {filtered.length === 0 && <div className="mon-log-empty">No events yet.</div>}
        {filtered.map((ev, i) => (
          <div key={i} className={`mon-log-entry ${severityClass(ev.type)}`}>
            <span className="mon-log-time">{formatTime(ev.timestamp)}</span>
            <span className="mon-log-msg">{eventMessage(ev)}</span>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
};

export default LiveActivityLog;
