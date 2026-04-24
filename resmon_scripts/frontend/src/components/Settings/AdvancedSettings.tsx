import React, { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';

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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  // Concurrent-executions panel state.
  const [execSettings, setExecSettings] = useState<ExecutionSettings | null>(null);
  const [execStatus, setExecStatus] = useState('');
  const [queueDraft, setQueueDraft] = useState<string>('16');

  // Scheduler-diagnostics state.
  const [jobs, setJobs] = useState<SchedulerJob[] | null>(null);
  const [jobsStatus, setJobsStatus] = useState('');

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
      const [s, h] = await Promise.all([
        apiClient.get<ServiceStatus>('/api/service/status'),
        apiClient.get<HealthResponse>('/api/health').catch(() => null),
      ]);
      setSvc(s);
      setHealth(h);
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
      <h2>Advanced</h2>
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
            {health ? (
              <span style={{ marginLeft: '0.5rem', color: '#2a7' }}>
                · daemon up (pid {health.pid}, v{health.version})
              </span>
            ) : (
              <span style={{ marginLeft: '0.5rem', color: '#a62' }}>· daemon not reachable</span>
            )}
          </div>
          {health && (
            <div>
              Last started: <code>{health.started_at}</code>
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
    </div>
  );
};

export default AdvancedSettings;
