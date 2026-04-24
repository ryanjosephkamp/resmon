import React, { useState, useEffect } from 'react';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';

const API_REASON_HINTS: Record<string, string> = {
  accessNotConfigured:
    'The Google Drive API is not enabled on your OAuth project. In the Google Cloud Console, open "APIs & Services → Library", search for "Google Drive API", and click Enable. Then click Refresh below.',
  insufficientPermissions:
    'The stored token is missing the drive.file scope. Unlink and re-link Google Drive to re-consent.',
  no_token:
    'No Google Drive token is stored. Click Link Google Drive to complete the OAuth flow.',
};

const CloudSettings: React.FC = () => {
  const [isLinked, setIsLinked] = useState(false);
  const [apiOk, setApiOk] = useState(false);
  const [apiReason, setApiReason] = useState<string | null>(null);
  const [autoBackup, setAutoBackup] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  const refresh = async () => {
    try {
      const [cloudStatus, cloudSettings] = await Promise.all([
        apiClient.get<{ is_linked: boolean; api_ok?: boolean; api_reason?: string | null }>(
          '/api/cloud/status',
        ),
        apiClient.get<Record<string, string>>('/api/settings/cloud'),
      ]);
      setIsLinked(cloudStatus.is_linked);
      setApiOk(Boolean(cloudStatus.api_ok));
      setApiReason(cloudStatus.api_reason ?? null);
      setAutoBackup(cloudSettings.cloud_auto_backup || '');
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const handleLink = async () => {
    setStatus('Linking…');
    try {
      await apiClient.post('/api/cloud/link');
      setStatus('Google Drive linked.');
      refresh();
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
    setTimeout(() => setStatus(''), 4000);
  };

  const handleUnlink = async () => {
    setStatus('Unlinking…');
    try {
      await apiClient.post('/api/cloud/unlink');
      setStatus('Google Drive unlinked.');
      refresh();
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
    setTimeout(() => setStatus(''), 4000);
  };

  const handleToggleAutoBackup = async () => {
    const next = autoBackup === 'true' ? 'false' : 'true';
    try {
      await apiClient.put('/api/settings/cloud', { settings: { cloud_auto_backup: next } });
      setAutoBackup(next);
    } catch { /* silent */ }
  };

  const [lastBackup, setLastBackup] = useState<
    { folder_name?: string | null; web_view_link?: string | null; uploaded: number; total_files: number } | null
  >(null);

  const handleBackupNow = async () => {
    setStatus('Backing up…');
    setLastBackup(null);
    try {
      const resp = await apiClient.post<{
        success: boolean;
        uploaded: number;
        total_files: number;
        folder_name?: string | null;
        web_view_link?: string | null;
      }>('/api/cloud/backup', {});
      setLastBackup(resp);
      if (resp.uploaded === 0) {
        setStatus(
          resp.total_files === 0
            ? 'Backup complete — no report files to upload yet.'
            : `Backup completed but 0 of ${resp.total_files} files uploaded. Check logs.`,
        );
      } else {
        setStatus(
          `Backup complete — uploaded ${resp.uploaded}/${resp.total_files} file(s) to "resmon/${resp.folder_name}" in Google Drive.`,
        );
      }
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
    setTimeout(() => setStatus(''), 8000);
  };

  if (loading) return <p className="text-muted">Loading…</p>;

  return (
    <div className="settings-section">
      <h2>Cloud Storage</h2>
      <PageHelp
        storageKey="settings-cloud-storage"
        title="Cloud Storage"
        summary="Back up executed reports to a cloud-storage provider."
        sections={[
          {
            heading: 'What this tab does',
            body: (
              <p>
                Configures an external cloud-storage provider (e.g. Google
                Drive) where resmon uploads a copy of each report when a
                routine fires. This is independent of the resmon-cloud
                account used for cloud-scheduler execution.
              </p>
            ),
          },
          {
            heading: 'How to connect',
            body: (
              <ol>
                <li>Choose a provider.</li>
                <li>Click <strong>Authorize</strong> and complete the OAuth flow in your browser.</li>
                <li>Pick a destination folder; resmon will upload new reports there whenever a routine produces them.</li>
              </ol>
            ),
          },
        ]}
      />
      <div className="settings-form">
        <div className="form-field">
          <label className="form-label">Google Drive Status</label>
          <div className="cloud-status-row">
            <span className={`status-dot ${isLinked && apiOk ? 'online' : 'offline'}`}></span>
            <span>
              {!isLinked && 'Not connected'}
              {isLinked && apiOk && 'Connected'}
              {isLinked && !apiOk && `Linked — API unreachable (${apiReason ?? 'unknown'})`}
            </span>
          </div>
          {isLinked && !apiOk && (
            <p className="form-help" style={{ marginTop: '0.25rem' }}>
              {API_REASON_HINTS[apiReason ?? ''] ??
                'The Drive API probe failed. Check that the Drive API is enabled on your OAuth project and that the token has the drive.file scope.'}
            </p>
          )}
        </div>
        <div className="form-actions" style={{ gap: '0.5rem' }}>
          {isLinked
            ? <button className="btn btn-danger" onClick={handleUnlink}>Unlink Google Drive</button>
            : <button className="btn btn-primary" onClick={handleLink}>Link Google Drive</button>}
          <button className="btn btn-secondary" onClick={refresh}>Refresh</button>
        </div>
        {!isLinked && (
          <p className="form-help" style={{ marginTop: '0.25rem' }}>
            Linking requires a Google OAuth 2.0 Desktop client. Create one in
            the Google Cloud Console and save its <code>credentials.json</code>
            at the project root before clicking <strong>Link Google Drive</strong>.
          </p>
        )}
        <div className="form-field">
          <label className="checkbox-label">
            <input type="checkbox" checked={autoBackup === 'true'} onChange={handleToggleAutoBackup} />
            <span>Auto-backup after each execution</span>
          </label>
        </div>
        <div className="form-actions">
          <button className="btn btn-secondary" onClick={handleBackupNow} disabled={!isLinked || !apiOk}>Backup Now</button>
        </div>
        {lastBackup?.web_view_link && (
          <p className="form-help" style={{ marginTop: '0.25rem' }}>
            Last backup folder:{' '}
            <a href={lastBackup.web_view_link} target="_blank" rel="noreferrer">
              {lastBackup.folder_name}
            </a>
            {' '}— under <code>My Drive › resmon › {lastBackup.folder_name}</code>.
          </p>
        )}
        {status && <div className={status.startsWith('Error') ? 'form-error' : 'form-success'}>{status}</div>}
      </div>
    </div>
  );
};

export default CloudSettings;
