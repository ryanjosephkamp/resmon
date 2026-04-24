import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiClient } from '../api/client';
import { useExecution } from '../context/ExecutionContext';
import { useAuth } from '../context/AuthContext';
import { useExecutionsMerged, ExecutionFilter } from '../hooks/useExecutionsMerged';
import ResultsList from '../components/Results/ResultsList';
import ReportViewer from '../components/Results/ReportViewer';
import PageHelp from '../components/Help/PageHelp';

interface Execution {
  id: number;
  execution_id?: string;
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
}

const ResultsPage: React.FC = () => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewId, setViewId] = useState<number | null>(null);
  const [viewCloudId, setViewCloudId] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<'report' | 'log' | 'meta' | 'progress' | undefined>(undefined);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState('');
  const [exportPath, setExportPath] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { completionCounter } = useExecution();
  const { isSignedIn } = useAuth();
  const reportRef = useRef<HTMLDivElement | null>(null);
  const {
    executions,
    filter: locationFilter,
    setFilter: setLocationFilter,
    loading,
    error: fetchError,
    refresh,
  } = useExecutionsMerged('all', 200);

  // Scroll the report viewer into view whenever an execution is opened
  useEffect(() => {
    if ((viewId !== null || viewCloudId !== null) && !loading && reportRef.current) {
      // Defer to next frame so the ReportViewer has mounted before scrolling
      requestAnimationFrame(() => {
        reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [viewId, viewCloudId, loading]);

  // Re-fetch whenever an execution completes in the local daemon so rows
  // that just finished show up without a manual reload.
  useEffect(() => {
    refresh();
  }, [completionCounter, refresh]);

  // Check URL for exec param
  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/exec=(\d+)/);
    if (match) setViewId(Number(match[1]));
    const tabMatch = hash.match(/tab=(report|log|meta|progress)/);
    if (tabMatch) setViewTab(tabMatch[1] as any);
  }, []);

  const handleToggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleToggleAll = () => {
    const filtered = executions.filter((e) => {
      if ((e.execution_location ?? 'local') !== 'local') return false;
      if (typeFilter && e.execution_type !== typeFilter) return false;
      if (statusFilter && e.status !== statusFilter) return false;
      return true;
    });
    const allSelected =
      filtered.length > 0 && filtered.every((e) => selected.has(e.id as number));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((e) => e.id as number)));
    }
  };

  const handleExport = async () => {
    if (selected.size === 0) return;
    setError('');
    setExportPath('');
    try {
      const resp = await apiClient.post<{ path: string }>('/api/executions/export', {
        ids: Array.from(selected),
      });
      setExportPath(resp.path);
      setTimeout(() => setExportPath(''), 10000);
    } catch (err: any) {
      setError(err.message);
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

  const handleDeleteSelected = async () => {
    setError('');
    for (const id of selected) {
      try {
        await apiClient.delete(`/api/executions/${id}`);
      } catch { /* continue */ }
    }
    setSelected(new Set());
    setConfirmDelete(false);
    refresh();
  };

  if (loading) return <div className="page-content"><p className="text-muted">Loading executions…</p></div>;

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Results &amp; Logs</h1>
        <div className="form-actions">
          <button className="btn btn-secondary" onClick={handleExport} disabled={selected.size === 0}>
            Export Selected ({selected.size})
          </button>
          <button className="btn btn-danger" onClick={() => setConfirmDelete(true)} disabled={selected.size === 0}>
            Delete Selected ({selected.size})
          </button>
        </div>
      </div>

      <PageHelp
        storageKey="results"
        title="Results & Logs"
        summary="Browse every execution, read its report, and export or delete selected runs."
        sections={[
          {
            heading: 'The table',
            body: (
              <ul>
                <li>Each row is one execution (manual dive, manual sweep, or routine-fired sweep).</li>
                <li><strong>Type</strong> and <strong>Status</strong> badges match the color palette used across the app.</li>
                <li>The <strong>Source</strong> column distinguishes <em>Local</em> runs (this device) from <em>Cloud</em> runs (your resmon-cloud account).</li>
                <li>Use the Type / Status filters and the Local / Cloud / All selector to narrow the view.</li>
              </ul>
            ),
          },
          {
            heading: 'Viewing a report',
            body: (
              <ul>
                <li>Click any row to open its full report below the table.</li>
                <li>The viewer tabs are: <strong>Report</strong> (the Markdown report), <strong>Log</strong> (the line-by-line execution log), <strong>Meta</strong> (parameters, timings, provenance), and <strong>Progress</strong> (structured progress events emitted during the run).</li>
              </ul>
            ),
          },
          {
            heading: 'Exporting',
            body: (
              <p>
                Select one or more rows and click <strong>Export Selected</strong>. resmon bundles the Markdown report, a LaTeX-compiled PDF (when available), any figures, and the log into a single folder on disk. Cloud rows are read-only and cannot be exported from this table — they are served live from the cloud account.
              </p>
            ),
          },
        ]}
      />

      {error && <div className="form-error">{error}</div>}
      {fetchError && !error && <div className="form-error">{fetchError}</div>}
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

      <div className="card">
        <ResultsList
          executions={executions as Execution[]}
          selected={selected}
          onToggle={handleToggle}
          onToggleAll={handleToggleAll}
          onRowClick={(e) => {
            if ((e.execution_location ?? 'local') === 'cloud') {
              setViewCloudId(e.execution_id ?? null);
              setViewId(null);
            } else {
              setViewId(e.id);
              setViewCloudId(null);
            }
          }}
          typeFilter={typeFilter}
          statusFilter={statusFilter}
          onTypeFilterChange={setTypeFilter}
          onStatusFilterChange={setStatusFilter}
          locationFilter={locationFilter as ExecutionFilter}
          onLocationFilterChange={(v) => setLocationFilter(v)}
          showLocationFilter={isSignedIn}
        />
      </div>

      {viewId !== null && (
        <div className="card" ref={reportRef}>
          <ReportViewer executionId={viewId} onClose={() => { setViewId(null); setViewTab(undefined); }} initialTab={viewTab} />
        </div>
      )}

      {viewCloudId !== null && (
        <div className="card" ref={reportRef}>
          <div className="page-header">
            <h2>Cloud Execution</h2>
            <button className="btn btn-secondary" onClick={() => setViewCloudId(null)}>Close</button>
          </div>
          <p className="text-muted">
            This execution was produced by a cloud routine. Its artifacts are fetched on demand
            and cached locally under <code>~/Library/Application Support/resmon/cloud-cache/</code>.
          </p>
          <p className="text-muted" style={{ fontSize: 12 }}>
            Execution ID: <code>{viewCloudId}</code>
          </p>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Confirm Delete</h3>
            <p>Delete {selected.size} execution(s)? This cannot be undone.</p>
            <div className="form-actions">
              <button className="btn btn-danger" onClick={handleDeleteSelected}>Delete</button>
              <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ResultsPage;
