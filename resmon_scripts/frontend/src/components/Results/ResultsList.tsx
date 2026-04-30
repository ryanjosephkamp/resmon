import React from 'react';

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
  execution_location?: 'local' | 'cloud';
  execution_id?: string;
}

export type LocationFilter = 'all' | 'local' | 'cloud';

interface Props {
  executions: Execution[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  onToggleAll: () => void;
  onRowClick: (exec: Execution) => void;
  typeFilter: string;
  statusFilter: string;
  onTypeFilterChange: (v: string) => void;
  onStatusFilterChange: (v: string) => void;
  locationFilter?: LocationFilter;
  onLocationFilterChange?: (v: LocationFilter) => void;
  showLocationFilter?: boolean;
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

const ResultsList: React.FC<Props> = ({
  executions,
  selected,
  onToggle,
  onToggleAll,
  onRowClick,
  typeFilter,
  statusFilter,
  onTypeFilterChange,
  onStatusFilterChange,
  locationFilter = 'all',
  onLocationFilterChange,
  showLocationFilter = false,
}) => {
  const filtered = executions.filter((e) => {
    if (typeFilter && e.execution_type !== typeFilter) return false;
    if (statusFilter && e.status !== statusFilter) return false;
    return true;
  });

  const selectableFiltered = filtered.filter(
    (e) => (e.execution_location ?? 'local') === 'local',
  );
  const allSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((e) => selected.has(e.id));

  return (
    <div className="results-list">
      <div className="results-filters">
        {showLocationFilter && onLocationFilterChange && (
          <div
            role="group"
            aria-label="Execution location"
            className="filter-chip-group"
            style={{ display: 'inline-flex', gap: 4 }}
          >
            {(['all', 'local', 'cloud'] as LocationFilter[]).map((v) => (
              <button
                key={v}
                type="button"
                className={`btn btn-sm ${locationFilter === v ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={locationFilter === v}
                onClick={() => onLocationFilterChange(v)}
              >
                {v === 'all' ? 'All' : v === 'local' ? 'Local' : 'Cloud'}
              </button>
            ))}
          </div>
        )}
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
            <th>Source</th>
            <th>Repos</th>
            <th>Query</th>
            <th>Status</th>
            <th>Results</th>
            <th>New</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr><td colSpan={10} className="text-muted text-center">No executions found.</td></tr>
          )}
          {filtered.map((e) => {
            const loc = e.execution_location ?? 'local';
            const isCloud = loc === 'cloud';
            const rowKey = isCloud ? `cloud:${e.execution_id}` : `local:${e.id}`;
            return (
              <tr
                key={rowKey}
                className={`clickable-row ${!isCloud && selected.has(e.id) ? 'row-selected' : ''}`}
                onClick={() => onRowClick(e)}
              >
                <td onClick={(ev) => ev.stopPropagation()}>
                  {isCloud ? (
                    <span className="text-muted" title="Cloud executions are read-only here" aria-hidden="true">—</span>
                  ) : (
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => onToggle(e.id)} />
                  )}
                </td>
                <td>{e.start_time?.slice(0, 16)?.replace('T', ' ') || '—'}</td>
                <td>Execution #{e.id}</td>
                <td><span className={`badge ${typeBadgeClass(e.execution_type)}`}>{e.execution_type}</span></td>
                <td>
                  <span
                    className={`badge ${isCloud ? 'badge-info' : 'badge-type-other'}`}
                    data-testid={`location-badge-${rowKey}`}
                  >
                    {isCloud ? 'Cloud' : 'Local'}
                  </span>
                </td>
                <td className="ellipsis-cell" title={formatRepos(e)}>{formatRepos(e)}</td>
                <td className="ellipsis-cell" title={formatKeywords(e)}>{formatKeywords(e)}</td>
                <td>
                  <span className={`badge ${statusBadgeClass(e.status)}`}>
                    {e.status}
                  </span>
                </td>
                <td>{e.total_results ?? '—'}</td>
                <td>{e.new_results ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default ResultsList;
