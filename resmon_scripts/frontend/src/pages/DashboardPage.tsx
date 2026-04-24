import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useExecution } from '../context/ExecutionContext';
import CloudSyncCard from '../components/Cloud/CloudSyncCard';
import PageHelp from '../components/Help/PageHelp';

interface Routine {
  id: number;
  name: string;
  schedule_cron: string;
  is_active: number;
  last_executed_at: string | null;
}

interface Execution {
  id: number;
  execution_type: string;
  status: string;
  start_time: string;
  result_count: number;
  new_result_count: number;
  query?: string;
  keywords?: string[] | null;
  repositories?: string[] | null;
  total_results?: number;
  new_results?: number;
  execution_location?: 'local' | 'cloud';
}

// Mirror the badge helpers in components/Results/ResultsList.tsx so the
// Dashboard's Recent Activity table renders Type/Source/Status with the
// exact same palette as the Results & Logs table.
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
  if (exec.keywords && exec.keywords.length > 0) return exec.keywords.join(', ');
  if (exec.query && exec.query.trim()) {
    const parts = parseQueryString(exec.query.trim());
    return (parts.length > 0 ? parts : [exec.query.trim()]).join(', ');
  }
  return '—';
};

const formatRepos = (exec: Execution): string => {
  if (exec.repositories && exec.repositories.length > 0) return exec.repositories.join(', ');
  return '—';
};

const DashboardPage: React.FC = () => {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [exportPath, setExportPath] = useState('');
  const [exportError, setExportError] = useState('');
  const { activeExecution, cancelExecution, completionCounter } = useExecution();
  const navigate = useNavigate();

  useEffect(() => {
    apiClient.get<Routine[]>('/api/routines')
      .then(setRoutines)
      .catch(() => {});
    apiClient.get<Execution[]>('/api/executions?limit=10')
      .then(setExecutions)
      .catch(() => {});
  }, [completionCounter]);

  const activeRoutines = routines.filter((r) => r.is_active);

  const handleViewReport = (id: number) => {
    navigate(`/results?exec=${id}`);
  };

  const handleExportOne = async (id: number) => {
    setExportError('');
    setExportPath('');
    try {
      const resp = await apiClient.post<{ path: string }>('/api/executions/export', {
        ids: [id],
      });
      setExportPath(resp.path);
      setTimeout(() => setExportPath(''), 10000);
    } catch (err: any) {
      setExportError(err.message || 'Export failed');
      setTimeout(() => setExportError(''), 10000);
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
    <div className="page-stub">
      <h1>Welcome to resmon</h1>

      <div className="about-resmon">
        <h2>What is resmon?</h2>
        <p>
          <strong>resmon</strong> (Research Monitor) is a literature-surveillance
          platform that automates the tedious parts of keeping up with the
          scholarly record. You tell it which open-access repositories to watch,
          which keywords matter, and how often to look — resmon handles the rest,
          queries the repository APIs on your schedule, de-duplicates results,
          optionally summarizes them with an LLM, and delivers reports locally
          or by email.
        </p>
        <div className="about-resmon-features">
          <div className="about-resmon-feature">
            <strong>Deep Dive</strong>
            <span>Targeted one-off query against a single repository.</span>
          </div>
          <div className="about-resmon-feature">
            <strong>Deep Sweep</strong>
            <span>Broad one-off query against multiple repositories at once.</span>
          </div>
          <div className="about-resmon-feature">
            <strong>Routines</strong>
            <span>Scheduled sweeps that run on their own (cron-based).</span>
          </div>
          <div className="about-resmon-feature">
            <strong>AI Summarization</strong>
            <span>Optional per-execution paper and batch summaries.</span>
          </div>
          <div className="about-resmon-feature">
            <strong>Email &amp; Cloud</strong>
            <span>Email delivery, cloud backup, and optional cloud execution.</span>
          </div>
          <div className="about-resmon-feature">
            <strong>Local-first</strong>
            <span>Credentials live in your OS keyring; reports live on disk.</span>
          </div>
        </div>
      </div>

      <PageHelp
        storageKey="dashboard"
        title="Dashboard"
        summary="At-a-glance view of active routines and recent executions."
        sections={[
          {
            heading: 'What you see here',
            body: (
              <ul>
                <li><strong>Active Routines</strong> — every enabled scheduled sweep and its next/last fire.</li>
                <li><strong>Recent Activity</strong> — the 10 most recent executions (local and cloud), with Type, Source, Status, keywords, repositories, and result counts.</li>
                <li><strong>Cloud Sync</strong> — status of your resmon-cloud account, if signed in.</li>
              </ul>
            ),
          },
          {
            heading: 'What you can do',
            body: (
              <ul>
                <li>Click <strong>View Report</strong> on any recent row to jump to its full report on the Results &amp; Logs page.</li>
                <li>Click <strong>Export</strong> to save a self-contained report bundle (Markdown, LaTeX, PDF, figures, logs) to disk.</li>
                <li>Use the sidebar to create new Deep Dives, Deep Sweeps, or Routines.</li>
              </ul>
            ),
          },
        ]}
      />

      <CloudSyncCard />

      <div className="card">
        <h2>Active Routines</h2>
        {activeRoutines.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
            No active routines. Create one from the Routines page.
          </p>
        ) : (
          <table className="simple-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Schedule</th>
                <th>Last Run</th>
              </tr>
            </thead>
            <tbody>
              {activeRoutines.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td><span className="badge badge-success">Active</span></td>
                  <td>{r.schedule_cron}</td>
                  <td>{r.last_executed_at || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Recent Activity</h2>
        {exportError && <div className="form-error">{exportError}</div>}
        {exportPath && (
          <div
            className="form-success"
            style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}
          >
            <span>Export saved to: {exportPath}</span>
            {window.resmonAPI?.revealPath && (
              <button
                className="btn btn-secondary"
                onClick={handleReveal}
                style={{ padding: '4px 10px', fontSize: 12 }}
              >
                {revealLabel}
              </button>
            )}
          </div>
        )}
        {executions.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
            No recent activity.
          </p>
        ) : (
          <table className="simple-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Source</th>
                <th>Repos</th>
                <th>Query</th>
                <th>Status</th>
                <th>Results</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((e) => {
                const isRunning =
                  activeExecution?.executionId === e.id &&
                  activeExecution?.status === 'running';
                const isCancelling =
                  activeExecution?.executionId === e.id &&
                  activeExecution?.status === 'cancelling';
                const isActive = isRunning || isCancelling;
                const loc = e.execution_location ?? 'local';
                const isCloud = loc === 'cloud';
                return (
                  <tr key={e.id}>
                    <td>{e.start_time?.slice(0, 16)?.replace('T', ' ') || '—'}</td>
                    <td>
                      <span className={`badge ${typeBadgeClass(e.execution_type)}`}>
                        {e.execution_type}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${isCloud ? 'badge-info' : 'badge-type-other'}`}>
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
                    <td>{(e.new_results ?? e.new_result_count ?? 0)} new / {(e.total_results ?? e.result_count ?? 0)} total</td>
                    <td>
                      {isActive ? (
                        <div className="action-btns">
                          <a className="btn btn-sm" href="#/monitor">View Monitor</a>
                          <button
                            className="btn btn-sm btn-danger"
                            disabled={isCancelling}
                            onClick={() => cancelExecution(e.id)}
                          >
                            {isCancelling ? (
                              <><span className="fw-spinner" aria-hidden="true" /> Stopping…</>
                            ) : 'Cancel'}
                          </button>
                        </div>
                      ) : (
                        <div className="action-btns">
                          <button
                            className="btn btn-sm"
                            onClick={() => handleViewReport(e.id)}
                          >
                            View Report
                          </button>
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => handleExportOne(e.id)}
                          >
                            Export
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default DashboardPage;
