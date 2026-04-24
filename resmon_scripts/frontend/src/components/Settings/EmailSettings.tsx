import React, { useState, useEffect } from 'react';
import { apiClient } from '../../api/client';
import PageHelp from '../Help/PageHelp';

const EmailSettings: React.FC = () => {
  const [settings, setSettings] = useState({
    smtp_server: '',
    smtp_port: '',
    smtp_username: '',
    smtp_from: '',
    smtp_to: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  // SMTP password is stored in the OS keychain via credential_manager,
  // not in the settings table. We only ever fetch presence ("is a
  // password stored?") and never the raw value.
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordMasked, setPasswordMasked] = useState(true);
  const [passwordStored, setPasswordStored] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const refreshPasswordPresence = async () => {
    try {
      const presence = await apiClient.get<Record<string, { present: boolean }>>(
        '/api/credentials',
      );
      setPasswordStored(!!presence?.smtp_password?.present);
    } catch {
      setPasswordStored(false);
    }
  };

  useEffect(() => {
    Promise.all([
      apiClient.get('/api/settings/email').then((data) =>
        setSettings((prev) => ({ ...prev, ...data })),
      ),
      refreshPasswordPresence(),
    ]).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setStatus('');
    try {
      await apiClient.put('/api/settings/email', { settings });
      setStatus('Email settings saved.');
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(''), 3000);
    }
  };

  const handleStorePassword = async () => {
    if (!passwordInput) {
      setStatus('Enter a password (or App Password) to store.');
      setTimeout(() => setStatus(''), 3000);
      return;
    }
    setPasswordBusy(true);
    try {
      // Gmail App Passwords are displayed with spaces for readability;
      // strip them so the raw 16-character secret is what's stored.
      const value = passwordInput.replace(/\s+/g, '');
      await apiClient.put('/api/credentials/smtp_password', { value });
      setPasswordInput('');
      await refreshPasswordPresence();
      setStatus('SMTP password stored in system keychain.');
    } catch (err: any) {
      setStatus(`Error storing password: ${err.message}`);
    } finally {
      setPasswordBusy(false);
      setTimeout(() => setStatus(''), 4000);
    }
  };

  const handleRemovePassword = async () => {
    setPasswordBusy(true);
    try {
      await apiClient.delete('/api/credentials/smtp_password');
      await refreshPasswordPresence();
      setStatus('SMTP password removed from system keychain.');
    } catch (err: any) {
      setStatus(`Error removing password: ${err.message}`);
    } finally {
      setPasswordBusy(false);
      setTimeout(() => setStatus(''), 4000);
    }
  };

  const handleTestEmail = async () => {
    setStatus('Sending test email…');
    try {
      await apiClient.post('/api/settings/email/test');
      setStatus('Test email sent.');
    } catch (err: any) {
      setStatus(`Test failed: ${err.message}`);
    }
    setTimeout(() => setStatus(''), 5000);
  };

  if (loading) return <p className="text-muted">Loading…</p>;

  const statusIsError =
    status.startsWith('Error') ||
    status.startsWith('Test failed') ||
    status.startsWith('Enter a password');

  return (
    <div className="settings-section">
      <h2>Email Notifications</h2>
      <PageHelp
        storageKey="settings-email"
        title="Email Notifications"
        summary="Deliver routine reports by email via any SMTP server."
        sections={[
          {
            heading: 'What this tab does',
            body: (
              <p>
                Configures the SMTP endpoint resmon uses to send report
                emails. Emails are only sent for routines that have the
                per-routine <strong>Email</strong> toggle enabled on the
                Routines page.
              </p>
            ),
          },
          {
            heading: 'Fields',
            body: (
              <ul>
                <li><strong>SMTP Server / Port</strong> — e.g. <code>smtp.gmail.com</code> / <code>587</code>.</li>
                <li><strong>Username</strong> — the account used to authenticate.</li>
                <li><strong>SMTP Password</strong> — stored in your OS keychain, never in the settings database. For Gmail, create an App Password at <code>myaccount.google.com/apppasswords</code>.</li>
                <li><strong>Sender</strong> / <strong>Recipient</strong> — the From: and To: addresses. Multiple recipients are comma-separated.</li>
              </ul>
            ),
          },
          {
            heading: 'Testing',
            body: (
              <p>
                Click <strong>Send Test Email</strong> to verify the
                settings. The test uses the current form values (save first
                if you have unsaved edits).
              </p>
            ),
          },
        ]}
      />
      <div className="settings-form">
        <div className="form-field">
          <label className="form-label">SMTP Server</label>
          <input className="form-input" value={settings.smtp_server} onChange={(e) => setSettings({ ...settings, smtp_server: e.target.value })} placeholder="smtp.gmail.com" />
        </div>
        <div className="form-field">
          <label className="form-label">SMTP Port</label>
          <input className="form-input" value={settings.smtp_port} onChange={(e) => setSettings({ ...settings, smtp_port: e.target.value })} placeholder="587" />
        </div>
        <div className="form-field">
          <label className="form-label">Username</label>
          <input className="form-input" value={settings.smtp_username} onChange={(e) => setSettings({ ...settings, smtp_username: e.target.value })} placeholder="you@gmail.com" />
        </div>
        <div className="form-field">
          <label className="form-label">
            SMTP Password{' '}
            {passwordStored && (
              <span className="text-muted">(stored in system keychain)</span>
            )}
          </label>
          <div className="key-input-row">
            <input
              className="form-input"
              type={passwordMasked ? 'password' : 'text'}
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder={
                passwordStored
                  ? 'Enter a new password to replace the stored one'
                  : 'Paste SMTP password or Gmail App Password'
              }
              autoComplete="off"
            />
            <button className="btn btn-sm" type="button" onClick={() => setPasswordMasked(!passwordMasked)}>
              {passwordMasked ? 'Show' : 'Hide'}
            </button>
            <button
              className="btn btn-sm btn-primary"
              type="button"
              onClick={handleStorePassword}
              disabled={passwordBusy || !passwordInput}
            >
              {passwordStored ? 'Replace' : 'Store'}
            </button>
            {passwordStored && (
              <button
                className="btn btn-sm"
                type="button"
                onClick={handleRemovePassword}
                disabled={passwordBusy}
              >
                Remove
              </button>
            )}
          </div>
          <p className="text-muted" style={{ marginTop: 4, fontSize: '0.85em' }}>
            For Gmail, use a 16-character App Password from{' '}
            <code>myaccount.google.com/apppasswords</code> (requires 2-Step Verification). Spaces are ignored.
          </p>
        </div>
        <div className="form-field">
          <label className="form-label">Sender Email</label>
          <input className="form-input" type="email" value={settings.smtp_from} onChange={(e) => setSettings({ ...settings, smtp_from: e.target.value })} placeholder="you@gmail.com" />
        </div>
        <div className="form-field">
          <label className="form-label">Recipient Email(s)</label>
          <input className="form-input" value={settings.smtp_to} onChange={(e) => setSettings({ ...settings, smtp_to: e.target.value })} placeholder="Comma-separated" />
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="btn btn-secondary" onClick={handleTestEmail}>Send Test Email</button>
        </div>
        {status && <div className={statusIsError ? 'form-error' : 'form-success'}>{status}</div>}
      </div>
    </div>
  );
};

export default EmailSettings;
