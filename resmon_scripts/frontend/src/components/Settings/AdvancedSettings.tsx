import React, { useState, useEffect, useCallback } from 'react';
import TutorialLinkButton from '../AboutResmon/TutorialLinkButton';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';
import { notifyConfigurationsChanged } from '../../lib/configurationsBus';
import { notifyRoutinesChanged } from '../../lib/routinesBus';

// Update 3 / 4_27_26 — Settings → Advanced → Danger Zone.
// Each entry drives one button in the Danger Zone section. ``needsTyping``
// flips the confirm modal between the simple Confirm/Cancel pair (for the
// two API-key wipes) and the type-CONFIRM-to-enable variant used by the
// six destructive data/settings actions.
interface DangerAction {
  id: string;
  label: string;
  endpoint: string;
  shortDescription: string;
  longWarning: string;
  needsTyping: boolean;
  scope: 'local' | 'cloud';
}

const LOCAL_DANGER_ACTIONS: DangerAction[] = [
  {
    id: 'ai_keys',
    label: 'Erase all AI API keys',
    endpoint: '/api/admin/erase-ai-keys',
    shortDescription:
      "Removes every saved BYOK LLM-provider key (OpenAI, Anthropic, Google, xAI, Meta, DeepSeek, Alibaba, Custom) from this device's OS keyring.",
    longWarning:
      "Every saved AI provider API key on this device will be deleted from the OS keyring. AI summarization will fall back to whichever provider has no key saved (typically 'local'). You will need to re-enter keys in Settings → AI to use cloud LLM providers again.",
    needsTyping: false,
    scope: 'local',
  },
  {
    id: 'repo_keys',
    label: 'Erase all repo API keys',
    endpoint: '/api/admin/erase-repo-keys',
    shortDescription:
      "Removes every saved research-repository API key from this device's OS keyring.",
    longWarning:
      'Every saved research-repository API key on this device will be deleted from the OS keyring. Key-gated repositories will report missing credentials until you re-enter their keys on the Repositories & API Keys page.',
    needsTyping: false,
    scope: 'local',
  },
  {
    id: 'configs',
    label: 'Erase all configs',
    endpoint: '/api/admin/erase-configs',
    shortDescription:
      'Deletes every saved configuration (manual dive, manual sweep, and routine) along with any routine linked to a routine config.',
    longWarning:
      'This will permanently delete every row on the Configurations page (manual dive presets, manual sweep presets, and routine configs). Any scheduled routine linked to a routine config is also deleted, so its future scheduled fires stop firing. Already-completed executions are kept, but they lose the link badge that pointed back to the deleted config.',
    needsTyping: true,
    scope: 'local',
  },
  {
    id: 'executions',
    label: 'Erase execution history',
    endpoint: '/api/admin/erase-executions',
    shortDescription:
      'Deletes every execution row (manual dives, manual sweeps, routine fires) and resets the default "Execution #N" counter back to 1.',
    longWarning:
      "This will permanently delete every execution on the Results & Logs page — local manual dives, local manual sweeps, and local routine fires — and reset the auto-incremented execution number so the next run is named 'Execution #1'. Reports and logs on disk for those executions are no longer reachable from the app.",
    needsTyping: true,
    scope: 'local',
  },
  {
    id: 'execution_data',
    label: 'Erase all execution data',
    endpoint: '/api/admin/erase-execution-data',
    shortDescription:
      'Combines "Erase all configs" and "Erase execution history". API keys and settings are untouched.',
    longWarning:
      'This will permanently delete every saved configuration AND every execution row, and reset the execution-number counter. API keys and Settings tabs are not affected.',
    needsTyping: true,
    scope: 'local',
  },
  {
    id: 'app_data',
    label: 'Erase all app data',
    endpoint: '/api/admin/erase-app-data',
    shortDescription:
      'Combines "Erase all AI API keys", "Erase all repo API keys", and "Erase all execution data". Settings (other than the AI tab, which depends on AI keys) are kept.',
    longWarning:
      'This will permanently delete every API key (AI + repo), every saved configuration, and every execution. Routines linked to routine configs are deleted too. Non-AI settings (Email, Storage, Notifications, Advanced) are kept; the AI tab will revert to the no-keys state.',
    needsTyping: true,
    scope: 'local',
  },
  {
    id: 'reset_settings',
    label: 'Reset all settings',
    endpoint: '/api/admin/reset-settings',
    shortDescription:
      'Resets every settings tab to defaults and erases every API key (both AI and research-repository keys plus the SMTP password). Configs and execution history are kept.',
    longWarning:
      'This will reset every Settings tab (Email, Cloud Storage, AI, Storage, Notifications, Advanced) to defaults, erase every saved API key (AI + research-repository + SMTP password), and clear the cached cloud-account email. Saved configurations and execution history are kept.',
    needsTyping: true,
    scope: 'local',
  },
  {
    id: 'factory',
    label: 'Factory reset',
    endpoint: '/api/admin/factory-reset',
    shortDescription:
      'Erases every API key, every configuration, every execution, and every setting on this device. The app is restored to its just-installed state.',
    longWarning:
      "This will permanently wipe every piece of resmon data on this device: every API key, every saved configuration, every execution row, every setting on every Settings tab, and the cached cloud-account email. The app will behave as if freshly installed. This cannot be undone.",
    needsTyping: true,
    scope: 'local',
  },
];

const CLOUD_DANGER_ACTIONS: DangerAction[] = LOCAL_DANGER_ACTIONS.map((a) => ({
  ...a,
  endpoint: a.endpoint.replace('/api/admin/', '/api/admin/cloud/'),
  scope: 'cloud',
}));

interface ServiceStatus {
  installed: boolean;
  unit_path: string;
  platform: string;
}

interface HealthResponse {
  status: string;
  pid: number;
  started_at: string;
  version: string;
}

// Update 4 / Fix E — ground-truth daemon status read from ``daemon.lock``
// by the backend, not from the renderer-attached backend's own
// ``/api/health``. Lets the Advanced tab show the real daemon's
// pid / version / last_started even when the renderer is talking to a
// separate fallback backend.
interface DaemonStatusResponse {
  lock_present: boolean;
  running: boolean;
  pid: number | null;
  port: number | null;
  version: string | null;
  started_at: string | null;
  lock_pid: number | null;
  lock_port: number | null;
  lock_version: string | null;
  error: string | null;
  is_self?: boolean;
}

interface ExecutionSettings {
  max_concurrent_executions: number;
  routine_fire_queue_limit: number;
}

interface SchedulerJob {
  id: string;
  name: string;
  next_run_time: string | null;
  trigger: string;
}

const AdvancedSettings: React.FC = () => {
  const [svc, setSvc] = useState<ServiceStatus | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  // Concurrent-executions panel state.
  const [execSettings, setExecSettings] = useState<ExecutionSettings | null>(null);
  const [execStatus, setExecStatus] = useState('');
  const [queueDraft, setQueueDraft] = useState<string>('16');

  // Scheduler-diagnostics state.
  const [jobs, setJobs] = useState<SchedulerJob[] | null>(null);
  const [jobsStatus, setJobsStatus] = useState('');

  // Update 3 / 4_27_26 — Danger Zone state.
  const [dangerAction, setDangerAction] = useState<DangerAction | null>(null);
  const [dangerInput, setDangerInput] = useState('');
  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerStatus, setDangerStatus] = useState('');
  const [dangerStatusKind, setDangerStatusKind] = useState<'success' | 'error' | ''>('');

  const openDanger = useCallback((a: DangerAction) => {
    setDangerAction(a);
    setDangerInput('');
  }, []);

  const closeDanger = useCallback(() => {
    if (dangerBusy) return;
    setDangerAction(null);
    setDangerInput('');
  }, [dangerBusy]);

  const runDangerAction = useCallback(async () => {
    if (!dangerAction) return;
    if (dangerAction.needsTyping && dangerInput !== 'CONFIRM') return;
    setDangerBusy(true);
    setDangerStatus('');
    setDangerStatusKind('');
    try {
      const body = dangerAction.needsTyping ? { confirm: 'CONFIRM' } : {};
      await apiClient.post(dangerAction.endpoint, body);
      // Tell every other page to refetch. The configurations and routines
      // buses cover the saved-config badges and the routines list; the
      // synthetic ``resmon:execution-completed`` event is what the
      // Dashboard / Calendar / Results pages already listen for to refresh
      // their execution tables.
      try { notifyConfigurationsChanged(); } catch { /* ignore */ }
      try { notifyRoutinesChanged(); } catch { /* ignore */ }
      try {
        if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('resmon:execution-completed', {
              detail: { source: 'danger-zone', action: dangerAction.id },
            }),
          );
        }
      } catch { /* ignore */ }
      setDangerStatus(`${dangerAction.label}: done.`);
      setDangerStatusKind('success');
      setDangerAction(null);
      setDangerInput('');
      setTimeout(() => { setDangerStatus(''); setDangerStatusKind(''); }, 6000);
    } catch (err: any) {
      setDangerStatus(`Error: ${err?.message ?? err}`);
      setDangerStatusKind('error');
    } finally {
      setDangerBusy(false);
    }
  }, [dangerAction, dangerInput]);

  const loadExecutionSettings = useCallback(async () => {
    try {
      const s = await apiClient.get<ExecutionSettings>('/api/settings/execution');
      setExecSettings(s);
      setQueueDraft(String(s.routine_fire_queue_limit));
    } catch (err: any) {
      setExecStatus(`Error: ${err.message ?? err}`);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const j = await apiClient.get<SchedulerJob[]>('/api/scheduler/jobs');
      setJobs(j);
      setJobsStatus('');
    } catch (err: any) {
      setJobs([]);
      setJobsStatus(`Error: ${err.message ?? err}`);
    }
  }, []);

  const persistExecutionSettings = useCallback(
    async (next: ExecutionSettings) => {
      try {
        await apiClient.put('/api/settings/execution', next);
        setExecSettings(next);
        setExecStatus('Saved.');
        setTimeout(() => setExecStatus(''), 2500);
      } catch (err: any) {
        setExecStatus(`Error: ${err.message ?? err}`);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const [s, h, d] = await Promise.all([
        apiClient.get<ServiceStatus>('/api/service/status'),
        apiClient.get<HealthResponse>('/api/health').catch(() => null),
        apiClient.get<DaemonStatusResponse>('/api/service/daemon-status').catch(() => null),
      ]);
      setSvc(s);
      setHealth(h);
      setDaemon(d);
    } catch (err: any) {
      setStatus(`Error: ${err.message ?? err}`);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    loadExecutionSettings();
    loadJobs();
  }, [loadExecutionSettings, loadJobs]);

  const handleToggle = async () => {
    if (!svc) return;
    const confirmMsg = svc.installed
      ? 'Remove the resmon background service? Scheduled routines will no longer run while the app is closed.'
      : 'Install the resmon background service? This will allow routines to run in the background even when the app is closed.';
    if (!window.confirm(confirmMsg)) return;

    setBusy(true);
    setStatus(svc.installed ? 'Uninstalling…' : 'Installing…');
    try {
      if (svc.installed) {
        await apiClient.post('/api/service/uninstall', { register: true });
        setStatus('Service uninstalled.');
      } else {
        await apiClient.post('/api/service/install', { register: true });
        setStatus('Service installed. The daemon will start at login.');
      }
      await refresh();
    } catch (err: any) {
      setStatus(`Error: ${err.message ?? err}`);
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(''), 5000);
    }
  };

  if (!svc) {
    return <div className="settings-panel">Loading service status…</div>;
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <h2>Advanced</h2>
        <TutorialLinkButton anchor="settings-advanced" />
      </div>
      <PageHelp
        storageKey="settings-advanced"
        title="Advanced"
        summary="Background daemon, concurrency limits, and scheduler diagnostics."
        sections={[
          {
            heading: 'Background daemon',
            body: (
              <p>
                Installs a per-user service (launchd on macOS,
                <code>systemd --user</code> on Linux, Task Scheduler on
                Windows) so scheduled routines keep firing even when the
                resmon window is closed. The Electron app attaches to the
                already-running daemon on launch.
              </p>
            ),
          },
          {
            heading: 'Concurrent executions',
            body: (
              <p>
                Caps how many executions the admission controller will
                allow to run at the same time. Excess runs are queued
                (manual dives / sweeps) or dropped with a warning
                (routines, to avoid runaway queues).
              </p>
            ),
          },
          {
            heading: 'Scheduler diagnostics',
            body: (
              <p>
                Shows the APScheduler job store health, next fires for
                every active routine, and any misfires since daemon
                startup. Use the listed next-fire times to verify your
                cron expressions are doing what you expect.
              </p>
            ),
          },
          {
            heading: 'Danger Zone',
            body: (
              <p>
                The collapsible <strong>Danger Zone</strong> at the bottom of this
                panel exposes 8 destructive maintenance actions on the local side
                (and 8 cloud-side counterparts, currently disabled until the cloud
                account feature lands). The two API-key wipes (Local / Cloud) use
                a simple OK/Cancel browser confirmation; the six data-and-settings
                destruction actions require typing <code>CONFIRM</code> into a
                dedicated input before the action button enables. All actions are
                irreversible — nothing here writes to a trash or undo log.
              </p>
            ),
          },
        ]}
      />
      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Run resmon in the background</h3>
        <p style={{ color: '#666', fontSize: '0.9rem' }}>
          Installs a per-user service unit so that scheduled routines continue to run
          even when the resmon window is closed. Uses launchd on macOS, systemd --user
          on Linux, and Task Scheduler on Windows.
        </p>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={svc.installed}
            disabled={busy}
            onChange={handleToggle}
          />
          <span>Run resmon in the background</span>
        </label>
        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
          <div>
            Status:{' '}
            <span style={{ fontWeight: 600 }}>
              {svc.installed ? 'Installed' : 'Not installed'}
            </span>
            {/* Update 4 / Fix E — daemon status is read from daemon.lock
                by the backend, not from the renderer-attached /api/health. */}
            {daemon && daemon.running ? (
              <span style={{ marginLeft: '0.5rem', color: '#2a7' }}>
                · daemon up (pid {daemon.pid}, v{daemon.version}
                {daemon.is_self ? ', this process' : ''})
              </span>
            ) : daemon && daemon.lock_present ? (
              <span style={{ marginLeft: '0.5rem', color: '#a62' }}>
                · daemon lock present (pid {daemon.lock_pid}, port {daemon.lock_port}) but unreachable
                {daemon.error ? `: ${daemon.error}` : ''}
              </span>
            ) : (
              <span style={{ marginLeft: '0.5rem', color: '#a62' }}>· no daemon running</span>
            )}
            {/* Renderer-attached backend identity — kept for diagnostics
                so the user can compare against the ground-truth daemon. */}
            {health && (
              <span style={{ marginLeft: '0.5rem', color: '#888' }}>
                · this window → pid {health.pid}, v{health.version}
              </span>
            )}
          </div>
          {daemon && daemon.running && daemon.started_at && (
            <div>
              Last started: <code>{daemon.started_at}</code>
            </div>
          )}
          <div style={{ color: '#888' }}>
            Unit path: <code>{svc.unit_path}</code>
          </div>
          <div style={{ color: '#888' }}>Platform: {svc.platform}</div>
        </div>
        {status && (
          <div style={{ marginTop: '0.5rem', color: status.startsWith('Error') ? '#c33' : '#2a7' }}>
            {status}
          </div>
        )}
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Concurrent executions</h3>
        <p style={{ color: '#666', fontSize: '0.9rem' }}>
          How many sweeps can run at the same time (range 1–8, default 3).
          Routines that fire while the limit is full are queued (up to 16 at a
          time). Manual dives/sweeps beyond the limit return an error telling
          you to try again shortly.
        </p>
        {execSettings ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 520 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.9rem' }}>
                Max concurrent executions:{' '}
                <strong>{execSettings.max_concurrent_executions}</strong>
              </span>
              <input
                type="range"
                min={1}
                max={8}
                step={1}
                value={execSettings.max_concurrent_executions}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setExecSettings({ ...execSettings, max_concurrent_executions: n });
                }}
                onMouseUp={() => {
                  if (execSettings) void persistExecutionSettings(execSettings);
                }}
                onKeyUp={() => {
                  if (execSettings) void persistExecutionSettings(execSettings);
                }}
                onTouchEnd={() => {
                  if (execSettings) void persistExecutionSettings(execSettings);
                }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.9rem' }}>
                Routine-fire queue limit (1–64):
              </span>
              <input
                type="number"
                min={1}
                max={64}
                step={1}
                value={queueDraft}
                onChange={(e) => setQueueDraft(e.target.value)}
                onBlur={() => {
                  const n = parseInt(queueDraft, 10);
                  if (!Number.isFinite(n) || n < 1 || n > 64) {
                    setQueueDraft(String(execSettings.routine_fire_queue_limit));
                    setExecStatus('Error: queue limit must be between 1 and 64.');
                    return;
                  }
                  if (n === execSettings.routine_fire_queue_limit) return;
                  void persistExecutionSettings({
                    ...execSettings,
                    routine_fire_queue_limit: n,
                  });
                }}
                style={{ width: 120 }}
              />
            </label>
            {execStatus && (
              <div
                style={{
                  fontSize: '0.85rem',
                  color: execStatus.startsWith('Error') ? '#c33' : '#2a7',
                }}
              >
                {execStatus}
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: '#888' }}>Loading execution settings…</div>
        )}
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Scheduler diagnostics</h3>
        <p style={{ color: '#666', fontSize: '0.9rem' }}>
          Read-only view of every active APScheduler job (one row per active
          routine). Use the refresh button to re-query.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => { void loadJobs(); }}
          style={{ marginBottom: '0.5rem' }}
        >
          Refresh
        </button>
        {jobsStatus && (
          <div style={{ fontSize: '0.85rem', color: '#c33', marginBottom: '0.5rem' }}>
            {jobsStatus}
          </div>
        )}
        {jobs === null ? (
          <div style={{ color: '#888' }}>Loading scheduler jobs…</div>
        ) : jobs.length === 0 ? (
          <div style={{ color: '#888' }}>No active scheduler jobs.</div>
        ) : (
          <table className="data-table" style={{ fontSize: '0.85rem', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Job ID</th>
                <th style={{ textAlign: 'left' }}>Next run time</th>
                <th style={{ textAlign: 'left' }}>Trigger</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td><code>{j.id}</code></td>
                  <td>{j.next_run_time ?? '—'}</td>
                  <td><code>{j.trigger}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Update 3 / 4_27_26 — Danger Zone. Bulk irreversible erase / reset
          actions. Local actions hit ``/api/admin/...``; cloud counterparts
          are scaffolded but disabled until the cloud account feature ships. */}
      <section
        style={{
          marginTop: '2rem',
          padding: '1rem',
          border: '1px solid #c33',
          borderRadius: 6,
          background: 'rgba(204, 51, 51, 0.05)',
        }}
      >
        <h3 style={{ color: '#c33', marginTop: 0 }}>Danger zone</h3>
        <p style={{ color: '#666', fontSize: '0.9rem' }}>
          Bulk erase and reset actions. <strong>Every action here is
          irreversible.</strong> The two API-key wipes use a quick
          confirm/cancel prompt; every other action requires you to type
          <code> CONFIRM </code>(case-sensitive, all caps) before the
          confirm button activates so nothing is wiped by accident.
        </p>

        {dangerStatus && (
          <div
            role="status"
            style={{
              marginBottom: '0.75rem',
              padding: '0.5rem 0.75rem',
              borderRadius: 4,
              fontSize: '0.85rem',
              background: dangerStatusKind === 'error' ? '#fdecea' : '#e6f4ea',
              color: dangerStatusKind === 'error' ? '#c33' : '#1a7e3a',
              border: `1px solid ${dangerStatusKind === 'error' ? '#c33' : '#1a7e3a'}`,
            }}
          >
            {dangerStatus}
          </div>
        )}

        <h4 style={{ marginBottom: '0.25rem' }}>This device</h4>
        <p style={{ color: '#888', fontSize: '0.8rem', marginTop: 0 }}>
          These actions affect data stored on this device only — the local
          OS keyring, the local SQLite database, and the local app
          settings. Other devices signed into the same cloud account (when
          that feature ships) are not touched.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 720 }}>
          {LOCAL_DANGER_ACTIONS.map((a) => (
            <div
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.75rem',
                padding: '0.5rem 0',
                borderBottom: '1px solid #eee',
              }}
            >
              <button
                type="button"
                className="btn btn-danger btn-sm"
                style={{ minWidth: 220, flex: '0 0 auto' }}
                onClick={() => openDanger(a)}
                disabled={dangerBusy}
              >
                {a.label}
              </button>
              <div style={{ fontSize: '0.85rem', color: '#555' }}>
                {a.shortDescription}
              </div>
            </div>
          ))}
        </div>

        <h4 style={{ marginTop: '1.25rem', marginBottom: '0.25rem' }}>
          Cloud account
        </h4>
        <p style={{ color: '#888', fontSize: '0.8rem', marginTop: 0 }}>
          These actions will affect the encrypted copy of your data stored
          in your resmon-cloud account once the cloud account feature
          ships. Until then, every cloud-scope button is disabled — the
          local actions above are the only ones currently wired.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 720 }}>
          {CLOUD_DANGER_ACTIONS.map((a) => (
            <div
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.75rem',
                padding: '0.5rem 0',
                borderBottom: '1px solid #eee',
                opacity: 0.55,
              }}
            >
              <button
                type="button"
                className="btn btn-danger btn-sm"
                style={{ minWidth: 220, flex: '0 0 auto' }}
                disabled
                title="Cloud account feature has not shipped yet."
              >
                {a.label}
              </button>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>
                {a.shortDescription} <em>(Coming with the cloud account feature.)</em>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Confirmation modal for danger-zone actions. Two variants:
            - needsTyping=false → simple Confirm / Cancel
            - needsTyping=true  → user must type CONFIRM exactly to enable Confirm. */}
      {dangerAction && (
        <div
          className="modal-overlay"
          onClick={closeDanger}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'white', maxWidth: 560, width: '90%',
              padding: '1.25rem', borderRadius: 8,
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            }}
          >
            <h3 style={{ marginTop: 0, color: '#c33' }}>
              {dangerAction.label}
            </h3>
            <p style={{ fontSize: '0.9rem', color: '#444' }}>
              {dangerAction.longWarning}
            </p>
            {dangerAction.needsTyping ? (
              <>
                <p style={{ fontSize: '0.85rem', color: '#666' }}>
                  Type <code>CONFIRM</code> (case-sensitive, all caps) to
                  enable the confirm button.
                </p>
                <input
                  type="text"
                  autoFocus
                  value={dangerInput}
                  onChange={(e) => setDangerInput(e.target.value)}
                  placeholder="Type CONFIRM"
                  spellCheck={false}
                  autoComplete="off"
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    fontFamily: 'monospace',
                    fontSize: '0.95rem',
                    border: '1px solid #ccc',
                    borderRadius: 4,
                    marginBottom: '0.75rem',
                  }}
                />
              </>
            ) : (
              <p style={{ fontSize: '0.85rem', color: '#666' }}>
                Click <strong>Confirm</strong> to proceed, or
                <strong> Cancel </strong>to back out.
              </p>
            )}
            <div
              style={{
                display: 'flex', justifyContent: 'flex-end',
                gap: '0.5rem', marginTop: '0.5rem',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeDanger}
                disabled={dangerBusy}
              >
                Cancel
              </button>
              {dangerAction.needsTyping ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={runDangerAction}
                  disabled={dangerBusy || dangerInput !== 'CONFIRM'}
                >
                  {dangerBusy ? 'Working…' : 'Confirm'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-success"
                  onClick={runDangerAction}
                  disabled={dangerBusy}
                  style={{
                    background: '#1a7e3a',
                    borderColor: '#1a7e3a',
                    color: 'white',
                  }}
                >
                  {dangerBusy ? 'Working…' : 'Confirm'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdvancedSettings;
