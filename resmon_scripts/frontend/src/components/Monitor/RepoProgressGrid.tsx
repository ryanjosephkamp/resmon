import React from 'react';
import { ActiveExecution } from '../../context/ExecutionContext';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The icon per status.
 *
 * ``done`` and ``no_answer`` used to share the ✓, because both are what the
 * engine calls a completed source: every client degrades rather than raising,
 * so a 503 and a quiet field arrive here identically. They are different
 * facts and the grid now says so — a tick on a source that never answered is
 * the app agreeing that nothing was wrong.
 */
function statusIcon(status: string): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'no_answer':
      return '⚠';
    case 'skipped':
      return '⊘';
    case 'querying':
      return '⟳';
    case 'error':
      return '✕';
    default:
      return '⏳';
  }
}

const STATUS_LABEL: Record<string, string> = {
  done: 'done',
  no_answer: 'no answer',
  skipped: 'not queried',
  querying: 'querying',
  error: 'error',
  pending: 'pending',
};

function resultCountForRepo(
  exec: ActiveExecution,
  repo: string,
): string {
  /* Find the most recent repo_done event for this repo */
  for (let i = exec.events.length - 1; i >= 0; i--) {
    const ev = exec.events[i];
    if (ev.type === 'repo_done' && ev.repository === repo) {
      return String(ev.result_count ?? 0);
    }
  }
  return '--';
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface RepoProgressGridProps {
  exec: ActiveExecution;
}

const RepoProgressGrid: React.FC<RepoProgressGridProps> = ({ exec }) => {
  return (
    <div className="mon-repo-grid">
      <h3 className="mon-section-title">Repository Status</h3>
      <table className="mon-repo-table">
        <thead>
          <tr>
            <th>Repository</th>
            <th>Status</th>
            <th>Results</th>
          </tr>
        </thead>
        <tbody>
          {exec.repositories.map((repo) => {
            const status = exec.repoStatuses[repo] ?? 'pending';
            /* The sentence the backend rendered for this source's zero. It is
               shown verbatim rather than rebuilt here, so the monitor, the
               report and the search record cannot say three different
               things about the same run. */
            const zero = exec.repoZeroReasons?.[repo];
            return (
              <tr key={repo} className={`mon-repo-row mon-repo-row--${status}`}>
                <td className="mon-repo-name">{repo}</td>
                <td className="mon-repo-status">
                  <span
                    className={`mon-repo-icon mon-repo-icon--${status}`}
                    title={zero?.message}
                  >
                    {statusIcon(status)}
                  </span>
                  <span className="mon-repo-status-text" title={zero?.message}>
                    {STATUS_LABEL[status] ?? status}
                  </span>
                  {zero && (
                    <span className="mon-repo-zero-reason">{zero.message}</span>
                  )}
                </td>
                <td className="mon-repo-count">{resultCountForRepo(exec, repo)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default RepoProgressGrid;
