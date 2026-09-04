import React from 'react';

/**
 * How many of an execution's sources actually answered.
 *
 * Sent with the execution rows themselves rather than fetched per row: a page
 * is fifty executions and this belongs on the row the user is already looking
 * at. ``not_recorded`` is its own count and is not folded into either of the
 * others — a zero nobody observed is neither an answer nor a failure to
 * answer, and rounding it into either would state something resmon did not
 * see.
 */
interface SourceOutcomes {
  selected: number;
  answered: number;
  could_not_answer: number;
  not_recorded: number;
  sources_that_could_not_answer: string[];
}

interface Execution {
  id: number;
  execution_type: string;
  query?: string;
  keywords?: string[] | null;
  repositories?: string[] | null;
  status: string;
  start_time: string;
  end_time?: string;
  total_results?: number;
  new_results?: number;
  source_outcomes?: SourceOutcomes | null;
}

interface Props {
  executions: Execution[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  onToggleAll: () => void;
  onRowClick: (exec: Execution) => void;
  /** Open this execution straight at its Search record tab. */
  onOpenSearchRecord?: (exec: Execution) => void;
  typeFilter: string;
  statusFilter: string;
  onTypeFilterChange: (v: string) => void;
  onStatusFilterChange: (v: string) => void;
}

// Map execution_type → badge CSS class. Each type gets a distinct palette
// that does not collide with the Status badges (green/red/blue).
const typeBadgeClass = (t: string): string => {
  switch (t) {
    case 'deep_dive':
    case 'dive':
      return 'badge-type-dive';
    case 'deep_sweep':
    case 'sweep':
      return 'badge-type-sweep';
    case 'routine':
      return 'badge-type-routine';
    default:
      return 'badge-type-other';
  }
};

const statusBadgeClass = (s: string): string => {
  if (s === 'completed') return 'badge-success';
  if (s === 'failed') return 'badge-error';
  if (s === 'cancelled') return 'badge-cancelled';
  return 'badge-info';
};

// Parse a flat query string into keywords, respecting double/single quotes
// so "machine learning" robotics → ['machine learning', 'robotics']. This is
// only used as a fallback for legacy executions that don't have a dedicated
// ``keywords`` list persisted alongside the query.
const parseQueryString = (q: string): string[] => {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const part = m[1] ?? m[2] ?? m[3];
    if (part && part.length > 0) out.push(part);
  }
  return out;
};

const formatKeywords = (exec: Execution): string => {
  if (exec.keywords && exec.keywords.length > 0) {
    return exec.keywords.join(', ');
  }
  if (exec.query && exec.query.trim()) {
    const parts = parseQueryString(exec.query.trim());
    return (parts.length > 0 ? parts : [exec.query.trim()]).join(', ');
  }
  return '—';
};

const formatRepos = (exec: Execution): string => {
  if (exec.repositories && exec.repositories.length > 0) {
    return exec.repositories.join(', ');
  }
  return '—';
};

/**
 * The coverage line under a row.
 *
 * Says nothing when every source answered, because a badge that is always
 * present is a badge nobody reads. Says "reason not recorded" separately from
 * "could not answer", because runs from before resmon 1.8.6 carry no reason
 * and presenting their zeros as measured would be the overclaim this whole
 * surface exists to avoid.
 */
const CoverageNote: React.FC<{
  exec: Execution;
  onOpen?: (exec: Execution) => void;
}> = ({ exec, onOpen }) => {
  const o = exec.source_outcomes;
  if (!o || o.selected === 0) return null;
  if (o.could_not_answer === 0 && o.not_recorded === 0) return null;

  const parts: string[] = [];
  if (o.could_not_answer > 0) {
    parts.push(`${o.could_not_answer} of ${o.selected} sources could not answer`);
  }
  if (o.not_recorded > 0) {
    parts.push(
      `${o.not_recorded} returned nothing for a reason resmon did not record`,
    );
  }

  return (
    <div
      className="results-coverage"
      title={
        o.sources_that_could_not_answer.length
          ? o.sources_that_could_not_answer.join(', ')
          : undefined
      }
    >
      {parts.join('; ')}
      {onOpen && (
        <>
          {' — '}
          <button
            type="button"
            className="link-button"
            onClick={(ev) => { ev.stopPropagation(); onOpen(exec); }}
          >
            see the search record
          </button>
        </>
      )}
    </div>
  );
};

const ResultsList: React.FC<Props> = ({
  executions,
  selected,
  onToggle,
  onToggleAll,
  onRowClick,
  onOpenSearchRecord,
  typeFilter,
  statusFilter,
  onTypeFilterChange,
  onStatusFilterChange,
}) => {
  const filtered = executions.filter((e) => {
    if (typeFilter && e.execution_type !== typeFilter) return false;
    if (statusFilter && e.status !== statusFilter) return false;
    return true;
  });

  const allSelected =
    filtered.length > 0 && filtered.every((e) => selected.has(e.id));

  return (
    <div className="results-list">
      <div className="results-filters">
        <select className="form-select" value={typeFilter} onChange={(e) => onTypeFilterChange(e.target.value)}>
          <option value="">All Types</option>
          <option value="deep_dive">Deep Dive</option>
          <option value="deep_sweep">Deep Sweep</option>
          <option value="routine">Routine</option>
        </select>
        <select className="form-select" value={statusFilter} onChange={(e) => onStatusFilterChange(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <table className="simple-table">
        <thead>
          <tr>
            <th><input type="checkbox" checked={allSelected} onChange={onToggleAll} /></th>
            <th>Date</th>
            <th>Name</th>
            <th>Type</th>
            <th>Repos</th>
            <th>Query</th>
            <th>Status</th>
            <th>Results</th>
            <th>New</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr><td colSpan={9} className="text-muted text-center">No executions found.</td></tr>
          )}
          {filtered.map((e) => (
              <tr
                key={e.id}
                className={`clickable-row ${selected.has(e.id) ? 'row-selected' : ''}`}
                onClick={() => onRowClick(e)}
              >
                <td onClick={(ev) => ev.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(e.id)} onChange={() => onToggle(e.id)} />
                </td>
                <td>{e.start_time?.slice(0, 16)?.replace('T', ' ') || '—'}</td>
                <td>Execution #{e.id}</td>
                <td><span className={`badge ${typeBadgeClass(e.execution_type)}`}>{e.execution_type}</span></td>
                <td className="ellipsis-cell" title={formatRepos(e)}>{formatRepos(e)}</td>
                <td className="ellipsis-cell" title={formatKeywords(e)}>{formatKeywords(e)}</td>
                <td>
                  <span className={`badge ${statusBadgeClass(e.status)}`}>
                    {e.status}
                  </span>
                </td>
                <td>
                  {e.total_results ?? '—'}
                  <CoverageNote exec={e} onOpen={onOpenSearchRecord} />
                </td>
                <td>{e.new_results ?? '—'}</td>
              </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default ResultsList;
