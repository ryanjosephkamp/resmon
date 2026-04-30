import React, { useState, useEffect, useCallback, useRef } from 'react';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import { apiClient } from '../api/client';
import PageHelp from '../components/Help/PageHelp';
import { notifyConfigurationsChanged } from '../lib/configurationsBus';
import RepositorySelector from '../components/Forms/RepositorySelector';
import DateRangePicker from '../components/Forms/DateRangePicker';
import KeywordInput from '../components/Forms/KeywordInput';
import ScheduleConfigurator from '../components/Forms/ScheduleConfigurator';
import KeywordCombinationBanner from '../components/Forms/KeywordCombinationBanner';
import RepoKeyStatus from '../components/Repositories/RepoKeyStatus';
import { useRepoCatalog } from '../hooks/useRepoCatalog';
import { useAuth } from '../context/AuthContext';
import InfoTooltip from '../components/Help/InfoTooltip';
import AIOverridePanel, {
  AIOverrideValue,
  EMPTY_AI_OVERRIDE,
  buildAIOverridePayload,
} from '../components/Forms/AIOverridePanel';
import AIDefaultsInfo from '../components/Forms/AIDefaultsInfo';

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
  // Update 3 / 4_27_26 follow-up: read-only "View JSON" modal that surfaces
  // the saved configuration row exactly as it would be exported, so the user
  // can audit the parameter payload before deciding to export.
  const [viewConfig, setViewConfig] = useState<Config | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ---- Edit modal state (Update 2) ---------------------------------------
  // The Edit button on each row opens a config-aware modal:
  //   - routine        → full Routines-style editor (cron + multi repos +
  //                      all toggles + execution location + AI override)
  //   - manual_sweep   → same form minus the cron section
  //   - manual_dive    → same form minus cron, with a single-repo dropdown
  // Saving a routine config dispatches to ``PUT /api/routines/{linked_routine_id}``
  // when the parameters JSON carries a ``linked_routine_id``; otherwise
  // (e.g. an imported routine config with no linked routine yet) we fall
  // back to ``PUT /api/configurations/{id}`` and persist the routine
  // payload back into the configuration row directly.
  const { bySlug, presence, refreshPresence } = useRepoCatalog();
  const { isSignedIn } = useAuth();
  const cloudSyncEnabled = isSignedIn;
  const [editConfig, setEditConfig] = useState<Config | null>(null);
  const [editName, setEditName] = useState('');
  const [editCron, setEditCron] = useState('0 8 * * *');
  const [editRepos, setEditRepos] = useState<string[]>([]);
  const [editRepo, setEditRepo] = useState('');
  const [editDateFrom, setEditDateFrom] = useState('');
  const [editDateTo, setEditDateTo] = useState('');
  const [editKeywords, setEditKeywords] = useState<string[]>([]);
  const [editMaxResults, setEditMaxResults] = useState(100);
  const [editAi, setEditAi] = useState(false);
  const [editEmail, setEditEmail] = useState(false);
  const [editEmailAi, setEditEmailAi] = useState(false);
  const [editNotify, setEditNotify] = useState(false);
  const [editLocation, setEditLocation] = useState<'local' | 'cloud'>('local');
  const [editAiOverride, setEditAiOverride] = useState<AIOverrideValue>(EMPTY_AI_OVERRIDE);
  const [editError, setEditError] = useState('');

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
      // Tell every mounted ConfigLoader (Deep Dive, Deep Sweep, Routines)
      // to refetch so newly imported rows appear immediately.
      notifyConfigurationsChanged();
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
    // Tell every mounted ConfigLoader (Deep Dive, Deep Sweep, Routines)
    // to refetch so deleted rows disappear from their dropdowns immediately.
    notifyConfigurationsChanged();
  };

  // ---- Edit helpers ------------------------------------------------------

  const parseParams = (raw: Record<string, any> | string): Record<string, any> => {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) || {}; } catch { return {}; }
    }
    return raw || {};
  };

  const hydrateAiOverride = (raw: any): AIOverrideValue => {
    let overlay: Record<string, any> = {};
    if (raw) {
      try {
        overlay = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch { overlay = {}; }
    }
    return {
      provider: typeof overlay.provider === 'string' ? overlay.provider : '',
      model: typeof overlay.model === 'string' ? overlay.model : '',
      length: typeof overlay.length === 'string' ? overlay.length : '',
      tone: typeof overlay.tone === 'string' ? overlay.tone : '',
      temperature: overlay.temperature !== undefined && overlay.temperature !== null
        ? String(overlay.temperature) : '',
      extraction_goals: typeof overlay.extraction_goals === 'string'
        ? overlay.extraction_goals : '',
    };
  };

  const openEdit = (c: Config) => {
    setEditError('');
    setEditConfig(c);
    setEditName(c.name);
    const params = parseParams(c.parameters);

    if (c.config_type === 'routine') {
      // Routine config parameters layout (see _serialize_routine_for_config):
      //   { linked_routine_id, schedule_cron, parameters: {...}, is_active,
      //     email_enabled, email_ai_summary_enabled, ai_enabled,
      //     notify_on_complete, execution_location, ai_settings? }
      const inner = (params.parameters && typeof params.parameters === 'object')
        ? params.parameters : {};
      setEditCron(typeof params.schedule_cron === 'string' ? params.schedule_cron : '0 8 * * *');
      setEditRepos(Array.isArray(inner.repositories) ? inner.repositories : []);
      setEditRepo('');
      setEditDateFrom(typeof inner.date_from === 'string' ? inner.date_from : '');
      setEditDateTo(typeof inner.date_to === 'string' ? inner.date_to : '');
      setEditKeywords(Array.isArray(inner.keywords) ? inner.keywords : []);
      setEditMaxResults(typeof inner.max_results === 'number' ? inner.max_results : 100);
      setEditAi(!!params.ai_enabled);
      setEditEmail(!!params.email_enabled);
      setEditEmailAi(!!params.email_ai_summary_enabled);
      setEditNotify(!!params.notify_on_complete);
      setEditLocation((params.execution_location === 'cloud') ? 'cloud' : 'local');
      setEditAiOverride(hydrateAiOverride(params.ai_settings));
    } else {
      // Manual configs (manual_dive / manual_sweep) — flat parameters JSON:
      //   { repository | repositories, date_from, date_to, keywords,
      //     max_results, ai_enabled, ai_settings? }
      setEditCron('0 8 * * *');
      setEditRepos(Array.isArray(params.repositories) ? params.repositories : []);
      setEditRepo(typeof params.repository === 'string' ? params.repository : '');
      setEditDateFrom(typeof params.date_from === 'string' ? params.date_from : '');
      setEditDateTo(typeof params.date_to === 'string' ? params.date_to : '');
      setEditKeywords(Array.isArray(params.keywords) ? params.keywords : []);
      setEditMaxResults(typeof params.max_results === 'number' ? params.max_results : 100);
      setEditAi(!!params.ai_enabled);
      setEditEmail(false);
      setEditEmailAi(false);
      setEditNotify(false);
      setEditLocation('local');
      setEditAiOverride(hydrateAiOverride(params.ai_settings));
    }
  };

  const closeEdit = () => { setEditConfig(null); setEditError(''); };

  const handleEditSave = async () => {
    if (!editConfig) return;
    if (!editName.trim()) { setEditError('Name is required.'); return; }
    setEditError('');
    const overrides = buildAIOverridePayload(editAiOverride);
    const aiSettings = Object.keys(overrides).length > 0 ? overrides : null;

    try {
      if (editConfig.config_type === 'routine') {
        const params = parseParams(editConfig.parameters);
        const linkedId =
          typeof params.linked_routine_id === 'number' ? params.linked_routine_id : null;
        const innerParams = {
          repositories: editRepos,
          date_from: editDateFrom,
          date_to: editDateTo,
          keywords: editKeywords,
          query: editKeywords.join(' '),
          max_results: editMaxResults,
        };
        const routinePayload = {
          linked_routine_id: linkedId,
          schedule_cron: editCron,
          parameters: innerParams,
          is_active: !!params.is_active,
          email_enabled: editEmail,
          email_ai_summary_enabled: editEmailAi,
          ai_enabled: editAi,
          ai_settings: aiSettings,
          notify_on_complete: editNotify,
          execution_location: editLocation,
        };
        // When a linked routine row exists, drive it directly so APScheduler
        // and the saved_configurations mirror stay in sync via the
        // backend's ``_sync_routine_config`` hook. If the linked routine is
        // missing (stale ``linked_routine_id`` from an orphaned/imported
        // config), fall back to updating the configuration row directly.
        let savedViaRoutine = false;
        if (linkedId !== null) {
          try {
            await apiClient.put(`/api/routines/${linkedId}`, {
              name: editName.trim(),
              schedule_cron: editCron,
              parameters: innerParams,
              is_active: !!params.is_active,
              email_enabled: editEmail,
              email_ai_summary_enabled: editEmailAi,
              ai_enabled: editAi,
              ai_settings: aiSettings,
              notify_on_complete: editNotify,
              execution_location: editLocation,
            });
            savedViaRoutine = true;
          } catch (err: any) {
            const msg = String(err?.message || '');
            if (!msg.startsWith('404')) throw err;
            // 404 → linked routine no longer exists; fall through to the
            // configuration-row update path with linked_routine_id cleared.
            routinePayload.linked_routine_id = null;
          }
        }
        if (!savedViaRoutine) {
          await apiClient.put(`/api/configurations/${editConfig.id}`, {
            name: editName.trim(),
            parameters: routinePayload,
          });
        }
      } else if (editConfig.config_type === 'manual_sweep') {
        await apiClient.put(`/api/configurations/${editConfig.id}`, {
          name: editName.trim(),
          parameters: {
            repositories: editRepos,
            date_from: editDateFrom,
            date_to: editDateTo,
            keywords: editKeywords,
            max_results: editMaxResults,
            ai_enabled: editAi,
            ...(aiSettings ? { ai_settings: aiSettings } : {}),
          },
        });
      } else if (editConfig.config_type === 'manual_dive') {
        await apiClient.put(`/api/configurations/${editConfig.id}`, {
          name: editName.trim(),
          parameters: {
            repository: editRepo,
            date_from: editDateFrom,
            date_to: editDateTo,
            keywords: editKeywords,
            max_results: editMaxResults,
            ai_enabled: editAi,
            ...(aiSettings ? { ai_settings: aiSettings } : {}),
          },
        });
      }
      closeEdit();
      fetchConfigs();
      notifyConfigurationsChanged();
    } catch (err: any) {
      setEditError(err.message || 'Failed to save configuration.');
    }
  };

  const editReposForKeyStatus =
    editConfig?.config_type === 'manual_dive'
      ? (editRepo ? [editRepo] : [])
      : editRepos;

  if (loading) return <div className="page-content"><p className="text-muted">Loading configurations…</p></div>;

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Configurations</h1>
        <TutorialLinkButton anchor="configurations" />
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
          {
            heading: 'View JSON',
            body: (
              <p>
                Each row exposes a <strong>View JSON</strong> button that opens a
                read-only modal with the full saved payload (parameters plus any
                linked routine id). Use the <strong>Copy JSON</strong> button inside
                the modal to copy the payload to the clipboard for inspection,
                debugging, or sharing.
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
                  <div className="action-btns">
                    <button className="btn btn-sm" onClick={() => openEdit(c)}>Edit</button>
                    <button className="btn btn-sm" onClick={() => setViewConfig(c)}>View JSON</button>
                    <button className="btn btn-sm btn-danger" onClick={() => { setSelected(new Set([c.id])); setConfirmDelete(true); }}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editConfig && (() => {
        const isRoutine = editConfig.config_type === 'routine';
        const isDive = editConfig.config_type === 'manual_dive';
        const titleSuffix = isRoutine
          ? 'Routine Configuration'
          : isDive
            ? 'Deep Dive Configuration'
            : 'Deep Sweep Configuration';
        return (
          <div className="modal-overlay" onClick={closeEdit}>
            <div className="modal-content modal-lg" onClick={(e) => e.stopPropagation()}>
              <h3>Edit {titleSuffix}</h3>
              {editError && <div className="form-error">{editError}</div>}
              <div className="form-field">
                <label className="form-label">Configuration Name</label>
                <input
                  type="text"
                  className="form-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                />
              </div>
              {isRoutine && (
                <ScheduleConfigurator cron={editCron} onChange={setEditCron} />
              )}
              {isDive ? (
                <RepositorySelector
                  mode="single"
                  value={editRepo}
                  onChange={(v) => setEditRepo(v as string)}
                />
              ) : (
                <RepositorySelector
                  mode="multi"
                  value={editRepos}
                  onChange={(v) => setEditRepos(v as string[])}
                />
              )}
              {editReposForKeyStatus.length > 0 && (
                <KeywordCombinationBanner
                  entries={editReposForKeyStatus.map((slug) => bySlug[slug]).filter(Boolean)}
                />
              )}
              {editReposForKeyStatus.length > 0 && (
                <div className="form-field">
                  <label className="form-label">Key Status</label>
                  <div className="repo-key-status-stack">
                    {editReposForKeyStatus.map((slug) => {
                      const entry = bySlug[slug];
                      if (!entry) return null;
                      const credName = entry.credential_name;
                      return (
                        <RepoKeyStatus
                          key={slug}
                          entry={entry}
                          present={!!(credName && presence[credName]?.present)}
                          onPresenceChange={() => { void refreshPresence(); }}
                          variant={isRoutine ? 'routine' : isDive ? 'dive' : 'sweep'}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
              <DateRangePicker
                dateFrom={editDateFrom}
                dateTo={editDateTo}
                onDateFromChange={setEditDateFrom}
                onDateToChange={setEditDateTo}
              />
              <KeywordInput keywords={editKeywords} onChange={setEditKeywords} />
              <div className="form-field">
                <label className="form-label">Max Results{isDive ? '' : ' (per repository)'}</label>
                <div className="range-row">
                  <input
                    type="range"
                    min={10}
                    max={500}
                    step={10}
                    value={editMaxResults}
                    onChange={(e) => setEditMaxResults(Number(e.target.value))}
                  />
                  <span className="range-value">{editMaxResults}</span>
                </div>
              </div>
              <div className="form-field toggles-row">
                <label className="checkbox-label">
                  <input type="checkbox" checked={editAi} onChange={(e) => setEditAi(e.target.checked)} />
                  <span>AI Summarization</span>
                  <InfoTooltip text="Attach LLM summaries to each report. Requires a configured provider and key in Settings → AI." />
                </label>
                {isRoutine && (
                  <>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={editEmail} onChange={(e) => setEditEmail(e.target.checked)} />
                      <span>Email Notifications</span>
                      <InfoTooltip text="Send a report email via the SMTP server configured in Settings → Email when this routine completes a run." />
                    </label>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={editEmailAi} onChange={(e) => setEditEmailAi(e.target.checked)} />
                      <span>Results in Email</span>
                      <InfoTooltip text="Include the AI summary in the body of the routine email. Requires both Email Notifications and AI Summarization to be on." />
                    </label>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={editNotify} onChange={(e) => setEditNotify(e.target.checked)} />
                      <span>Notify on Completion</span>
                      <InfoTooltip text="Send a desktop notification when this routine finishes. Only effective when Settings → Notifications → Automatic routines is set to 'selected'." />
                    </label>
                  </>
                )}
              </div>
              {editAi && <AIDefaultsInfo />}
              {editAi && (
                <details className="form-field">
                  <summary>Override AI settings for this {isRoutine ? 'routine' : 'configuration'}</summary>
                  <AIOverridePanel value={editAiOverride} onChange={setEditAiOverride} />
                </details>
              )}
              {isRoutine && (
                <div
                  className="form-field"
                  role="radiogroup"
                  aria-label="Execution location"
                >
                  <label className="form-label">
                    Execution location
                    <InfoTooltip text="Where this routine runs. 'Local' uses the resmon daemon on this device. 'Cloud' runs on the resmon-cloud scheduler and does not require this machine to be online." />
                  </label>
                  <div className="toggles-row">
                    <label className="checkbox-label">
                      <input
                        type="radio"
                        name="edit_execution_location"
                        value="local"
                        checked={editLocation === 'local'}
                        onChange={() => setEditLocation('local')}
                      />
                      <span>Local (this device)</span>
                    </label>
                    <label
                      className="checkbox-label"
                      title={
                        cloudSyncEnabled
                          ? 'Run this routine in the resmon-cloud scheduler'
                          : 'Sign in and enable Cloud sync to run routines in the cloud'
                      }
                    >
                      <input
                        type="radio"
                        name="edit_execution_location"
                        value="cloud"
                        disabled={!cloudSyncEnabled}
                        checked={editLocation === 'cloud'}
                        onChange={() => setEditLocation('cloud')}
                      />
                      <span>Cloud{!cloudSyncEnabled ? ' (sign in to enable)' : ''}</span>
                    </label>
                  </div>
                </div>
              )}
              <div className="form-actions">
                <button className="btn btn-primary" onClick={handleEditSave}>Save</button>
                <button className="btn btn-secondary" onClick={closeEdit}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}

      {viewConfig && (() => {
        // Pretty-print the saved row exactly as it sits in the database
        // (parameters JSON-decoded so nested keys are not double-escaped).
        // Read-only: no inputs, no Save button.
        const params = parseParams(viewConfig.parameters);
        const json = JSON.stringify(
          {
            id: viewConfig.id,
            name: viewConfig.name,
            config_type: viewConfig.config_type,
            created_at: viewConfig.created_at,
            parameters: params,
          },
          null,
          2,
        );
        return (
          <div className="modal-overlay" onClick={() => setViewConfig(null)}>
            <div
              className="modal-content"
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: 720, width: '90%' }}
            >
              <div className="page-header" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>View JSON — {viewConfig.name}</h3>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setViewConfig(null)}
                >
                  Close
                </button>
              </div>
              <p className="text-muted" style={{ fontSize: 12, marginTop: 0 }}>
                Read-only view of the saved configuration. Use the Edit button
                on the row to change any field; this view is for inspection
                before exporting.
              </p>
              <pre
                style={{
                  maxHeight: '60vh',
                  overflow: 'auto',
                  background: 'var(--color-bg-elevated, #1e1e1e)',
                  color: 'var(--color-text, inherit)',
                  padding: 12,
                  borderRadius: 4,
                  fontSize: 12,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  whiteSpace: 'pre',
                  userSelect: 'text',
                }}
              >
                {json}
              </pre>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    if (navigator.clipboard?.writeText) {
                      navigator.clipboard.writeText(json).catch(() => { /* ignore */ });
                    }
                  }}
                >
                  Copy to Clipboard
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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
