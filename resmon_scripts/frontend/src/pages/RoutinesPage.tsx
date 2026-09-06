import React, { useState, useEffect, useCallback } from 'react';
import CoveragePanel from '../components/Routines/CoveragePanel';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import { apiClient } from '../api/client';
import { useExecution } from '../context/ExecutionContext';
import RepoKeyStatus from '../components/Repositories/RepoKeyStatus';
import { useRepoCatalog } from '../hooks/useRepoCatalog';
import PageHelp from '../components/Help/PageHelp';
import InfoTooltip from '../components/Help/InfoTooltip';
import RoutineEditModal from '../components/Routines/RoutineEditModal';
import { useConfigurationsVersion } from '../lib/configurationsBus';
import { useRoutinesVersion } from '../lib/routinesBus';

interface Routine {
  id: number;
  name: string;
  schedule_cron: string;
  /** ``routines.intent`` — hydrates the edit modal's intent field. */
  intent?: string | null;
  is_active: number | boolean;
  email_enabled: number | boolean;
  email_ai_summary_enabled: number | boolean;
  ai_enabled: number | boolean;
  notify_on_complete?: number | boolean;
  parameters: string | Record<string, any>;
  ai_settings?: string | Record<string, any> | null;
  last_execution?: string;
  last_status?: string;
}

// Mirror the status-badge palette used on Dashboard / Results & Logs so
// the Routines page's Last Status column matches the rest of the app —
// ``running`` uses the blue ``badge-info`` instead of red.
const lastStatusBadgeClass = (s: string): string => {
  if (s === 'completed') return 'badge-success';
  if (s === 'failed') return 'badge-error';
  if (s === 'cancelled') return 'badge-cancelled';
  return 'badge-info'; // running, cancelling, scheduled, unknown → blue
};

const RoutinesPage: React.FC = () => {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { activeExecutions, cancelExecution, completionCounter } = useExecution();
  const { bySlug, presence, refreshPresence } = useRepoCatalog();
  // Refetch the routines list whenever a Configurations-page mutation
  // fires (e.g. importing a routine config materializes a new routine
  // row server-side; we need to surface it here without a manual reload).
  const configsVersion = useConfigurationsVersion();
  // Refetch when any routine save/edit broadcasts a change — covers the
  // Calendar page's Edit Routine button, the modal's Create New flow,
  // and any future mutation site that calls ``notifyRoutinesChanged``.
  const routinesVersion = useRoutinesVersion();

  /* ---- modal state ---- */
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Routine | null>(null);

  const fetchRoutines = useCallback(async () => {
    try {
      const data = await apiClient.get<Routine[]>('/api/routines');
      setRoutines(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRoutines(); }, [fetchRoutines, completionCounter, configsVersion, routinesVersion]);

  const openCreate = () => { setEditTarget(null); setFormOpen(true); };
  const openEdit = (r: Routine) => { setEditTarget(r); setFormOpen(true); };

  const handleDelete = async (id: number) => {
    try {
      await apiClient.delete(`/api/routines/${id}`);
      fetchRoutines();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleActive = async (r: Routine) => {
    const active = !!r.is_active;
    try {
      await apiClient.post(`/api/routines/${r.id}/${active ? 'deactivate' : 'activate'}`);
      fetchRoutines();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleEmail = async (r: Routine) => {
    try {
      await apiClient.put(`/api/routines/${r.id}`, { email_enabled: !r.email_enabled });
      fetchRoutines();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleAi = async (r: Routine) => {
    try {
      await apiClient.put(`/api/routines/${r.id}`, { ai_enabled: !r.ai_enabled });
      fetchRoutines();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleNotify = async (r: Routine) => {
    try {
      await apiClient.put(`/api/routines/${r.id}`, { notify_on_complete: !r.notify_on_complete });
      fetchRoutines();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loading) return <div className="page-content"><p className="text-muted">Loading routines…</p></div>;

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Routines</h1>
        <TutorialLinkButton anchor="routines" />
        <button className="btn btn-primary" onClick={openCreate}>Create New Routine</button>
      </div>

      <PageHelp
        storageKey="routines"
        title="Routines"
        summary="Create, edit, and manage scheduled sweeps that run automatically."
        sections={[
          {
            heading: 'What a routine is',
            body: (
              <p>
                A <strong>routine</strong> is a saved sweep configuration plus a
                cron schedule. When its time comes, resmon fires an automated
                sweep across the configured repositories, stores the report,
                and (optionally) emails and/or sends a desktop notification
                about the results. Routines run on this device, via the resmon
                daemon.
              </p>
            ),
          },
          {
            heading: 'How to use this page',
            body: (
              <ul>
                <li>Click <strong>Create New Routine</strong> to build one from scratch or load a saved routine configuration.</li>
                <li>The <strong>Schedule</strong> column shows the cron expression; the <strong>Status</strong> column shows whether it is active.</li>
                <li>Per-routine <strong>Email</strong>, <strong>AI</strong>, and <strong>Notify</strong> toggles let you override those features on a single row without opening the editor.</li>
                <li>Use <strong>Activate / Deactivate</strong> to pause a routine without deleting it.</li>
                <li>If a routine is currently firing, a <strong>Cancel Run</strong> button appears on its row.</li>
              </ul>
            ),
          },
          {
            heading: 'Is this finding what I meant?',
            body: (
              <>
                <p>
                  Each routine carries a <strong>coverage audit</strong>. It compares
                  every paper the routine has ever returned against what the routine is{' '}
                  <em>for</em>, and shows two lists: the results sitting furthest from
                  that, and papers <strong>already in your corpus</strong> that this
                  routine never returned — usually a keyword gap you can close.
                </p>
                <p>
                  It compares against an <strong>intent</strong> you write for the
                  routine — the optional{' '}
                  <em>What this routine is really looking for</em> box in the editor, a
                  sentence in your own words. Without one it falls back to the keyword
                  string and says so, because comparing a query against the results that
                  query produced is measuring it against itself.
                </p>
                <p>
                  Both lists are a page of 25. When there are more, each says{' '}
                  <em>Showing 25 of N</em> — a list that stopped without saying so would
                  read as the whole answer.
                </p>
                <p>
                  The cutoff comes from the routine&rsquo;s own spread of distances, not
                  a fixed number, and below a dozen embedded results resmon declines to
                  draw one rather than dressing up a guess. Distance is not relevance:
                  the model has not read the papers, so the far end of the list is a
                  prompt to look, never a verdict.
                </p>
                <p>
                  <strong>resmon can only compare against papers it already holds.</strong>{' '}
                  A paper missing from the second list may simply never have been
                  collected by any routine — resmon has no idea what is out there and
                  does not pretend to. The audit needs an embedding model
                  (Settings &rarr; AI &rarr; Embeddings).
                </p>
              </>
            ),
          },
          {
            heading: 'Tips',
            body: (
              <ul>
                <li>Routines only fire when the resmon daemon is running (it is launched automatically on login by the background daemon installer).</li>
                <li>The cron field accepts standard 5-field syntax: <code>m h dom mon dow</code>. Example: <code>0 8 * * 1-5</code> = 8:00 AM on weekdays.</li>
                <li>If you want the date range to slide forward with each fire, leave it blank — routines without a fixed range default to the last 24 hours of the repository's index.</li>
              </ul>
            ),
          },
        ]}
      />

      {error && <div className="form-error">{error}</div>}

      <div className="card">
        <table className="simple-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Schedule</th>
              <th>Status</th>
              <th>Last Execution</th>
              <th>Last Status</th>
              <th>Email</th>
              <th>AI</th>
              <th>Notify</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {routines.length === 0 && (
              <tr><td colSpan={9} className="text-muted text-center">No routines configured.</td></tr>
            )}
            {routines.map((r) => (
              <React.Fragment key={`local-${r.id}`}>
              <tr>
                <td>{r.name}</td>
                <td><code>{r.schedule_cron}</code></td>
                <td>
                  <span className={`badge ${r.is_active ? 'badge-success' : 'badge-error'}`}>
                    {r.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>{r.last_execution || '—'}</td>
                <td>
                  {r.last_status
                    ? <span className={`badge ${lastStatusBadgeClass(r.last_status)}`}>{r.last_status}</span>
                    : '—'}
                </td>
                <td>
                  <button
                    className={`toggle-btn ${r.email_enabled ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => handleToggleEmail(r)}
                    title="Toggle email notifications"
                  >{r.email_enabled ? 'ON' : 'OFF'}</button>
                </td>
                <td>
                  <button
                    className={`toggle-btn ${r.ai_enabled ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => handleToggleAi(r)}
                    title="Toggle AI summarization"
                  >{r.ai_enabled ? 'ON' : 'OFF'}</button>
                </td>
                <td>
                  <button
                    className={`toggle-btn ${r.notify_on_complete ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => handleToggleNotify(r)}
                    title="Notify on Completion (only applies when automatic-routine notifications are set to 'selected' in Settings)"
                  >{r.notify_on_complete ? 'ON' : 'OFF'}</button>
                </td>
                <td>
                  <div className="action-btns">
                    <button className="btn btn-sm" onClick={() => openEdit(r)}>Edit</button>
                    <button className="btn btn-sm" onClick={() => handleToggleActive(r)}>
                      {r.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(r.id)}>Delete</button>
                    {(() => {
                      const running = Object.values(activeExecutions).find(
                        (e) =>
                          e.executionType === 'automated_sweep' &&
                          (e.status === 'running' || e.status === 'cancelling') &&
                          e.routine_id === r.id,
                      );
                      if (!running) return null;
                      return (
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={running.status === 'cancelling'}
                          onClick={() => cancelExecution(running.executionId)}
                        >
                          {running.status === 'cancelling' ? (
                            <><span className="fw-spinner" aria-hidden="true" /> Stopping…</>
                          ) : 'Cancel Run'}
                        </button>
                      );
                    })()}
                  </div>
                </td>
              </tr>
              {/*
                A row of its own rather than a cell: the audit is two lists and a
                caveat, and none of that fits a table cell. Collapsed, and fetched
                only when opened — the audit embeds the intent and runs two vector
                queries, so eight routines must not run eight of them on mount.
              */}
              <tr className="routine-coverage-row">
                <td colSpan={9}>
                  <CoveragePanel routineId={r.id} />
                </td>
              </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {formOpen && (
        <RoutineEditModal
          open={formOpen}
          target={editTarget}
          onClose={() => setFormOpen(false)}
          onSaved={() => { fetchRoutines(); }}
        />
      )}
    </div>
  );
};

export default RoutinesPage;
