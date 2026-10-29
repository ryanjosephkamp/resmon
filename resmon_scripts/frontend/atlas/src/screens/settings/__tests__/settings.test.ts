import { daemonSentence, daemonState, groupPath, keychainName, unitKind, type DaemonStatus } from '../model';

const NO_LOCK: DaemonStatus = {
  lock_present: false, running: false, pid: null, port: null, version: null, started_at: null,
  lock_pid: null, lock_port: null, lock_version: null, error: null,
};

describe('what is running in the background, from the lock file and its probe', () => {
  test('no lock is no daemon, and the sentence says what that means for watches', () => {
    expect(daemonState(NO_LOCK, 4567)).toBe('none');
    expect(daemonSentence(NO_LOCK, 'none', null))
      .toBe('There is no daemon running, so your watches run only while a resmon window is open.');
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
