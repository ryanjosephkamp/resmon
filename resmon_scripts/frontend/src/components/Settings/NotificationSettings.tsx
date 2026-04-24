import React, { useState, useEffect } from 'react';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';

type Mode = 'all' | 'selected' | 'none';

const NotificationSettings: React.FC = () => {
  const [notifyManual, setNotifyManual] = useState(true);
  const [mode, setMode] = useState<Mode>('none');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );

  useEffect(() => {
    apiClient.get('/api/settings/notifications')
      .then((data) => {
        if (typeof data.notify_manual === 'boolean') setNotifyManual(data.notify_manual);
        const m = (data.notify_automatic_mode || 'none') as Mode;
        if (m === 'all' || m === 'selected' || m === 'none') setMode(m);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setStatus('');
    try {
      await apiClient.put('/api/settings/notifications', {
        settings: { notify_manual: notifyManual, notify_automatic_mode: mode },
      });
      setStatus('Notification settings saved.');
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(''), 3000);
    }
  };

  const requestPermission = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setPermission(p);
  };

  if (loading) return <p className="text-muted">Loading…</p>;

  return (
    <div className="settings-section">
      <h2>Notifications</h2>
      <PageHelp
        storageKey="settings-notifications"
        title="Notifications"
        summary="Control which events trigger a desktop notification."
        sections={[
          {
            heading: 'Scope',
            body: (
              <ul>
                <li><strong>Manual executions</strong> — whether Deep Dive / Sweep runs you started by hand post a desktop notification on completion.</li>
                <li><strong>Automatic routines</strong> — whether scheduled routine fires post a notification. Options: <em>all</em> routines, <em>selected</em> routines only (per-routine <strong>Notify</strong> toggle on the Routines page), or <em>none</em>.</li>
              </ul>
            ),
          },
          {
            heading: 'Notes',
            body: (
              <p>
                Desktop notifications require OS-level permission the first
                time they are displayed. Email notifications and cloud
                uploads are independent of this tab.
              </p>
            ),
          },
        ]}
      />
      <div className="settings-form">
        <div className="form-field">
          <label className="form-check">
            <input
              type="checkbox"
              checked={notifyManual}
              onChange={(e) => setNotifyManual(e.target.checked)}
            />
            <span>Notify me when a manual execution completes</span>
          </label>
        </div>

        <div className="form-field">
          <label className="form-label">Automatic routine notifications</label>
          <div className="radio-group" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="form-check">
              <input
                type="radio"
                name="auto-mode"
                checked={mode === 'all'}
                onChange={() => setMode('all')}
              />
              <span>All automatic routines</span>
            </label>
            <label className="form-check">
              <input
                type="radio"
                name="auto-mode"
                checked={mode === 'selected'}
                onChange={() => setMode('selected')}
              />
              <span>Only selected routines (toggle per-routine on the Routines page)</span>
            </label>
            <label className="form-check">
              <input
                type="radio"
                name="auto-mode"
                checked={mode === 'none'}
                onChange={() => setMode('none')}
              />
              <span>None</span>
            </label>
          </div>
        </div>

        <div className="form-field">
          <label className="form-label">Browser permission</label>
          <div>
            <span className="text-muted">Current: {permission}</span>
            {permission !== 'granted' && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: 12 }}
                onClick={requestPermission}
              >Request permission</button>
            )}
          </div>
        </div>

        <div className="form-actions">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {status && <span className="form-status">{status}</span>}
        </div>
      </div>
    </div>
  );
};

export default NotificationSettings;
