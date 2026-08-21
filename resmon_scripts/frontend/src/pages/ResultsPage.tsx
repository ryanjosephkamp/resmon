import React, { useState, useEffect, useCallback, useRef } from 'react';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import { apiClient, getBaseUrl } from '../api/client';
import { useExecution } from '../context/ExecutionContext';
import { useExecutions } from '../hooks/useExecutions';
import ResultsList from '../components/Results/ResultsList';
import ReportViewer from '../components/Results/ReportViewer';
import PageHelp from '../components/Help/PageHelp';

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
}

const ResultsPage: React.FC = () => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewId, setViewId] = useState<number | null>(null);
  const [viewTab, setViewTab] = useState<'report' | 'log' | 'meta' | 'progress' | undefined>(undefined);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState('');
  const [exportPath, setExportPath] = useState('');
  const [exportError, setExportError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { completionCounter } = useExecution();
  const reportRef = useRef<HTMLDivElement | null>(null);
  const {
    executions,
    loading,
    error: fetchError,
    refresh,
  } = useExecutions(200);

  // Scroll the report viewer into view whenever an execution is opened
  useEffect(() => {
    if (viewId !== null && !loading && reportRef.current) {
      // Defer to next frame so the ReportViewer has mounted before scrolling
      requestAnimationFrame(() => {
        reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [viewId, loading]);

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

  /**
   * Download the selected executions' papers in a reference-manager format.
   *
   * These endpoints return plain text with a Content-Disposition header rather
   * than JSON, so they bypass apiClient. One request per selected execution,
   * concatenated, so selecting three runs yields one file.
   */
  const handleReferenceExport = async (fmt: 'bibtex' | 'ris' | 'csv') => {
    if (selected.size === 0) return;
    setExportError('');
    try {
      const ids = Array.from(selected);
      const parts: string[] = [];
      for (const id of ids) {
        const resp = await fetch(
          `${getBaseUrl()}/api/executions/${id}/references?format=${fmt}`,
          { headers: { 'Cache-Control': 'no-store' } },
        );
        if (!resp.ok) {
          throw new Error(`Export failed for execution ${id} (HTTP ${resp.status})`);
        }
        parts.push(await resp.text());
      }
      // CSV: keep the first header row only, so the file opens as one table.
      const text = fmt === 'csv'
        ? parts
            .map((part, i) => (i === 0 ? part : part.split('\n').slice(1).join('\n')))
            .join('')
        : parts.join('\n');

      const ext = fmt === 'bibtex' ? 'bib' : fmt;
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `resmon-references-${ids.join('-')}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setExportError(err?.message || 'Reference export failed.');
    }
  };

  if (loading) return <div className="page-content"><p className="text-muted">Loading executions…</p></div>;

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Results &amp; Logs</h1>
        <TutorialLinkButton anchor="results" />
        <div className="form-actions">
          <button className="btn btn-secondary" onClick={handleExport} disabled={selected.size === 0}>
            Export Selected ({selected.size})
          </button>
          <button className="btn btn-secondary" onClick={() => void handleReferenceExport('bibtex')} disabled={selected.size === 0} title="Export the selected runs' papers as BibTeX">
            BibTeX
          </button>
          <button className="btn btn-secondary" onClick={() => void handleReferenceExport('ris')} disabled={selected.size === 0} title="Export the selected runs' papers as RIS">
            RIS
          </button>
          <button className="btn btn-secondary" onClick={() => void handleReferenceExport('csv')} disabled={selected.size === 0} title="Export the selected runs' papers as CSV">
            CSV
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
            heading: 'The search record',
            body: (
              <p>
                Every execution has a <strong>Search record</strong> tab: the complete,
                dated account of that search — exact terms, publication window,
                per-database record counts, deduplication figures, and the resmon
                version that ran it — in the shape a PRISMA flow diagram needs, with a
                Markdown download for a methods section. Each figure names the PRISMA
                box it belongs in, and where resmon&rsquo;s number has no honest
                equivalent the record says so rather than filing it under a heading it
                does not fit. resmon <em>flags</em> cross-source duplicates and keeps
                both copies, so the record reports duplicates found, never duplicates
                removed; and a figure it never measured reads <em>not recorded</em>,
                never 0.
              </p>
            ),
          },
          {
            heading: 'The table',
            body: (
              <ul>
                <li>Each row is one execution (manual dive, manual sweep, or routine-fired sweep).</li>
                <li>The <strong>Name</strong> column resolves to the saved-configuration name when the run was launched from (or saved into) one, otherwise to the routine name for routine-fired runs, otherwise to <code>Execution #&lt;id&gt;</code>.</li>
                <li><strong>Type</strong> and <strong>Status</strong> badges match the color palette used across the app.</li>
                <li>Use the Type and Status filters to narrow the view.</li>
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
            heading: 'Exporting a bundle to read',
            body: (
              <p>
                Select one or more rows and click <strong>Export Selected</strong>. resmon bundles the Markdown report, a LaTeX-compiled PDF (when available), any figures, and the log into a single folder on disk.
              </p>
            ),
          },
          {
            heading: 'Exporting references to a reference manager',
            body: (
              <>
                <p>
                  The <strong>BibTeX</strong>, <strong>RIS</strong> and <strong>CSV</strong>{' '}
                  buttons export the <em>papers</em> the selected runs found, rather than the
                  report about them, in the formats reference managers read.
                </p>
                <ul>
                  <li><strong>BibTeX</strong> — LaTeX, Overleaf, JabRef, and Zotero&rsquo;s importer.</li>
                  <li><strong>RIS</strong> — EndNote, Papers, Mendeley, and most publisher sites.</li>
                  <li><strong>CSV</strong> — a spreadsheet, or your own scripts.</li>
                </ul>
                <p>
                  Selecting several runs produces one file containing all of them. Papers with a
                  DOI are exported as journal articles; those without — usually preprints — are
                  exported as generic entries, because claiming a venue resmon does not know
                  would be worse than leaving it out.
                </p>
              </>
            ),
          },
        ]}
      />

      {error && <div className="form-error">{error}</div>}
      {fetchError && !error && <div className="form-error">{fetchError}</div>}
      {exportError && (
        <div className="form-error" role="alert">{exportError}</div>
      )}

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
          onRowClick={(e) => setViewId(e.id)}
          typeFilter={typeFilter}
          statusFilter={statusFilter}
          onTypeFilterChange={setTypeFilter}
          onStatusFilterChange={setStatusFilter}
        />
      </div>

      {viewId !== null && (
        <div className="card" ref={reportRef}>
          <ReportViewer executionId={viewId} onClose={() => { setViewId(null); setViewTab(undefined); }} initialTab={viewTab} />
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
