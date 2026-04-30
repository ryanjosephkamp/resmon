import React, { useState, useEffect, useCallback } from 'react';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import { apiClient } from '../api/client';
import { cloudClient } from '../api/cloudClient';
import { useAuth } from '../context/AuthContext';
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
  is_active: number | boolean;
  email_enabled: number | boolean;
  email_ai_summary_enabled: number | boolean;
  ai_enabled: number | boolean;
  notify_on_complete?: number | boolean;
  parameters: string | Record<string, any>;
  ai_settings?: string | Record<string, any> | null;
  last_execution?: string;
  last_status?: string;
  execution_location?: 'local' | 'cloud';
}

/**
 * Cloud routines are returned by ``GET /api/v2/routines`` and use a
 * different field-name set (`cron` / `enabled` / `routine_id`). We
 * normalize them into a common ``UnifiedRoutine`` shape so the table can
 * render local and cloud rows side-by-side with identical controls.
 */
interface CloudRoutineRow {
  routine_id: string;
  name: string;
  cron: string;
  enabled: boolean;
  parameters: Record<string, any>;
}

interface UnifiedRoutine extends Routine {
  execution_location: 'local' | 'cloud';
  cloud_id?: string; // present for cloud rows only
}

type PendingMigration =
  | { kind: 'to-cloud'; routine: UnifiedRoutine }
  | { kind: 'to-local'; routine: UnifiedRoutine }
  | null;

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
  const [cloudRoutines, setCloudRoutines] = useState<CloudRoutineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { activeExecutions, cancelExecution, completionCounter } = useExecution();
  const { bySlug, presence, refreshPresence } = useRepoCatalog();
  const { isSignedIn } = useAuth();
  // IMPL-37: "Cloud sync enabled" gating. There is no stand-alone
  // cloud-sync toggle yet (Settings → Cloud Account tab arrives with
  // IMPL-38), so signed-in implies enabled.
  const cloudSyncEnabled = isSignedIn;
  const [pendingMigration, setPendingMigration] = useState<PendingMigration>(null);
  const [migrating, setMigrating] = useState(false);
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

  const fetchCloudRoutines = useCallback(async () => {
    if (!cloudSyncEnabled) {
      setCloudRoutines([]);
      return;
    }
    try {
      const rows = await cloudClient.get<CloudRoutineRow[]>('/api/v2/routines');
      setCloudRoutines(rows ?? []);
    } catch {
      // Swallow: cloud list is best-effort; sign-in dialogs and toast
      // surfaces already inform the user of auth failures.
      setCloudRoutines([]);
    }
  }, [cloudSyncEnabled]);

  useEffect(() => { fetchRoutines(); }, [fetchRoutines, completionCounter, configsVersion, routinesVersion]);
  useEffect(() => { fetchCloudRoutines(); }, [fetchCloudRoutines, completionCounter, routinesVersion]);

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

  const handleDeleteCloud = async (cloudId: string) => {
    try {
      await cloudClient.delete(`/api/v2/routines/${cloudId}`);
      fetchCloudRoutines();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // ---- Local ⇄ Cloud migration (IMPL-37) ---------------------------------
  //
  // The renderer orchestrates atomicity: create on the destination first,
  // then delete on the source. If the destination POST fails, the source
  // row is untouched. If the source delete fails after a successful
  // destination create, we surface the error and leave both rows present
  // — the user can retry the delete on the second attempt without losing
  // the destination copy.

  const performMoveToCloud = async (r: UnifiedRoutine) => {
    setMigrating(true);
    setError('');
    try {
      const params =
        typeof r.parameters === 'string' ? JSON.parse(r.parameters) : r.parameters;
      await cloudClient.post('/api/v2/routines', {
        name: r.name,
        cron: r.schedule_cron,
        parameters: params || {},
        enabled: !!r.is_active,
      });
      await apiClient.post(`/api/routines/${r.id}/released-to-cloud`);
      await Promise.all([fetchRoutines(), fetchCloudRoutines()]);
      setPendingMigration(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setMigrating(false);
    }
  };

  const performMoveToLocal = async (r: UnifiedRoutine) => {
    if (!r.cloud_id) {
      setError('Missing cloud_id for migration');
      return;
    }
    setMigrating(true);
    setError('');
    try {
      const params =
        typeof r.parameters === 'string' ? JSON.parse(r.parameters) : r.parameters;
      await apiClient.post('/api/routines/adopt-from-cloud', {
        name: r.name,
        schedule_cron: r.schedule_cron,
        parameters: params || {},
        email_enabled: !!r.email_enabled,
        email_ai_summary_enabled: !!r.email_ai_summary_enabled,
        ai_enabled: !!r.ai_enabled,
        notify_on_complete: !!r.notify_on_complete,
      });
      await cloudClient.delete(`/api/v2/routines/${r.cloud_id}`);
      await Promise.all([fetchRoutines(), fetchCloudRoutines()]);
      setPendingMigration(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setMigrating(false);
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
                about the results. Routines can run <strong>locally</strong> (on
                this device, via the resmon daemon) or in the <strong>cloud</strong> (if
                you are signed in and cloud sync is enabled).
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
                <li>Use <strong>Move to Cloud / Local</strong> to migrate a routine between execution locations (atomic: the destination is created first, then the source is deleted).</li>
                <li>If a routine is currently firing, a <strong>Cancel Run</strong> button appears on its row.</li>
              </ul>
            ),
          },
          {
            heading: 'Tips',
            body: (
              <ul>
                <li>Local routines only fire when the resmon daemon is running (it is launched automatically on login by the background daemon installer).</li>
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
              <th>Source</th>
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
            {routines.length === 0 && cloudRoutines.length === 0 && (
              <tr><td colSpan={10} className="text-muted text-center">No routines configured.</td></tr>
            )}
            {routines.map((r) => {
              const loc: 'local' | 'cloud' = (r.execution_location as any) || 'local';
              const unified: UnifiedRoutine = { ...r, execution_location: loc };
              return (
              <tr key={`local-${r.id}`}>
                <td>{r.name}</td>
                <td>
                  <span className="badge badge-type-other" data-testid={`routine-source-local-${r.id}`}>
                    Local
                  </span>
                </td>
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
                    {cloudSyncEnabled && (
                      <button
                        className="btn btn-sm"
                        data-testid={`move-to-cloud-${r.id}`}
                        onClick={() => setPendingMigration({ kind: 'to-cloud', routine: unified })}
                      >
                        Move to Cloud
                      </button>
                    )}
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
              );
            })}
            {cloudSyncEnabled && cloudRoutines.map((c) => {
              const unified: UnifiedRoutine = {
                id: -1,
                cloud_id: c.routine_id,
                name: c.name,
                schedule_cron: c.cron,
                is_active: c.enabled ? 1 : 0,
                email_enabled: 0,
                email_ai_summary_enabled: 0,
                ai_enabled: 0,
                notify_on_complete: 0,
                parameters: c.parameters,
                execution_location: 'cloud',
              };
              return (
              <tr key={`cloud-${c.routine_id}`}>
                <td>{c.name}</td>
                <td>
                  <span className="badge badge-info" data-testid={`routine-source-cloud-${c.routine_id}`}>
                    Cloud
                  </span>
                </td>
                <td><code>{c.cron}</code></td>
                <td>
                  <span className={`badge ${c.enabled ? 'badge-success' : 'badge-error'}`}>
                    {c.enabled ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="text-muted">—</td>
                <td className="text-muted">—</td>
                <td className="text-muted">—</td>
                <td className="text-muted">—</td>
                <td className="text-muted">—</td>
                <td>
                  <div className="action-btns">
                    <button
                      className="btn btn-sm"
                      data-testid={`move-to-local-${c.routine_id}`}
                      onClick={() => setPendingMigration({ kind: 'to-local', routine: unified })}
                    >
                      Move to Local
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => handleDeleteCloud(c.routine_id)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pendingMigration && (
        <div className="modal-overlay" onClick={() => !migrating && setPendingMigration(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Confirm Migration</h3>
            <p>
              {pendingMigration.kind === 'to-cloud' ? (
                <>
                  Move routine <strong>{pendingMigration.routine.name}</strong> to the cloud?
                  The local copy will be deleted after the cloud copy is created. Historical
                  executions produced locally remain attached to this device.
                </>
              ) : (
                <>
                  Move routine <strong>{pendingMigration.routine.name}</strong> to local?
                  A new local routine will be created first; the cloud copy will then be
                  deleted. Historical executions produced in the cloud stay in the cloud.
                </>
              )}
            </p>
            <div className="form-actions">
              <button
                className="btn btn-primary"
                disabled={migrating}
                onClick={() => {
                  if (pendingMigration.kind === 'to-cloud') {
                    performMoveToCloud(pendingMigration.routine);
                  } else {
                    performMoveToLocal(pendingMigration.routine);
                  }
                }}
              >
                {migrating ? 'Migrating…' : 'Confirm'}
              </button>
              <button
                className="btn btn-secondary"
                disabled={migrating}
                onClick={() => setPendingMigration(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {formOpen && (
        <RoutineEditModal
          open={formOpen}
          target={editTarget}
          onClose={() => setFormOpen(false)}
          onSaved={() => { fetchRoutines(); fetchCloudRoutines(); }}
        />
      )}
    </div>
  );
};

export default RoutinesPage;
