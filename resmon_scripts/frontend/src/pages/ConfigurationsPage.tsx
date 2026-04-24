import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiClient } from '../api/client';
import PageHelp from '../components/Help/PageHelp';

interface Config {
  id: number;
  name: string;
  config_type: string;
  parameters: Record<string, any> | string;
  created_at?: string;
}

// Match the palette used on the Dashboard / Results & Logs pages so that
// ``manual_dive`` shares the pink-purple dive badge and ``manual_sweep``
// shares the green-teal sweep badge. The Configurations-page ``routine``
// type uses a distinct amber/gold badge (``badge-type-config-routine``)
// so it does not collide with the orange ``badge-type-routine`` used for
// routine-fired executions elsewhere in the app.
const configTypeBadgeClass = (t: string): string => {
  switch (t) {
    case 'manual_dive':
    case 'deep_dive':
    case 'dive':
      return 'badge-type-dive';
    case 'manual_sweep':
    case 'deep_sweep':
    case 'sweep':
      return 'badge-type-sweep';
    case 'routine':
      return 'badge-type-config-routine';
    default:
      return 'badge-type-other';
  }
};

const ConfigurationsPage: React.FC = () => {
  const [configs, setConfigs] = useState<Config[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'routine' | 'manual'>('routine');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [exportPath, setExportPath] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchConfigs = useCallback(async () => {
    try {
      const data = await apiClient.get<Config[]>('/api/configurations');
      setConfigs(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  const filtered = configs.filter((c) =>
    tab === 'routine'
      ? c.config_type === 'routine'
      : c.config_type === 'manual_dive' || c.config_type === 'manual_sweep',
  );

  const allSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id));

  const handleToggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleToggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((c) => c.id)));
    }
  };

  const handleExport = async () => {
    if (selected.size === 0) return;
    setError('');
    try {
      const resp = await apiClient.post<{ path: string }>('/api/configurations/export', {
        ids: Array.from(selected),
      });
      setExportPath(resp.path);
      setStatus(`Export saved to: ${resp.path}`);
      setTimeout(() => { setStatus(''); setExportPath(''); }, 10000);
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

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setError('');
    setStatus('');

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.name.endsWith('.json')) {
        setError(`Invalid file type: ${file.name}. Only .json files accepted.`);
        if (fileRef.current) fileRef.current.value = '';
        return;
      }
      formData.append('files', file);
    }

    try {
      const resp = await fetch(`${getBaseUrl()}/api/configurations/import`, {
        method: 'POST',
        body: formData,
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text);
      }
      const data = await resp.json();
      setStatus(`Imported ${data.imported} configuration(s).`);
      fetchConfigs();
    } catch (err: any) {
      setError(`Import failed: ${err.message}`);
    }
    if (fileRef.current) fileRef.current.value = '';
    setTimeout(() => { setStatus(''); setError(''); }, 5000);
  };

  const handleDeleteSelected = async () => {
    for (const id of selected) {
      try { await apiClient.delete(`/api/configurations/${id}`); } catch { /* continue */ }
    }
    setSelected(new Set());
    setConfirmDelete(false);
    fetchConfigs();
  };

  if (loading) return <div className="page-content"><p className="text-muted">Loading configurations…</p></div>;

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Configurations</h1>
        <div className="form-actions">
          <button className="btn btn-secondary" onClick={handleExport} disabled={selected.size === 0}>
            Export Selected ({selected.size})
          </button>
          <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept=".json" multiple hidden onChange={handleImport} />
          <button className="btn btn-danger" onClick={() => setConfirmDelete(true)} disabled={selected.size === 0}>
            Delete Selected ({selected.size})
          </button>
        </div>
      </div>

      <PageHelp
        storageKey="configurations"
        title="Configurations"
        summary="Reusable parameter presets for manual dives, sweeps, and routines."
        sections={[
          {
            heading: 'What a configuration is',
            body: (
              <p>
                A <strong>configuration</strong> is a saved bundle of parameters
                (repository / repositories, keywords, max-results, AI toggle,
                etc.) that you can load on the Deep Dive, Deep Sweep, or
                Routines page to avoid re-entering them. Date ranges are
                intentionally <em>not</em> saved — set them fresh per run.
              </p>
            ),
          },
          {
            heading: 'Tabs',
            body: (
              <ul>
                <li><strong>Routine</strong> configurations seed new scheduled routines.</li>
                <li><strong>Manual</strong> configurations cover both <code>manual_dive</code> and <code>manual_sweep</code> presets.</li>
              </ul>
            ),
          },
          {
            heading: 'Import / export',
            body: (
              <p>
                Configurations round-trip as JSON. Use <strong>Export Selected</strong>
                to save the chosen rows to a file; use <strong>Import</strong> to
                load one or more JSON files back in. Re-importing a file with
                an existing name appends a numeric suffix instead of
                overwriting.
              </p>
            ),
          },
        ]}
      />

      {error && <div className="form-error">{error}</div>}
      {status && (
        <div className="form-success" style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
          <span>{status}</span>
          {exportPath && window.resmonAPI?.revealPath && (
            <button className="btn btn-secondary" onClick={handleReveal} style={{ padding: '4px 10px', fontSize: 12 }}>
              {revealLabel}
            </button>
          )}
        </div>
      )}

      <div className="tab-bar">
        <button className={`tab-btn ${tab === 'routine' ? 'tab-active' : ''}`} onClick={() => { setTab('routine'); setSelected(new Set()); }}>Routine Configs</button>
        <button className={`tab-btn ${tab === 'manual' ? 'tab-active' : ''}`} onClick={() => { setTab('manual'); setSelected(new Set()); }}>Manual Configs</button>
      </div>

      <div className="card">
        <table className="simple-table">
          <thead>
            <tr>
              <th><input type="checkbox" checked={allSelected} onChange={handleToggleAll} /></th>
              <th>Name</th>
              <th>Type</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="text-muted text-center">No configurations.</td></tr>
            )}
            {filtered.map((c) => (
              <tr key={c.id} className={selected.has(c.id) ? 'row-selected' : ''}>
                <td><input type="checkbox" checked={selected.has(c.id)} onChange={() => handleToggle(c.id)} /></td>
                <td>{c.name}</td>
                <td><span className={`badge ${configTypeBadgeClass(c.config_type)}`}>{c.config_type}</span></td>
                <td>{c.created_at?.slice(0, 16)?.replace('T', ' ') || '—'}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => { setSelected(new Set([c.id])); setConfirmDelete(true); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmDelete && (() => {
        const selectedRows = configs.filter((c) => selected.has(c.id));
        const routineCount = selectedRows.filter((c) => c.config_type === 'routine').length;
        return (
        <div className="modal-overlay" onClick={() => setConfirmDelete(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Confirm Delete</h3>
            <p>Delete {selected.size} configuration(s)? This cannot be undone.</p>
            {routineCount > 0 && (
              <p className="form-error">
                <strong>Warning:</strong> {routineCount} routine config{routineCount === 1 ? '' : 's'}{' '}
                will also delete the linked routine{routineCount === 1 ? '' : 's'}. Proceed?
              </p>
            )}
            <div className="form-actions">
              <button className="btn btn-danger" onClick={handleDeleteSelected}>Delete</button>
              <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
};

function getBaseUrl(): string {
  const port = window.resmonAPI?.getBackendPort() || '8742';
  return `http://127.0.0.1:${port}`;
}

export default ConfigurationsPage;
