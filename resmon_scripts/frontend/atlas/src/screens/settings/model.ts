/**
 * Settings: the words for what is installed, what is running, and where a
 * password is kept. Each sentence says only what the engine's answer
 * establishes; a lock file that names a process is not a running process.
 */
import type { components } from '../../api/schema';

export type ServiceStatus = components['schemas']['ServiceStatus'];
export type DaemonStatus = components['schemas']['DaemonStatus'];
export type Health = components['schemas']['Health'];
export type EmailSettings = components['schemas']['EmailSettings'];
export type NotificationSettings = components['schemas']['NotificationSettings'];
export type BackupLast = components['schemas']['BackupLast'];

/** Settings' groups, in the order of the rail. The first is `/settings` itself. */
export const GROUPS = [
  { slug: '', label: 'Appearance' },
  { slug: 'background', label: 'In the background' },
  { slug: 'email', label: 'Email' },
  { slug: 'notifications', label: 'Notifications' },
  { slug: 'ai', label: 'AI' },
  { slug: 'sources', label: 'Sources' },
  { slug: 'storage', label: 'Backup' },
  { slug: 'tutorials', label: 'Tutorials' },
  { slug: 'about', label: 'About resmon' },
  { slug: 'danger', label: 'Danger zone' },
] as const;

export type GroupSlug = (typeof GROUPS)[number]['slug'];

export function groupPath(slug: GroupSlug): string {
  return slug ? `/settings/${slug}` : '/settings';
}

/** What the unit file is on this platform, and what registers it. */
export function unitKind(platform: string | null | undefined): { kind: string; manager: string } {
  switch (platform) {
    case 'darwin': return { kind: 'a launch agent', manager: 'launchd' };
    case 'win32': return { kind: 'a scheduled task', manager: 'Task Scheduler' };
    case 'linux': return { kind: 'a systemd user unit', manager: 'systemd' };
    default: return { kind: 'a service unit', manager: 'the system’s service manager' };
  }
}

/** Where the operating system keeps a password resmon stores. */
export function keychainName(platform: string | null | undefined): string {
  switch (platform) {
    case 'darwin': return 'the macOS Keychain';
    case 'win32': return 'Windows Credential Manager';
    case 'linux': return 'the desktop’s keyring';
    default: return 'this computer’s credential store';
  }
}

export type DaemonState = 'attached' | 'beside' | 'unanswered' | 'none';

/**
 * What is running in the background, from the lock file and its probe, and
 * whether this window is attached to it. The probe's own `is_self` is true
 * when the process answering this request is the one the lock names; the pid
 * comparison is the same fact read from this window's side.
 */
export function daemonState(daemon: DaemonStatus, windowPid: number | null): DaemonState {
  if (daemon.running) {
    return daemon.is_self || (windowPid !== null && daemon.pid === windowPid) ? 'attached' : 'beside';
  }
  return daemon.lock_present ? 'unanswered' : 'none';
}

export function daemonSentence(daemon: DaemonStatus, state: DaemonState, since: string | null): string {
  const who = [daemon.pid !== null && `pid ${daemon.pid}`, daemon.version && `version ${daemon.version}`, since && `since ${since}`]
    .filter(Boolean).join(', ');
  switch (state) {
    case 'attached':
      return `The background service is running (${who}), and this window is using it.`;
    case 'beside':
      return `A daemon is running (${who}), but this window is not using it: it started an engine of its own.`;
    case 'unanswered': {
      const named = [daemon.lock_pid !== null && `pid ${daemon.lock_pid}`, daemon.lock_port !== null && `port ${daemon.lock_port}`]
        .filter(Boolean).join(' on ');
      return `A lock file names ${named || 'a daemon'}, but it did not answer${daemon.error ? ` (${daemon.error})` : ''}, `
        + 'so resmon cannot say a daemon is running.';
    }
    default:
      // A window's own engine runs no scheduler, so without the service
      // nothing runs a watch on schedule, window open or not.
      return 'There is no daemon running, so nothing runs your watches on schedule: a resmon window does not run them itself.';
  }
}

/**
 * The two limits the engine's admission control reads (`admission.py`), and
 * the ranges `PUT /api/settings/execution` accepts.
 */
export const RUN_LIMITS = {
  runs: { min: 1, max: 8, words: 'Runs at once' },
  queue: { min: 1, max: 64, words: 'Watch runs that can wait' },
} as const;

/** Why a typed limit cannot be saved, or null when it can. */
export function limitProblem(raw: string, limit: (typeof RUN_LIMITS)[keyof typeof RUN_LIMITS]): string | null {
  const text = raw.trim();
  const n = Number(text);
  if (text === '' || !/^\d+$/.test(text) || n < limit.min || n > limit.max) {
    return `${limit.words} must be a whole number from ${limit.min} to ${limit.max}.`;
  }
  return null;
}

/**
 * Which engine a change to the limits reaches, and when. Each engine holds
 * its own count of what it is running and reads the stored limits when it
 * starts; the one that answers the change also applies it at once. Only the
 * background service runs watches on schedule, so a window with an engine of
 * its own changes the service's limits only from the service's next start.
 */
export function limitsReach(state: DaemonState | null): string {
  switch (state) {
    case 'attached':
      return 'This window uses the background service’s engine, so a change applies to it at once: to your searches and to your watches.';
    case 'beside':
      return 'This window uses an engine it started itself, so a change applies to that engine at once. The background service, '
        + 'which runs your watches on schedule, is a separate engine with its own count, and reads these limits when it next starts.';
    case 'none':
    case 'unanswered':
      return 'This window uses an engine it started itself, so a change applies to that engine at once. The background service, '
        + 'which runs your watches on schedule, reads these limits when it starts.';
    default:
      return 'A change applies at once to the engine this window uses. Any other engine reads these limits when it next starts.';
  }
}

/**
 * Whether the staged restore runs when this app next starts, so Restart
 * resmon now would carry it out. Not where the background service holds the
 * database (restarting the app is not a start of the service), and not for a
 * pointer the next start cannot read. Decided by the engine's code for the
 * case rather than by its sentence.
 */
export function restartRestores(last: {
  pending_restore: object | null; pending_restore_runs_on: BackupLast['pending_restore_runs_on'];
}): boolean {
  const pending = last.pending_restore as { unreadable?: unknown } | null;
  if (!pending || pending.unreadable === true) return false;
  return last.pending_restore_runs_on === 'app_restart';
}
