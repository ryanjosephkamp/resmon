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

/** Settings' groups, in the order of the rail. The first is `/settings` itself. */
export const GROUPS = [
  { slug: '', label: 'Appearance' },
  { slug: 'background', label: 'In the background' },
  { slug: 'email', label: 'Email' },
  { slug: 'notifications', label: 'Notifications' },
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
      return 'There is no daemon running, so your watches run only while a resmon window is open.';
  }
}
