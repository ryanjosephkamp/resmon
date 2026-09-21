import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

// Backup and restore, Settings → Storage.
//
// Two things this panel is careful about, both of which cost a user their
// corpus if they are got wrong:
//
//  * A restore never happens while the user is looking at it. It is verified,
//    staged, and applied on the next start — so the button says "Restart to
//    restore" and means it.
//  * What a restore does *not* bring back is shown, not implied. Credentials
//    are excluded from every backup by design, so after a restore the card
//    below lists the keyring entries by name for re-entry.

interface FileEntry { path: string; size: number; sha256: string }

interface Manifest {
  app_version?: string;
  schema_version?: number;
  created_at_utc?: string;
  vault_id?: string | null;
  includes_reports?: boolean;
  files?: FileEntry[];
  excluded?: { credentials?: string[]; process_state?: string[] };
}

interface FkViolation { table: string; rowid: number | null; parent: string; fkid: number }

interface VerifyReport {
  path: string;
  manifest: Manifest;
  files_checked: number;
  files_in_manifest: number;
  schema_relation: string;
  vault_relation: string;
  problems: string[];
  ok: boolean;
  fk_violations: FkViolation[];
  fk_violations_total: number;
  fk_violations_message: string;
  needs_fk_acceptance: boolean;
  will_not_restore: { credentials: string[]; process_state: string[]; note: string };
}

interface LastState {
  last_backup: { path: string; created_at_utc?: string; files?: number } | null;
  pending_restore: { bundle?: string } | null;
  last_restore: {
    ok: boolean;
    reason?: string;
    message?: string;
    bundle?: string;
    acknowledged?: boolean;
    credentials_to_reenter?: string[];
    fk_violations_total?: number;
    fk_violations_message?: string;
  } | null;
  undo_copies: string[];
}

const VAULT_RELATION: Record<string, string> = {
  same: 'The same Library vault this database already uses.',
  different: 'A different Library vault. resmon will refuse to overwrite the one on this machine.',
  none_configured: 'This machine has no Library vault yet; the backup’s vault will be restored.',
  none_in_backup: 'This backup carries no Library vault.',
};

const BackupRestore: React.FC = () => {
  const [includeReports, setIncludeReports] = useState(true);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [acceptFk, setAcceptFk] = useState(false);
  const [last, setLast] = useState<LastState | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLast(await apiClient.get('/api/backup/last'));
    } catch {
      /* the panel is still usable without the summary */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const describe = (err: any): string => {
    const detail = err?.detail ?? err?.response?.detail;
    if (detail && typeof detail === 'object' && detail.message) return String(detail.message);
    if (detail && typeof detail === 'object' && Array.isArray(detail.problems)) {
      return detail.problems.join(' ');
    }
    return err?.message ? String(err.message) : 'The request failed.';
  };

  const backUpNow = async () => {
    setBusy('backup'); setStatus(''); setError('');
    try {
      const result = await apiClient.post('/api/backup', {
        confirm: 'CONFIRM', include_reports: includeReports,
      });
      setStatus(`Backup written to ${result.path}`);
      if (window.resmonAPI?.revealPath) await window.resmonAPI.revealPath(result.path);
      await refresh();
    } catch (err: any) {
      setError(describe(err));
    } finally {
      setBusy('');
    }
  };

  const chooseAndVerify = async () => {
    const picker = window.resmonAPI?.chooseDirectory;
    if (!picker) {
      setError('The folder picker is only available inside the resmon desktop app.');
      return;
    }
    const picked = await picker();
    if (!picked) return;
    setBusy('verify'); setStatus(''); setError(''); setReport(null); setAcceptFk(false);
    try {
      setReport(await apiClient.post('/api/backup/verify', { path: picked }));
    } catch (err: any) {
      setError(describe(err));
    } finally {
      setBusy('');
    }
  };

  const stageRestore = async () => {
    if (!report) return;
    setBusy('restore'); setStatus(''); setError('');
    try {
      const result = await apiClient.post('/api/restore', {
        confirm: 'CONFIRM', path: report.path, accept_fk_violations: acceptFk,
      });
      setStatus(result.next_step);
      setReport(null);
      await refresh();
    } catch (err: any) {
      setError(describe(err));
    } finally {
      setBusy('');
    }
  };

  const cancelStaged = async () => {
    await apiClient.post('/api/restore/cancel', {});
    setStatus('The staged restore was cancelled. Nothing had been changed.');
    await refresh();
  };

  const deleteUndo = async () => {
    setBusy('undo');
    try {
      const result = await apiClient.post('/api/restore/undo-copy/delete', { confirm: 'CONFIRM' });
      setStatus(`Deleted ${result.deleted} saved copy of the previous database.`);
      await refresh();
    } catch (err: any) {
      setError(describe(err));
    } finally {
      setBusy('');
    }
  };

  const acknowledge = async () => {
    await apiClient.post('/api/restore/acknowledge', {});
    await refresh();
  };

  const restored = last?.last_restore;
  const showReentryCard = !!restored && restored.ok && !restored.acknowledged;

  return (
    <div className="settings-subsection" data-testid="backup-restore">
      <h3>Backup and restore</h3>
      <p className="text-muted" style={{ marginTop: 0 }}>
        A backup holds your database as a consistent snapshot and every byte in your
        Library vault — the two are a pair and resmon backs them up together.
        <strong> Credentials are never written into a backup.</strong> After a restore
        resmon lists, by name, which ones you need to enter again.
      </p>

      {showReentryCard && (
        <div className="form-warning" data-testid="reentry-card">
          <strong>A backup was restored on this start.</strong>
          <p style={{ marginBottom: '0.25rem' }}>
            These credentials are not in a backup and must be entered again on this machine:
          </p>
          {restored?.credentials_to_reenter?.length ? (
            <ul>
              {restored.credentials_to_reenter.map((name) => <li key={name}><code>{name}</code></li>)}
            </ul>
          ) : (
            <p>The backup recorded no credentials, so there is nothing to re-enter.</p>
          )}
          {!!restored?.fk_violations_total && (
            <p data-testid="reentry-fk">
              This backup was restored with {restored.fk_violations_total} reference
              {restored.fk_violations_total === 1 ? '' : 's'} to a missing parent that you
              chose to keep.{' '}
              {restored.fk_violations_message}
            </p>
          )}
          <p className="text-muted">
            Webhook signing secrets are keyed to a delivery target’s row id. A target
            restored under a different id has no secret bound to it until you set one.
          </p>
          <button type="button" className="btn btn-sm" onClick={acknowledge}>Got it</button>
        </div>
      )}

      {restored && !restored.ok && (
        <div className="form-error" data-testid="restore-failure">
          The last staged restore did not run ({restored.reason}). {restored.message}
        </div>
      )}

      <div className="form-field">
        <label className="form-label">
          <input
            type="checkbox"
            checked={includeReports}
            onChange={(e) => setIncludeReports(e.target.checked)}
          />{' '}
          Include the reports folder
        </label>
        <button
          type="button"
          className="btn btn-primary"
          onClick={backUpNow}
          disabled={busy !== ''}
        >
          {busy === 'backup' ? 'Backing up…' : 'Back up now'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={chooseAndVerify}
          disabled={busy !== ''}
        >
          {busy === 'verify' ? 'Checking…' : 'Restore from backup…'}
        </button>
      </div>

      {report && (
        <div className="settings-panel" data-testid="verify-report">
          <h4>{report.path}</h4>
          <p>
            {report.files_checked} of {report.files_in_manifest} files re-hashed and matched.
            Written by resmon {report.manifest.app_version} (database schema{' '}
            {report.manifest.schema_version}, {report.schema_relation} as this app’s).
          </p>
          <p>{VAULT_RELATION[report.vault_relation] ?? report.vault_relation}</p>
          {report.problems.length > 0 && (
            <ul className="form-error">
              {report.problems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          )}
          {report.needs_fk_acceptance && (
            <div className="form-warning" data-testid="fk-violations">
              <strong>This backup contains references to rows that are not there.</strong>
              <p>{report.fk_violations_message}</p>
              <ul>
                {report.fk_violations.slice(0, 10).map((v) => (
                  <li key={`${v.table}-${v.rowid}-${v.parent}`}>
                    <code>{v.table}</code> row {String(v.rowid)} → <code>{v.parent}</code>
                  </li>
                ))}
              </ul>
              <label className="form-label">
                <input
                  type="checkbox"
                  checked={acceptFk}
                  onChange={(e) => setAcceptFk(e.target.checked)}
                />{' '}
                Restore anyway, keeping these rows as they are
              </label>
            </div>
          )}
          <p className="text-muted">
            Not restored: {report.will_not_restore.credentials.length} credential
            {report.will_not_restore.credentials.length === 1 ? '' : 's'} (by name only),
            and the files that describe a running process. {report.will_not_restore.note}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={stageRestore}
            disabled={!report.ok || busy !== '' || (report.needs_fk_acceptance && !acceptFk)}
          >
            Restart to restore
          </button>
        </div>
      )}

      {last?.pending_restore?.bundle && (
        <div className="form-warning" data-testid="pending-restore">
          A restore of <code>{last.pending_restore.bundle}</code> is staged and will run the
          next time resmon starts. Nothing has changed yet.
          <button type="button" className="btn btn-sm" onClick={cancelStaged}>Cancel it</button>
        </div>
      )}

      {last?.last_backup && (
        <p className="text-muted" data-testid="last-backup">
          Last backup: <code>{last.last_backup.path}</code> ({last.last_backup.created_at_utc}).
        </p>
      )}

      {!!last?.undo_copies?.length && (
        <p className="text-muted" data-testid="undo-copies">
          A copy of the database a restore replaced is kept at{' '}
          <code>{last.undo_copies[0]}</code>.{' '}
          <button type="button" className="btn btn-sm" onClick={deleteUndo} disabled={busy !== ''}>
            Delete undo copy
          </button>
        </p>
      )}

      {status && <div className="form-success">{status}</div>}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
};

export default BackupRestore;
