import React, { useState, useEffect } from 'react';
import TutorialLinkButton from '../AboutResmon/TutorialLinkButton';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';

const POLICIES = ['save', 'archive', 'discard'] as const;

const StorageSettings: React.FC = () => {
  const [settings, setSettings] = useState({
    pdf_policy: '',
    txt_policy: '',
    archive_after_days: '',
    export_directory: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    apiClient.get('/api/settings/storage')
      .then((data) => setSettings((prev) => ({ ...prev, ...data })))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setStatus('');
    try {
      await apiClient.put('/api/settings/storage', { settings });
      setStatus('Storage settings saved.');
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(''), 3000);
    }
  };

  if (loading) return <p className="text-muted">Loading…</p>;

  return (
    <div className="settings-section">
      <div className="settings-panel-header">
        <h2>Storage Management</h2>
        <TutorialLinkButton anchor="settings-storage" />
      </div>
      <PageHelp
        storageKey="settings-storage"
        title="Storage Management"
        summary="Choose where resmon stores reports, logs, and figures."
        sections={[
          {
            heading: 'What this tab does',
            body: (
              <p>
                Sets the on-disk location for <code>resmon_reports/</code>
                (Markdown, LaTeX, PDF, figures, and logs). Change it to
                move your output off the project folder — e.g. onto a
                larger drive or into a synced folder.
              </p>
            ),
          },
          {
            heading: 'Retention',
            body: (
              <p>
                Retention policy controls how long past executions stay on
                disk. Reports older than the retention window are
                automatically pruned on daemon startup; the on-disk cache
                of cloud executions is capped independently.
              </p>
            ),
          },
        ]}
      />
      <p className="text-muted" style={{ marginTop: '-0.5rem', marginBottom: '1rem' }}>
        <strong>Note:</strong> The PDF / TXT retention controls below are
        reserved for a future per-paper artifact download feature. The current
        sweep pipeline only generates Markdown reports and execution logs under
        <code> resmon_reports/</code>; it does not download per-paper PDFs or
        TXTs, so these policies have no effect on Deep Dive or Deep Sweep
        behavior today. The <em>Export Location</em> setting below is active
        and is used by configuration / execution exports.
      </p>
      <div className="settings-form">
        <div className="form-field">
          <label className="form-label">PDF Files</label>
          <div className="policy-btns">
            {POLICIES.map((p) => (
              <button
                key={p}
                type="button"
                className={`btn btn-sm ${settings.pdf_policy === p ? 'btn-active' : ''}`}
                onClick={() => setSettings({ ...settings, pdf_policy: p })}
              >{p.charAt(0).toUpperCase() + p.slice(1)}</button>
            ))}
          </div>
        </div>
        <div className="form-field">
          <label className="form-label">TXT Files</label>
          <div className="policy-btns">
            {POLICIES.map((p) => (
              <button
                key={p}
                type="button"
                className={`btn btn-sm ${settings.txt_policy === p ? 'btn-active' : ''}`}
                onClick={() => setSettings({ ...settings, txt_policy: p })}
              >{p.charAt(0).toUpperCase() + p.slice(1)}</button>
            ))}
          </div>
        </div>
        <div className="form-field">
          <label className="form-label">Archive Retention (days)</label>
          <input
            className="form-input"
            type="number"
            min={1}
            value={settings.archive_after_days}
            onChange={(e) => setSettings({ ...settings, archive_after_days: e.target.value })}
            placeholder="30"
          />
        </div>
        <div className="form-field">
          <label className="form-label">Export Location</label>
          <p className="text-muted" style={{ marginTop: 0 }}>
            Destination folder for exported files (e.g., configuration <code>.zip</code> archives).
            Leave blank to use a temporary location.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              className="form-input"
              style={{ flex: 1 }}
              type="text"
              value={settings.export_directory}
              onChange={(e) => setSettings({ ...settings, export_directory: e.target.value })}
              placeholder="/path/to/export/folder"
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const picker = window.resmonAPI?.chooseDirectory;
                if (!picker) {
                  setStatus('Error: folder picker is only available inside the resmon desktop app.');
                  setTimeout(() => setStatus(''), 4000);
                  return;
                }
                const picked = await picker(settings.export_directory || undefined);
                if (picked) setSettings((prev) => ({ ...prev, export_directory: picked }));
              }}
              title="Choose folder…"
            >
              Browse…
            </button>
            {settings.export_directory && window.resmonAPI?.openPath && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  const opener = window.resmonAPI?.openPath;
                  if (opener && settings.export_directory) await opener(settings.export_directory);
                }}
                title="Open in file manager"
              >
                Open
              </button>
            )}
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
        {status && <div className={status.startsWith('Error') ? 'form-error' : 'form-success'}>{status}</div>}
      </div>
    </div>
  );
};

export default StorageSettings;
