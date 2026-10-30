import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine, EngineError, engineSentence } from '../../api/client';
import type { components } from '../../api/schema';
import { bridge } from '../../bridge';
import { restartRestores } from './model';

type Verified = components['schemas']['BundleReport'];

export const BACKUP_KEY = ['backup-last'] as const;
const readLast = () => call(engine().GET('/api/backup/last'));
type Last = Awaited<ReturnType<typeof readLast>>;
const STORAGE_KEY = ['storage-settings'] as const;

/** The engine's own words for a refusal: its message, or the problems a verification found. */
function refusal(error: unknown): string {
  const detail = (error as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === 'object') {
    const d = detail as { message?: unknown; problems?: unknown };
    if (typeof d.message === 'string') return d.message;
    if (Array.isArray(d.problems)) return d.problems.map(String).join(' ');
  }
  return engineSentence(error) ?? (error instanceof Error ? error.message : String(error));
}

/** A typed call whose refusal keeps the engine's whole `detail`, which the backup routes answer as an object. */
async function call<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await request;
  if (error !== undefined || data === undefined) {
    const failure = new EngineError(response.status, `HTTP ${response.status}`) as EngineError & { detail: unknown };
    Object.defineProperty(failure, 'detail', { value: (error as { detail?: unknown } | undefined)?.detail ?? null });
    throw failure;
  }
  return data;
}

const WHEN = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const when = (iso: string | null | undefined) => {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? WHEN.format(at) : 'a time it did not record';
};

/**
 * Settings › Backup: one folder holding the database as a consistent
 * snapshot and every byte of the Library vault, with a manifest that hashes
 * all of it, and a restore that checks a folder and stages it for the next
 * start.
 *
 * It says what resmon established and no more: a backup was written to a
 * folder at a time. Writing it into Google Drive's folder means Google
 * Drive for desktop syncs it; resmon does not see that happen and does not
 * say it did.
 */
export function Storage() {
  const last = useQuery({ queryKey: BACKUP_KEY, queryFn: readLast });
  const settings = useQuery({ queryKey: STORAGE_KEY, queryFn: () => answer(engine().GET('/api/settings/storage')) });
  return (
    <section className="settings-group storage" aria-labelledby="storage-title" aria-busy={last.isPending || settings.isPending}>
      <h2 id="storage-title" className="group-title">Backup</h2>
      <p className="group-lede">
        A backup holds your database as a consistent snapshot and every byte in your Library vault, the two as a
        pair, with a manifest that hashes all of it. <strong>Credentials are never written into a backup</strong>:
        after a restore, resmon lists by name the ones to enter again.
      </p>
      {last.data && <Reentry last={last.data} />}
      {last.data?.drive_upload_retired && <DriveUploadRemoved />}
      {settings.data && <Destination stored={settings.data.export_directory} />}
      {last.data && <BackUp last={last.data} folder={settings.data?.export_directory ?? ''} />}
      {last.data && <Restore last={last.data} />}
      {(last.isError || settings.isError) && (
        <p className="field-error" role="alert">The engine did not answer ({(last.error ?? settings.error)?.message}).</p>
      )}
    </section>
  );
}

/** Where a backup is written. Unset, it is the system's temporary folder, which may be emptied; that is said. */
function Destination({ stored }: { stored: string }) {
  const client = useQueryClient();
  const choose = useMutation({
    mutationFn: async () => {
      const picked = await bridge()?.chooseDirectory?.();
      if (!picked) return null;
      await answer(engine().PUT('/api/settings/storage', { body: { settings: { export_directory: picked } } }));
      return picked;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: STORAGE_KEY }),
  });
  return (
    <div className="backup-where" data-backup="destination">
      <h3 className="field-title">Where backups go</h3>
      <p className="field-lede">
        {stored
          ? <>Into <code>{stored}</code>.</>
          : <>No folder is chosen, so a backup goes into the system’s temporary folder, which the system may empty. Choose a folder you keep.</>}
      </p>
      <p className="form-hint">
        To keep a copy in Google Drive, choose the folder Google Drive for desktop keeps on this computer (on a Mac,
        under <code>CloudStorage/GoogleDrive-…/My Drive</code>). It syncs what resmon writes there; resmon does not
        sign in to Google and does not see the upload.
      </p>
      <div className="form-actions">
        <button type="button" className="btn" disabled={choose.isPending || !bridge()?.chooseDirectory} onClick={() => choose.mutate()}>
          {stored ? 'Choose another folder' : 'Choose a folder'}
        </button>
      </div>
      {choose.error && <p className="field-error" role="alert">{refusal(choose.error)}</p>}
    </div>
  );
}

function BackUp({ last, folder }: { last: Last; folder: string }) {
  const client = useQueryClient();
  const [reports, setReports] = useState(true);
  const backUp = useMutation({
    mutationFn: () => call(engine().POST('/api/backup', { body: { confirm: 'CONFIRM', include_reports: reports } })),
    onSuccess: () => client.invalidateQueries({ queryKey: BACKUP_KEY }),
  });
  const latest = last.last_backup;
  return (
    <div className="backup-now" data-backup="now">
      <h3 className="field-title">Back up now</h3>
      <p className="field-lede" data-backup="last">
        {latest
          ? <>The last backup was written at {when(latest.created_at_utc)}: {latest.files} {latest.files === 1 ? 'file' : 'files'}{latest.includes_reports ? ', with the reports' : ''}, in <code>{latest.path}</code>.</>
          : 'No backup has been written from this copy of resmon.'}
      </p>
      <label className="backup-check">
        <input type="checkbox" checked={reports} onChange={(e) => setReports(e.target.checked)} />
        <span>Include the reports folder</span>
      </label>
      <div className="form-actions">
        <button type="button" className="btn primary" disabled={backUp.isPending} onClick={() => backUp.mutate()}>
          {backUp.isPending ? 'Backing up' : 'Back up now'}
        </button>
      </div>
      {backUp.data && (
        <p className="settings-said" role="status" data-backup="written">
          Written{folder ? '' : ' into the temporary folder'}. The manifest in it lists every file and its hash.
        </p>
      )}
      {backUp.error && <p className="field-error" role="alert">{refusal(backUp.error)}</p>}
    </div>
  );
}

/**
 * A restore checks a folder, then stages it: nothing moves until resmon next
 * starts, and the database it replaces is kept until deleted here. Where this
 * window's own engine is the one that will apply it, Restart resmon now quits
 * and opens the app again, which is that start.
 */
function Restore({ last }: { last: Last }) {
  const client = useQueryClient();
  const [report, setReport] = useState<Verified | null>(null);
  const [acceptFk, setAcceptFk] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: BACKUP_KEY });
  const verify = useMutation({
    mutationFn: async () => {
      const picked = await bridge()?.chooseDirectory?.();
      if (!picked) return null;
      return call(engine().POST('/api/backup/verify', { body: { path: picked } }));
    },
    onSuccess: (verified) => { setReport(verified); setAcceptFk(false); setSaid(null); },
  });
  const stage = useMutation({
    mutationFn: () => call(engine().POST('/api/restore', {
      body: { confirm: 'CONFIRM', path: report?.path ?? '', accept_fk_violations: acceptFk, vault_parent: '' },
    })),
    // The pending notice below says what will apply it, in the engine's words;
    // saying it again here put the same sentence on the screen twice.
    onSuccess: () => { setSaid(null); setReport(null); return refresh(); },
  });
  const restart = useMutation({
    mutationFn: async () => {
      if (!(await bridge()?.relaunch?.())) {
        throw new Error('This window could not restart resmon. Quit resmon and open it again to restore.');
      }
    },
  });
  const askRestart = () => {
    if (window.confirm('Restart resmon now? This window closes and resmon opens again, and the restore runs as it '
      + 'starts. A search running now is stopped.')) restart.mutate();
  };
  const cancel = useMutation({
    mutationFn: () => call(engine().POST('/api/restore/cancel')),
    onSuccess: () => { setSaid('The staged restore was cancelled. Nothing had been changed.'); return refresh(); },
  });
  const removeUndo = useMutation({
    mutationFn: () => call(engine().POST('/api/restore/undo-copy/delete', { body: { confirm: 'CONFIRM' } })),
    onSuccess: (done) => { setSaid(`Deleted ${done.deleted} saved ${done.deleted === 1 ? 'copy' : 'copies'} of what a restore replaced.`); return refresh(); },
  });
  const failed = last.last_restore && !last.last_restore.ok ? last.last_restore : null;
  const restored = last.last_restore && last.last_restore.ok ? last.last_restore : null;
  const undoKept = restored?.undo_copy ? last.undo_copies.includes(restored.undo_copy) : false;
  const error = verify.error ?? stage.error ?? cancel.error ?? removeUndo.error ?? restart.error;
  return (
    <div className="backup-restore" data-backup="restore">
      <h3 className="field-title">Restore</h3>
      <p className="field-lede">
        Choose a backup folder. resmon checks it first, then stages it: the restore runs the next time resmon starts,
        and the database it replaces is kept until you delete it here.
      </p>
      {last.pending_restore && (
        <p className="settings-said" role="status" data-backup="pending" data-runs-on={last.pending_restore_runs_on ?? undefined}>
          A restore is staged. {last.pending_restore_runs_when}{' '}
          {restartRestores(last) && bridge()?.relaunch && (
            <button type="button" className="btn primary sm" disabled={restart.isPending || cancel.isPending} onClick={askRestart}>
              {restart.isPending ? 'Restarting' : 'Restart resmon now'}
            </button>
          )}{' '}
          <button type="button" className="btn quiet sm" disabled={cancel.isPending || restart.isPending} onClick={() => cancel.mutate()}>Cancel it</button>
        </p>
      )}
      {restored && (
        <p className="field-lede" data-backup="restored">
          The last restore ran on {when(restored.at_utc)}, from <code>{restored.bundle}</code>.
          {restored.undo_copy && (undoKept
            ? <> What it replaced is kept in <code>{restored.undo_copy}</code> until you delete it here.</>
            : ' The copy of what it replaced has been deleted.')}
        </p>
      )}
      {failed && (
        <p className="field-error" data-backup="restore-failure">
          The last staged restore did not run ({String(failed.reason ?? 'no reason recorded')}). {String(failed.message ?? '')}
          {failed.vault_copy_kept && <> resmon kept the copy it had made of your Library vault at <code>{String(failed.vault_copy_kept)}</code>: put it back by hand before deleting any undo copy, which removes it too.</>}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn" disabled={verify.isPending || !bridge()?.chooseDirectory} onClick={() => verify.mutate()}>
          {verify.isPending ? 'Checking' : 'Restore from a backup…'}
        </button>
        {last.undo_copies.length > 0 && (
          <button type="button" className="btn quiet" disabled={removeUndo.isPending} onClick={() => removeUndo.mutate()}>
            Delete what the last restore replaced
          </button>
        )}
      </div>
      {report && (
        <div className="backup-report" role="group" aria-label="The backup, checked">
          <p><code>{report.path}</code></p>
          <p>{report.ok ? 'It checks out: every file is there and matches its hash.' : `It does not check out: ${report.problems.join(' ')}`}</p>
          {report.fk_violations_total > 0 && (
            <label className="backup-check">
              <input type="checkbox" checked={acceptFk} onChange={(e) => setAcceptFk(e.target.checked)} />
              <span>Restore it with its {report.fk_violations_total} reference{report.fk_violations_total === 1 ? '' : 's'} to a missing row</span>
            </label>
          )}
          <div className="form-actions">
            <button type="button" className="btn primary" disabled={!report.ok || stage.isPending || (report.fk_violations_total > 0 && !acceptFk)}
              onClick={() => stage.mutate()}>Stage this restore</button>
            <button type="button" className="btn quiet" onClick={() => setReport(null)}>Not now</button>
          </div>
        </div>
      )}
      {said && <p className="settings-said" role="status">{said}</p>}
      {error && <p className="field-error" role="alert">{refusal(error)}</p>}
    </div>
  );
}

/**
 * For a copy of resmon that had the upload to Google Drive after each run
 * switched on. That upload, and the Google sign-in it used, were removed, so
 * the switch does nothing now; this says so once, until Got it, which deletes
 * the setting it is read from.
 */
function DriveUploadRemoved() {
  const client = useQueryClient();
  const done = useMutation({
    mutationFn: () => call(engine().POST('/api/backup/drive-upload-notice/acknowledge')),
    onSuccess: () => client.invalidateQueries({ queryKey: BACKUP_KEY }),
  });
  return (
    <div className="backup-notice" role="group" aria-label="The upload to Google Drive was removed" data-backup="drive-upload-removed">
      <p>
        <strong>resmon no longer uploads to Google Drive.</strong> The upload of each run’s report and log, which was
        switched on here, has been removed, and resmon does not sign in to Google. To keep a copy in Google Drive,
        choose the folder Google Drive for desktop keeps on this computer under Where backups go, then back up into
        it: a backup holds your database and your Library, not only the reports.
      </p>
      <p className="form-hint">If you connected Google Drive to resmon, you can remove its access in your Google Account.</p>
      <button type="button" className="btn sm" disabled={done.isPending} onClick={() => done.mutate()}>Got it</button>
      {done.error && <p className="field-error" role="alert">{refusal(done.error)}</p>}
    </div>
  );
}

/** After a restore: the credentials a backup never holds, by name, until acknowledged. */
function Reentry({ last }: { last: Last }) {
  const client = useQueryClient();
  const restored = last.last_restore;
  const done = useMutation({
    mutationFn: () => call(engine().POST('/api/restore/acknowledge')),
    onSuccess: () => client.invalidateQueries({ queryKey: BACKUP_KEY }),
  });
  if (!restored || !restored.ok || restored.acknowledged) return null;
  const names = (restored.credentials_to_reenter ?? []).map(String);
  return (
    <div className="backup-reentry" role="group" aria-label="What the restore did not bring back" data-backup="reentry">
      <p><strong>A backup was restored on this start.</strong> These credentials are not in a backup and must be entered again on this computer:</p>
      {names.length ? <ul>{names.map((name) => <li key={name}><code>{name}</code></li>)}</ul>
        : <p>The backup recorded no credentials, so there is nothing to re-enter.</p>}
      {!!restored.fk_violations_total && <p>{String(restored.fk_violations_message ?? '')}</p>}
      <p className="form-hint">
        A webhook’s signing secret belongs to its delivery target’s row; a target restored under another id has no
        secret until you set one.
      </p>
      <button type="button" className="btn sm" disabled={done.isPending} onClick={() => done.mutate()}>Got it</button>
    </div>
  );
}
