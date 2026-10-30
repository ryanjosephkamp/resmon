import {
  autoBackupOn, daemonSentence, daemonState, groupPath, keychainName, limitProblem, limitsReach, restartRestores, RUN_LIMITS,
  unitKind, type BackupLast, type DaemonStatus,
} from '../model';

const NO_LOCK: DaemonStatus = {
  lock_present: false, running: false, pid: null, port: null, version: null, started_at: null,
  lock_pid: null, lock_port: null, lock_version: null, error: null,
};

describe('what is running in the background, from the lock file and its probe', () => {
  test('no lock is no daemon, and the sentence says what that means for watches', () => {
    expect(daemonState(NO_LOCK, 4567)).toBe('none');
    expect(daemonSentence(NO_LOCK, 'none', null))
      .toBe('There is no daemon running, so nothing runs your watches on schedule: a resmon window does not run them itself.');
  });

  test('a lock that did not answer is not a running daemon, and the error is quoted', () => {
    const stale: DaemonStatus = { ...NO_LOCK, lock_present: true, lock_pid: 99999, lock_port: 8742, error: 'health probe failed: ConnectError' };
    expect(daemonState(stale, 4567)).toBe('unanswered');
    const said = daemonSentence(stale, 'unanswered', null);
    expect(said).toContain('pid 99999 on port 8742');
    expect(said).toContain('(health probe failed: ConnectError)');
    expect(said).toContain('cannot say a daemon is running');
  });

  test('a daemon that answered is this window\'s when the probe says so, or when the pids agree', () => {
    const up: DaemonStatus = { ...NO_LOCK, lock_present: true, running: true, pid: 4242, port: 8742, version: '2.4.0' };
    expect(daemonState({ ...up, is_self: true }, 1)).toBe('attached');
    expect(daemonState(up, 4242)).toBe('attached');
    expect(daemonState(up, 4567)).toBe('beside');
    expect(daemonSentence(up, 'beside', '8:02 PM'))
      .toBe('A daemon is running (pid 4242, version 2.4.0, since 8:02 PM), but this window is not using it: it started an engine of its own.');
  });
});

describe('the platform words', () => {
  test.each([
    ['darwin', 'a launch agent', 'launchd', 'the macOS Keychain'],
    ['linux', 'a systemd user unit', 'systemd', 'the desktop’s keyring'],
    ['win32', 'a scheduled task', 'Task Scheduler', 'Windows Credential Manager'],
  ])('%s', (platform, kind, manager, keychain) => {
    expect(unitKind(platform)).toEqual({ kind, manager });
    expect(keychainName(platform)).toBe(keychain);
  });

  test('an unknown platform is not guessed at', () => {
    expect(unitKind(null).manager).toBe('the system’s service manager');
    expect(keychainName(undefined)).toBe('this computer’s credential store');
  });
});

test('every group has its own address, and Appearance is Settings itself', () => {
  expect(groupPath('')).toBe('/settings');
  expect(groupPath('email')).toBe('/settings/email');
});

test('an erasure is reported in the engine’s own counts, and nothing it did not count', async () => {
  const { removedWords } = await import('../DangerZone');
  expect(removedWords({ success: true, documents_removed: 0 })).toBe('Removed 0 papers.');
  expect(removedWords({ success: true, configs_removed: 2, executions_removed: 5 })).toBe('Removed 2 saved configurations, 5 runs.');
  expect(removedWords({ success: true, ai_keys_removed: 3 })).toBe('Removed 3 AI keys.');
  expect(removedWords({ success: true, reset: 'all' })).toBe('Done.');
  expect(removedWords({ widgets_removed: 1 })).toBe('Removed 1 widgets.');
  expect(removedWords(null)).toBe('Done.');
});

test('every Settings group has its own address, and the rail lists each once', async () => {
  const { GROUPS, groupPath } = await import('../model');
  const slugs = GROUPS.map((g) => g.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
  expect(slugs).toEqual(['', 'background', 'email', 'notifications', 'ai', 'sources', 'storage', 'cloud', 'tutorials', 'about', 'danger']);
  expect(groupPath('danger')).toBe('/settings/danger');
});

describe('how many runs at once, and how many watch runs wait', () => {
  test('a whole number in the range the engine accepts saves, and anything else says why not', () => {
    expect(limitProblem('3', RUN_LIMITS.runs)).toBeNull();
    expect(limitProblem(' 8 ', RUN_LIMITS.runs)).toBeNull();
    expect(limitProblem('64', RUN_LIMITS.queue)).toBeNull();
    for (const raw of ['', '0', '9', '2.5', '-1', 'three', '1e1']) {
      expect(limitProblem(raw, RUN_LIMITS.runs)).toBe('Runs at once must be a whole number from 1 to 8.');
    }
    expect(limitProblem('65', RUN_LIMITS.queue)).toBe('Watch runs that can wait must be a whole number from 1 to 64.');
  });

  test('which engine a change reaches says the service is a separate engine whenever this window is not using it', () => {
    expect(limitsReach('attached')).toMatch(/uses the background service’s engine, so a change applies to it at once/);
    for (const state of ['beside', 'none', 'unanswered'] as const) {
      const said = limitsReach(state);
      expect(said).toContain('an engine it started itself, so a change applies to that engine at once');
      expect(said).toMatch(/The background service, which runs your watches on schedule, .*reads these limits when it (next )?starts\./);
      // A window's engine runs no watch on schedule; nothing here may say it does.
      expect(said).not.toMatch(/while (a|this) window is open/);
    }
    expect(limitsReach('beside')).toContain('a separate engine with its own count');
    expect(limitsReach(null)).toBe('A change applies at once to the engine this window uses. Any other engine reads these limits when it next starts.');
  });
});

test('the upload after each run is on only as the engine reads it', () => {
  expect(autoBackupOn('true')).toBe(true);
  expect(autoBackupOn(' TRUE ')).toBe(true);
  for (const stored of ['', 'false', '1', 'yes', 'on', null, undefined]) expect(autoBackupOn(stored)).toBe(false);
});

describe('Restart resmon now is offered only where restarting the app restores', () => {
  const staged: BackupLast['pending_restore'] = {
    bundle: '/backups/resmon-backup-1', manifest_sha256: 'abc', accept_fk_violations: false, staged_at_utc: '2026-10-29T21:02:46Z',
  };

  test('this window\'s own engine applies it on the next start', () => {
    expect(restartRestores({ pending_restore: staged, pending_restore_runs_on: 'app_restart' })).toBe(true);
  });

  test('not where a service holds the database, nor with nothing staged or a pointer nobody can read', () => {
    expect(restartRestores({ pending_restore: staged, pending_restore_runs_on: 'service_restart' })).toBe(false);
    expect(restartRestores({ pending_restore: staged, pending_restore_runs_on: 'service_stopped' })).toBe(false);
    expect(restartRestores({ pending_restore: null, pending_restore_runs_on: null })).toBe(false);
    expect(restartRestores({
      pending_restore: { bundle: null, manifest_sha256: null, unreadable: true }, pending_restore_runs_on: 'app_restart',
    })).toBe(false);
  });
});
