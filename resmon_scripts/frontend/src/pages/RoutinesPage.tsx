import React, { useState, useEffect, useCallback } from 'react';
import { formatInstant } from '../lib/datetime';
import { useNavigate } from 'react-router-dom';
import CoveragePanel from '../components/Routines/CoveragePanel';
import DeliveryPanel from '../components/Routines/DeliveryPanel';
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
import { routineFiringNote, schedulerNotice, type SchedulerStatus } from '../lib/schedulerStatus';

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
  /**
   * Fires that did not run, counted from ``routine_missed_fires``. A count and
   * the most recent overdue time, never a verdict: resmon knows the schedule
   * was not kept, not what the run would have found. Optional because an older
   * backend does not answer it.
   *
   * ``count`` is every such fire; ``overlap_skipped`` is the subset APScheduler
   * refused because the routine's previous run was still going. The two causes
   * render as separate lines because they are separate facts, and the
   * difference is what the user acts on: a fire missed while resmon was closed
   * means open the laptop, a fire skipped as an overlap means the routine takes
   * longer than the interval it was given.
   *
   * Each line takes the timestamp belonging to its own cause.
   * ``last_due_at_utc`` spans every row, so rendering it on the closed-miss
   * line stamps that line with an overlap skip's time whenever the overlap
   * was the later of the two -- the closed-miss sentence then carries the
   * exact instant the line below it proves resmon was running. That is what
   * ``last_closed_miss_due_at_utc`` exists to prevent. Both new fields are
   * absent on a backend older than the distinction, so each is read with a
   * fallback rather than assumed.
   */
  missed_fires?: {
    count: number;
    last_due_at_utc: string | null;
    overlap_skipped?: number;
    last_overlap_skipped_due_at_utc?: string | null;
    last_closed_miss_due_at_utc?: string | null;
  };
}

/**
 * The fires missed while resmon was not running: every recorded fire less the
 * ones refused as overlaps. Subtraction rather than its own field because the
 * backend counts all rows in ``count``, and a backend that predates the
 * overlap record answers no ``overlap_skipped`` at all -- on which this
 * correctly returns the old number and the old line.
 */
const closedMissCount = (m: { count: number; overlap_skipped?: number }): number =>
  Math.max(0, m.count - (m.overlap_skipped ?? 0));

/**
 * When the last fire missed while resmon was not running came due. Falls back
 * to the all-rows maximum only on a backend that does not answer the narrower
 * field, where it is the same number the page showed before and the only one
 * available. On a backend that does answer, the fallback never fires, so an
 * overlap skip can no longer put its timestamp on this line.
 */
const closedMissLastDue = (
  m: { last_due_at_utc: string | null; last_closed_miss_due_at_utc?: string | null },
): string | null => m.last_closed_miss_due_at_utc ?? m.last_due_at_utc;

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
  const navigate = useNavigate();
  /**
   * Whether anything will fire the active routines. ``null`` until it answers,
   * and left ``null`` when it cannot: a backend older than the route answers
   * 404, and on that one the page says nothing rather than guess.
   */
  const [scheduling, setScheduling] = useState<SchedulerStatus | null>(null);

  /* ---- modal state ---- */
  const [formOpen, setFormOpen] = useState(false);
  /** Which rows have a Run now request in flight, so the button can say so. */
  const [running, setRunning] = useState<Record<number, boolean>>({});
  const [editTarget, setEditTarget] = useState<Routine | null>(null);

  const fetchRoutines = useCallback(async () => {
    try {
      const data = await apiClient.get<Routine[]>('/api/routines');
      setRoutines(data);
      apiClient.get<SchedulerStatus>('/api/scheduler/status')
        .then(setScheduling)
        .catch(() => setScheduling(null));
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

  /**
   * Run now, from the missed-fire line.
   *
   * The same endpoint the MCP tool and the editor use, so a manual run and a
   * scheduled fire stay one code path. The backend also marks this routine's
   * ``recorded`` missed fires ``ran_late`` — the word schema 20 reserved for
   * exactly this and nothing wrote until now. A 409 means the routine is
   * already running and says which run; it is shown rather than swallowed.
   */
  const handleRunNow = async (r: Routine) => {
    setError('');
    setRunning((prev) => ({ ...prev, [r.id]: true }));
    try {
      await apiClient.post(`/api/routines/${r.id}/run`);
      fetchRoutines();
    } catch (err: any) {
      setError(err?.message || 'Could not start that routine.');
    } finally {
      setRunning((prev) => ({ ...prev, [r.id]: false }));
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
            heading: 'One run at a time, and the fires resmon missed',
            body: (
              <>
                <p>
                  A routine runs once at a time. If its schedule comes round
                  while the previous run is still going &mdash; or you press
                  Run now while one is in flight &mdash; resmon refuses the
                  second fire and tells you which run already exists, rather
                  than searching the same sources twice for one slot.
                </p>
                <p>
                  If a routine was due while resmon was closed, its row says{' '}
                  <em>missed N fires while resmon was closed</em> and when the
                  last one was due. resmon does <strong>not</strong> run them
                  now: opening your laptop on Monday would otherwise start a
                  weekend&rsquo;s worth of sweeps at once. The line is there so
                  the schedule you believe in and the schedule that ran are the
                  same thing, or you can see that they are not.
                </p>
              </>
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
                <li>Where resmon recorded missed fires, a <strong>Run now</strong> button sits beside the count: it runs the routine once and marks those fires as answered by a late run &mdash; not as each having run.</li>
                <li>A separate line reads <em>skipped N fires because the previous run was still going</em>. resmon runs one copy of a routine at a time, so a fire that comes due while the last run is still working is refused rather than queued. It is recorded, not run, and there is no <strong>Run now</strong> beside it: the answer is a longer interval, not another run.</li>
              </ul>
            ),
          },
          {
            heading: 'Where the report goes',
            body: (
              <>
                <p>
                  A routine&rsquo;s report can be <strong>delivered</strong> to as many
                  destinations as you like. An <strong>email address</strong>. A{' '}
                  <strong>folder</strong> &mdash; which is how a cloud drive becomes a
                  destination: resmon writes the report bundle into the folder and your
                  drive&rsquo;s own client syncs it, with nothing of ours going over the
                  wire. A <strong>webhook</strong>, an https address you own, which
                  receives a signed summary of the run and a link to the bundle. Or a{' '}
                  <strong>feed</strong>, an Atom file in a folder that any feed reader
                  &mdash; or a static site &mdash; can point at. Add them in the
                  routine&rsquo;s editor, under <em>Delivery</em>.
                </p>
                <p>
                  A webhook needs a <strong>shared secret</strong>, which you type on the
                  destination&rsquo;s row. It goes straight into this computer&rsquo;s
                  keychain; resmon signs every envelope with it so your receiver can be
                  sure the message is yours, and it will not send an unsigned one. The
                  screen only ever tells you whether a secret is saved, never what it is.
                </p>
                <p>
                  Each destination is either <strong>automatic</strong> or{' '}
                  <strong>waits for your review</strong>. A review destination records
                  the delivery and holds it &mdash; through restarts, for as long as it
                  takes &mdash; until you press <em>Deliver</em>. Nothing releases it on
                  its own.
                </p>
                <p>
                  <strong>Every attempt is recorded</strong>, including the ones that
                  fail. Open <em>Where did this go?</em> under any routine for the state
                  of each delivery, how many attempts it took, and the reason it has not
                  arrived. A failure is retried after 1, 5 and 25 minutes and then waits
                  for you to press <em>Retry</em>; a delivery cut short by a force-quit
                  is picked up by the next start.
                </p>
                <p>
                  What resmon can tell you is that it handed the report to your mail
                  server, or wrote it into the folder.{' '}
                  <strong>Whether the message reached an inbox, or the folder finished
                  syncing, it cannot see</strong> &mdash; so it does not say.
                </p>
              </>
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
                <li>Routines fire only where a scheduler runs: the background service, which <strong>Run resmon in the background</strong> in Settings &rarr; Advanced installs and starts at login. This window does not run them itself. When nothing will run an active routine, this page says so above the table and under the routine&rsquo;s status, with the reason.</li>
                <li>The cron field accepts standard 5-field syntax: <code>m h dom mon dow</code>. Example: <code>0 8 * * 1-5</code> = 8:00 AM on weekdays.</li>
                <li>If you want the date range to slide forward with each fire, leave it blank — routines without a fixed range default to the last 24 hours of the repository's index.</li>
              </ul>
            ),
          },
        ]}
      />

      {error && <div className="form-error">{error}</div>}

      {(() => {
        const notice = scheduling ? schedulerNotice(scheduling) : null;
        if (!notice) return null;
        return (
          <div className="form-notice" role="status" data-testid="scheduler-notice">
            {notice.text}
            {notice.advanced && (
              <>
                {' '}
                <button className="btn btn-sm" onClick={() => navigate('/settings/advanced')}>
                  Open Settings → Advanced
                </button>
              </>
            )}
          </div>
        );
      })()}

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
                  {(() => {
                    const firing = scheduling?.routines.find((f) => f.id === r.id);
                    const note = r.is_active ? routineFiringNote(firing) : null;
                    return note ? (
                      <div className="text-muted missed-fires-note" data-testid={`firing-note-${r.id}`}>
                        {note}
                      </div>
                    ) : null;
                  })()}
                </td>
                <td>
                  {formatInstant(r.last_execution) || '—'}
                  {r.missed_fires && closedMissCount(r.missed_fires) > 0 && (
                    <div className="text-muted missed-fires-note">
                      {`missed ${closedMissCount(r.missed_fires)} ${closedMissCount(r.missed_fires) === 1 ? 'fire' : 'fires'} while resmon was closed`}
                      {closedMissLastDue(r.missed_fires)
                        ? `; last due ${formatInstant(closedMissLastDue(r.missed_fires))}`
                        : ''}
                      {' '}
                      <button
                        className="btn btn-sm"
                        data-testid={`run-now-${r.id}`}
                        disabled={!!running[r.id]}
                        onClick={() => handleRunNow(r)}
                        title="Run this routine once, now. The missed fires stay recorded; they are marked as answered by a late run, not as having each run."
                      >{running[r.id] ? 'Starting…' : 'Run now'}</button>
                    </div>
                  )}
                  {r.missed_fires && (r.missed_fires.overlap_skipped ?? 0) > 0 && (
                    <div className="text-muted missed-fires-note" data-testid={`overlap-skipped-${r.id}`}>
                      {`skipped ${r.missed_fires.overlap_skipped} ${r.missed_fires.overlap_skipped === 1 ? 'fire' : 'fires'} because the previous run was still going`}
                      {r.missed_fires.last_overlap_skipped_due_at_utc
                        ? `; last due ${formatInstant(r.missed_fires.last_overlap_skipped_due_at_utc)}`
                        : ''}
                      {' \u2014 this routine takes longer than its schedule allows.'}
                    </div>
                  )}
                </td>
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
                  {/*
                    Same treatment, same reason: the delivery record is a table
                    of its own and is fetched only when it is opened.
                  */}
                  <DeliveryPanel routineId={r.id} />
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
