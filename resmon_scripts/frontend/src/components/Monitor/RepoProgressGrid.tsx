import React from 'react';
import { ActiveExecution } from '../../context/ExecutionContext';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function statusIcon(status: string): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'querying':
      return '⟳';
    case 'error':
      return '✕';
    default:
      return '⏳';
  }
}

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
            return (
              <tr key={repo} className={`mon-repo-row mon-repo-row--${status}`}>
                <td className="mon-repo-name">{repo}</td>
                <td className="mon-repo-status">
                  <span className={`mon-repo-icon mon-repo-icon--${status}`}>
                    {statusIcon(status)}
                  </span>
                  <span className="mon-repo-status-text">{status}</span>
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
